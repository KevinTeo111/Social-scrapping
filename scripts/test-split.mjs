/**
 * The board as Vercel runs it, and a separate scraper process, end to end.
 *
 * Two processes that share only the database, exactly as deployed: the board is
 * api/index.js served as a bare (req, res) handler with VERCEL=1, and a hook
 * records any attempt of it to load Playwright; the scraper is
 * `src/server.js --role=worker`. Covers: scraper offline -> 503, two members
 * pressing Refresh at the same instant -> one 200 and one 409, progress reaching
 * the board, owner-only Stop actually ending the run, a login check routed
 * through the scraper, and a scraper killed outright being reported offline.
 *
 *   node --env-file=data\test.env scripts/test-split.mjs
 *
 * It starts real (short) scrapes with a fake session and creates two accounts,
 * so it refuses to run against a database not named "test". Takes ~3 minutes.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireTestDatabase } from './support/test-guard.mjs';

requireTestDatabase();

/*
 * Start from a known slot. A scraper killed outright a moment ago -- by an
 * earlier run of this test, say -- leaves its "last seen" fresh for up to a
 * minute, and the first assertions (scraper offline, Refresh refused) would then
 * be testing that leftover rather than this run.
 */
{
  const { initDatabase } = await import('../src/db.js');
  const { run, close } = await import('../src/sql.js');
  await initDatabase();
  await run(`UPDATE scrape_control SET state = 'idle', run_token = NULL, holder_user_id = NULL,
    run_trigger = NULL, options = NULL, started_at = NULL, lease_until = NULL, stop_requested = 0,
    paused = 0, progress = NULL, last_error = NULL, next_run_at = NULL, worker_id = NULL,
    worker_seen_at = NULL WHERE id = 1`);
  await run("DELETE FROM worker_tasks");
  await close();
}

const NODE = process.execPath;
const SP = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-split-'));
console.log(`logs: ${SP}\n`);
const PORT = 4411;
const BASE = `http://127.0.0.1:${PORT}`;
const PW_LOG = path.join(SP, 'pw-loads.txt');
fs.rmSync(PW_LOG, { force: true });
const common = { ...process.env, APP_SECRET: 'split-test-secret-not-real', AUTO_SCRAPE_MINUTES: '0' };

let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch {}
    await sleep(700);
  }
  console.log(`  (timed out waiting for: ${what})`);
  return false;
}

function start(name, args, env) {
  const out = fs.openSync(path.join(SP, `${name}.log`), 'w');
  return spawn(NODE, args, { env, stdio: ['ignore', out, out] });
}

