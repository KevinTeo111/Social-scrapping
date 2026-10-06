/**
 * The scraper, as a process of its own.
 *
 * Everything that needs a browser happens here, and only here: the scheduled
 * refresh, runs members asked for with Refresh or Full crawl, and the one-off
 * tasks the board cannot do itself (checking a Workana login, reading one job's
 * insights). The board -- local or on Vercel -- never starts Chromium. It writes
 * what it wants into the database and this loop picks it up; see control.js for
 * the slot rules both sides follow.
 *
 * It runs wherever a real Chromium can reach Workana convincingly, which in
 * practice means a workstation: Cloudflare's clearance is tied to the IP and
 * browser fingerprint, and a home connection with a real browser is what it
 * trusts.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import { config } from './config.js';
import { scrape, stopScraping, currentProgress, fetchInsights, checkLogin, isScraping } from './scraper/scrape.js';
import {
  getWorkanaCookies,
  getWorkanaProxy,
  recordCookieCheck,
  scrapeCandidates,
  purgeExpiredSessions,
  findUser,
  proxyBlocker,
  recordRunOutcome,
  recordProxyCheck,
  brokenInputs,
  setScrapeLocale,
} from './auth.js';
import { checkProxy, probeExit } from './scraper/proxy-check.js';
import * as control from './control.js';

/** How often the loop looks for work. Each look is one or two small queries. */
const TICK_MS = 3_000;
/** When the schedule falls due while a member's run holds the slot. */
const BUSY_RETRY_MS = 60_000;
/** The same for the quick check, which is only worth anything when it is prompt. */
const SWEEP_BUSY_RETRY_MS = 15_000;
const PURGE_MS = 6 * 3600e3;
/** One-off tasks each open their own browser, so only a couple at a time. */
const MAX_TASKS = 2;

/**
 * Whether to stop waiting for a run and hand its slot back.
 *
 * True when the scrape is no longer running (its own watchdog gave up on it, or
 * it ended without this loop hearing), or when it has outlived the deadline by
 * a clear margin. `inFlight` guards the moments before the scrape begins --
 * sessions and proxies are fetched first, and the scraper is legitimately idle
 * then, which would otherwise read as a finished run.
 *
 * Exported so the decision can be tested without having to wedge a real scrape.
 */
export function runIsOver(run, { scraping, now = Date.now(), maxRunMs = control.MAX_RUN_MS }) {
  if (!run?.inFlight) return false;
  return !scraping || now - run.startedAt > maxRunMs + 60_000;
}

/**
 * Which automatic run is due, or null.
 *
 * Only one thing may run at a time, so when several are due the most
 * informative wins: the deep walk covers the quick check's pages, and both
 * matter more than filling in descriptions. Exported so the order can be
 * tested without waiting out three clocks.
 */
export function whichRunIsDue(c, now = Date.now()) {
  if (!c || c.paused) return null;
  const nowIso = control.iso(now);
  const due = (on, at) => on && at && at <= nowIso;

  if (due(config.deepMinutes > 0, c.next_deep_at)) {
    return {
      clock: 'deep',
      // To the end of the list: that is what proves a job is gone, so it is
      // also the only walk that may take closed projects off the board.
      options: { kind: 'deep', pages: config.maxListPages, withDetails: false, insightBudget: 0 },
    };
  }
  if (due(config.autoScrapeMinutes > 0, c.next_run_at)) {
    return {
      clock: 'enrich',
      // No list pages at all: pages = 0 skips the walk and goes straight to the
      // jobs that still lack a description or a contender list.
      options: { kind: 'enrich', pages: 0 },
    };
  }
  if (due(config.sweepMinutes > 0, c.next_sweep_at)) {
    return {
      clock: 'sweep',
      options: { kind: 'sweep', pages: config.sweepPages, withDetails: false, insightBudget: 0 },
    };
  }
  return null;
}

/**
 * When a failed exit lookup may be tried again. A proxy that swallows the
 * request costs the full timeout, and nothing is stored when it fails, so
 * without this it would be retried on every single run forever.
 */
const EXIT_RETRY_MS = 30 * 60_000;
const exitTried = new Map();

/**
 * Learns which country a member's proxy comes out of, once per proxy.
 *
 * It decides the timezone and language their browser presents, which has to
 * agree with the address Workana sees the traffic arrive from.
 *
 * Deliberately *after* a run rather than before: it is one more network call
 * through a proxy that may be the very thing that is broken, and no run should
 * ever wait on it. The answer is stored for the next run, so a member's first
 * run after registering a proxy still presents the instance default and every
 * run after that presents their own.
 */
