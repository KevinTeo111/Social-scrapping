import { config } from '../config.js';
import {
  launchContext,
  gotoWithChallenge,
  jitter,
  sleep,
  saveState,
  CloudflareChallengeError,
  dump,
} from './browser.js';
import { pageExtractList, pageExtractDetail, pageExtractInsights, normaliseListJob, normaliseDetail } from './parse.js';
import {
  db,
  upsertJob,
  upsertClient,
  upsertUserJob,
  saveClientReviews,
  saveInsights,
  startRun,
  finishRun,
} from '../db.js';

/**
 * Only one scrape at a time, across all accounts. Several members each driving
 * their own Chromium at Workana simultaneously is both heavy locally and a good
 * way to get the whole instance rate-limited, so runs queue instead.
 */
let running = null;
let runningUserId = null;
// Named `pending` rather than `queue` because enrichDetails() has its own local
// work queue; two things called `queue` in one module is a trap.
const pending = [];

export const isScraping = () => Boolean(running);
export const scrapingUserId = () => runningUserId;
export const queueLength = () => pending.length;

/**
 * A run walks list pages, then detail pages, then insight pages, and the whole
 * thing takes minutes. Without this the UI can only say "scraping", which is
 * indistinguishable from a hang; publishing the current phase lets it show that
 * work is actually advancing.
 */
let progress = null;
export const currentProgress = () => progress;

export function scrape(options = {}) {
  const task = () => {
    runningUserId = options.userId ?? null;
    return runScrape(options);
  };

  if (!running) {
    running = task().finally(next);
    return running;
  }

  // Already busy: line up behind whatever is in flight.
  return new Promise((resolve, reject) => {
    pending.push({ task, resolve, reject });
  });
}

function next() {
  running = null;
  runningUserId = null;
  const item = pending.shift();
  if (!item) return;
  running = item
    .task()
    .then(item.resolve, item.reject)
    .finally(next);
}

