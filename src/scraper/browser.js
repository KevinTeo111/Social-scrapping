import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { loadWorkanaCookies } from '../cookies.js';
import { saveBrowserState, loadBrowserState, getScrapeLocale } from '../auth.js';
import { acceptLanguage, isValidTimezone, isSupportedLocale } from '../locale.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pause between navigations so we don't hammer the site.
 *
 * `nextPage` is how deep into a list walk the *next* request will be, and past
 * a point it buys a much longer pause. That point is measured, not guessed: of
 * every challenge this instance has recorded mid-walk, none landed before page
 * 9 and they cluster at 9-18, which is the signature of a per-session request
 * budget rather than anything about the account. Easing off there is what lets
 * a walk reach the end -- and a walk that finishes collects pages 14 to 36,
 * which a walk challenged at 13 loses entirely. Slower per page, more pages.
 */
export function jitter(nextPage = 0) {
  const { minDelayMs, maxDelayMs, slowFromPage, slowMinDelayMs, slowMaxDelayMs } = config;
  const deep = slowFromPage > 0 && nextPage >= slowFromPage;
  const min = deep ? slowMinDelayMs : minDelayMs;
  const max = deep ? slowMaxDelayMs : maxDelayMs;
  return sleep(min + Math.random() * Math.max(0, max - min));
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

/**
 * Where a member's browser state lives when there is no account to hang it on —
 * the CLI run from a cookie file. Anything belonging to a registered member goes
 * to their row instead, so it survives a redeploy that erases the filesystem.
 */
export function statePathFor(userId) {
  return userId ? path.join(path.dirname(config.storageState), `state-user-${userId}.json`) : config.storageState;
}

/**
 * The cookie export's `cf_clearance` was minted for the browser and IP it came
 * from, so it is worthless here. When our own browser clears a challenge,
 * Cloudflare issues a clearance bound to *this* machine -- keeping that between
 * runs is what stops every run from having to fight the challenge again.
 */
async function savedClearance(userId) {
  const state = userId ? await loadBrowserState(userId) : readStateFile(config.storageState);
  return (state?.cookies || []).filter((c) => c.name === 'cf_clearance');
}

function readStateFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `cookies` lets a caller drive the browser as a particular registered user;
 * omitting it falls back to the on-disk export, which is what the CLI uses.
 */
/*
 * Launching, with a fallback.
 *
 * `channel: 'chromium'` asks for the full browser rather than
 * chromium-headless-shell, which Cloudflare fingerprints readily — that choice
 * is what took a run from four challenges to none, so it is tried first.
 *
 * It depends on that build being present, though, and an image can end up with
 * only the headless shell: a cached or partial `playwright install` leaves the
 * directory the channel points at missing, and the launch fails with a bare
 * "spawn ... ENOENT" naming a path nobody recognises. Scraping with the shell is
 * worse than scraping with the full browser and far better than not scraping, so
 * the shell is used rather than failing the run.
 */
let launchNote = null;

async function launchBrowser(headless) {
  const base = { headless, args: LAUNCH_ARGS };
  try {
    return await chromium.launch({ ...base, channel: 'chromium' });
  } catch (err) {
    if (!/ENOENT|Executable doesn't exist|Failed to launch/i.test(err.message)) throw err;

    try {
      const browser = await chromium.launch(base);
      if (launchNote !== 'shell') {
        launchNote = 'shell';
        console.warn(
          [
            '[browser] The full Chromium build is missing; using the headless shell.',
            '          Cloudflare challenges that one far more often. Fix the image with:',
            '            npx playwright install chromium',
            `          (PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH || "default"})`,
          ].join(String.fromCharCode(10)),
        );
      }
      return browser;
    } catch (second) {
      throw new Error(
        `No Chromium could be launched. Playwright looked under ` +
          `${process.env.PLAYWRIGHT_BROWSERS_PATH || 'its default browsers path'} and found nothing usable. ` +
          `Run "npx playwright install chromium" where the app runs. (${second.message})`,
      );
    }
  }
}

export async function launchContext({
  headless = config.headless,
  cookies = null,
  userId = null,
  proxy = null,
  timezone = null,
  locale = null,
} = {}) {
  // A member's own exit beats the instance-wide default.
  const egress = proxy || config.proxy;
  const browser = await launchBrowser(headless);

  /*
   * The zone and language this identity presents. A member scraping through a
   * proxy in São Paulo should look like a browser in São Paulo, not like every
   * other identity on this instance; the instance default is only for traffic
   * that really does leave from this machine. See src/locale.js.
   *
   * Resolved from the account here rather than passed in, so that every entry
   * point -- a scrape, a login check, a single job's insights, the scripts --
   * gets it without each one having to remember to look it up.
   */
  const own = timezone || locale ? null : userId ? await getScrapeLocale(userId) : null;
  const zone = isValidTimezone(timezone) ? timezone : isValidTimezone(own?.timezone) ? own.timezone : config.timezone;
  const tag = isSupportedLocale(locale) ? locale : isSupportedLocale(own?.locale) ? own.locale : config.locale;

  const context = await browser.newContext({
    userAgent: config.userAgent,
    locale: tag,
    timezoneId: zone,
    viewport: { width: 1600, height: 950 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      // Has to agree with `locale` above: Workana picks its translation from
      // this header, and the two disagreeing was half of the original tell.
      'Accept-Language': acceptLanguage(tag),
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
  const clearance = await savedClearance(userId);
  if (clearance.length) await context.addCookies(clearance).catch(() => {});

  context.setDefaultNavigationTimeout(config.navTimeoutMs);
  context.setDefaultTimeout(config.navTimeoutMs);

  context._userId = userId;
  /*
   * The zone this context renders in, carried on the context because Workana
   * prints its clocks -- "Last login" above all -- as a bare wall clock with no
   * zone on it. Reading one back requires knowing which zone drew it, and this
   * is the only place that knows. Rides on the context the way _userId does, so
   * every page opened from it can convert without being handed the zone again.
   */
  context._timezone = zone;
  return { browser, context, timezone: zone, locale: tag };
}

/**
 * Keeps whatever clearance this run earned. For a registered member that goes to
 * their row, encrypted alongside their cookies — it is a live credential, and it
 * has to outlive a container that is rebuilt on every deploy. Only a run with no
 * account behind it still falls back to a file.
 */
export async function saveState(context) {
  try {
    const state = await context.storageState();
    if (context._userId) {
      await saveBrowserState(context._userId, state);
      return;
    }
    fs.mkdirSync(path.dirname(config.storageState), { recursive: true });
    fs.writeFileSync(config.storageState, JSON.stringify(state), 'utf8');
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

/**
 * True when the tab itself died rather than the navigation failing. Chromium
 * reports this as "Target crashed", and in a container it almost always means
 * the renderer was killed for memory — several lanes each hold a full tab open,
 * and a Turnstile challenge is one of the heavier things one can be showing.
 */
/**
 * Opens a tab, and says what it means when that fails.
 *
 * A browser short of memory dies at the moment a page is created, so this is
 * where a container that is too small announces itself -- as
 * "browserContext.newPage: Target crashed", which names no cause and suggests
 * no remedy. Every tab in a run comes through here so that it does.
 */
export async function newPage(context) {
  try {
    return await context.newPage();
  } catch (err) {
    if (isTargetCrash(err)) throw new BrowserCrashError('a new tab', err);
    throw err;
  }
}

export function isTargetCrash(err) {
  return /target (crashed|closed)|browser has been closed/i.test(err?.message || '');
}

/**
 * Clicks the Turnstile checkbox when the challenge renders an interactive one.
 *
 * Everything here is best-effort: it runs against a page that is, by definition,
 * in a strange state, and a frame can be torn down between listing it and
 * querying it. A failure to nudge is not a failure to clear.
 */
async function nudgeTurnstile(page) {
  try {
    for (const frame of page.frames()) {
      if (!/challenges\.cloudflare\.com/.test(frame.url())) continue;
      const box = await frame.$('input[type="checkbox"], .cb-lb input, #challenge-stage');
      if (box) {
        await box.click({ timeout: 3000 }).catch(() => {});
        return true;
      }
    }
  } catch (err) {
    // A crashed tab cannot be nudged back to life; let the caller notice.
    if (isTargetCrash(err)) throw err;
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
      // Retrying a crashed tab only produces the same error more slowly.
      if (isTargetCrash(e)) throw new BrowserCrashError(url, e);
      if (attempt === attempts) throw e;
      return null;
    });

    if (response !== null && !(await isChallenge(page))) break;

    const cleared = await waitForClear(page, Date.now() + config.challengeTimeoutMs).catch((e) => {
      if (isTargetCrash(e)) throw new BrowserCrashError(url, e);
      throw e;
    });
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

/**
 * The tab died mid-navigation. Distinct from a challenge: nothing about the
 * request was refused, the browser simply ran out of room to render it.
 */
export class BrowserCrashError extends Error {
  constructor(url, cause) {
    super(
      `Chromium crashed while loading ${url} (${cause?.message || 'target crashed'}). ` +
        `This is usually memory: each detail and insight lane holds a browser tab open, so ` +
        `lower DETAIL_CONCURRENCY / INSIGHT_CONCURRENCY on a small container, or give the ` +
        `service more RAM.`,
    );
    this.name = 'BrowserCrashError';
    this.code = 'BROWSER_CRASH';
    this.cause = cause;
  }
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
