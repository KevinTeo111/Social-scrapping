/**
 * Copies an existing SQLite corpus into Postgres, once.
 *
 *   $env:DATABASE_URL = "postgresql://...public url..."
 *   node scripts/migrate-to-postgres.mjs             # report only
 *   node scripts/migrate-to-postgres.mjs --apply     # copy
 *
 * Options:
 *   --from <path>   source database (default: the configured DB_FILE)
 *   --replace       overwrite rows that already exist in Postgres
 *
 * DATABASE_URL must be the *public* connection string while running this from a
 * workstation. Railway's `*.railway.internal` hostnames resolve only inside
 * Railway's own network, so the internal URL will simply fail to connect.
 *
 * Encryption matters here. Workana cookies, proxy URLs and browser state travel
 * as the ciphertext they already are, so the destination must be able to decrypt
 * them: APP_SECRET on the server has to match the key this SQLite database was
 * written with (data/secret.key, unless APP_SECRET was already set). Copy the
 * key across *before* running this, or every member will have to re-attach their
 * session afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.js';
import { all, get, run, exec, initDatabase, isPostgres } from '../src/db.js';

const argv = process.argv;
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const apply = flag('--apply');
const replace = flag('--replace');
const sourcePath = path.resolve(value('--from', config.dbFile));

if (!isPostgres) {
  console.error(
    'DATABASE_URL is not set, so there is no Postgres to migrate into.\n' +
      'Set it to the public connection string of your Railway Postgres service first.',
  );
  process.exit(1);
}
if (!fs.existsSync(sourcePath)) {
  console.error(`No SQLite database at ${sourcePath}. Pass --from <path> if it lives elsewhere.`);
  process.exit(1);
}

/*
 * Order matters: a table is copied only after whatever it points at. `clients`
 * before `jobs` because jobs reference a client; `users` before the three tables
 * keyed by user_id.
 */
const TABLES = [
  'clients',
  'jobs',
  'client_reviews',
  'job_insights',
  'user_flags',
  'users',
  'sessions',
  'user_jobs',
  'scrape_runs',
];

/** Identity columns whose generator has to be moved past the ids we inserted. */
const SEQUENCES = [
  ['users', 'id'],
  ['client_reviews', 'id'],
  ['scrape_runs', 'id'],
  ['jobs', 'seq'],
];

/** Natural keys, so a re-run updates rather than duplicating. */
const CONFLICT = {
  clients: ['id'],
  jobs: ['slug'],
  client_reviews: ['client_id', 'project_title', 'freelancer', 'comment'],
  job_insights: ['job_slug', 'freelancer'],
  user_flags: ['job_slug'],
  users: ['id'],
  sessions: ['token'],
  user_jobs: ['user_id', 'job_slug'],
  scrape_runs: ['id'],
};

const source = new DatabaseSync(sourcePath, { readOnly: true });
const sourceTables = new Set(
  source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
);

console.log(`source : ${sourcePath}`);
console.log(`target : ${new URL(config.databaseUrl).host}\n`);

await initDatabase();

/*
 * A hosted Postgres over the public internet can drop a connection mid-run: the
 * compute scales down, a proxy recycles, a NAT forgets the flow. The pool throws
 * a dead client away, so trying again gets a fresh one. Retrying an insert is
 * safe because every insert here is ON CONFLICT: a chunk that did land the
 * first time is skipped (or, with --replace, rewritten identically).
 */
