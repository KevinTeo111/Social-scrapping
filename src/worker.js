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
import { scrape, stopScraping, currentProgress, fetchInsights, checkLogin } from './scraper/scrape.js';
import {
  getWorkanaCookies,
  getWorkanaProxy,
  recordCookieCheck,
  scrapeCandidates,
  purgeExpiredSessions,
  findUser,
  proxyBlocker,
} from './auth.js';
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
    const run = { token, lost: false, stopping: false };
    current = run;
    // A quick check every couple of minutes would drown the log; it speaks only
    // when it finds something.
    if (!sweep) log.log(`[worker] ${trigger} run started (${options.pages ?? config.refreshPages} page(s))`);

    run.promise = (async () => {
      let error = null;
      try {
        // Checked here as well as at the board: whatever asked for this run,
        // the session must not go out through the wrong address.
        const blocked = proxyBlocker(await findUser(userId));
        if (blocked) throw new Error(blocked);
        const cookies = await getWorkanaCookies(userId);
        if (!cookies) throw new Error('That member has no Workana session stored.');
        const stats = await scrape({ ...options, userId, cookies, proxy: await getWorkanaProxy(userId), trigger });
        if (trigger === 'manual') await recordCookieCheck(userId, { valid: true });
        if (sweep && stats?.inserted) {
          log.log(`[worker] quick check: ${stats.inserted} new posting(s) at ${new Date().toLocaleTimeString()}`);
        }
      } catch (err) {
        // A thrown run is a failure worth showing; a stopped one returns normally.
        error = err.message;
        log.error(`[worker] run failed: ${err.message}`);
      } finally {
        // A run that lost its slot must not write over the one that replaced it;
        // finishRun only touches the row while it still carries this token.
        // A quick check must not book the full run: see finishRun().
        await control
          .finishRun(token, { error, bookNext: !sweep })
          .catch((err) => log.error('[worker] finish:', err.message));
        if (current === run) current = null;
        if (!sweep) log.log('[worker] run finished');
      }
    })();
  }

  /**
   * The schedule, two clocks:
   *
   *   the quick check -- page 1, and details for jobs not seen before -- every
   *   SWEEP_MINUTES, timed from when the previous one *started*. New postings
   *   land on page 1, so this decides how soon one reaches the board.
   *
   *   the full refresh -- REFRESH_PAGES pages plus backlog enrichment -- every
   *   AUTO_SCRAPE_MINUTES after the previous one finished. It is the slow,
   *   thorough work and has no reason to hurry.
   *
   * When both are due the full refresh runs: it reads page 1 as well, so it
   * does the quick check's job too.
   */
  async function maybeScheduled(c) {
    if (c.paused) return;
    const fullOn = config.autoScrapeMinutes > 0;
    const sweepOn = config.sweepMinutes > 0;
    if (!fullOn && !sweepOn) return;

    const now = Date.now();
    const nowIso = control.iso(now);

    // First start, or just resumed: wait one interval rather than scraping the
    // instant the process boots.
    if (fullOn && !c.next_run_at) {
      await control.setNextRunAt(now + interval);
      return;
    }
    if (sweepOn && !c.next_sweep_at) {
      await control.setNextSweepAt(now + sweepInterval);
      return;
    }

    const fullDue = fullOn && c.next_run_at <= nowIso;
    const sweepDue = sweepOn && c.next_sweep_at <= nowIso;
    if (!fullDue && !sweepDue) return;

    // Take turns between members so one account does not carry every refresh,
    // and so a member whose cookies expired does not stall the rotation.
    const [candidate] = await scrapeCandidates();
    if (!candidate) {
      if (fullDue) await control.setNextRunAt(now + interval);
      if (sweepDue) await control.setNextSweepAt(now + sweepInterval);
      return;
    }

    const options = fullDue
      ? { kind: 'full', pages: config.refreshPages }
      : // Details only for jobs this check listed (in practice the new ones);
        // contact counts need bids first and come with the full refresh.
        { kind: 'sweep', pages: config.sweepPages, onlyListed: true, insightBudget: 0 };
    const token = await control.claimSlot({ userId: candidate.id, trigger: 'auto', options, state: 'running' });
    if (!token) {
      // Somebody pressed Refresh a moment ago. Their run does the same work;
      // come back after it rather than competing.
      if (fullDue) await control.setNextRunAt(now + BUSY_RETRY_MS);
      if (sweepDue) await control.setNextSweepAt(now + SWEEP_BUSY_RETRY_MS);
      return;
    }
    // Booked from the start, so SWEEP_MINUTES is the real gap between checks.
    if (sweepOn) await control.setNextSweepAt(now + sweepInterval);
    begin({ holder_user_id: candidate.id, run_trigger: 'auto', options: JSON.stringify(options) }, token);
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
        try {
          result = await checkLogin({ cookies, userId: t.user_id, proxy });
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
