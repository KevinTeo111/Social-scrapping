import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Password hashing and at-rest encryption for stored Workana cookies.
 *
 * The cookie blobs are not ordinary application data: each one is a live login to
 * somebody's Workana account, usable by anyone who reads the database file. They
 * are therefore encrypted with a server-held key rather than stored as-is, so a
 * leaked `workana.db` alone does not hand over everyone's accounts.
 */

const KEY_FILE = path.join(path.dirname(config.dbFile), 'secret.key');

function loadKeyMaterial() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;

  // No secret configured: keep a generated one beside the database so restarts
  // can still read what they wrote. Same-machine only — see README.
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();

  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(KEY_FILE, generated, { mode: 0o600 });
  console.warn(
    `[secrets] No APP_SECRET set — generated one at ${KEY_FILE}.\n` +
      `          Set APP_SECRET in the environment to control it yourself; ` +
      `losing this file makes every stored Workana session unreadable.`,
  );
  return generated;
}

const KEY = crypto.scryptSync(loadKeyMaterial(), 'workana-board-v1', 32);

/** AES-256-GCM. Returns "iv.tag.ciphertext", all base64url. */
export function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, body].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(payload) {
  if (!payload) return null;
  try {
    const [iv, tag, body] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, or tampered ciphertext. Treat as "no cookies stored".
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Passwords                                                           */
/* ------------------------------------------------------------------ */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('base64url');
  return { hash, salt };
}

/** Constant-time comparison, so a wrong password cannot be timed out character by character. */
export function verifyPassword(password, salt, expected) {
  if (!password || !salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  const want = Buffer.from(expected, 'base64url');
  if (want.length !== actual.length) return false;
  return crypto.timingSafeEqual(actual, want);
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
