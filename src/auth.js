import { db } from './db.js';
import { hashPassword, verifyPassword, newToken, encrypt, decrypt } from './secrets.js';
import { parseWorkanaCookies } from './cookies.js';

const SESSION_DAYS = 30;

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

export function userCount() {
  return db.prepare('SELECT COUNT(*) n FROM users').get().n;
}

export function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normaliseEmail(email));
}

export function findUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function registerUser({ email, password, name }) {
  const mail = normaliseEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new AuthError('Enter a valid email address.');
  if (!password || password.length < 8) throw new AuthError('Password must be at least 8 characters.');
  if (findUserByEmail(mail)) throw new AuthError('That email is already registered.', 409);

  const { hash, salt } = hashPassword(password);
  // The first account to register owns the instance.
  const isAdmin = userCount() === 0 ? 1 : 0;

  const info = db
    .prepare(
      `INSERT INTO users (email, name, password_hash, password_salt, is_admin, created_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(mail, String(name || '').trim() || null, hash, salt, isAdmin, new Date().toISOString());

  return findUser(Number(info.lastInsertRowid));
}

export function authenticate(email, password) {
  const user = findUserByEmail(email);
  // Always run the comparison so a missing account and a wrong password take
  // the same time and cannot be told apart by an attacker enumerating emails.
  const ok = verifyPassword(password, user?.password_salt || 'x', user?.password_hash || '');
  if (!user || !ok) throw new AuthError('Email or password is incorrect.', 401);

  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  return user;
}

export function changePassword(userId, currentPassword, nextPassword) {
  const user = findUser(userId);
  if (!user) throw new AuthError('No such user.', 404);
  if (!verifyPassword(currentPassword, user.password_salt, user.password_hash)) {
    throw new AuthError('Current password is incorrect.', 401);
  }
  if (!nextPassword || nextPassword.length < 8) throw new AuthError('New password must be at least 8 characters.');

  const { hash, salt } = hashPassword(nextPassword);
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, userId);
  // Changing a password invalidates other sessions.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export function createSession(userId) {
  const token = newToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400e3);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
    token,
    userId,
    now.toISOString(),
    expires.toISOString(),
  );
  return { token, expires };
}

export function resolveSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return findUser(row.user_id) || null;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
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
export function setWorkanaCookies(userId, rawJson) {
  const cookies = parseWorkanaCookies(rawJson); // throws with a useful message
  const hasSession = cookies.some((c) => c.name === 'workana_session' && c.value);

  db.prepare(
    `UPDATE users SET workana_cookies = ?, cookies_updated_at = ?, cookies_valid = NULL WHERE id = ?`,
  ).run(encrypt(JSON.stringify(cookies)), new Date().toISOString(), userId);

  return { count: cookies.length, hasSession };
}

export function getWorkanaCookies(userId) {
  const user = findUser(userId);
  if (!user?.workana_cookies) return null;
  const json = decrypt(user.workana_cookies);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function clearWorkanaCookies(userId) {
  db.prepare(
    'UPDATE users SET workana_cookies = NULL, cookies_updated_at = NULL, cookies_valid = NULL, workana_name = NULL WHERE id = ?',
  ).run(userId);
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
export function setWorkanaProxy(userId, url) {
  const value = String(url || '').trim();
  if (!value) {
    db.prepare('UPDATE users SET workana_proxy = NULL WHERE id = ?').run(userId);
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

  db.prepare('UPDATE users SET workana_proxy = ? WHERE id = ?').run(encrypt(value), userId);
  return describeProxy(value);
}

export function getWorkanaProxy(userId) {
  const user = findUser(userId);
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

export function recordCookieCheck(userId, { valid, workanaName }) {
  db.prepare('UPDATE users SET cookies_valid = ?, workana_name = COALESCE(?, workana_name) WHERE id = ?').run(
    valid ? 1 : 0,
    workanaName ?? null,
    userId,
  );
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
    proxy: user.workana_proxy ? describeProxy(decrypt(user.workana_proxy)) : null,
    createdAt: user.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* Express middleware                                                  */
/* ------------------------------------------------------------------ */

export const SESSION_COOKIE = 'wk_session';

export function attachUser(req, _res, next) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const token = match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : null;
  req.sessionToken = token;
  req.user = resolveSession(token);
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
