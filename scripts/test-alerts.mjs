/**
 * What earns an alert: a posting that has just gone up, or an older one whose
 * client has just replied. Nothing else.
 *
 * The rule used to be "this row arrived in our database since the last check",
 * which is a different question. Once the deep walk started reaching further
 * than before, it began discovering projects that were weeks old and had simply
 * never been collected -- 83 of 98 in one three-hour stretch -- and every one
 * of them was announced as new. The board cried wolf often enough that the
 * alerts stopped meaning anything.
 *
 *   node scripts/test-alerts.mjs
 *
 * Board on a temporary SQLite file; the rule is evaluated in a real browser,
 * because that is where it runs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-alerts-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'alerts-test-secret';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

const PORT = Number(process.env.PORT || 4472);
const BASE = `http://127.0.0.1:${PORT}`;
let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const board = spawn(process.execPath, ['src/server.js', '--role=web'], {
  env: { ...process.env, PORT: String(PORT), AUTO_SCRAPE_MINUTES: '0', SWEEP_MINUTES: '0', DEEP_MINUTES: '0' },
  stdio: ['ignore', fs.openSync(path.join(dir, 'board.log'), 'w'), 'inherit'],
});

try {
  const { initDatabase } = await import('../src/db.js');
  const { close } = await import('../src/sql.js');
  await initDatabase();
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch {}
    await sleep(500);
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.waitForFunction(() => typeof window.alertReason === 'function', null, { timeout: 15_000 });

    const reason = (job) => page.evaluate((j) => window.alertReason(j, Date.now()), job);
    const ago = (ms) => new Date(Date.now() - ms).toISOString();
    const MIN = 60_000;

    /* ---- a posting that has just gone up ---- */
    ok('a posting from a minute ago is announced',
      (await reason({ published_approx_at: ago(1 * MIN), first_seen_at: ago(1 * MIN) })) === 'new');
    ok('...and one from nineteen minutes ago still is',
      (await reason({ published_approx_at: ago(19 * MIN), first_seen_at: ago(1 * MIN) })) === 'new');
    ok('...but not one from half an hour ago',
      (await reason({ published_approx_at: ago(30 * MIN), first_seen_at: ago(1 * MIN) })) === null);

    /* ---- the case that caused all the noise ---- */
    const fortnight = { published_approx_at: ago(14 * 24 * 60 * MIN), first_seen_at: ago(1 * MIN) };
    ok('a fortnight-old posting found just now is NOT announced',
      (await reason(fortnight)) === null, 'this is the bug the rule exists for');

    /* ---- unless the client is active on it ---- */
    ok('...unless the client replied two minutes ago',
      (await reason({ ...fortnight, last_reply_at: ago(2 * MIN) })) === 'reply');
    ok('...a reply nine minutes ago still counts',
      (await reason({ ...fortnight, last_reply_at: ago(9 * MIN) })) === 'reply');
    ok('...but one from half an hour ago does not',
      (await reason({ ...fortnight, last_reply_at: ago(30 * MIN) })) === null);
    ok('...nor one from yesterday',
      (await reason({ ...fortnight, last_reply_at: ago(24 * 60 * MIN) })) === null);

    /* ---- a new posting wins even without a reply ---- */
    ok('a fresh posting needs no reply to qualify',
      (await reason({ published_approx_at: ago(2 * MIN), first_seen_at: ago(2 * MIN), last_reply_at: null })) === 'new');

    /* ---- when Workana gave no publication date ---- */
    ok('with no posted date, when we found it is all there is',
      (await reason({ published_approx_at: null, first_seen_at: ago(2 * MIN) })) === 'new');
    ok('...and an old find with no posted date is not announced',
      (await reason({ published_approx_at: null, first_seen_at: ago(90 * MIN) })) === null);
    ok('...unless its client just replied',
      (await reason({ published_approx_at: null, first_seen_at: ago(90 * MIN), last_reply_at: ago(1 * MIN) })) === 'reply');

    /* ---- nothing usable at all ---- */
    ok('a row with nothing to judge by is not announced',
      (await reason({ published_approx_at: null, first_seen_at: 'not a date' })) === null);

    /* ---- the proportions from the real board ---- */
    const sample = [];
    for (let i = 0; i < 83; i++) sample.push({ published_approx_at: ago(14 * 24 * 60 * MIN), first_seen_at: ago(1 * MIN) });
    for (let i = 0; i < 12; i++) sample.push({ published_approx_at: ago(3 * MIN), first_seen_at: ago(1 * MIN) });
    const announced = await page.evaluate(
      (rows) => rows.filter((r) => window.alertReason(r, Date.now())).length,
      sample,
    );
    ok('of the 95 rows that caused this, only the 12 real postings are announced',
      announced === 12, `${announced} announced`);
  } finally {
    await browser.close();
  }
  await close().catch(() => {});
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
} finally {
  board.kill('SIGKILL');
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
