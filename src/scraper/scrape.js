import { config } from '../config.js';
import {
  launchContext,
  gotoWithChallenge,
  jitter,
  sleep,
  saveState,
  CloudflareChallengeError,
  isTargetCrash,
  dump,
} from './browser.js';
import { pageExtractList, pageExtractDetail, pageExtractInsights, normaliseListJob, normaliseDetail } from './parse.js';
import {
  all,
  run as dbRun,
  upsertJob,
  upsertClient,
  upsertUserJob,
  saveClientReviews,
  saveInsights,
  startRun,
  finishRun,
} from '../db.js';
import { findUser } from '../auth.js';

/**
 * Only one scrape at a time, across all accounts. Several members each driving
 * their own Chromium at Workana simultaneously is both heavy locally and a good
 * way to get the whole instance rate-limited, so runs queue instead.
 *
 * At most one waiting run per member, though. Every run walks the same list
 * pages, so a queue of them is not more work done, it is the same work repeated
 * while everyone waits longer — which is what "3 queued" behind another member's
 * run actually meant. A second request from a member who is already running or
 * already waiting joins the one they have instead of adding another.
 */
let running = null;
let runningUserId = null;
let runningPages = 0;
// Named `pending` rather than `queue` because enrichDetails() has its own local
// work queue; two things called `queue` in one module is a trap.
const pending = [];

export const isScraping = () => Boolean(running);
export const scrapingUserId = () => runningUserId;
export const queueLength = () => pending.length;
export const isQueued = (userId) => pending.some((p) => p.userId === userId);

/** Where a member stands right now: running their own, waiting, or neither. */
export function runStateFor(userId) {
  if (running && runningUserId === userId) return 'running';
  if (isQueued(userId)) return 'queued';
  return null;
}

const pagesOf = (options) => Number(options?.pages) || config.refreshPages;

/*
 * Stopping a run.
 *
 * A run is minutes of network waits, so a flag alone would leave it sitting on
 * whatever navigation it had already started -- up to a full NAV_TIMEOUT_MS
 * before it noticed. Closing the browser is what makes it stop now: every
 * pending Playwright call rejects immediately, and the enrichment lanes already
 * treat a dead tab as "stop, keep what we have". The flag then prevents the
 * loops from opening anything new.
 *
 * Nothing is rolled back. Every job read before the stop was upserted as it was
 * read, so cancelling costs the remainder of the run, not its results.
 */
let cancelling = false;
let activeBrowser = null;

export const isCancelling = () => cancelling && Boolean(running);

/**
 * A run walks list pages, then detail pages, then insight pages, and the whole
 * thing takes minutes. Without this the UI can only say "scraping", which is
 * indistinguishable from a hang; publishing the current phase lets it show that
 * work is actually advancing.
 */
let progress = null;
export const currentProgress = () => progress;

export function scrape(options = {}) {
  const userId = options.userId ?? null;
  const pages = pagesOf(options);

  if (!running) {
    runningUserId = userId;
    runningPages = pages;
    running = runScrape(options).finally(next);
    return running;
  }

  const waiting = pending.find((p) => p.userId === userId);
  if (waiting) {
    /*
     * This member is already in line. A deeper request replaces the shallower
     * one it would have superseded — otherwise clicking Refresh and then Full
     * crawl would silently discard the full crawl.
     */
    if (pages > pagesOf(waiting.options)) waiting.options = options;
    return waiting.promise;
  }

  // Their own run is in flight: only queue behind it for something deeper.
  if (runningUserId === userId && pages <= runningPages) return running;

  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pending.push({ userId, options, promise, resolve, reject });
  return promise;
}

/**
 * Stops the run in flight and empties the queue behind it.
 *
 * Queued runs are resolved rather than rejected: their caller asked for a
 * scrape and is getting an answer, just one that says nothing was collected.
 * Rejecting would surface as a failure in the status badge, which a deliberate
 * stop is not.
 */
export async function stopScraping() {
  const stopped = { wasRunning: Boolean(running), queued: pending.length };

  while (pending.length) {
    const item = pending.shift();
    item.resolve({ ok: false, cancelled: true, seen: 0, error: 'Cancelled before it started' });
  }

  if (running) {
    cancelling = true;
    // Closing the browser is what interrupts an in-flight navigation; without
    // it the run would idle until whatever it was waiting on timed out. Not
    // awaited: the flag has already done the deciding, and a close that hangs
    // must not hang the request that asked for the stop.
    activeBrowser?.close().catch(() => {});
  }

  return stopped;
}

