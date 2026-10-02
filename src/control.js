/**
 * The scrape slot, kept in the database.
 *
 * One scrape at a time for the whole instance, and a second request is refused
 * rather than queued -- the rules are unchanged. What changed is where they
 * live. They used to be variables in the server's memory, which worked only
 * while one process both served the board and ran the browser. With the board
 * on Vercel (many short-lived instances, no browser) and the scraper on a
 * workstation (one long-lived process, the only one with Chromium), the
 * database is the one thing every party can see, so the slot is a row in it:
 * `scrape_control`, id 1.
 *
 * Claiming is a single conditional UPDATE. Postgres re-checks the WHERE clause
 * against the row as it stands once it holds the row lock, and SQLite serialises
 * writers outright, so two members pressing Refresh in the same instant cannot
 * both win -- on any number of instances.
 *
 * A held slot carries a lease that the scraper renews every few seconds. A
 * scraper that dies, or a computer that is switched off mid-run, stops renewing,
 * and the slot frees itself within a minute and a half. The hard deadline from
 * before (SCRAPE_MAX_MINUTES) still applies on top, for a scraper that is alive
 * but wedged: its heartbeat keeps ticking while the run itself goes nowhere.
 *
 * Nothing here imports the browser. The board uses this module; so does the
 * scraper; only the scraper imports Playwright.
 */
import crypto from 'node:crypto';
import { all, get, run, insertReturning, isPostgres } from './sql.js';
import { config } from './config.js';

export const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** How long a pressed Refresh waits for a scraper to pick it up. */
export const PICKUP_MS = 90_000;
/** How far each heartbeat pushes a running lease out. */
export const LEASE_MS = 90_000;
/** How often the scraper renews its lease and reports progress. */
export const HEARTBEAT_MS = 5_000;
/** A scraper not heard from for this long is reported as offline. */
export const WORKER_STALE_MS = 60_000;
/** A run is abandoned past this, however healthy its heartbeat looks. */
export const MAX_RUN_MS = Math.max(5, Number(process.env.SCRAPE_MAX_MINUTES) || 45) * 60_000;

const IDLE_COLUMNS = `state = 'idle', run_token = NULL, holder_user_id = NULL, run_trigger = NULL,
  options = NULL, started_at = NULL, lease_until = NULL, stop_requested = 0, progress = NULL`;

export async function readControl() {
  return (await get('SELECT * FROM scrape_control WHERE id = 1')) || { state: 'idle' };
}

/** Held means a live lease on a run still inside the hard deadline. */
export function slotHeld(c, now = Date.now()) {
  if (!c || c.state === 'idle') return false;
  if (!c.lease_until || c.lease_until < iso(now)) return false;
  if (c.started_at && c.started_at < iso(now - MAX_RUN_MS)) return false;
  return true;
}

/** Not idle, but no longer held: a run that stopped reporting. */
export const isStalled = (c, now = Date.now()) => Boolean(c) && c.state !== 'idle' && !slotHeld(c, now);

export const workerOnline = (c, now = Date.now()) =>
  Boolean(c?.worker_seen_at) && c.worker_seen_at >= iso(now - WORKER_STALE_MS);

/**
 * Takes the slot, or returns null because somebody holds it.
 *
 * `state` is 'requested' when the board asks (the scraper still has to pick it
 * up) and 'running' when the scraper claims it for itself. The token identifies
 * this particular run, so a scraper that lost its lease can never write over the
 * run that replaced it.
 */
export async function claimSlot({ userId, trigger, options = {}, state }) {
  const now = Date.now();
  const token = crypto.randomUUID();
  const row = await get(
    `UPDATE scrape_control
        SET state = ?, run_token = ?, holder_user_id = ?, run_trigger = ?, options = ?,
            started_at = ?, lease_until = ?, stop_requested = 0, progress = NULL
      WHERE id = 1
        AND (state = 'idle' OR lease_until IS NULL OR lease_until < ? OR started_at < ?)
      RETURNING run_token`,
    [
      state,
      token,
      userId,
      trigger,
      JSON.stringify(options),
      iso(now),
      iso(now + (state === 'requested' ? PICKUP_MS : LEASE_MS)),
      iso(now),
      iso(now - MAX_RUN_MS),
    ],
  );
  return row?.run_token === token ? token : null;
}

/** The scraper accepting a run the board asked for. */
export async function takeRequested(token) {
  const now = Date.now();
  return get(
    `UPDATE scrape_control SET state = 'running', lease_until = ?
      WHERE id = 1 AND state = 'requested' AND run_token = ? AND lease_until >= ?
      RETURNING *`,
    [iso(now + LEASE_MS), token, iso(now)],
  );
}