async function noteExit(userId, proxy, log = console) {
  if (!proxy) return;
  const last = exitTried.get(userId);
  if (last && Date.now() - last < EXIT_RETRY_MS) return;
  try {
    const user = await findUser(userId);
    if (user?.exit_country) return;
    exitTried.set(userId, Date.now());
    const exit = await probeExit(proxy);
    if (!exit.country && !exit.timezone) return;
    exitTried.delete(userId);
    const stored = await setScrapeLocale(userId, { ...exit, source: 'probe' });
    log.log(
      `[worker] ${user.email}: exit is ${exit.country ?? 'unknown'} — from the next run it presents ` +
        `${stored.timezone ?? 'the default zone'} / ${stored.locale ?? 'the default language'}`,
    );
  } catch {
    /* A locale is a nicety; never let it stop a run. */
  }
}

/**
 * Works out why a member's runs collect nothing, and records it against the
 * field that fixes it.
 *
 * The two causes are indistinguishable from the run itself -- an expired
 * session and a refused proxy both end as an empty page -- so each is tested
 * for what it is. The proxy first, because it is a single connection rather
 * than a browser, and because a proxy that refuses makes the session untestable
 * anyway: the session is then checked through this machine's own connection, so
 * the answer is about the session rather than the route to it.
 */
export async function diagnose(userId, log = console) {
  const user = await findUser(userId);
  if (!user) return [];
  const proxy = await getWorkanaProxy(userId);
  const result = await checkProxy(proxy);
  await recordProxyCheck(userId, result);
  if (!result.ok) log.warn(`[worker] ${user.email}: proxy — ${result.detail}`);
  // While the exit is known to work, note which country it is: it decides what
  // this member's browser says about itself. Best effort, never fatal.
  if (result.ok) await noteExit(userId, proxy, log);

  const cookies = await getWorkanaCookies(userId);
  if (cookies) {
    try {
      const login = await checkLogin({ cookies, userId, proxy: result.ok ? proxy : null });
      await recordCookieCheck(userId, { valid: login.loggedIn, workanaName: login.user });
      if (!login.loggedIn) log.warn(`[worker] ${user.email}: Workana did not accept the session`);
    } catch (err) {
      log.warn(`[worker] ${user.email}: could not check the session — ${err.message}`);
    }
  }

  const needs = brokenInputs(await findUser(userId));
  log.warn(
    `[worker] set aside ${user.email}: ${needs.length ? needs.map((n) => n.field).join(' and ') + ' need attention' : 'cause not identified'}`,
  );
  return needs;
}

