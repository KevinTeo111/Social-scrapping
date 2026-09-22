/**
 * The scrape slot and task queue (src/control.js), against a real database.
 *
 * On Postgres this is the test that matters: twenty claims fired at once over
 * parallel connections must produce exactly one winner, which a single-process
 * SQLite run cannot really challenge. It also covers lease expiry and takeover,
 * the hard deadline, stop and resume, scraper presence, and task claiming.
 *
 *   node --env-file=data\test.env scripts/test-control.mjs    (a Postgres test database)
 *   $env:DB_FILE = "$env:TEMP\test.db"; node scripts/test-control.mjs   (SQLite)
 *
 * It resets the slot, so it refuses to run against a database not named "test".
 */
import { requireTestDatabase } from './support/test-guard.mjs';
import { initDatabase } from '../src/db.js';
import { run, get, close, isPostgres } from '../src/sql.js';
import * as c from '../src/control.js';

let fail = 0;
const ok = (n, cond, x = '') => {
  if (!cond) fail += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};
const reset = () => run(`UPDATE scrape_control SET state='idle', run_token=NULL, holder_user_id=NULL,
  run_trigger=NULL, options=NULL, started_at=NULL, lease_until=NULL, stop_requested=0, paused=0,
  progress=NULL, last_error=NULL, next_run_at=NULL, worker_seen_at=NULL, worker_id=NULL WHERE id=1`);

requireTestDatabase();
await initDatabase();
console.log(`engine: ${isPostgres ? 'postgres' : 'sqlite'}\n`);
await reset();

// 1. Simultaneous claims: exactly one may win.
const tokens = await Promise.all(
  Array.from({ length: 20 }, (_, i) => c.claimSlot({ userId: i + 1, trigger: 'manual', options: { i }, state: 'requested' })),
);
const winners = tokens.filter(Boolean);
ok('20 simultaneous claims -> exactly one winner', winners.length === 1, `winners=${winners.length}`);
const row = await c.readControl();
ok('the row names the winner', row.run_token === winners[0] && row.state === 'requested');
ok('a later claim is refused', (await c.claimSlot({ userId: 99, trigger: 'manual', state: 'requested' })) === null);

// 2. Pickup, lease renewal, wrong-token renewal.
ok('the scraper takes the requested run', Boolean(await c.takeRequested(winners[0])));
ok('it is now running', (await c.readControl()).state === 'running');
ok('renewing with the right token works', Boolean(await c.renewLease(winners[0], { phase: 'list', page: 2 })));
ok('renewing with a wrong token is refused', (await c.renewLease('not-the-token', null)) == null);
const d = c.describeSlot(await c.readControl(), (await c.readControl()).holder_user_id);
ok('status: scraping, mine, progress carried', d.scraping && d.scrapingMine && d.progress?.page === 2, JSON.stringify(d.progress));

// 3. An expired lease frees the slot for a takeover, and the loser cannot write back.
await run('UPDATE scrape_control SET lease_until = ? WHERE id = 1', [c.iso(Date.now() - 1000)]);
ok('an expired lease reads as stalled, not scraping', c.isStalled(await c.readControl()) && !c.slotHeld(await c.readControl()));
const taker = await c.claimSlot({ userId: 50, trigger: 'auto', state: 'running' });
ok('a new claim takes over the stalled slot', Boolean(taker));
await c.finishRun(winners[0], { error: 'late write from the old run' });
ok('the displaced run cannot free the new one', (await c.readControl()).run_token === taker);
await c.finishRun(taker, {});
ok('the owner frees it', (await c.readControl()).state === 'idle');

// 4. The hard deadline applies even with a live lease.
const long = await c.claimSlot({ userId: 1, trigger: 'auto', state: 'running' });
await run('UPDATE scrape_control SET started_at = ? WHERE id = 1', [c.iso(Date.now() - c.MAX_RUN_MS - 60_000)]);
ok('a run past MAX_RUN_MS is not held despite its lease', !c.slotHeld(await c.readControl()));
ok('clearStale frees it and says why', (await c.clearStale()) === 1 && /stopped reporting/.test((await c.readControl()).last_error));
void long;

