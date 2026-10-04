/**
 * How quickly a new posting reaches you: the quick check's schedule, the list
 * redrawing mid-run, and the browser alert.
 *
 *   A. A real scraper process with short clocks (quick check every 15 s, full
 *      refresh every 45 s) for about three and a half minutes. From scrape_runs:
 *      quick checks happen at their interval, full refreshes still happen --
 *      a quick check must never push the full refresh back -- and how long a
 *      quick check takes.
 *   B. The board in a real browser (Playwright), notifications recorded: a new
 *      job raises an alert; one outside the current filters does not; a run
 *      still in progress that has found new jobs redraws the list at once.
 *
 *   node --env-file=data\test.env scripts/test-freshness.mjs
 *
 * Scrapes Workana with a fake session (so, logged out) and creates an account,
 * so it refuses to run against a database not named "test". Takes ~5 minutes.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireTestDatabase } from './support/test-guard.mjs';

requireTestDatabase();
// Before anything imports secrets.js, which derives its key once at import.
process.env.APP_SECRET = 'freshness-test-secret-not-real';

const { initDatabase, upsertJob, startRun, finishRun } = await import('../src/db.js');
const { all, get, run, close } = await import('../src/sql.js');
const { registerUser, findUserByEmail, setWorkanaCookies } = await import('../src/auth.js');

let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SP = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-fresh-'));
console.log(`logs: ${SP}\n`);
const start = (name, args, env) =>
  spawn(process.execPath, args, { env, stdio: ['ignore', fs.openSync(path.join(SP, `${name}.log`), 'w'), 'inherit'] });

await initDatabase();
await run(`UPDATE scrape_control SET state = 'idle', run_token = NULL, holder_user_id = NULL, run_trigger = NULL,
  options = NULL, started_at = NULL, lease_until = NULL, stop_requested = 0, paused = 0, progress = NULL,
  last_error = NULL, next_run_at = NULL, next_sweep_at = NULL, worker_id = NULL, worker_seen_at = NULL WHERE id = 1`);
const email = 'fresh-owner@local.test';
const owner = (await findUserByEmail(email)) || (await registerUser({ email, password: 'fresh-test-1234', name: 'Fresh' }));
await setWorkanaCookies(owner.id, JSON.stringify([{ name: 'workana_session', value: 'fresh', domain: '.workana.com', path: '/' }]));

/* --------------------------------------------------------------- A0 */
/*
 * Which of the three clocks wins, and what each run is allowed to fetch. The
 * list walks must never open a job's own page: that is what made them slow.
 */
{
  const { whichRunIsDue } = await import('../src/worker.js');
  const now = Date.parse('2026-10-02T12:00:00Z');
  const past = new Date(now - 60_000).toISOString();
  const soon = new Date(now + 600_000).toISOString();
  const clock = (row) => whichRunIsDue(row, now)?.clock ?? null;
  ok('nothing due -> nothing runs', clock({ next_deep_at: soon, next_run_at: soon, next_sweep_at: soon }) === null);
  ok('the quick check runs when only it is due', clock({ next_deep_at: soon, next_run_at: soon, next_sweep_at: past }) === 'sweep');
  ok('all three due -> the deep walk wins', clock({ next_deep_at: past, next_run_at: past, next_sweep_at: past }) === 'deep');
  ok('enrichment outranks the quick check', clock({ next_deep_at: soon, next_run_at: past, next_sweep_at: past }) === 'enrich');
  ok('paused -> nothing runs', clock({ paused: 1, next_deep_at: past, next_run_at: past, next_sweep_at: past }) === null);

  const optionsFor = (row) => whichRunIsDue(row, now).options;
  const sweep = optionsFor({ next_deep_at: soon, next_run_at: soon, next_sweep_at: past });
  const deep = optionsFor({ next_deep_at: past, next_run_at: soon, next_sweep_at: soon });
  const enrich = optionsFor({ next_deep_at: soon, next_run_at: past, next_sweep_at: soon });
  ok('the quick check opens no job pages', sweep.withDetails === false && sweep.insightBudget === 0, JSON.stringify(sweep));
  ok('the deep walk reads every page and opens no job pages',
    deep.withDetails === false && deep.insightBudget === 0 && deep.pages >= 100, JSON.stringify(deep));
  ok('enrichment reads no list pages', enrich.pages === 0, JSON.stringify(enrich));
}

