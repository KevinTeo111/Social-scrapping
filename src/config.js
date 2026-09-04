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

export const config = {
  rootDir,
  cookieFile: process.env.COOKIE_FILE || path.join(rootDir, 'Hiyashi.json'),
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

  /** Scrape pacing — deliberately gentle, this is one user's own account. */
  detailConcurrency: num(process.env.DETAIL_CONCURRENCY, 2),
  detailBudget: num(process.env.DETAIL_BUDGET, 100),
  /** Project Insights pages per run — these supply the "in contact" counts. */
  insightBudget: num(process.env.INSIGHT_BUDGET, 60),
  minDelayMs: num(process.env.MIN_DELAY_MS, 1200),
  maxDelayMs: num(process.env.MAX_DELAY_MS, 2600),
  navTimeoutMs: num(process.env.NAV_TIMEOUT_MS, 60000),
  challengeTimeoutMs: num(process.env.CHALLENGE_TIMEOUT_MS, 45000),

  /** Background refresh loop in the server. 0 disables it. */
  autoScrapeMinutes: num(process.env.AUTO_SCRAPE_MINUTES, 10),
  /**
   * Pages the *background* refresh walks. New postings land on page 1, so a
   * shallow sweep catches them; re-walking all 40 pages every ten minutes would
   * only burn requests and invite throttling. Deep crawls are a deliberate act:
   *   .\start.ps1 scrape
   */
  refreshPages: num(process.env.REFRESH_PAGES, 5),
};
