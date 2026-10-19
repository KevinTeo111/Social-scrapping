/**
 * The status poll follows what is happening, because it is the hosting bill.
 *
 * Every poll goes through the Vercel function, which proxies it over the tunnel
 * to the workstation and is billed for provisioned memory the whole time it
 * waits -- about 1.2 s a call, against 1.3 ms asking the board directly. At a
 * flat five seconds one open tab was 17,280 calls a day; five members came to
 * roughly 29 function-hours a day, which spent three quarters of a month's free
 * tier in three weeks. Past the allowance the projects are paused, so this is
 * not a tuning preference.
 *
 *   node scripts/test-polling.mjs
 *
 * Board on a temporary SQLite file; the rates are read from the real page.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-poll-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'poll-test-secret';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

const PORT = Number(process.env.PORT || 4478);
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
    await page.waitForFunction(() => typeof window.pollDelay === 'function', null, { timeout: 15_000 });

    const delayWhen = (hidden, scraping) =>
      page.evaluate(([h, sc]) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
        window.pollStatus.scraping = sc;
        return window.pollDelay();
      }, [hidden, scraping]);

    const visibleActive = await delayWhen(false, true);
    const visibleIdle = await delayWhen(false, false);
    const hiddenIdle = await delayWhen(true, false);
    const hiddenActive = await delayWhen(true, true);

    ok('a run in view is watched closely', visibleActive === 5000, `${visibleActive} ms`);
    ok('an idle board in view is asked less often', visibleIdle === 20000, `${visibleIdle} ms`);
    ok('...which is slower than during a run', visibleIdle > visibleActive);
    ok('a hidden tab drops to a heartbeat', hiddenIdle === 60000, `${hiddenIdle} ms`);
    ok('...even while a run is going, since nobody is watching it', hiddenActive === 60000, `${hiddenActive} ms`);

    /* A hidden tab still has to poll: that is what fires the alerts, and the
     * scraper only looks for new postings every two minutes anyway. */
    ok('a hidden tab is not silenced altogether', hiddenIdle > 0 && hiddenIdle <= 120000);

    /* ---- what this costs ---- */
    const callsPerDay = (ms) => Math.round((24 * 3600 * 1000) / ms);
    const before = callsPerDay(5000);
    const after = callsPerDay(hiddenIdle);
    ok(`one tab left open overnight: ${before} calls/day -> ${after}`, after * 12 <= before);
    ok('five members cost less than a tenth of what they did',
      5 * after <= 5 * before / 10, `${5 * after} vs ${5 * before}`);

    /* ---- the chain must not stack calls behind a slow one ---- */
    const usesInterval = await page.evaluate(() => String(window.schedulePoll).includes('setInterval'));
    ok('the next poll is scheduled after the last one answers, not on a fixed interval', !usesInterval);
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
