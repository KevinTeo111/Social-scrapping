/**
 * The two-minute check for new postings does not queue behind a long job.
 *
 * Only one scrape runs at a time, which is what keeps two full walks off
 * Workana at once. The cost was that the quick check -- one page, under thirty
 * seconds, and the only thing that decides how fast a posting reaches the board
 * -- waited behind jobs holding the slot for six to thirty-five minutes. Over
 * twelve hours, 77 of an expected 360 quick checks ran, and a posting took a
 * median of ten minutes to appear.
 *
 * Enrichment is the one that gives way: nothing waits on any particular job
 * page, and the remainder of its budget is picked up by the next run. A list
 * walk is never interrupted, because only a walk that reaches the end can prove
 * a job is gone.
 *
 *   node scripts/test-yield.mjs
 *
 * Temporary SQLite file, no browser and no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-yield-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'yield-test-secret';
process.env.SWEEP_MINUTES = '2';
process.env.DEEP_MINUTES = '20';
process.env.AUTO_SCRAPE_MINUTES = '10';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};

const { initDatabase } = await import('../src/db.js');
const { close } = await import('../src/sql.js');
const { config } = await import('../src/config.js');
const { whichRunIsDue } = await import('../src/worker.js');
const { requestYield } = await import('../src/scraper/scrape.js');
const control = await import('../src/control.js');

try {
  await initDatabase();
  const iso = (ms) => new Date(ms).toISOString();
  const now = Date.now();
  const soon = iso(now + 60_000);
  const past = iso(now - 60_000);

  /* ---- a ceiling exists, and it is short enough to matter ---- */
  ok('enrichment has a ceiling on how long it may hold the slot', config.enrichMaxMinutes > 0);
  ok('...shorter than the quick check is tolerable to delay',
    config.enrichMaxMinutes <= 10, `${config.enrichMaxMinutes} min`);
  ok('...and the worst run measured (34.6 min) would now be cut short',
    config.enrichMaxMinutes < 34.6);

  /* ---- nothing to yield when nothing is running ---- */
  ok('asking an idle scraper to step aside does nothing', requestYield() === false);

  /* ---- the ordering the clocks are served in ---- */
  const due = (over) => whichRunIsDue({ paused: 0, next_deep_at: past, next_run_at: past, next_sweep_at: past, ...over }, now);
  ok('a deep walk outranks the others when all three are due', due({}).clock === 'deep');
  ok('enrichment comes next', due({ next_deep_at: soon }).clock === 'enrich');
  ok('the quick check runs when nothing else is due',
    due({ next_deep_at: soon, next_run_at: soon }).clock === 'sweep');
  ok('nothing runs when nothing is due',
    due({ next_deep_at: soon, next_run_at: soon, next_sweep_at: soon }) === null);
  ok('a paused board runs nothing at all', due({ paused: 1 }) === null);

  /* ---- the quick check stays cheap: that is why it may interrupt ---- */
  const sweep = due({ next_deep_at: soon, next_run_at: soon }).options;
  ok('the quick check reads one or two pages, no more', sweep.pages <= 2, String(sweep.pages));
  ok('...and opens no job pages', sweep.withDetails === false && sweep.insightBudget === 0);

  /* ---- a deep walk must never be cut short ---- */
  const deep = due({}).options;
  ok('a deep walk still goes to the end of the list', deep.pages === config.maxListPages);
  ok('...and is not an enrichment run, so nothing will ask it to yield', deep.kind === 'deep');

  /* ---- what this is worth, in the terms that were measured ---- */
  const walkMin = 8.7;
  const enrichMin = 5.9;
  const busyBefore = (22 * walkMin + 66 * enrichMin) / (12 * 60);
  const busyAfter = (22 * walkMin + 66 * Math.min(enrichMin, config.enrichMaxMinutes)) / (12 * 60);
  ok(`the slot was busy ${(busyBefore * 100).toFixed(0)}% of the time; walks alone are ${((22 * walkMin) / (12 * 60) * 100).toFixed(0)}%`,
    busyAfter <= busyBefore);
  ok('a quick check now waits on list walks only, not on enrichment',
    (22 * walkMin) / (12 * 60) < 0.35);
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
  console.log(err.stack);
} finally {
  await close().catch(() => {});
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
