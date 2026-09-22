import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, '..');

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value, fallback) =>
  value === undefined ? fallback : /^(1|true|yes|on)$/i.test(String(value));

/**
 * Memory this process is actually allowed, in bytes.
 *
 * `os.totalmem()` reports the *host's* RAM even inside a container, so on a
 * small Railway instance it cheerfully claims many gigabytes that the cgroup
 * will not let us touch. The cgroup limit is the real number; v2 exposes it as
 * `memory.max` (the string "max" when uncapped) and v1 as `limit_in_bytes`
 * (a sentinel near 2^63 when uncapped).
 */
function memoryLimitBytes() {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw === 'max') continue;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n < Number.MAX_SAFE_INTEGER / 2) return n;
    } catch {
      /* not a cgroup, or not readable — try the next one */
    }
  }
  return os.totalmem();
}

/**
 * How many browser tabs a scrape may hold open at once.
 *
 * Each lane is a full Chromium tab, and a tab showing a Cloudflare Turnstile
 * challenge is one of the heavier things it can render — which is how a run on a
 * small container ends as "Target crashed", the renderer killed for memory.
 * Deriving this from the real limit means a workstation still gets the fast path
 * without a hosted deployment needing to be told to slow down.
 *
 * The detail and insight phases run one after the other, never together, so this
 * is the peak rather than a total to be shared out.
 */
const MB = 1024 * 1024;

/** Split out from the lookup so the arithmetic can be tested against fixed sizes. */
export function lanesForMemory(bytes) {
  const budget = bytes - 500 * MB; // the browser process itself, plus Node
  return Math.max(1, Math.min(4, Math.floor(budget / (450 * MB))));
}

const defaultLanes = () => lanesForMemory(memoryLimitBytes());