// 5. Stop: a run the scraper is working on is asked; an orphan is freed on the spot.
await reset();
await c.markWorkerSeen('test-worker', 10);
const t5 = await c.claimSlot({ userId: 1, trigger: 'manual', state: 'running' });
let s = await c.requestStop();
let r = await c.readControl();
ok('stop on a live run asks the scraper', r.stop_requested === 1 && r.state === 'running' && r.paused === 1 && !s.direct);
await c.finishRun(t5, {});
ok('paused: finishing books no next run', (await c.readControl()).next_run_at == null);
await c.resume();
ok('resume books the next run', Boolean((await c.readControl()).next_run_at));
await reset();
await c.claimSlot({ userId: 1, trigger: 'manual', state: 'requested' });
s = await c.requestStop();
ok('stop on a run nobody picked up frees it directly', s.direct && (await c.readControl()).state === 'idle');

// 5b. A quick check must not touch the full refresh's schedule, or checks every
//     couple of minutes would push the full refresh back forever.
await reset();
const booked = c.iso(Date.now() + 10 * 60_000);
await run('UPDATE scrape_control SET next_run_at = ? WHERE id = 1', [booked]);
const tq = await c.claimSlot({ userId: 1, trigger: 'auto', options: { kind: 'sweep', pages: 1 }, state: 'running' });
ok('status names a quick check as such', c.describeSlot(await c.readControl(), 1).scrapingKind === 'sweep');
await c.finishRun(tq, { bookNext: false });
r = await c.readControl();
ok('finishing a quick check leaves the full refresh where it was', r.state === 'idle' && r.next_run_at === booked);
const tf = await c.claimSlot({ userId: 1, trigger: 'auto', options: { kind: 'full' }, state: 'running' });
await c.finishRun(tf, {});
ok('finishing a full refresh books the next one', (await c.readControl()).next_run_at !== booked);

// 6. Presence.
await reset();
ok('never seen -> offline', !c.workerOnline(await c.readControl()));
await c.markWorkerSeen('w1', 10);
ok('just seen -> online', c.workerOnline(await c.readControl()));
await run('UPDATE scrape_control SET worker_seen_at = ? WHERE id = 1', [c.iso(Date.now() - c.WORKER_STALE_MS - 1000)]);
ok('silent past the limit -> offline', !c.workerOnline(await c.readControl()));
await c.markWorkerSeen('w1', 10);
await c.markWorkerGone('w1');
ok('shutdown -> offline at once', !c.workerOnline(await c.readControl()));

// 7. Tasks: each is claimed once, results round-trip.
const ids = await Promise.all([1, 2, 3].map((n) => c.enqueueTask('insights', 1, { slug: `s${n}` })));
const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => c.claimTask(`w${i}`)));
const got = claims.filter(Boolean).map((t) => Number(t.id)).sort();
ok('8 workers racing for 3 tasks claim each exactly once', got.length === 3 && new Set(got).size === 3, got.join(','));
await c.completeTask(ids[0], { result: { n: 7 } });
await c.completeTask(ids[1], { error: 'boom' });
ok('a done task returns its result', (await c.waitForTask(ids[0], 1000)).result?.n === 7);
ok('a failed task returns its error', (await c.waitForTask(ids[1], 1000)).error === 'boom');
ok('an unfinished task times out as pending', (await c.waitForTask(ids[2], 1500)).status === 'pending');
const stale = await c.enqueueTask('verify', 1, {});
await run('UPDATE worker_tasks SET created_at = ? WHERE id = ?', [c.iso(Date.now() - c.TASK_PICKUP_MS - 1000), stale]);
ok('a task nobody picked up in time is skipped', (await c.claimTask('late')) == null);

// 8. The SQLite/Postgres row-count fix: run() reports what it changed.
ok('run() reports rows changed by a plain UPDATE', (await run("UPDATE worker_tasks SET error = 'x' WHERE kind = 'insights'")) === 3);

await reset();
await run('DELETE FROM worker_tasks');
console.log(fail ? `\n${fail} failing` : '\nall pass');
await close();
process.exit(fail ? 1 : 0);