/**
 * Keeps a running lease alive and publishes progress. Returns the row, whose
 * `stop_requested` says whether the owner asked for a stop -- or null when the
 * slot is no longer this run's, in which case the caller must stop at once.
 */
export async function renewLease(token, progress) {
  return get(
    `UPDATE scrape_control SET lease_until = ?, progress = ?
      WHERE id = 1 AND state = 'running' AND run_token = ?
      RETURNING stop_requested`,
    [iso(Date.now() + LEASE_MS), progress ? JSON.stringify(progress) : null, token],
  );
}

/**
 * Hands the slot back and, unless `bookNext` is false, books the next full
 * automatic run.
 *
 * The quick check for new postings passes false. It runs every couple of
 * minutes, and if each one booked the full run "an interval from now", the full
 * run would be pushed back forever and never happen.
 */
export async function finishRun(token, { error = null, autoMinutes = config.autoScrapeMinutes, bookNext = true } = {}) {
  if (!bookNext) {
    return run(`UPDATE scrape_control SET ${IDLE_COLUMNS}, last_error = ? WHERE id = 1 AND run_token = ?`, [
      error,
      token,
    ]);
  }
  const next = autoMinutes ? iso(Date.now() + autoMinutes * 60_000) : null;
  return run(
    `UPDATE scrape_control
        SET ${IDLE_COLUMNS}, last_error = ?,
            next_run_at = CASE WHEN paused = 1 THEN NULL ELSE ? END
      WHERE id = 1 AND run_token = ?`,
    [error, next, token],
  );
}

export async function setNextSweepAt(ms) {
  return run('UPDATE scrape_control SET next_sweep_at = ? WHERE id = 1', [ms == null ? null : iso(ms)]);
}

export async function setNextDeepAt(ms) {
  return run('UPDATE scrape_control SET next_deep_at = ? WHERE id = 1', [ms == null ? null : iso(ms)]);
}

/** Frees a slot whose holder stopped reporting. Returns rows changed (0 or 1). */
export async function clearStale() {
  const now = Date.now();
  return run(
    `UPDATE scrape_control
        SET ${IDLE_COLUMNS},
            last_error = CASE WHEN state = 'running'
                              THEN 'The previous run stopped reporting and was abandoned.'
                              ELSE last_error END
      WHERE id = 1 AND state <> 'idle'
        AND (lease_until IS NULL OR lease_until < ? OR started_at < ?)`,
    [iso(now), iso(now - MAX_RUN_MS)],
  );
}

/**
 * The scraper saying it is alive, in the same round trip that reads the slot.
 * Also records its schedule, so the board shows the interval the scraper is
 * actually using rather than whatever the board's own environment says.
 */
export async function markWorkerSeen(workerId, autoMinutes, sweepMinutes = null) {
  /*
   * auto_minutes is an integer column. This statement runs on every tick and
   * everything the scraper does waits behind it, so a value it cannot store --
   * AUTO_SCRAPE_MINUTES=0.75 did exactly that -- would stop the scraper cold.
   * The column only feeds what the board displays and resume() books; whole
   * minutes are plenty for both.
   */
  const whole = autoMinutes == null ? null : Math.max(0, Math.round(Number(autoMinutes)) || 0);
  const sweep = sweepMinutes == null || !Number.isFinite(Number(sweepMinutes)) ? null : Number(sweepMinutes);
  return get(
    `UPDATE scrape_control SET worker_id = ?, worker_seen_at = ?, auto_minutes = ?, sweep_minutes = ?
      WHERE id = 1 RETURNING *`,
    [workerId, iso(), whole, sweep],
  );
}

/** Tells the board at once that the scraper has gone, instead of a minute later. */
export async function markWorkerGone(workerId) {
  return run('UPDATE scrape_control SET worker_seen_at = NULL WHERE id = 1 AND worker_id = ?', [workerId]);
}

export async function setNextRunAt(ms) {
  return run('UPDATE scrape_control SET next_run_at = ? WHERE id = 1', [ms == null ? null : iso(ms)]);
}

/**
 * Stop, as the owner means it: the clock is held, and a run in flight ends.
 *
 * A run the scraper is working on is asked to stop, and the scraper frees the
 * slot as it unwinds. A run nobody is working on -- requested but not yet picked
 * up, or held by a scraper that is not there -- would wait for its lease to
 * lapse with nobody to act on the request, so it is freed right here.
 */
export async function requestStop() {
  const c = await readControl();
  const wasActive = c.state !== 'idle';
  const direct = c.state === 'requested' || !workerOnline(c) || !slotHeld(c);
  await run(
    `UPDATE scrape_control SET paused = 1, next_run_at = NULL, next_sweep_at = NULL, next_deep_at = NULL,
            stop_requested = CASE WHEN state = 'running' THEN 1 ELSE 0 END
      WHERE id = 1`,
  );
  if (wasActive && direct) await run(`UPDATE scrape_control SET ${IDLE_COLUMNS} WHERE id = 1`);
  return { wasRunning: wasActive, stalled: isStalled(c), direct };
}

