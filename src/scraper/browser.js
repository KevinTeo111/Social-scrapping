import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { loadWorkanaCookies } from '../cookies.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Human-ish pause between navigations so we don't hammer the site. */
export function jitter() {
  const { minDelayMs, maxDelayMs } = config;
  return sleep(minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs));
}

/**
 * Chromium started by an automation driver advertises itself in a handful of ways
 * that Cloudflare's managed challenge scores against you. These flags plus the
 * init script below remove the cheapest tells. This is not an arms race we try to
 * win -- it is enough to let a legitimate, logged-in user read their own job feed.
 */
const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

const STEALTH_INIT = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  if (!navigator.plugins || navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  }
  window.chrome = window.chrome || { runtime: {} };
  const query = window.navigator.permissions?.query;
  if (query) {
    window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : query(params);
  }
};

/**
 * Each account gets its own storage-state file. Sharing one would mix accounts'
 * Cloudflare clearances together, and a clearance is tied to the session that
 * earned it.
 */
/**
 * Playwright takes proxy credentials as separate fields rather than inline in
 * the URL, so `http://user:pass@host:8080` has to be taken apart first.
 */
function proxyOptions(url) {
  try {
    const u = new URL(url);
    const server = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
    return {
      server,
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    };
  } catch {
    return { server: url };
  }
}

export function statePathFor(userId) {
  return userId ? path.join(path.dirname(config.storageState), `state-user-${userId}.json`) : config.storageState;
}

/**
 * The cookie export's `cf_clearance` was minted for the browser and IP it came
 * from, so it is worthless here. When our own browser clears a challenge,
 * Cloudflare issues a clearance bound to *this* machine -- keeping that between
 * runs is what stops every run from having to fight the challenge again.
 */
function savedClearance(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return (state.cookies || []).filter((c) => c.name === 'cf_clearance');
  } catch {
    return [];
  }
}

/**
 * `cookies` lets a caller drive the browser as a particular registered user;
 * omitting it falls back to the on-disk export, which is what the CLI uses.
 */
export async function launchContext({
  headless = config.headless,
  cookies = null,
  userId = null,
  proxy = null,
} = {}) {
  const statePath = statePathFor(userId);
  // A member's own exit beats the instance-wide default.
  const egress = proxy || config.proxy;
  const browser = await chromium.launch({
    headless,
    args: LAUNCH_ARGS,
    // Without this Playwright launches `chromium-headless-shell`, which Cloudflare
    // fingerprints readily. `channel: 'chromium'` uses the full browser binary.
    channel: 'chromium',
  });

  const context = await browser.newContext({
    userAgent: config.userAgent,
    locale: config.locale,
    timezoneId: config.timezone,
    viewport: { width: 1600, height: 950 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'Accept-Language': `${config.locale},en;q=0.9`,
      'Sec-Ch-Ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
    },
    // Playwright wants credentials split out of the URL.
    ...(egress ? { proxy: proxyOptions(egress) } : {}),
  });

  await context.addInitScript(STEALTH_INIT);

  // The account's cookies first (they carry the login), then any clearance we
  // earned ourselves, which must win over the stale one in the export.
  const jar = cookies ?? loadWorkanaCookies();
  await context.addCookies(jar.filter((c) => c.name !== 'cf_clearance'));
  const clearance = savedClearance(statePath);
  if (clearance.length) await context.addCookies(clearance).catch(() => {});

  context.setDefaultNavigationTimeout(config.navTimeoutMs);
  context.setDefaultTimeout(config.navTimeoutMs);

  context._statePath = statePath;
  return { browser, context };
}

export async function saveState(context) {
  try {
    const target = context._statePath || config.storageState;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await context.storageState({ path: target });
  } catch {
    /* best effort */
  }
}

const CHALLENGE_TITLES = ['Just a moment', 'Un momento', 'Un instant', 'Bitte warten'];

/**
 * Note: a successfully served Workana page *also* contains a
 * `/cdn-cgi/challenge-platform/` script tag, so its presence proves nothing. Only
 * the interstitial's own title and challenge markup are reliable signals.
 */
export async function isChallenge(page) {
  const title = await page.title().catch(() => '');
  if (CHALLENGE_TITLES.some((m) => title.includes(m))) return true;
  return page
    .evaluate(() => Boolean(document.querySelector('#challenge-running, #challenge-form, #cf-challenge-running')))
    .catch(() => false);
}

/** True when Cloudflare rendered its "verification failed" state. */
async function challengeErrored(page) {
  return page
    .evaluate(() => {
      const el = document.querySelector('#challenge-error-text, #challenge-error-title');
      return Boolean(el && el.offsetParent !== null);
    })
    .catch(() => false);
}

/** Clicks the Turnstile checkbox when the challenge renders an interactive one. */
async function nudgeTurnstile(page) {
  for (const frame of page.frames()) {
    if (!/challenges\.cloudflare\.com/.test(frame.url())) continue;
    const box = await frame.$('input[type="checkbox"], .cb-lb input, #challenge-stage');
    if (box) {
      await box.click({ timeout: 3000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function waitForClear(page, deadline) {
  while (Date.now() < deadline) {
    if (!(await isChallenge(page))) return true;
    if (await challengeErrored(page)) return false;
    await nudgeTurnstile(page);
    await sleep(1200);
  }
  return !(await isChallenge(page));
}

/**
 * Navigates and, if Cloudflare interposes, waits for the challenge to resolve.
 * A failed challenge is retried a couple of times with backoff, since the managed
 * challenge is probabilistic rather than a hard block.
 */
export async function gotoWithChallenge(page, url, { waitFor, referer, attempts = 3 } = {}) {
  let response = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', referer }).catch((e) => {
      if (attempt === attempts) throw e;
      return null;
    });

    if (response !== null && !(await isChallenge(page))) break;

    const cleared = await waitForClear(page, Date.now() + config.challengeTimeoutMs);
    if (cleared) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      break;
    }

    if (attempt === attempts) throw new CloudflareChallengeError(url);
    await sleep(4000 * attempt + Math.random() * 3000);
  }

  if (waitFor) await page.waitForSelector(waitFor, { timeout: 20000 }).catch(() => {});
  return response;
}

export class CloudflareChallengeError extends Error {
  constructor(url) {
    super(
      `Cloudflare did not clear its challenge for ${url}. ` +
        `Try HEADLESS=false (a headed browser passes far more reliably), slow the scrape down ` +
        `with MIN_DELAY_MS/MAX_DELAY_MS, or run from the same network the cookies were exported from.`,
    );
    this.name = 'CloudflareChallengeError';
    this.code = 'CF_CHALLENGE';
  }
}

/** Dumps HTML + screenshot for debugging selector drift. */
export async function dump(page, name) {
  fs.mkdirSync(config.debugDir, { recursive: true });
  const base = path.join(config.debugDir, name);
  await fs.promises.writeFile(`${base}.html`, await page.content(), 'utf8');
  await page.screenshot({ path: `${base}.png`, fullPage: false }).catch(() => {});
  return base;
}
