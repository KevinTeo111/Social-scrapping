import { all, get, run, insertReturning } from './sql.js';
import { hashPassword, verifyPassword, newToken, encrypt, decrypt } from './secrets.js';
import { parseWorkanaCookies } from './cookies.js';
import { config } from './config.js';

const SESSION_DAYS = 30;

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

export async function userCount() {
  return (await get('SELECT COUNT(*) AS n FROM users')).n;
}

export async function findUserByEmail(email) {
  return get('SELECT * FROM users WHERE email = ?', [normaliseEmail(email)]);
}

export async function findUser(id) {
  return get('SELECT * FROM users WHERE id = ?', [id]);
}

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function registerUser({ email, password, name }) {
  const mail = normaliseEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new AuthError('Enter a valid email address.');
  if (!password || password.length < 8) throw new AuthError('Password must be at least 8 characters.');
  if (await findUserByEmail(mail)) throw new AuthError('That email is already registered.', 409);

  const { hash, salt } = hashPassword(password);
  // The first account to register owns the instance.
  const isAdmin = (await userCount()) === 0 ? 1 : 0;

  const id = await insertReturning(
    `INSERT INTO users (email, name, password_hash, password_salt, is_admin, created_at)
     VALUES (?,?,?,?,?,?) RETURNING id`,
    [mail, String(name || '').trim() || null, hash, salt, isAdmin, new Date().toISOString()],
  );

  return findUser(Number(id));
}

export async function authenticate(email, password) {
  const user = await findUserByEmail(email);
  // Always run the comparison so a missing account and a wrong password take
  // the same time and cannot be told apart by an attacker enumerating emails.
  const ok = verifyPassword(password, user?.password_salt || 'x', user?.password_hash || '');
  if (!user || !ok) throw new AuthError('Email or password is incorrect.', 401);

  await run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), user.id]);
  return user;
}

export async function changePassword(userId, currentPassword, nextPassword) {
  const user = await findUser(userId);
  if (!user) throw new AuthError('No such user.', 404);
  if (!verifyPassword(currentPassword, user.password_salt, user.password_hash)) {
    throw new AuthError('Current password is incorrect.', 401);
  }
  if (!nextPassword || nextPassword.length < 8) throw new AuthError('New password must be at least 8 characters.');

  const { hash, salt } = hashPassword(nextPassword);
  await run('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', [hash, salt, userId]);
  // Changing a password invalidates other sessions.
  await run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export async function createSession(userId) {
  const token = newToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400e3);
  await run('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)', [
    token,
    userId,
    now.toISOString(),
    expires.toISOString(),
  ]);
  return { token, expires };
}

/*
 * Runs in front of every request, so it is one query: the session and its user
 * together. Reading them one after the other cost a second round trip to the
 * database on every single request -- a third of a second each, from a
 * workstation to a hosted Postgres.
 */