function next() {
  running = null;
  runningUserId = null;
  runningPages = 0;
  cancelling = false;
  const item = pending.shift();
  if (!item) return;
  runningUserId = item.userId;
  runningPages = pagesOf(item.options);
  running = runScrape(item.options)
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
  const runId = await startRun(userId);
  // A stop applies to the run that was in flight, never to the next one.
  cancelling = false;
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
    activeBrowser = browser;
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
      if (cancelling) {
        stats.error = `Stopped after page ${p - 1} (kept ${stats.seen} jobs)`;
        stats.endedAt = p;
        break;
      }
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
          if (cancelling || isTargetCrash(err)) {
            stats.error = `Stopped during page ${p} (kept ${stats.seen} jobs)`;
            cards = null;
            break;
          }
          if (err instanceof CloudflareChallengeError || err.code === 'CF_CHALLENGE') {
            await dump(page, `challenge-page-${p}`).catch(() => {});
            stats.error = `Cloudflare challenge on page ${p} (stopped early, kept ${stats.seen} jobs)`;
            cards = null;
            break;
          }
          // The tab died. Nothing further can be fetched, but everything
          // already upserted stands, so end the walk instead of failing the run.
          if (err.code === 'BROWSER_CRASH') {
            stats.error = cancelling
              ? `Stopped during page ${p} (kept ${stats.seen} jobs)`
              : `${err.message} (stopped at page ${p}, kept ${stats.seen} jobs)`;
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
        if (job.client) await upsertClient(job.client);
        const result = await upsertJob(job);

        // "I bid on this" and "the client contacted me" are true of the account
        // that fetched the page, not of the posting, so they belong to the user.
        if (userId && (job.hasOwnBid || job.wasContacted)) {
          await upsertUserJob(userId, job.slug, {
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

    if (withDetails && detailBudget > 0 && !cancelling) {
      stats.details = await enrichDetails(context, { budget: detailBudget, onProgress, userId });
    }

    if (insightBudget > 0 && !cancelling) {
      stats.insights = await enrichInsights(context, { budget: insightBudget, onProgress, userId });
    }

    if (cancelling && !stats.error) {
      stats.error = `Stopped by request (kept ${stats.seen} jobs)`;
    }
    stats.cancelled = cancelling;
    stats.ok = true;
  } catch (err) {
    if (cancelling) {
      stats.ok = true;
      stats.cancelled = true;
      stats.error = `Stopped by request (kept ${stats.seen} jobs)`;
      return stats;
    }
    stats.ok = false;
    stats.error = err.message;
    throw err;
  } finally {
    // Keep any cf_clearance this run earned so the next one starts warm.
    if (context) await saveState(context);
    await finishRun(runId, stats);
    progress = null;
    activeBrowser = null;
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
  const targets = (
    await all(
      `SELECT slug FROM jobs
        WHERE detail_fetched_at IS NULL
        ORDER BY COALESCE(published_approx_at, published_at, first_seen_at) DESC
        LIMIT ?`,
      [budget],
    )
  ).map((r) => r.slug);

  if (targets.length === 0) return 0;

  const lanes = Math.max(1, Math.min(config.detailConcurrency, 4));
  const queue = [...targets];
  let done = 0;

  await Promise.all(
    Array.from({ length: lanes }, async () => {
      const page = await context.newPage();
      try {
        while (queue.length) {
          if (cancelling) break;
          const slug = queue.shift();
          try {
            await fetchDetail(page, slug, userId);
            done += 1;
            onProgress({ phase: 'detail', slug, done, total: targets.length });
          } catch (err) {
            // A challenge means "stop asking"; a crashed tab means "we cannot
            // ask". Either way the rest of the budget waits for the next run.
            if (err.code === 'CF_CHALLENGE' || err.code === 'BROWSER_CRASH') {
              queue.length = 0;
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

  if (detail.client?.id) await upsertClient(detail.client);

  await upsertJob({
    slug,
    url,
    title: detail.title || slug,
    detailFetchedAt: new Date().toISOString(),
    ...detail,
    raw: { detail: raw },
  });

  if (detail.client?.id) await saveClientReviews(detail.client.id, slug, detail.reviews);

  // The bid button reads "Improve proposal" only for the account that bid.
  if (userId && detail.hasOwnBid) await upsertUserJob(userId, slug, { hasOwnBid: true });

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
      { timeout: config.insightHydrateMs },
    )
    .catch(() => {});
  await sleep(400);

  const raw = await page.evaluate(pageExtractInsights);
  await saveInsights(slug, raw);

  /*
   * Two independent proofs that this account bid, neither of which is a property
   * of the job — they are true of whoever's session fetched the page.
   *
   * "Your budget" is the panel Workana shows only to the bidder. Appearing in
   * the contender list under your own display name is the other, and it catches
   * projects where the panel is missing or worded in a language the parser has
   * not seen. Both beat reading the button label, which is a guess by comparison.
   */
  if (userId) {
    const me = (await findUser(userId))?.workana_name;
    const amContender =
      me && raw.proposals?.some((p) => p.freelancer && p.freelancer.trim() === me.trim());

    if (raw.ownBudget || amContender) {
      await upsertUserJob(userId, slug, {
        ownBudget: raw.ownBudget ?? undefined,
        hasOwnBid: true,
      });
    }
  }

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
  const targets = (
    await all(
      `SELECT slug FROM jobs
        WHERE insights_fetched_at IS NULL AND COALESCE(bids, 0) > 0
        ORDER BY COALESCE(published_approx_at, published_at, first_seen_at) DESC
        LIMIT ?`,
      [budget],
    )
  ).map((r) => r.slug);

  if (!targets.length) return 0;

  // Each insights page waits on Vue to hydrate before it can be read, so this
  // phase is mostly idle waiting — the slowest part of a run when done one at a
  // time, and the one that gains most from lanes.
  const lanes = Math.max(1, Math.min(config.insightConcurrency, 4));
  const queue = [...targets];
  let done = 0;

  await Promise.all(
    Array.from({ length: lanes }, async () => {
      const page = await context.newPage();
      try {
        while (queue.length) {
          if (cancelling) break;
          const slug = queue.shift();
          try {
            await fetchInsightsOn(page, slug, userId);
            done += 1;
            onProgress({ phase: 'insights', slug, done, total: targets.length });
          } catch (err) {
            /*
             * Stop the lane before the fallback below can run. That line means
             * "this job has no insights page"; letting a challenge or a crashed
             * tab reach it would stamp that on every job still in the queue and
             * they would never be fetched again.
             */
            if (err.code === 'CF_CHALLENGE' || err.code === 'BROWSER_CRASH') {
              queue.length = 0;
              break;
            }
            // Some jobs have no insights page (closed, or not visible to us).
            await dbRun('UPDATE jobs SET insights_fetched_at = ? WHERE slug = ?', [
              new Date().toISOString(),
              slug,
            ]);
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