const TRANSIENT = /terminated|ECONNRESET|ETIMEDOUT|EPIPE|timeout|connect/i;
async function retry(what, fn, attempts = 5) {
  for (let n = 1; ; n += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!TRANSIENT.test(err.message) || n >= attempts) throw err;
      const wait = 3000 * n;
      console.warn(`  ${what}: ${err.message} — retrying in ${wait / 1000}s (${n}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Columns present in both databases — anything else cannot be carried across. */
async function sharedColumns(table) {
  const from = source.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const to = (
    await retry(`${table} columns`, () =>
      all('SELECT column_name FROM information_schema.columns WHERE table_name = ?', [table]),
    )
  ).map((c) => c.column_name);
  const shared = from.filter((c) => to.includes(c));
  const dropped = from.filter((c) => !to.includes(c));
  return { shared, dropped };
}

const plan = [];
for (const table of TABLES) {
  if (!sourceTables.has(table)) {
    plan.push({ table, rows: 0, note: 'not in source' });
    continue;
  }
  const rows = source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const existing = (await retry(`${table} count`, () => get(`SELECT COUNT(*) AS n FROM ${table}`))).n;
  const { shared, dropped } = await sharedColumns(table);
  plan.push({
    table,
    rows,
    already_there: existing,
    columns: shared.length,
    note: dropped.length ? `skipping ${dropped.join(', ')}` : '',
  });
}
console.table(plan);

if (!apply) {
  console.log('Dry run — nothing written. Re-run with --apply to copy.');
  process.exit(0);
}

/*
 * Rows go over in chunks. One statement per row would be a round trip per row,
 * which over a public connection turns a thousand jobs into minutes of latency.
 */
const CHUNK = 100;
let copied = 0;

for (const table of TABLES) {
  if (!sourceTables.has(table)) continue;
  const { shared } = await sharedColumns(table);
  if (!shared.length) continue;

  const rows = source.prepare(`SELECT ${shared.join(', ')} FROM ${table}`).all();
  if (!rows.length) {
    console.log(`${table.padEnd(16)} 0`);
    continue;
  }

  const keys = CONFLICT[table];
  const updatable = shared.filter((c) => !keys.includes(c));
  const onConflict = replace && updatable.length
    ? `ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${updatable.map((c) => `${c} = excluded.${c}`).join(', ')}`
    : `ON CONFLICT (${keys.join(', ')}) DO NOTHING`;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const tuple = `(${shared.map(() => '?').join(',')})`;
    const params = [];
    for (const row of slice) {
      for (const c of shared) {
        const v = row[c];
        // node:sqlite hands back BigInt for INTEGER columns; pg wants a number.
        params.push(typeof v === 'bigint' ? Number(v) : v);
      }
    }
    await retry(`${table} rows ${i + 1}-${i + slice.length}`, () =>
      run(
        `INSERT INTO ${table} (${shared.join(', ')}) VALUES ${slice.map(() => tuple).join(',')} ${onConflict}`,
        params,
      ),
    );
    // Large tables take minutes over a public connection; show that it moves.
    if (rows.length > 5000 && (i / CHUNK) % 50 === 49) {
      console.log(`  ${table} ${i + slice.length} / ${rows.length}`);
    }
  }

  copied += rows.length;
  console.log(`${table.padEnd(16)} ${rows.length}`);
}

/*
 * Every id came from SQLite, so Postgres' identity generators are still sitting
 * at 1 and the next insert would collide. Move each past the highest id present.
 */
for (const [table, column] of SEQUENCES) {
  await exec(
    `SELECT setval(pg_get_serial_sequence('${table}', '${column}'),
                   GREATEST((SELECT COALESCE(MAX(${column}), 0) FROM ${table}), 1))`,
  ).catch((err) => console.warn(`  could not advance ${table}.${column}: ${err.message}`));
}

console.log(`\ncopied ${copied} row(s).`);
console.table(
  await get(`SELECT
    (SELECT COUNT(*) FROM jobs) AS jobs,
    (SELECT COUNT(*) FROM clients) AS clients,
    (SELECT COUNT(*) FROM job_insights) AS insights,
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM user_jobs) AS user_jobs`),
);
console.log(
  '\nIf members are asked to re-attach their Workana session after this, APP_SECRET\n' +
    'on the server does not match the key this database was encrypted with.',
);