/* ---------------------------------------------------------------- A */
console.log('A. schedule (about 200 s)…');
const since = new Date().toISOString();
const worker = start('worker', ['src/server.js', '--role=worker'], {
  ...process.env,
  SWEEP_MINUTES: '0.25', // every 15 s
  AUTO_SCRAPE_MINUTES: '0.75', // enrichment, every 45 s
  DEEP_MINUTES: '1.5', // every 90 s, so one lands inside the window
  // The deep walk goes to the end of the list, which against the real site
  // outlasts this test; two pages is still "every page there is".
  MAX_LIST_PAGES: '2',
  REFRESH_PAGES: '2',
  DETAIL_BUDGET: '2',
  INSIGHT_BUDGET: '0',
});
await sleep(200_000);
worker.kill('SIGKILL');
await sleep(1500);

const runs = await all(
  `SELECT started_at, finished_at, pages FROM scrape_runs WHERE started_at >= ? AND finished_at IS NOT NULL ORDER BY started_at`,
  [since],
);
// The three clocks are told apart by how many list pages they read: the quick
// check one, the deep walk every page, enrichment none at all.
const quick = runs.filter((r) => Number(r.pages) === 1);
const deep = runs.filter((r) => Number(r.pages) >= 2);
const enrich = runs.filter((r) => Number(r.pages) === 0);
const secs = (a, b) => (new Date(b) - new Date(a)) / 1000;
const quickDur = quick.map((r) => secs(r.started_at, r.finished_at)).sort((a, b) => a - b);
const gaps = runs.slice(1).map((r, i) => secs(runs[i].started_at, r.started_at)).sort((a, b) => a - b);
const median = (a) => (a.length ? a[Math.floor((a.length - 1) / 2)] : NaN);
console.log(`  ${runs.length} runs: ${quick.length} quick checks, ${deep.length} deep walks, ${enrich.length} enrichment`);
console.log(`  quick check takes: median ${median(quickDur).toFixed(1)} s (min ${quickDur[0]?.toFixed(1)}, max ${quickDur.at(-1)?.toFixed(1)})`);
console.log(`  gap between run starts: median ${median(gaps).toFixed(1)} s`);
for (const r of runs) {
  const t = secs(since, r.started_at).toFixed(0).padStart(4);
  const kind = Number(r.pages) === 0 ? 'enrichment ' : Number(r.pages) === 1 ? 'quick check' : 'deep walk  ';
  console.log(`    +${t} s  ${kind}  ${secs(r.started_at, r.finished_at).toFixed(1)} s`);
}
ok('quick checks run repeatedly', quick.length >= 3, `${quick.length}`);
ok('enrichment still gets its turn (never pushed back by the quick checks)', enrich.length >= 1, `${enrich.length}`);
ok('the deep walk gets its turn too', deep.length >= 1, `${deep.length}`);
ok('runs follow each other closely (was 12.6 min apart)', median(gaps) < 45, `${median(gaps).toFixed(1)} s`);

