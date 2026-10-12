/**
 * The database, behind one small async interface.
 *
 * Two engines are supported deliberately. A hosted deployment sets DATABASE_URL
 * and gets Postgres, because a container's filesystem is erased on every deploy
 * and a managed database is the only thing that survives it. A workstation with
 * no DATABASE_URL keeps the SQLite file, so the project still runs with nothing
 * installed and no server to start.
 *
 * Everything here is async even on SQLite, where it need not be. Having one call
 * shape means the rest of the codebase is written once rather than twice, and it
 * is the Postgres shape that constrains us — `node:sqlite` can pretend to be
 * asynchronous, `pg` cannot pretend to be synchronous.
 *
 * SQL is written in the Postgres dialect and translated down to SQLite, rather
 * than the other way around, so the engine that is harder to please is the one
 * being written for directly.
 */
import { config } from './config.js';

export const dialect = config.databaseUrl ? 'postgres' : 'sqlite';
export const isPostgres = dialect === 'postgres';

let driver = null;

/* ------------------------------------------------------------------ */
/* Statement translation                                               */
/* ------------------------------------------------------------------ */

/**
 * Rewrites `?` placeholders as `$1, $2, …` for Postgres.
 *
 * Quoted text is skipped, because a `?` inside a string literal is data, not a
 * placeholder. Doubled quotes ('' and "") are how both dialects escape a quote
 * inside a literal, and the scan below handles them by simply toggling twice.
 */
export function toPgPlaceholders(sql) {
  let out = '';
  let n = 0;
  let quote = null;
  for (const ch of sql) {
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch === '?' ? `$${++n}` : ch;
  }
  return out;
}

/**
 * Postgres-isms SQLite spells differently.
 *
 * `GREATEST` is the one that matters: the upserts use it to make a flag sticky
 * ("once true, stay true"), and SQLite's two-argument `MAX` does the same job
 * under a different name. Postgres reserves `MAX` for the aggregate, which is
 * why the shared SQL is written the Postgres way.
 */
function toSqlite(sql) {
  return sql.replace(/\bGREATEST\s*\(/gi, 'MAX(');
}

/* ------------------------------------------------------------------ */
/* Drivers                                                             */
/* ------------------------------------------------------------------ */

async function openPostgres() {
  const { default: pg } = await import('pg');

  /*
   * Postgres returns BIGINT and NUMERIC as strings, since they can exceed what a
   * JS number holds safely. Nothing here is anywhere near that range — ids,
   * counts, ratings and budgets — and the rest of the code compares and formats
   * them as numbers, so they are parsed back rather than leaking strings into
   * every caller.
   */
  pg.types.setTypeParser(20, Number); // int8
  pg.types.setTypeParser(1700, Number); // numeric

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolSize,
    /*
     * A hosted Postgres reached over the public internet -- Neon especially,
     * which scales its compute to zero when idle -- can stall a connect or drop
     * a connection the pool still believes is healthy. Without a timeout the
     * pool waits for a connection indefinitely, so a stall hangs the caller
     * instead of failing it; keep-alive stops NATs and proxies on the way from
     * silently forgetting a connection that sat idle between two scrapes.
     */
    connectionTimeoutMillis: 20_000,
    /*
     * Opening a connection to a hosted Postgres costs a TLS handshake and an
     * authentication exchange -- two to three seconds from a workstation whose
     * traffic goes out through a VPN. The pool's default closes a connection
     * after ten idle seconds, so the board kept paying that again between
     * clicks. Idle connections are kept instead (0 = never closed for being
     * idle); one that has actually died is noticed by keep-alive or by the next
     * query, and replaced.
     */
    idleTimeoutMillis: 0,
    keepAlive: true,
    // The OS default before the first keep-alive probe is two hours; a dead
    // connection should be noticed in seconds.
    keepAliveInitialDelayMillis: 10_000,
    /*
     * A query that stalls after the connection is up never fails on its own --
     * it simply never answers. From a workstation to Neon that happens now and
     * then, and in the scraper's loop one such query would freeze everything
     * behind it for good. Timing it out turns the stall into an error: the pool
     * throws the connection away and the next attempt gets a fresh one. Nothing
     * this app runs legitimately takes anywhere near this long.
     */
    query_timeout: config.dbQueryTimeoutMs,
    // Railway terminates TLS with its own certificate chain.
    ssl: /\blocalhost\b|\b127\.0\.0\.1\b/.test(config.databaseUrl)
      ? false
      : { rejectUnauthorized: false },
  });

  // A pooled client dying in the background must not take the process with it.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));

  return {
    async query(sql, params) {
      const text = toPgPlaceholders(sql);
      const started = performance.now();
      let r;
      for (let attempt = 1; ; attempt += 1) {
        try {
          r = await pool.query(text, params);
          break;
        } catch (err) {
          // Reads only: a write whose connection died may already have been
          // applied, and running it again could apply it twice.
          if (attempt >= 3 || !DROPPED.test(err.message) || !READ_ONLY.test(sql)) throw err;
        }
      }
      logIfSlow(sql, performance.now() - started);
      return { rows: r.rows, changes: r.rowCount };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const api = {
          async query(sql, params) {
            const r = await client.query(toPgPlaceholders(sql), params);
            return { rows: r.rows, changes: r.rowCount };
          },
          exec: (sql) => client.query(sql).then(() => undefined),
        };
        const result = await fn(api);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    /*
     * Opens connections ahead of need, one at a time: a page load asks for
     * several queries at once, and each connection opened on demand then costs
     * seconds -- several opened together is also what made Neon drop some.
     * Each is held until the next one exists, so the pool cannot hand the same
     * connection back and stop growing.
     */
    async warm(n) {
      const held = [];
      try {
        while (held.length < n && pool.totalCount < config.dbPoolSize) held.push(await pool.connect());
      } finally {
        for (const client of held) client.release();
      }
      return held.length;
    },
    close: () => pool.end(),
  };
}