function listUrl({ page = 1, language, category, query } = {}) {
  const url = new URL('/jobs', config.baseUrl);
  if (language) url.searchParams.set('language', language);
  if (category) url.searchParams.set('category', category);
  if (query) url.searchParams.set('query', query);
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

async function runScrape({
  pages = config.maxListPages,
  language = config.language,
  category = config.category,
  query = '',
  withDetails = true,
  detailBudget = config.detailBudget,
  insightBudget = config.insightBudget,
  userId = null,
  cookies = null,
  proxy = null,
  onProgress: report = () => {},
} = {}) {
  const runId = startRun(userId);
  const stats = { pages: 0, seen: 0, inserted: 0, updated: 0, details: 0, insights: 0, ok: false, error: null };
  const startedAt = Date.now();
  let browser;
  let context;

  // Every progress event is mirrored into the module-level snapshot that
  // /api/status reads, then passed on to whatever the caller wanted to do.
  const onProgress = (info) => {
    progress = { ...info, userId, startedAt, pagesTarget: pages };
    report(info);
  };
  onProgress({ phase: 'starting' });

  try {
    ({ browser, context } = await launchContext({ cookies, userId, proxy }));
    const page = await context.newPage();

    /*
     * Walk the result set forward one page at a time.
     *
     * Workana's pager renders a sliding five-number window -- open page 5 and it
     * offers 3..7, open page 6 and it offers 4..8 -- so it never names the last
     * page and there is no total to read. Parsing that widget can only ever
     * under-count, so it is ignored entirely: we step forward until the results
     * genuinely run out, and `pages` is a safety cap rather than a target.
     *
     * "Ran out" needs care, because an empty page is ambiguous. It means either
     * the end of the list, or that Workana soft-throttled this particular
     * request -- which is exactly what made an earlier version stop at page 4 on
     * a feed that actually went deeper. So an empty page is retried before it is
     * believed, and a page whose jobs were all seen already means Workana clamped
     * an out-of-range page number back onto an earlier one.
     */
    const seenSlugs = new Set();

    for (let p = 1; p <= pages; p++) {
      const url = listUrl({ page: p, language, category, query });
      let usable = null;

      for (let attempt = 0; attempt <= config.emptyPageRetries; attempt++) {
        if (attempt > 0) {
          onProgress({ phase: 'list-retry', page: p, attempt });
          await sleep(4000 * attempt + Math.random() * 2000);
        }
        onProgress({ phase: 'list', page: p, url });

        let cards;
        try {
          // Arriving at page N with page N-1 as the referer looks like ordinary paging.
          await gotoWithChallenge(page, url, {
            waitFor: '.project-item',
            referer: p > 1 ? listUrl({ page: p - 1, language, category, query }) : undefined,
          });
          cards = await page.evaluate(pageExtractList);
        } catch (err) {
          if (err instanceof CloudflareChallengeError || err.code === 'CF_CHALLENGE') {
            await dump(page, `challenge-page-${p}`).catch(() => {});
            stats.error = `Cloudflare challenge on page ${p} (stopped early, kept ${stats.seen} jobs)`;
            cards = null;
            break;
          }
          throw err;
        }

        const found = cards.filter((c) => c.slug && c.title);
        if (found.length > 0) {
          usable = found;
          break;
        }
      }

      // Challenged, or empty on every attempt — treat as the end of the list.
      if (!usable) {
        stats.endedAt = p;
        break;
      }

      const fresh = usable.filter((c) => !seenSlugs.has(c.slug));
      if (fresh.length === 0) {
        // Every job here was already collected this run: Workana clamped an
        // out-of-range page back onto one we have seen. That is the real end.
        stats.endedAt = p;
        stats.clamped = true;
        break;
      }

      stats.pages = p;
      const now = Date.now();
      for (const card of usable) {
        seenSlugs.add(card.slug);
        const job = normaliseListJob(card, now);
        if (job.client) upsertClient(job.client);
        const result = upsertJob(job);

        // "I bid on this" and "the client contacted me" are true of the account
        // that fetched the page, not of the posting, so they belong to the user.
        if (userId && (job.hasOwnBid || job.wasContacted)) {
          upsertUserJob(userId, job.slug, {
            hasOwnBid: job.hasOwnBid,
            wasContacted: job.wasContacted,
          });
        }

        stats[result] += 1;
        stats.seen += 1;
      }
      onProgress({ phase: 'list-done', page: p, count: usable.length, fresh: fresh.length, ...stats });

      if (p < pages) await jitter();
    }

    if (withDetails && detailBudget > 0) {
      stats.details = await enrichDetails(context, { budget: detailBudget, onProgress, userId });
    }

    if (insightBudget > 0) {
      stats.insights = await enrichInsights(context, { budget: insightBudget, onProgress, userId });
    }

    stats.ok = true;
  } catch (err) {
    stats.ok = false;
    stats.error = err.message;
    throw err;
  } finally {
    // Keep any cf_clearance this run earned so the next one starts warm.
    if (context) await saveState(context);
    finishRun(runId, stats);
    progress = null;
    if (browser) await browser.close().catch(() => {});
  }

  return stats;
}

/**
 * Fills in the fields only the detail page carries (full description, category,
 * duration, project size, client review history). Newest-first, and jobs whose
 * details we already have are skipped unless they look stale.
 */
async function enrichDetails(context, { budget, onProgress = () => {}, userId = null }) {
  const targets = db
    .prepare(
      `SELECT slug FROM jobs
        WHERE detail_fetched_at IS NULL
        ORDER BY COALESCE(published_approx_at, published_at, first_seen_at) DESC
        LIMIT ?`,
    )
    .all(budget)
    .map((r) => r.slug);

  if (targets.length === 0) return 0;

  const lanes = Math.max(1, Math.min(config.detailConcurrency, 4));
  const queue = [...targets];
  let done = 0;

  await Promise.all(
    Array.from({ length: lanes }, async () => {
      const page = await context.newPage();
      try {
        while (queue.length) {
          const slug = queue.shift();
          try {
            await fetchDetail(page, slug, userId);
            done += 1;
            onProgress({ phase: 'detail', slug, done, total: targets.length });
          } catch (err) {
            if (err instanceof CloudflareChallengeError || err.code === 'CF_CHALLENGE') {
              queue.length = 0; // back off entirely, try again next run
              break;
            }
            // A single unparseable job should not sink the run.
          }
          await jitter();
        }
      } finally {
        await page.close().catch(() => {});
      }
    }),
  );

  return done;
}

export async function fetchDetail(page, slug, userId = null) {
  const url = `${config.baseUrl}/job/${slug}`;
  await gotoWithChallenge(page, url, { waitFor: '.project-view-v3' });

  const raw = await page.evaluate(pageExtractDetail);
  const detail = normaliseDetail(raw);

  if (detail.client?.id) upsertClient(detail.client);

  upsertJob({
    slug,
    url,
    title: detail.title || slug,
    detailFetchedAt: new Date().toISOString(),
    ...detail,
    raw: { detail: raw },
  });

  if (detail.client?.id) saveClientReviews(detail.client.id, slug, detail.reviews);

  // The bid button reads "Improve proposal" only for the account that bid.
  if (userId && detail.hasOwnBid) upsertUserJob(userId, slug, { hasOwnBid: true });

  return detail;
}

/**
 * Scrapes the Project Insights tab for one job using an existing page.
 *
 * The wait below is load-bearing. Workana server-renders the contender badges in
 * their *default* state -- "New" visible, the rest hidden -- and only once Vue
 * hydrates does it hide "New" and reveal the badges that actually apply. Reading
 * the DOM as soon as a `.contender-card` exists therefore marks every freelancer
 * as New, HEROes with 179 completed projects included. Waiting until at least one
 * badge carries an inline `display: none` proves the reconcile has run.
 */
export async function fetchInsightsOn(page, slug, userId = null) {
  await gotoWithChallenge(page, `${config.baseUrl}/job/insight/${slug}`, {
    waitFor: '.contender-card',
  });

  await page
    .waitForFunction(
      () => {
        const badges = document.querySelectorAll('.contender-card .badge');
        return badges.length > 0 && [...badges].some((b) => b.style.display === 'none');
      },
      { timeout: 15000 },
    )
    .catch(() => {});
  await sleep(400);

  const raw = await page.evaluate(pageExtractInsights);
  saveInsights(slug, raw);

  // "Your budget" is what *this* account proposed — not a property of the job.
  if (userId && raw.ownBudget) upsertUserJob(userId, slug, { ownBudget: raw.ownBudget, hasOwnBid: true });

  return raw;
}

/** On-demand single-job variant, for the drawer's refresh button. */
export async function fetchInsights(slug, { userId = null, cookies = null, proxy = null } = {}) {
  const { browser, context } = await launchContext({ cookies, userId, proxy });
  try {
    return await fetchInsightsOn(await context.newPage(), slug, userId);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Insights cost one page load per job, so they are fetched on a budget:
 * jobs that have bids but no contender data yet, newest first. Jobs with zero
 * bids are skipped -- the page would be empty.
 */
async function enrichInsights(context, { budget, onProgress = () => {}, userId = null }) {
  const targets = db
    .prepare(
      `SELECT slug FROM jobs
        WHERE insights_fetched_at IS NULL AND COALESCE(bids, 0) > 0
        ORDER BY COALESCE(published_approx_at, published_at, first_seen_at) DESC
        LIMIT ?`,
    )
    .all(budget)
    .map((r) => r.slug);

  if (!targets.length) return 0;

  const page = await context.newPage();
  let done = 0;
  try {
    for (const slug of targets) {
      try {
        await fetchInsightsOn(page, slug, userId);
        done += 1;
        onProgress({ phase: 'insights', slug, done, total: targets.length });
      } catch (err) {
        if (err.code === 'CF_CHALLENGE') break;
        // Some jobs have no insights page (closed, or not visible to us).
        db.prepare('UPDATE jobs SET insights_fetched_at = ? WHERE slug = ?').run(
          new Date().toISOString(),
          slug,
        );
      }
      await jitter();
    }
  } finally {
    await page.close().catch(() => {});
  }
  return done;
}

/** Confirms a set of cookies still authenticates, and whose account they are. */
export async function checkLogin({ cookies = null, userId = null, proxy = null } = {}) {
  const { browser, context } = await launchContext({ cookies, userId, proxy });
  try {
    const page = await context.newPage();
    // The list is rendered client-side, so wait for a card before counting.
    await gotoWithChallenge(page, `${config.baseUrl}/jobs?language=${config.language}`, {
      waitFor: '.project-item',
    });
    return await page.evaluate(() => ({
      loggedIn: Boolean(document.querySelector('a[href*="/logout"]')),
      user: document.querySelector('.nav__userthumbnail img')?.getAttribute('alt') || null,
      cards: document.querySelectorAll('.project-item').length,
      title: document.title,
    }));
  } finally {
    await browser.close().catch(() => {});
  }
}