/* ---------------------------------------------------------------- B */
console.log('\nB. the board in a browser…');
const PORT = 4414;
const board = start('board', ['scripts/support/vercel-harness.mjs'], { ...process.env, PORT: String(PORT), VERCEL: '1' });
const { chromium } = await import('playwright');
const browser = await chromium.launch();
try {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break; } catch {}
    await sleep(500);
  }
  const context = await browser.newContext();
  await context.addInitScript(() => {
    // Records notifications instead of showing them; permission already given.
    window.__notes = [];
    window.Notification = class {
      static permission = 'granted';
      static requestPermission() { return Promise.resolve('granted'); }
      constructor(title, opts) { window.__notes.push({ title, body: opts?.body }); }
      close() {}
    };
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.evaluate(async () => {
    await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'fresh-owner@local.test', password: 'fresh-test-1234' }) });
  });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('#alertsBtn');
  await page.click('#alertsBtn');
  ok('the Alerts button switches on at once', (await page.textContent('#alertsBtn')).includes('🔔'));

  const notes = () => page.evaluate(() => window.__notes);
  const addJob = async (title, finishRunToo = true) => {
    const slug = `fresh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    await upsertJob({ slug, url: `https://www.workana.com/job/${slug}`, title, publishedText: 'Just now',
      publishedApproxAt: now, listedAt: now, budgetText: 'USD 500', isHourly: false });
    if (finishRunToo) {
      const id = await startRun(owner.id);
      await finishRun(id, { ok: true, pages: 1, seen: 1, inserted: 1 });
    }
    return slug;
  };
  const waitFor = async (fn, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await sleep(500); }
    return false;
  };

  // Alerts count from the moment they are armed -- that is the promise to test.
  ok('alerts arm', await waitFor(() => page.evaluate(() => Boolean(alertCursor))));
  await addJob('Freshness test: python automation');
  ok('a new job raises a notification', await waitFor(async () =>
    (await notes()).some((n) => /python automation/.test(n.title))), JSON.stringify(await notes()));

  /*
   * Filters are a way of reading the board, not a subscription: a new posting
   * is announced whatever is typed in the search box at the time.
   */
  await page.fill('#search', 'python');
  await sleep(1500);
  await addJob('Freshness test: golang service');
  ok('a job outside the current filters is announced anyway', await waitFor(async () =>
    (await notes()).some((n) => /golang service/.test(n.title))), JSON.stringify(await notes()));
  await addJob('Freshness test: python scraper');
  ok('...as is one inside them', await waitFor(async () =>
    (await notes()).some((n) => /python scraper/.test(n.title))));

  /*
   * A job collected a while ago must not be announced because the filters
   * changed to include it: an alert is about something that just arrived.
   */
  const stale = await addJob('Freshness test: python legacy posting', false);
  await run('UPDATE jobs SET first_seen_at = ? WHERE slug = ?', [new Date(Date.now() - 45 * 60_000).toISOString(), stale]);
  await page.fill('#search', '');
  await sleep(1500);
  await page.evaluate(() => { alertCursor = new Date(Date.now() - 2 * 3600e3).toISOString(); });
  const beforeStale = (await notes()).length;
  const id = await startRun(owner.id);
  await finishRun(id, { ok: true, pages: 1, seen: 1, inserted: 1 });
  await sleep(9000);
  ok('a job collected 45 minutes ago is not announced now',
    !(await notes()).slice(beforeStale).some((n) => /legacy posting/.test(n.title)));

  // A run still in progress that reports new jobs: the list redraws now, not at the end.
  await page.fill('#search', '');
  await sleep(1500);
  await addJob('Freshness test: mid-run arrival', false);
  const now = Date.now();
  await run(`UPDATE scrape_control SET state = 'running', run_token = 'fresh-test', run_trigger = 'auto',
    options = ?, started_at = ?, lease_until = ?, progress = ? WHERE id = 1`,
    [JSON.stringify({ kind: 'full' }), new Date(now).toISOString(), new Date(now + 90_000).toISOString(),
      JSON.stringify({ phase: 'detail', done: 1, total: 9, newJobs: 1 })]);
  ok('mid-run, the list shows the new job before the run ends', await waitFor(async () =>
    (await page.textContent('table.jobs tbody')).includes('mid-run arrival')));
  ok('...and it is announced', await waitFor(async () => (await notes()).some((n) => /mid-run arrival/.test(n.title))));
  await run(`UPDATE scrape_control SET state = 'idle', run_token = NULL, run_trigger = NULL, options = NULL,
    started_at = NULL, lease_until = NULL, progress = NULL WHERE id = 1`);

  ok('each job announced once', (await notes()).length === new Set((await notes()).map((n) => n.title)).size,
    `${(await notes()).length} notifications`);
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
} finally {
  await browser.close();
  board.kill('SIGKILL');
}

await close();
console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