/*
 * A new connection dropped mid-handshake -- which Neon did when several were
 * opened at once from a workstation -- fails the query on it. For a read the
 * cure is simply to ask again on another connection.
 */
const DROPPED = /terminated unexpectedly|Connection terminated|ECONNRESET|EPIPE|timeout exceeded when trying to connect/i;
const READ_ONLY = /^\s*(SELECT|WITH)\b(?![\s\S]*\b(INSERT|UPDATE|DELETE)\b)/i;

/*
 * DB_LOG_SLOW_MS=500 prints every query that took longer than that, with the
 * time measured from here -- so it includes the network, which is the point:
 * it tells a slow query apart from a slow link, and a slow board is usually one
 * or the other. Off unless set.
 */
const SLOW_MS = Number(process.env.DB_LOG_SLOW_MS) || 0;
function logIfSlow(sql, ms) {
  if (!SLOW_MS || ms < SLOW_MS) return;
  const text = sql.replace(/\s+/g, ' ').trim();
  console.warn(`[db] ${Math.round(ms)} ms  ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`);
}

async function openSqlite() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');

  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  const db = new DatabaseSync(config.dbFile);
  /*
   * `busy_timeout` is the one that is easy to leave out and expensive to leave
   * out. WAL lets readers and a writer work at once, but two writers still
   * collide, and SQLite's default timeout is zero: the loser is told "database
   * is locked" immediately rather than waiting its turn. More than one process
   * touches this file -- the board and the scraper share it, a backup runs
   * VACUUM INTO over it, and the scripts in scripts/ open it directly -- so the
   * collisions are routine and brief. Without a timeout they took the board
   * down: 1,316 consecutive "database is locked" failures in one evening,
   * every one of which would have succeeded after a few milliseconds' wait.
   */
  db.exec(
    `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;` +
      `PRAGMA busy_timeout = ${config.dbBusyTimeoutMs};`,
  );

  /*
   * A statement that hands back rows is read with all(); anything else goes
   * through run(), the only one of the two that reports how many rows changed.
   * Reading everything with all() made every plain UPDATE and DELETE report 0
   * rows touched, so a caller that counted its effect on SQLite was always told
   * nothing happened. `all()` covers RETURNING too, which is how both engines
   * hand back a generated id.
   */
  const RETURNS_ROWS = /^\s*(SELECT|WITH|PRAGMA|VALUES|EXPLAIN)\b|\bRETURNING\b/i;
  const query = (sql, params = []) => {
    const text = toSqlite(sql);
    const stmt = db.prepare(text);
    if (RETURNS_ROWS.test(text)) {
      const rows = stmt.all(...params);
      return { rows, changes: rows.length };
    }
    return { rows: [], changes: Number(stmt.run(...params).changes) };
  };

  const api = {
    async query(sql, params) {
      return query(sql, params);
    },
    async exec(sql) {
      db.exec(toSqlite(sql));
    },
    async transaction(fn) {
      db.exec('BEGIN');
      try {
        const result = await fn(api);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close: async () => db.close(),
    raw: db,
  };
  return api;
}

/* ------------------------------------------------------------------ */
/* Public interface                                                    */
/* ------------------------------------------------------------------ */

export async function connect() {
  if (!driver) driver = isPostgres ? await openPostgres() : await openSqlite();
  return driver;
}

const on = (target) => target || driver;

/** Every matching row. */
export async function all(sql, params = [], target) {
  const d = on(target) || (await connect());
  return (await d.query(sql, params)).rows;
}

/** The first matching row, or undefined. */
export async function get(sql, params = [], target) {
  const rows = await all(sql, params, target);
  return rows[0];
}

/** A statement run for its effect. Returns the number of rows it touched. */
export async function run(sql, params = [], target) {
  const d = on(target) || (await connect());
  const r = await d.query(sql, params);
  return r.changes ?? 0;
}

/**
 * An INSERT that needs its generated key back. Both engines support RETURNING,
 * which is cleaner than reaching for `lastInsertRowid` on one and not the other.
 */
export async function insertReturning(sql, params = [], column = 'id', target) {
  const row = await get(sql, params, target);
  return row?.[column];
}

/** Multiple statements, no parameters — schema work. */
export async function exec(sql, target) {
  const d = on(target) || (await connect());
  return d.exec(sql);
}

/**
 * Runs `fn` inside a transaction, handing it a target to pass as the last
 * argument of the helpers above so its statements join the transaction.
 */
export async function tx(fn) {
  const d = await connect();
  return d.transaction(fn);
}

/** Opens up to `n` connections in the background (Postgres only); see warm(). */
export async function warmUp(n) {
  const d = await connect();
  return d.warm ? d.warm(n) : 0;
}

export async function close() {
  if (driver) await driver.close();
  driver = null;
}