export function startWorker({ log = console } = {}) {
  const workerId = `${os.hostname()}#${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const interval = config.autoScrapeMinutes * 60_000;
  const sweepInterval = config.sweepMinutes * 60_000;

  let current = null; // the run this process is working on: { token, promise, lost, stopping }
  let tasksInFlight = 0;
  let lastBeat = 0;
  let lastPurge = 0;
  let stopped = false;
  let timer = null;

  function begin(row, token) {
    const userId = row.holder_user_id;
    const trigger = row.run_trigger === 'manual' ? 'manual' : 'auto';
    let options = {};
    try {
      options = row.options ? JSON.parse(row.options) : {};
    } catch {
      options = {};
    }

    lastBeat = Date.now();
    const sweep = options.kind === 'sweep';
    const kindName = { sweep: 'quick check', deep: 'deep list walk', enrich: 'enrichment' }[options.kind];
    const run = { token, lost: false, stopping: false, startedAt: Date.now(), inFlight: false };
    current = run;
    // A quick check every couple of minutes would drown the log; it speaks only
    // when it finds something.
    if (!sweep) {
      log.log(
        `[worker] ${kindName ?? `${trigger} run`} started` +
          (options.kind === 'enrich' ? ' (no list pages)' : ` (${options.pages ?? config.refreshPages} page(s))`),
      );
    }

    run.promise = (async () => {
      let error = null;
      try {
        // Checked here as well as at the board: whatever asked for this run,
        // the session must not go out through the wrong address.
        const blocked = proxyBlocker(await findUser(userId));
        if (blocked) throw new Error(blocked);
        const cookies = await getWorkanaCookies(userId);
        if (!cookies) throw new Error('That member has no Workana session stored.');
        const proxy = await getWorkanaProxy(userId);
        run.inFlight = true;
        const stats = await scrape({ ...options, userId, cookies, proxy, trigger });
        if (trigger === 'manual') await recordCookieCheck(userId, { valid: true });
        /*
         * A run that walked list pages and found nothing is the only sign the
         * board gets that a session has expired or a proxy is refusing it --
         * neither raises an error, both simply return an empty page.
         */
        const setAside = await recordRunOutcome(userId, { listPages: stats?.pages ?? 0, seen: stats?.seen ?? 0 });
        if (setAside) await diagnose(userId, log);
        // The run is done; this only prepares what the next one will present.
        else await noteExit(userId, proxy, log);
        if (sweep && stats?.inserted) {
          log.log(`[worker] quick check: ${stats.inserted} new posting(s) at ${new Date().toLocaleTimeString()}`);
        }
      } catch (err) {
        // A thrown run is a failure worth showing; a stopped one returns normally.
        error = err.message;
        log.error(`[worker] run failed: ${err.message}`);
      } finally {
        run.inFlight = false;
        // A run that lost its slot must not write over the one that replaced it;
        // finishRun only touches the row while it still carries this token.
        // A quick check must not book the full run: see finishRun().
        /*
         * Every automatic clock books itself when its run starts, so finishing
         * must book nothing: a quick check that booked the enrichment clock
         * would push it an interval further away every two minutes, and it
         * would never run at all.
         */
        await control
          .finishRun(token, { error, bookNext: trigger === 'manual' })
          .catch((err) => log.error('[worker] finish:', err.message));
        if (current === run) current = null;
        if (!sweep) log.log('[worker] run finished');
      }
    })();
  }

  /**
   * The schedule, three clocks for three jobs that cost very different amounts.
   *
   *   quick check, every SWEEP_MINUTES -- the newest SWEEP_PAGES list pages.
   *   deep walk, every DEEP_MINUTES -- every list page to the end.
   *   enrichment, every AUTO_SCRAPE_MINUTES -- descriptions and contender lists
   *   for jobs that lack them, and no list pages at all.
   *
   * The list walks read only what the cards carry: bid counts, statuses, and
   * when the client last replied. That is the information that ages by the
   * hour, and a page of it costs a second or two. Opening each job's own page
   * costs seconds per job, and while that work rode along with the list walk it
   * made every walk slow -- a one-page check took 12 to 18 seconds, a walk that
   * also enriched took 64 to 79. Separating them lets the list be walked often
   * and the per-item work proceed quietly behind it.
   *
   * Only one thing may run at a time, so when several are due the most
   * informative wins: the deep walk covers the quick check's pages, and both
   * matter more than filling in descriptions.
   */
  function dueRun(c, now = Date.now()) {
    return whichRunIsDue(c, now);
  }

  /** Books a clock, from now, however its run turned out. */
  const book = {
    deep: (ms) => control.setNextDeepAt(Date.now() + ms),
    enrich: (ms) => control.setNextRunAt(Date.now() + ms),
    sweep: (ms) => control.setNextSweepAt(Date.now() + ms),
  };
  const intervalOf = { deep: config.deepMinutes * 60_000, enrich: interval, sweep: sweepInterval };

  async function maybeScheduled(c) {
    if (c.paused) return;
    const now = Date.now();

    // First start, or just resumed: wait one interval rather than scraping the
    // instant the process boots.
    if (config.autoScrapeMinutes > 0 && !c.next_run_at) return book.enrich(interval);
    if (config.sweepMinutes > 0 && !c.next_sweep_at) return book.sweep(sweepInterval);
    if (config.deepMinutes > 0 && !c.next_deep_at) return book.deep(intervalOf.deep);

    const next = dueRun(c, now);
    if (!next) return;

    // Take turns between members so one account does not carry every refresh,
    // and so a member whose cookies expired does not stall the rotation.
    const [candidate] = await scrapeCandidates();
    if (!candidate) return book[next.clock](intervalOf[next.clock]);

    const token = await control.claimSlot({
      userId: candidate.id,
      trigger: 'auto',
      options: next.options,
      state: 'running',
    });
    if (!token) {
      // Somebody pressed Refresh a moment ago. Their run does the same work;
      // come back after it rather than competing.
      return book[next.clock](next.clock === 'sweep' ? SWEEP_BUSY_RETRY_MS : BUSY_RETRY_MS);
    }
    // Booked from the start, so the interval is the real gap between runs.
    await book[next.clock](intervalOf[next.clock]);
    begin(
      { holder_user_id: candidate.id, run_trigger: 'auto', options: JSON.stringify(next.options) },
      token,
    );
  }

  async function runTask(t) {
    try {
      const blocked = proxyBlocker(await findUser(t.user_id));
      if (blocked) throw new Error(blocked);
      const cookies = await getWorkanaCookies(t.user_id);
      if (!cookies) throw new Error('No Workana session stored yet.');
      const proxy = await getWorkanaProxy(t.user_id);
      const payload = t.payload ? JSON.parse(t.payload) : {};
      let result;
      if (t.kind === 'verify') {
        /*
         * The proxy first, and separately: if it will not carry the request,
         * the browser would only report "not signed in" about a page it never
         * reached, and the member would re-export cookies that were fine.
         */
        const route = await checkProxy(proxy);
        await recordProxyCheck(t.user_id, route);
        if (!route.ok) {
          await control.completeTask(t.id, {
            result: { loggedIn: false, proxyOk: false, proxyError: route.detail, user: null },
          });
          return;
        }
        try {
          result = await checkLogin({ cookies, userId: t.user_id, proxy });
          result = { ...result, proxyOk: true };
          await recordCookieCheck(t.user_id, { valid: result.loggedIn, workanaName: result.user });
        } catch (err) {
          await recordCookieCheck(t.user_id, { valid: false });
          throw err;
        }
      } else if (t.kind === 'insights') {
        result = await fetchInsights(payload.slug, { userId: t.user_id, cookies, proxy });
      } else {
        throw new Error(`Unknown task "${t.kind}"`);
      }
      await control.completeTask(t.id, { result });
    } catch (err) {
      await control.completeTask(t.id, { error: err.message }).catch(() => {});
    }
  }

  async function pickTasks() {
    while (tasksInFlight < MAX_TASKS) {
      const t = await control.claimTask(workerId);
      if (!t) return;
      tasksInFlight += 1;
      runTask(t).finally(() => {
        tasksInFlight -= 1;
      });
    }
  }

  async function tick() {
    // Saying "alive" and reading the slot are one round trip.
    let c = await control.markWorkerSeen(workerId, config.autoScrapeMinutes, config.sweepMinutes);

    if (current) {
      /*
       * Let go of a run that is never coming back.
       *
       * The scrape's own watchdog abandons a run that stops reporting, but the
       * promise it was awaiting can stay pending for ever -- and this loop,
       * waiting on that promise, went on renewing the lease of a run that was
       * already over. The slot then looked perfectly healthy in the database,
       * so nothing was ever scheduled again: the board simply stopped scraping,
       * with a lease being refreshed every few seconds to prove it was fine.
       *
       * Two ways to notice: the scraper says it is no longer running, or the
       * run has outlived the deadline by a clear margin. Either way, hand the
       * slot back now. The abandoned promise may still settle later; finishRun
       * only touches the row while it carries that run's token, so a late
       * arrival cannot disturb whatever came next.
       */
      if (runIsOver(current, { scraping: isScraping() })) {
        log.warn(`[worker] the run stopped reporting after ${Math.round((Date.now() - current.startedAt) / 60_000)} min — freeing the slot`);
        const stale = current;
        current = null;
        stale.inFlight = false;
        await stopScraping().catch(() => {});
        await control
          .finishRun(stale.token, { error: 'The run stopped reporting and was abandoned.' })
          .catch((err) => log.error('[worker] finish:', err.message));
        return;
      }

      if (Date.now() - lastBeat >= control.HEARTBEAT_MS) {
        lastBeat = Date.now();
        const r = await control.renewLease(current.token, currentProgress());
        if (!r) {
          // The slot is somebody else's now -- a forced reset, or a takeover
          // after a stall. Carrying on would put a second browser on Workana
          // under a slot that is not ours.
          log.warn('[worker] lost the slot; stopping the local run');
          current.lost = true;
          await stopScraping();
        } else if (r.stop_requested && !current.stopping) {
          current.stopping = true;
          log.log('[worker] stop requested by the owner');
          await stopScraping();
        }
      }
    } else if (c) {
      if (control.isStalled(c) && (await control.clearStale())) {
        log.warn('[worker] freed a slot whose run stopped reporting');
        c = await control.readControl();
      }
      if (c.state === 'requested' && c.run_token) {
        const row = await control.takeRequested(c.run_token);
        if (row) begin(row, c.run_token);
      } else if (c.state === 'idle') {
        await maybeScheduled(c);
      }
    }

    await pickTasks();

    if (Date.now() - lastPurge > PURGE_MS) {
      lastPurge = Date.now();
      await purgeExpiredSessions().catch(() => {});
      await control.purgeTasks().catch(() => {});
    }
  }

  const loop = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      // A dropped connection is routine against a hosted database; the next
      // tick gets a fresh one from the pool.
      log.error('[worker]', err.message);
    }
    if (!stopped) timer = setTimeout(loop, TICK_MS);
  };
  loop();

  return {
    workerId,
    /**
     * Ends the loop and hands back anything held, so the board shows the
     * scraper as gone and the slot as free at once rather than after the lease
     * lapses.
     */
    async shutdown() {
      stopped = true;
      clearTimeout(timer);
      const run = current;
      if (run) {
        await stopScraping();
        await Promise.race([run.promise, new Promise((r) => setTimeout(r, 10_000))]);
        await control
          .finishRun(run.token, { error: 'The scraper was shut down mid-run.' })
          .catch(() => {});
      }
      await control.markWorkerGone(workerId).catch(() => {});
    },
  };
}
