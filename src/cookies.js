import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Cookie exports from the popular "EditThisCookie" / "Cookie-Editor" extensions use
 * a slightly different shape than Playwright wants. The interesting differences:
 *
 *   - `sameSite` is "unspecified" | "no_restriction" | "lax" | "strict"
 *     while Playwright wants "Lax" | "Strict" | "None".
 *   - `expirationDate` is a float (seconds) and `0` means "session cookie",
 *     which Playwright expresses as `expires: -1`.
 *   - Host-only cookies are exported with the bare host in `domain`, while
 *     domain cookies keep the leading dot. Playwright follows the same
 *     convention, so `domain` passes through untouched.
 */
const SAME_SITE = {
  no_restriction: 'None',
  unspecified: 'Lax',
  lax: 'Lax',
  strict: 'Strict',
  none: 'None',
};

function normalise(raw) {
  let sameSite = SAME_SITE[String(raw.sameSite || '').toLowerCase()] || 'Lax';

  // Chromium rejects `SameSite=None` on a non-secure cookie outright. Rather than
  // dropping the cookie (some of these carry the session) we downgrade it to Lax.
  if (sameSite === 'None' && !raw.secure) sameSite = 'Lax';

  const cookie = {
    name: raw.name,
    value: String(raw.value ?? ''),
    domain: raw.domain,
    path: raw.path || '/',
    httpOnly: Boolean(raw.httpOnly),
    secure: Boolean(raw.secure),
    sameSite,
  };

  const expires = Number(raw.expirationDate);
  cookie.expires = Number.isFinite(expires) && expires > 0 ? Math.floor(expires) : -1;

  return cookie;
}

function matchesWorkana(domain = '') {
  const d = domain.toLowerCase().replace(/^\./, '');
  return d === 'workana.com' || d.endsWith('.workana.com');
}

/**
 * Parses a cookie export (JSON text) and returns only the cookies Playwright can
 * use for workana.com.
 *
 * The export typically contains a whole browser profile — Google, LinkedIn,
 * banking, everything — so the filter is a privacy measure as much as a
 * correctness one: there is no reason for this app to keep, or for Workana to
 * receive, somebody's unrelated third-party sessions.
 */
export function parseWorkanaCookies(text, source = 'cookie data') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`);
  }

  const list = Array.isArray(parsed) ? parsed : parsed?.cookies;
  if (!Array.isArray(list)) {
    throw new Error(`${source} should be a JSON array of cookies (as exported by a cookie-editor extension).`);
  }

  const cookies = list.filter((c) => c && c.name && matchesWorkana(c.domain)).map(normalise);
  if (cookies.length === 0) {
    throw new Error(
      `No workana.com cookies found in ${source}. Make sure you exported them while signed in to workana.com.`,
    );
  }
  return cookies;
}

/** File-backed variant, used by the CLI and the single-user bootstrap. */
export function loadWorkanaCookies(file = config.cookieFile) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    throw new Error(
      `Cookie file not found: ${abs}\n` +
        `Export your Workana cookies with a cookie-editor extension and save them there, ` +
        `or point COOKIE_FILE at a different path.`,
    );
  }
  return parseWorkanaCookies(fs.readFileSync(abs, 'utf8'), abs);
}

/** True when the export still carries a login session (not just analytics cookies). */
export function hasSessionCookie(cookies) {
  return cookies.some((c) => c.name === 'workana_session' && c.value);
}

/** Cookies whose absence/expiry explains a logged-out scrape, for diagnostics. */
export function describeSession(cookies) {
  const now = Date.now() / 1000;
  const interesting = ['workana_session', 'appcookie[wd]', 'appcookie[wldh]', 'cf_clearance'];
  return interesting.map((name) => {
    const cookie = cookies.find((c) => c.name === name);
    if (!cookie) return { name, present: false };
    return {
      name,
      present: true,
      expired: cookie.expires > 0 && cookie.expires < now,
      expiresAt: cookie.expires > 0 ? new Date(cookie.expires * 1000).toISOString() : 'session',
    };
  });
}