export const config = {
  rootDir,
  cookieFile: process.env.COOKIE_FILE || path.join(rootDir, 'Hiyashi.json'),
  /*
   * Set DATABASE_URL and everything — the corpus, every account, their encrypted
   * Workana sessions and their browser state — lives in Postgres, which is what
   * makes a redeploy survivable on a platform that erases the filesystem.
   * Railway injects this automatically once a Postgres service is attached.
   * Without it the SQLite file below is used, so a workstation needs no server.
   */
  databaseUrl: process.env.DATABASE_URL || '',
  dbPoolSize: num(process.env.DB_POOL_SIZE, 8),
  /** Client-side limit on any one query; see the pool in src/sql.js. */
  dbQueryTimeoutMs: num(process.env.DB_QUERY_TIMEOUT_MS, 30_000),
  dbFile: process.env.DB_FILE || path.join(rootDir, 'data', 'workana.db'),
  storageState: path.join(rootDir, 'data', 'storage-state.json'),
  debugDir: path.join(rootDir, 'data', 'debug'),

  port: num(process.env.PORT, 4300),
  host: process.env.HOST || '127.0.0.1',

  /**
   * Multi-user access. The first account created always becomes the owner, even
   * when registration is closed, so a fresh install cannot lock itself out.
   * `REGISTRATION_CODE` gates sign-ups without closing them entirely.
   */
  allowRegistration: bool(process.env.ALLOW_REGISTRATION, true),
  registrationCode: process.env.REGISTRATION_CODE || '',

  /**
   * Virtual-domain support.
   *
   * `trustProxy` makes Express believe `X-Forwarded-Proto`/`X-Forwarded-For`, which
   * is how the app learns a request arrived over HTTPS when a reverse proxy
   * terminated the TLS. Enable it *only* behind a proxy you control: if the app is
   * directly reachable, any client can forge those headers and claim to be secure.
   *
   * `allowedHosts` is a Host-header allowlist. Serving on a hostname rather than
   * an IP invites DNS rebinding, where an attacker's domain resolves to this
   * server's address so their page can talk to it; refusing unexpected Host
   * values shuts that down. Empty means "accept anything", which is fine while
   * bound to loopback and flagged at startup when it is not.
   */
  trustProxy: bool(process.env.TRUST_PROXY, false),
  allowedHosts: (process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),

  baseUrl: 'https://www.workana.com',

  /**
   * Project language filter. This one matters more than it looks: omit it and
   * Workana applies the account's own default (`language=en` here, from the
   * locale cookie), which silently hides every Spanish and Portuguese project --
   * the bulk of the site, since Workana is Latin-American. A comma-separated
   * list is accepted and is the only way to ask for all of them.
   */
  language: process.env.WORKANA_LANGUAGE ?? 'en,pt,es',

  /**
   * Category to crawl. Empty string crawls every category.
   * Slugs: it-programming, design-multimedia, writing-translation, sales-marketing,
   *        admin-support, legal, finance-management, engineering-manufacturing.
   */
  category: process.env.WORKANA_CATEGORY ?? 'it-programming',

  /**
   * Workana is fronted by Cloudflare. A plain HTTP client is served the
   * "Just a moment..." interstitial no matter which cookies it presents, because
   * `cf_clearance` is bound to the originating IP *and* TLS fingerprint. Driving a
   * real Chromium is therefore not a convenience here, it is the only thing that works.
   *
   * `headless: false` is markedly more reliable against the managed challenge; the
   * scraper falls back to it automatically when a headless run is challenged.
   */
  headless: bool(process.env.HEADLESS, true),
  /** Matches the browser the cookies were exported from as closely as we can. */
  userAgent:
    process.env.WORKANA_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  locale: process.env.WORKANA_LOCALE || 'en-US',
  timezone: process.env.WORKANA_TZ || 'Asia/Tokyo',
  proxy: process.env.WORKANA_PROXY || '',

  /**
   * Safety cap only, not an expectation. Workana's pager shows a sliding window
   * of five page numbers and never reveals the last page, so the crawler walks
   * forward until the results actually run out rather than trusting the widget.
   */
  maxListPages: num(process.env.MAX_LIST_PAGES, 250),
  /**
   * An empty list page is ambiguous: it can mean "past the end", or it can mean
   * Workana soft-throttled this request. Retry before believing it.
   */
  emptyPageRetries: num(process.env.EMPTY_PAGE_RETRIES, 2),

  /*
   * Workana prints "Last login" as a wall clock with no zone, and it is not the
   * browser's: driving the context as Asia/Tokyo still produced timestamps two
   * hours ahead of UTC. Measuring (login - when we read it) across 1312 clients
   * put every gap just under 2.00 hours and none above, which is the signature
   * of a fixed UTC+2 rendering. Re-derive the same way if Workana moves it --
   * scripts/backfill-last-login.mjs prints the estimate it measures.
   */
  workanaClockOffsetHours: num(process.env.WORKANA_CLOCK_OFFSET_HOURS, 2),

  /*
   * Scrape pacing, tuned for throughput: a run should finish in minutes, not
   * tens of minutes, so the board is current rather than perpetually catching
   * up. Both phases fetch in parallel lanes and pause only briefly between
   * pages.
   *
   * The cost is exposure. Cloudflare's managed challenge scores request rate and
   * concurrency, and if it starts interposing, a run stops early and keeps what
   * it has (see the CF_CHALLENGE handling in scrape.js) — so the failure mode is
   * a short run, not corrupt data. Dial MIN_DELAY_MS/MAX_DELAY_MS up and the
   * concurrencies down if challenges start showing up in the status badge.
   *
   * The lane counts default to what this machine's memory can hold rather than
   * to a fixed number, so a workstation runs wide and a small container runs
   * narrow without either being configured. An explicit value still wins.
   */
  memoryLimitBytes: memoryLimitBytes(),
  detailConcurrency: num(process.env.DETAIL_CONCURRENCY, defaultLanes()),
  detailBudget: num(process.env.DETAIL_BUDGET, 100),
  /** Project Insights pages per run — these supply the "in contact" counts. */
  insightBudget: num(process.env.INSIGHT_BUDGET, 60),
  insightConcurrency: num(process.env.INSIGHT_CONCURRENCY, defaultLanes()),
  /**
   * How long to wait for Vue to reconcile the contender badges before reading
   * them. This dominates the insights phase: a project where the reconcile never
   * visibly happens burns the whole budget. Lowering it speeds runs up at the
   * risk of reading badges in their server-rendered default state — which is
   * what made every freelancer look "New" once. See fetchInsightsOn().
   */
  insightHydrateMs: num(process.env.INSIGHT_HYDRATE_MS, 15000),
  minDelayMs: num(process.env.MIN_DELAY_MS, 500),
  maxDelayMs: num(process.env.MAX_DELAY_MS, 1200),
  navTimeoutMs: num(process.env.NAV_TIMEOUT_MS, 60000),
  challengeTimeoutMs: num(process.env.CHALLENGE_TIMEOUT_MS, 45000),

  /** Background refresh loop in the server. 0 disables it. */
  autoScrapeMinutes: num(process.env.AUTO_SCRAPE_MINUTES, 10),
  /**
   * The quick check for new postings: the newest SWEEP_PAGES list pages, the
   * details of any job on them not seen before, and nothing else. New postings
   * always land on page 1, so this is what decides how soon one reaches the
   * board -- the full refresh above, with its backlog work, is too slow and too
   * heavy to run this often. Timed from when the previous check *started*, so
   * the interval is the real gap. 0 disables it; fractions are allowed.
   */
  sweepMinutes: num(process.env.SWEEP_MINUTES, 2),
  sweepPages: num(process.env.SWEEP_PAGES, 1),
  /**
   * Pages the *background* refresh walks. New postings land on page 1, so a
   * shallow sweep catches them; re-walking all 40 pages every ten minutes would
   * only burn requests and invite throttling. Deep crawls are a deliberate act:
   *   .\start.ps1 scrape
   */
  refreshPages: num(process.env.REFRESH_PAGES, 5),
  /**
   * Pages the *Refresh button* walks. A button press should come back in
   * seconds with what is new, so it reads the newest pages and enriches only
   * the jobs on them; the scheduled refresh and Full crawl clear the backlog.
   */
  manualRefreshPages: num(process.env.MANUAL_REFRESH_PAGES, 2),
};
