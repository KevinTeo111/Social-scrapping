/**
 * The account window opens by itself when something must be entered.
 *
 * A member whose own session has stopped working sees a board that looks
 * perfectly healthy -- the jobs are all there, filled in by everyone else's
 * scraping -- and nothing tells them their account has been set aside. So the
 * window is opened at the one moment they are certainly looking: arrival.
 *
 *   node scripts/test-prompt.mjs
 *
 * Drives a real browser against a board on a temporary SQLite file.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-prompt-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'prompt-test-secret';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

const PORT = Number(process.env.PORT || 4450);
const BASE = `http://127.0.0.1:${PORT}`;
let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const board = spawn(process.execPath, ['src/server.js', '--role=web'], {
  env: { ...process.env, PORT: String(PORT), REQUIRE_PROXY: '1', AUTO_SCRAPE_MINUTES: '0', SWEEP_MINUTES: '0', DEEP_MINUTES: '0' },
  stdio: ['ignore', fs.openSync(path.join(dir, 'board.log'), 'w'), 'inherit'],
});

const { initDatabase } = await import('../src/db.js');
const { close } = await import('../src/sql.js');
const auth = await import('../src/auth.js');
const { chromium } = await import('playwright');
const browser = await chromium.launch();

const cookieJson = JSON.stringify([{ name: 'workana_session', value: 'p', domain: '.workana.com', path: '/' }]);

/** Signs in as `email` in a fresh browser and reports what the board shows. */
async function arrive(email) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE);
  await page.evaluate(async (e) => {
    await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: e, password: 'prompt-test-1234' }) });
  }, email);
  await page.goto(BASE);
  await page.waitForSelector('table.jobs', { timeout: 15_000 }).catch(() => {});
  await sleep(2500); // the window opens once the board has loaded
  const shown = await page.isVisible('#accountBackdrop').catch(() => false);
  const text = shown ? await page.textContent('#accountModal') : '';
  const focused = await page.evaluate(() => document.activeElement?.id || null);
  await context.close();
  return { shown, text, focused };
}

try {
  await initDatabase();
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch {}
    await sleep(500);
  }

  // The owner registers first; everyone else is an ordinary member.
  await auth.registerUser({ email: 'prompt-owner@local.test', password: 'prompt-test-1234', name: 'Owner' });
  const fresh = await auth.registerUser({ email: 'prompt-fresh@local.test', password: 'prompt-test-1234', name: 'Fresh' });
  const noProxy = await auth.registerUser({ email: 'prompt-noproxy@local.test', password: 'prompt-test-1234', name: 'NoProxy' });
  const broken = await auth.registerUser({ email: 'prompt-broken@local.test', password: 'prompt-test-1234', name: 'Broken' });
  const fine = await auth.registerUser({ email: 'prompt-fine@local.test', password: 'prompt-test-1234', name: 'Fine' });

  await auth.setWorkanaCookies(noProxy.id, cookieJson);
  for (const u of [broken, fine]) {
    await auth.setWorkanaCookies(u.id, cookieJson);
    await auth.setWorkanaProxy(u.id, 'socks5://198.51.100.3:1080');
  }
  await auth.recordProxyCheck(broken.id, { ok: false, detail: 'the proxy rejected its credentials — auth err user=*** pass=***' });
  await auth.recordCookieCheck(broken.id, { valid: false });

  let r = await arrive('prompt-fresh@local.test');
  ok('a member who has never added a session is asked at once', r.shown);
  ok('...for the session', /Your Workana session/.test(r.text), r.focused ? `focus: ${r.focused}` : '');

  r = await arrive('prompt-noproxy@local.test');
  ok('a member with no proxy is asked at once', r.shown);
  ok('...and the proxy field is where the cursor lands', r.focused === 'proxyBox', `focus: ${r.focused}`);

  r = await arrive('prompt-broken@local.test');
  ok('a member whose session and proxy both failed is asked at once', r.shown);
  ok('...and told what each fault was',
    /must be entered again/i.test(r.text) && /rejected its credentials/i.test(r.text) && /expired|signed out/i.test(r.text));
  ok('...without the credentials in it', !/bgjay|XX4tjy/.test(r.text));

  r = await arrive('prompt-fine@local.test');
  ok('a member with everything in order is left alone', r.shown === false);
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
} finally {
  await browser.close();
  board.kill('SIGKILL');
  await close().catch(() => {});
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
