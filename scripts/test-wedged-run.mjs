/**
 * A run that hangs must not stop the board scraping for ever.
 *
 * The failure this reproduces: a scrape wedged mid-run, the scraper's own
 * watchdog abandoned it, but the worker -- still awaiting a promise that never
 * settled -- went on renewing that run's lease. The slot then looked healthy in
 * the database, so nothing was scheduled again and the board quietly stopped
 * scraping while insisting it was fine.
 *
 * The wedge is real, not simulated: the member's traffic is pointed at a socket
 * that accepts connections and never answers, with a ten-minute navigation
 * timeout, so the scrape genuinely hangs. SCRAPE_MAX_MINUTES is at its five
 * minute floor, so the whole thing takes about eight minutes.
 *
 *   node scripts/test-wedged-run.mjs
 *
 * Runs its own scraper against a temporary SQLite file. Touches no real data.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-wedge-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'wedged-run-test-secret';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

const { initDatabase } = await import('../src/db.js');
const { get, close } = await import('../src/sql.js');
const { registerUser, setWorkanaCookies, setWorkanaProxy } = await import('../src/auth.js');

let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const control = () => get('SELECT state, run_token, started_at, lease_until, last_error, next_sweep_at FROM scrape_control WHERE id = 1');

// Accepts the connection, then says nothing at all: the scrape hangs on it.
const blackhole = net.createServer((socket) => socket.on('error', () => {}));
await new Promise((r) => blackhole.listen(0, '127.0.0.1', r));
const proxyPort = blackhole.address().port;
console.log(`black-hole proxy on 127.0.0.1:${proxyPort}\n`);

await initDatabase();
const user = await registerUser({ email: 'wedge@local.test', password: 'wedge-test-1234', name: 'Wedge' });
await setWorkanaCookies(user.id, JSON.stringify([{ name: 'workana_session', value: 'wedge', domain: '.workana.com', path: '/' }]));
await setWorkanaProxy(user.id, `socks5://127.0.0.1:${proxyPort}`);

const worker = spawn(process.execPath, ['src/server.js', '--role=worker'], {
  env: {
    ...process.env,
    SWEEP_MINUTES: '0.5',
    AUTO_SCRAPE_MINUTES: '0',
    SCRAPE_MAX_MINUTES: '5', // the floor
    NAV_TIMEOUT_MS: '600000', // long enough that the navigation itself never saves us
    DETAIL_BUDGET: '0',
    INSIGHT_BUDGET: '0',
  },
  stdio: ['ignore', fs.openSync(path.join(dir, 'worker.log'), 'w'), 'inherit'],
});

async function waitFor(what, fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(5000);
  }
  console.log(`  (timed out waiting for ${what} after ${Math.round(ms / 1000)} s)`);
  return false;
}

try {
  // The decision itself, which a hang cannot be relied on to provoke.
  const { runIsOver } = await import('../src/worker.js');
  const now = Date.now();
  const fresh = { inFlight: true, startedAt: now - 60_000 };
  ok('a healthy run is left alone', runIsOver(fresh, { scraping: true, now, maxRunMs: 2_700_000 }) === false);
  ok('a run the scraper no longer knows about is given up', runIsOver(fresh, { scraping: false, now, maxRunMs: 2_700_000 }) === true);
  ok('a run past the deadline is given up even while it claims to run',
    runIsOver({ inFlight: true, startedAt: now - 2_800_000 }, { scraping: true, now, maxRunMs: 2_700_000 }) === true);
  ok('a run still being prepared is not mistaken for a finished one',
    runIsOver({ inFlight: false, startedAt: now }, { scraping: false, now, maxRunMs: 2_700_000 }) === false);

  const started = await waitFor('a run to start', async () => (await control())?.state === 'running', 120_000);
  ok('a run starts and takes the slot', started);
  const wedged = await control();

  // While it hangs, the lease is renewed: this is what used to last for ever.
  await sleep(30_000);
  const during = await control();
  ok('the run is still holding the slot while it hangs', during?.state === 'running' && during.run_token === wedged.run_token);
  ok('its lease is being renewed', during.lease_until > wedged.lease_until);

  /*
   * Five minutes in, the scrape abandons itself; the worker must then hand the
   * slot back rather than renewing the lease of a run that is over.
   */
  /*
   * Freed either way: the scrape's watchdog closes the browser, which usually
   * makes the hung navigation fail and the run end on its own -- reporting
   * nothing, since a stop is not a failure. Only when that does not happen does
   * the loop give up on the promise itself (see runIsOver). What matters here
   * is that the slot comes back and the schedule continues, whichever path ran.
   */
  const freed = await waitFor('the slot to be freed', async () => (await control())?.state === 'idle', 420_000);
  ok('the wedged run is given up and the slot freed', freed);

  const scheduled = await waitFor('another run to be scheduled', async () => {
    const c = await control();
    return c?.state !== 'idle' || (c?.next_sweep_at && c.next_sweep_at > new Date().toISOString());
  }, 120_000);
  ok('scraping is scheduled again afterwards', scheduled);
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
} finally {
  worker.kill('SIGKILL');
  blackhole.close();
  await close().catch(() => {});
}

console.log(`\nworker log: ${path.join(dir, 'worker.log')}`);
console.log(fail ? `${fail} failing` : 'all pass');
process.exit(fail ? 1 : 0);