export async function resume() {
  const c = await readControl();
  const minutes = c.auto_minutes ?? config.autoScrapeMinutes;
  const next = minutes ? iso(Date.now() + minutes * 60_000) : null;
  await run('UPDATE scrape_control SET paused = 0, next_run_at = ? WHERE id = 1', [next]);
  return next;
}

/** What /api/status says about scraping, for one viewer. */
export function describeSlot(c, viewerId, now = Date.now()) {
  const held = slotHeld(c, now);
  const parse = (text) => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  const progress = held ? parse(c.progress) : null;
  // 'sweep' (the quick check for new postings) or 'full'; null for a button press.
  const kind = held ? (parse(c.options)?.kind ?? null) : null;
  return {
    workerOnline: workerOnline(c, now),
    scraping: held,
    /*
     * The background refresh borrows somebody's session, so going by the
     * session alone would report the clock's own work as that member's. Only a
     * run a person actually asked for is anybody's.
     */
    scrapingAuto: held && c.run_trigger === 'auto',
    scrapingKind: kind,
    scrapingMine: held && c.run_trigger === 'manual' && Number(c.holder_user_id) === Number(viewerId),
    // When it started, but never whose run it is.
    scrapingSince: held ? c.started_at : null,
    stalled: isStalled(c, now),
    stopping: held && Boolean(c.stop_requested),
    paused: Boolean(c.paused),
    progress,
    lastError: c.last_error ?? null,
    autoScrapeMinutes: c.auto_minutes ?? config.autoScrapeMinutes,
    nextRunAt: c.paused ? null : (c.next_run_at ?? null),
    sweepMinutes: c.sweep_minutes == null ? null : Number(c.sweep_minutes),
    nextSweepAt: c.paused ? null : (c.next_sweep_at ?? null),
  };
}

/* ------------------------------------------------------------------ */
/* One-off tasks for the scraper's machine                             */
/* ------------------------------------------------------------------ */

/** A task not picked up within this is dropped: whoever asked has given up. */
export const TASK_PICKUP_MS = 120_000;

export async function enqueueTask(kind, userId, payload = {}) {
  return insertReturning(
    `INSERT INTO worker_tasks (kind, user_id, payload, status, created_at)
     VALUES (?, ?, ?, 'pending', ?) RETURNING id`,
    [kind, userId, JSON.stringify(payload), iso()],
  );
}

/**
 * Waits for a task to finish, up to `timeoutMs`. Returns
 * `{ status: 'done', result }`, `{ status: 'failed', error }` or
 * `{ status: 'pending' }` when time ran out first.
 */
export async function waitForTask(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = await get('SELECT status, result, error FROM worker_tasks WHERE id = ?', [id]);
    if (t?.status === 'done') return { status: 'done', result: t.result ? JSON.parse(t.result) : null };
    if (t?.status === 'failed') return { status: 'failed', error: t.error };
    if (Date.now() >= deadline) return { status: 'pending' };
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Takes the oldest waiting task, if any. Atomic for the same reason claimSlot is.
 *
 * On Postgres the inner SELECT skips rows another claimer has already locked.
 * Without that, simultaneous claimers all pick the same oldest task, one wins,
 * and the rest come back empty-handed although tasks are waiting. Never a
 * double claim, but slower pickup than there should be. SQLite runs writers
 * one at a time, so it neither needs nor supports the clause.
 */
export async function claimTask(workerId) {
  return get(
    `UPDATE worker_tasks SET status = 'running', worker_id = ?
      WHERE id = (SELECT id FROM worker_tasks
                   WHERE status = 'pending' AND created_at >= ?
                   ORDER BY id LIMIT 1${isPostgres ? ' FOR UPDATE SKIP LOCKED' : ''})
        AND status = 'pending'
      RETURNING *`,
    [workerId, iso(Date.now() - TASK_PICKUP_MS)],
  );
}

export async function completeTask(id, { result = null, error = null }) {
  return run(
    `UPDATE worker_tasks SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?`,
    [error ? 'failed' : 'done', result == null ? null : JSON.stringify(result), error, iso(), id],
  );
}

/** Tasks are only ever read while someone waits on them; a day is plenty. */
export async function purgeTasks() {
  return run('DELETE FROM worker_tasks WHERE created_at < ?', [iso(Date.now() - 24 * 3600e3)]);
}

/** For tests and diagnostics. */
export async function pendingTasks() {
  return all(`SELECT id, kind, status FROM worker_tasks WHERE status IN ('pending', 'running') ORDER BY id`);
}