export async function resolveSession(token) {
  if (!token) return null;
  const row = await get(
    `SELECT s.expires_at AS session_expires_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`,
    [token],
  );
  if (!row) return null;
  if (new Date(row.session_expires_at) < new Date()) {
    await run('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  delete row.session_expires_at;
  return row;
}

export async function destroySession(token) {
  if (token) await run('DELETE FROM sessions WHERE token = ?', [token]);
}

export async function purgeExpiredSessions() {
  await run('DELETE FROM sessions WHERE expires_at < ?', [new Date().toISOString()]);
}

/* ------------------------------------------------------------------ */
/* Workana credentials                                                 */
/* ------------------------------------------------------------------ */

/**
 * Stores a user's Workana cookie export. The raw JSON is validated first (so a
 * bad paste fails loudly rather than at scrape time), reduced to workana.com
 * cookies only — the export usually contains the person's whole browser profile,
 * and there is no reason to keep their Google or bank cookies — and encrypted.
 */
export async function setWorkanaCookies(userId, rawJson) {
  const cookies = parseWorkanaCookies(rawJson); // throws with a useful message
  const hasSession = cookies.some((c) => c.name === 'workana_session' && c.value);

  /*
   * Clears any quarantine: a fresh session is exactly the fix a set-aside
   * account is waiting for, so let it be tried again at once.
   */
  await run(
    `UPDATE users SET workana_cookies = ?, cookies_updated_at = ?, cookies_valid = NULL,
            empty_runs = 0, scrape_blocked_at = NULL, scrape_blocked_reason = NULL
      WHERE id = ?`,
    [encrypt(JSON.stringify(cookies)), new Date().toISOString(), userId],
  );

  return { count: cookies.length, hasSession };
}

export async function getWorkanaCookies(userId) {
  const user = await findUser(userId);
  if (!user?.workana_cookies) return null;
  const json = decrypt(user.workana_cookies);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function clearWorkanaCookies(userId) {
  await run(
    `UPDATE users SET workana_cookies = NULL, cookies_updated_at = NULL, cookies_valid = NULL,
                      workana_name = NULL, browser_state = NULL, browser_state_at = NULL
      WHERE id = ?`,
    [userId],
  );
}

/* ------------------------------------------------------------------ */
/* Browser state                                                       */
/* ------------------------------------------------------------------ */

/**
 * The Playwright storage state a member's scrapes reuse between runs.
 *
 * Its value is the `cf_clearance` inside it: Cloudflare issues that to the
 * browser and IP that actually passed the challenge, so keeping it is what stops
 * every run from having to fight the challenge again. It used to live in a file
 * beside the database, which a container redeploy erased along with everything
 * else — so it now sits on the member's row, encrypted like their cookies,
 * because it is every bit as much a live credential.
 */
export async function saveBrowserState(userId, state) {
  if (!userId || !state) return;
  await run('UPDATE users SET browser_state = ?, browser_state_at = ? WHERE id = ?', [
    encrypt(typeof state === 'string' ? state : JSON.stringify(state)),
    new Date().toISOString(),
    userId,
  ]);
}

export async function loadBrowserState(userId) {
  if (!userId) return null;
  const user = await findUser(userId);
  if (!user?.browser_state) return null;
  const json = decrypt(user.browser_state);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Per-member egress proxy for Workana traffic.
 *
 * Scraping runs on the server, so without this every member's session is driven
 * from the host's IP wherever they actually are. That matters because Workana's
 * `cf_clearance` is bound to the IP that earned it, and a session that suddenly
 * appears from another continent is exactly the pattern account-security checks
 * look for. Pointing each member at an exit in their own region avoids both.
 *
 * Stored encrypted, since proxy URLs routinely embed credentials.
 */
export async function setWorkanaProxy(userId, url) {
  const value = String(url || '').trim();
  if (!value) {
    await run(
      `UPDATE users SET workana_proxy = NULL, empty_runs = 0, scrape_blocked_at = NULL,
              scrape_blocked_reason = NULL, proxy_checked_at = NULL, proxy_error = NULL
        WHERE id = ?`,
      [userId],
    );
    return null;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new AuthError('Proxy must be a URL, e.g. http://user:pass@host:8080 or socks5://host:1080');
  }
  if (!/^(https?|socks[45]?):$/.test(parsed.protocol)) {
    throw new AuthError(`Unsupported proxy protocol "${parsed.protocol.replace(':', '')}".`);
  }

  /*
   * Clears any quarantine: changing the session or the exit is exactly the fix
   * a set-aside session is waiting for, so let it be tried again at once.
   */
  await run(
    `UPDATE users SET workana_proxy = ?, empty_runs = 0, scrape_blocked_at = NULL,
            scrape_blocked_reason = NULL, proxy_checked_at = NULL, proxy_error = NULL
      WHERE id = ?`,
    [encrypt(value), userId],
  );
  return describeProxy(value);
}

export async function getWorkanaProxy(userId) {
  const user = await findUser(userId);
  return user?.workana_proxy ? decrypt(user.workana_proxy) : null;
}

/** Host and port only — never hand the credentials back to the browser. */
export function describeProxy(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.username ? ' (authenticated)' : ''}`;
  } catch {
    return 'configured';
  }
}

/** Stores the proposal count read from the member's own inbox. */
export async function recordProposalCount(userId, total) {
  await run('UPDATE users SET proposals_total = ?, proposals_synced_at = ? WHERE id = ?', [
    total,
    new Date().toISOString(),
    userId,
  ]);
}

export async function recordCookieCheck(userId, { valid, workanaName }) {
  await run('UPDATE users SET cookies_valid = ?, workana_name = COALESCE(?, workana_name) WHERE id = ?', [
    valid ? 1 : 0,
    workanaName ?? null,
    userId,
  ]);
}

/** Never send hashes or cookie blobs to the browser. */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isAdmin: Boolean(user.is_admin),
    workanaName: user.workana_name,
    hasCookies: Boolean(user.workana_cookies),
    cookiesUpdatedAt: user.cookies_updated_at,
    cookiesValid: user.cookies_valid === null ? null : Boolean(user.cookies_valid),
    proposalsTotal: user.proposals_total ?? null,
    proposalsSyncedAt: user.proposals_synced_at ?? null,
    proxy: user.workana_proxy ? describeProxy(decrypt(user.workana_proxy)) : null,
    // So the board can say why scraping is refused before anyone presses it.
    proxyRequired: Boolean(proxyBlocker(user)),
    scrapeBlocked: scrapeBlocker(user),
    // Which fields are known to be wrong, and why — so the panel can ask for
    // exactly those rather than saying "something failed".
    brokenInputs: brokenInputs(user),
    createdAt: user.created_at,
  };
}

/** Members eligible to carry a background refresh, least recently run first. */
export async function scrapeCandidates() {
  return all(
    `SELECT id FROM users
      WHERE workana_cookies IS NOT NULL AND COALESCE(cookies_valid, 1) = 1
        AND scrape_blocked_at IS NULL
        ${config.requireProxy ? 'AND (is_admin = 1 OR workana_proxy IS NOT NULL)' : ''}
      ORDER BY COALESCE(
        (SELECT MAX(started_at) FROM scrape_runs WHERE scrape_runs.user_id = users.id), '')
      ASC`,
  );
}

/** Consecutive runs that collected nothing before a session is set aside. */
export const EMPTY_RUNS_BEFORE_BLOCK = 3;

/**
 * Records how a run that walked list pages turned out, and sets a session aside
 * when it keeps coming back with nothing.
 *
 * Three accounts here spent six hours producing nothing on every single run --
 * two with expired Workana sessions, one behind a proxy that refused the
 * connection -- while the rotation kept handing them turns and the board said
 * nothing. A run costs over a minute, so half the schedule was going nowhere.
 *
 * Only runs that actually walked a list page count: enrichment reads no list,
 * so seeing no jobs means nothing there. One good run clears the count, because
 * an empty page is also what throttling looks like and that passes.
 */
export async function recordRunOutcome(userId, { listPages = 0, seen = 0 } = {}) {
  if (!userId || listPages < 1) return null;
  if (seen > 0) {
    await run(
      `UPDATE users SET empty_runs = 0, scrape_blocked_at = NULL, scrape_blocked_reason = NULL
        WHERE id = ? AND (empty_runs > 0 OR scrape_blocked_at IS NOT NULL)`,
      [userId],
    );
    return null;
  }

  const user = await findUser(userId);
  const empty = (user?.empty_runs ?? 0) + 1;
  if (empty < EMPTY_RUNS_BEFORE_BLOCK) {
    await run('UPDATE users SET empty_runs = ? WHERE id = ?', [empty, userId]);
    return null;
  }
  const reason =
    `${empty} runs in a row collected nothing. Either this Workana session has expired — ` +
    'check with Verify, and re-export the cookies if so — or the proxy is refusing the ' +
    'connection. Attaching a session or saving a proxy starts it again.';
  await run(
    `UPDATE users SET empty_runs = ?, scrape_blocked_at = ?, scrape_blocked_reason = ? WHERE id = ?`,
    [empty, new Date().toISOString(), reason, userId],
  );
  return reason;
}

/** Why this member's session is set aside, or null. */
export function scrapeBlocker(user) {
  return user?.scrape_blocked_at ? user.scrape_blocked_reason || 'This session kept collecting nothing.' : null;
}

/** What the proxy said when last asked to reach Workana. */
export async function recordProxyCheck(userId, { ok, detail }) {
  return run('UPDATE users SET proxy_checked_at = ?, proxy_error = ? WHERE id = ?', [
    new Date().toISOString(),
    ok ? null : detail || 'the proxy refused the connection',
    userId,
  ]);
}

/**
 * What this member must fix before their session can be used again, named.
 *
 * The point is to stop guessing. An expired session and a refused proxy both
 * end a run the same way -- an empty page, no error -- so each is tested for
 * what it actually is: the proxy by asking it to connect, the session by
 * loading Workana with it. Each entry says which field on the account panel
 * puts it right.
 */
export function brokenInputs(user) {
  const needs = [];
  if (user?.proxy_error) {
    needs.push({ field: 'proxy', problem: user.proxy_error, checkedAt: user.proxy_checked_at });
  }
  if (user?.cookies_valid === 0) {
    needs.push({
      field: 'session',
      problem: 'Workana did not accept this session — it has expired or was signed out.',
      checkedAt: user.cookies_updated_at,
    });
  }
  return needs;
}

/**
 * Why this member's Workana session may not be used yet, or null when it may.
 *
 * Their session would otherwise be driven from the scraper's own address --
 * another country, as far as Workana is concerned -- which invites both
 * Cloudflare challenges and questions about the account. The owner is exempt:
 * the scraper runs on their machine, so their traffic is already their own.
 */
export function proxyBlocker(user) {
  if (!config.requireProxy || !user || user.is_admin) return null;
  if (user.workana_proxy) return null;
  return (
    'Add a proxy in your own country first (Account → Egress proxy). Without one, your ' +
    'Workana session would be driven from the scraper machine\'s address, which gets both ' +
    'of you challenged.'
  );
}

/* ------------------------------------------------------------------ */
/* Express middleware                                                  */
/* ------------------------------------------------------------------ */

export const SESSION_COOKIE = 'wk_session';

/**
 * Express 5 forwards a rejected promise from middleware to the error handler,
 * so this can be async without a try/catch of its own.
 */
export async function attachUser(req, _res, next) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const token = match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : null;
  req.sessionToken = token;
  req.user = await resolveSession(token);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Administrator only.' });
  next();
}