async function member(email) {
  const jar = [];
  const call = async (p, opts = {}) => {
    const res = await fetch(BASE + p, {
      ...opts,
      headers: { 'content-type': 'application/json', cookie: jar.join('; '), ...(opts.headers || {}) },
    });
    for (const c of res.headers.getSetCookie?.() || []) jar.push(c.split(';')[0]);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const creds = JSON.stringify({ email, password: 'split-test-1234', name: email });
  let r = await call('/api/register', { method: 'POST', body: creds });
  if (r.status !== 200) r = await call('/api/login', { method: 'POST', body: creds });
  if (r.status !== 200) throw new Error(`auth ${email}: ${JSON.stringify(r.body)}`);
  const cookies = JSON.stringify([{ name: 'workana_session', value: 'split-test', domain: '.workana.com', path: '/' }]);
  await call('/api/session/cookies', { method: 'POST', body: JSON.stringify({ cookies }) });
  return call;
}

const board = start('board', ['--import', './scripts/support/no-playwright-hook.mjs', 'scripts/support/vercel-harness.mjs'],
  { ...common, PORT: String(PORT), VERCEL: '1', PW_LOG });
let worker = null;
try {
  const up = await until('board', async () => (await fetch(BASE + '/healthz')).ok, 30_000);
  ok('board (Vercel handler) comes up', up);
  if (!up) throw new Error(`the board did not start — see ${path.join(SP, 'board.log')}`);

  const a = await member('split-owner@local.test'); // first account: the owner
  const b = await member('split-member@local.test');

  let s = await a('/api/status');
  ok('status works through the handler', s.status === 200, `http ${s.status}`);
  ok('no scraper yet -> reported offline', s.body.workerOnline === false);
  let r = await a('/api/scrape', { method: 'POST', body: JSON.stringify({ pages: 1 }) });
  ok('Refresh with the scraper offline -> 503, not a silent queue', r.status === 503 && /offline/i.test(r.body.error), `http ${r.status}`);
  r = await a('/api/session/verify', { method: 'POST' });
  ok('login check with the scraper offline -> 503', r.status === 503);

  worker = start('worker', ['src/server.js', '--role=worker'],
    { ...common, DETAIL_BUDGET: '0', INSIGHT_BUDGET: '0' });
  ok('scraper comes online (seen by the board)', await until('online', async () => (await a('/api/status')).body.workerOnline === true, 45_000));

  const [ra, rb] = await Promise.all([
    a('/api/scrape', { method: 'POST', body: JSON.stringify({ pages: 1 }) }),
    b('/api/scrape', { method: 'POST', body: JSON.stringify({ pages: 1 }) }),
  ]);
  const codes = [ra.status, rb.status].sort().join(',');
  ok('two simultaneous Refresh -> exactly one 200 and one 409', codes === '200,409', codes);
  const winner = ra.status === 200 ? a : b;
  const loser = ra.status === 200 ? b : a;

  ok('the scraper picks the run up', await until('running', async () => (await a('/api/status')).body.scraping === true, 20_000));
  s = await winner('/api/status');
  ok('the winner sees it as theirs', s.body.scrapingMine === true && s.body.scrapingAuto === false);
  s = await loser('/api/status');
  ok('the other member sees another member, not themselves', s.body.scrapingMine === false && s.body.scraping === true);
  r = await loser('/api/scrape', { method: 'POST', body: JSON.stringify({ pages: 250 }) });
  ok('a Full crawl during the run is refused', r.status === 409 && /Another member/.test(r.body.error), r.body.error);
  r = await winner('/api/scrape', { method: 'POST', body: '{}' });
  ok('the runner pressing again is told it is theirs', r.status === 409 && /Your scrape/.test(r.body.error), r.body.error);

  const progressSeen = await until('progress', async () => Boolean((await a('/api/status')).body.progress), 20_000);
  ok('progress travels from the scraper to the board', progressSeen);

  r = await b('/api/scrape/stop', { method: 'POST' });
  ok('a non-owner cannot stop', r.status === 403, `http ${r.status}`);
  r = await a('/api/scrape/stop', { method: 'POST' });
  ok('the owner can stop', r.status === 200 && r.body.paused === true);
  ok('the run actually ends and frees the slot', await until('idle', async () => (await a('/api/status')).body.scraping === false, 30_000));
  s = await a('/api/status');
  ok('the clock stays held after a stop', s.body.paused === true && s.body.nextRunAt === null);
  r = await a('/api/scrape/resume', { method: 'POST' });
  ok('resume', r.status === 200 && r.body.paused === false);

  r = await a('/api/session/verify', { method: 'POST' });
  ok('login check round-trips through the scraper', r.status === 200 && r.body.loggedIn === false, `http ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);

  // The PC switched off: kill the scraper without any chance to say goodbye.
  worker.kill('SIGKILL');
  worker = null;
  ok('a scraper that vanishes is reported offline within a minute',
    await until('offline', async () => (await a('/api/status')).body.workerOnline === false, 75_000));
  r = await a('/api/scrape', { method: 'POST', body: '{}' });
  ok('...and Refresh says so instead of queueing', r.status === 503);

  const loads = fs.existsSync(PW_LOG) ? fs.readFileSync(PW_LOG, 'utf8').trim() : '';
  ok('the board never loaded Playwright', loads === '', loads);
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
} finally {
  worker?.kill('SIGKILL');
  board.kill('SIGKILL');
}
console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
