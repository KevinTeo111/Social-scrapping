/**
 * The job list is not readable until a member has supplied what the board needs
 * to scrape as them.
 *
 * The corpus exists because members contribute their own sessions to collecting
 * it, and the failure this closes is quiet: a session expires, that member keeps
 * reading a board everyone else is filling, and the one person who can fix it
 * never notices. Checked at the routes as well as in the page, since a page is
 * bypassed with one fetch.
 *
 *   node scripts/test-gate.mjs
 *
 * Board on a temporary SQLite file, real browser for the page half.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-gate-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'gate-test-secret';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

const PORT = Number(process.env.PORT || 4460);
const BASE = `http://127.0.0.1:${PORT}`;
let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const board = spawn(process.execPath, ['src/server.js', '--role=web'], {
  env: { ...process.env, PORT: String(PORT), REQUIRE_PROXY: '1', REQUIRE_SETUP: '1',
         AUTO_SCRAPE_MINUTES: '0', SWEEP_MINUTES: '0', DEEP_MINUTES: '0' },
  stdio: ['ignore', fs.openSync(path.join(dir, 'board.log'), 'w'), 'inherit'],
});

const { initDatabase, upsertJob } = await import('../src/db.js');
const { close } = await import('../src/sql.js');
const auth = await import('../src/auth.js');
const cookieJson = JSON.stringify([{ name: 'workana_session', value: 'g', domain: '.workana.com', path: '/' }]);

async function signedIn(email) {
  const jar = [];
  const call = async (p, opts = {}) => {
    const res = await fetch(BASE + p, {
      ...opts,
      headers: { 'content-type': 'application/json', cookie: jar.join('; '), ...(opts.headers || {}) },
    });
    for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(';')[0]);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  await call('/api/login', { method: 'POST', body: JSON.stringify({ email, password: 'gate-test-1234' }) });
  return call;
}

try {
  await initDatabase();
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch {}
    await sleep(500);
  }
  const now = new Date().toISOString();
  await upsertJob({ slug: 'gate-test-job', url: 'https://www.workana.com/job/gate-test-job', title: 'Gate test job',
    publishedText: 'Just now', publishedApproxAt: now, listedAt: now });

  const owner = await auth.registerUser({ email: 'gate-owner@local.test', password: 'gate-test-1234', name: 'Owner' });
  const member = await auth.registerUser({ email: 'gate-member@local.test', password: 'gate-test-1234', name: 'Member' });

  /* ---- the routes ---- */
  const m = await signedIn('gate-member@local.test');
  let r = await m('/api/jobs?limit=5');
  ok('no session yet -> the list is refused', r.status === 403 && r.body.setupRequired === true, `http ${r.status}`);
  ok('...naming the session', (r.body.needs || []).includes('session'), JSON.stringify(r.body.needs));
  ok('...and one job page too', (await m('/api/jobs/gate-test-job')).status === 403);
  ok('...and the filter counts', (await m('/api/facets')).status === 403);
  ok('...and the statistics', (await m('/api/stats')).status === 403);
  ok('...and starring a job', (await m('/api/flags/gate-test-job', { method: 'POST', body: '{"starred":true}' })).status === 403);
  ok('but the account route stays open, so it can be fixed', (await m('/api/me')).status === 200);
  ok('and the status badge still answers', (await m('/api/status')).status === 200);

  await auth.setWorkanaCookies(member.id, cookieJson);
  r = await m('/api/jobs?limit=5');
  ok('a session alone is not enough while a proxy is required', r.status === 403 && (r.body.needs || []).includes('proxy'), JSON.stringify(r.body.needs));

  await auth.setWorkanaProxy(member.id, 'socks5://198.51.100.5:1080');
  r = await m('/api/jobs?limit=5');
  ok('session and proxy -> the list opens', r.status === 200 && r.body.total === 1, `http ${r.status}`);

  await auth.recordCookieCheck(member.id, { valid: false });
  r = await m('/api/jobs?limit=5');
  ok('a session later found expired closes it again', r.status === 403 && (r.body.needs || []).includes('session'));
  await auth.setWorkanaCookies(member.id, cookieJson);
  ok('re-entering it opens the list again', (await m('/api/jobs?limit=5')).status === 200);

  /* ---- the owner, who needs no proxy ---- */
  const o = await signedIn('gate-owner@local.test');
  ok('the owner is held back too while they have no session', (await o('/api/jobs?limit=5')).status === 403);
  await auth.setWorkanaCookies(owner.id, cookieJson);
  ok('...and let through on a session alone, needing no proxy', (await o('/api/jobs?limit=5')).status === 200);

  /* ---- the page ---- */
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const blocked = await auth.registerUser({ email: 'gate-locked@local.test', password: 'gate-test-1234', name: 'Locked' });
    void blocked;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(BASE);
    await page.evaluate(async () => {
      await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'gate-locked@local.test', password: 'gate-test-1234' }) });
    });
    await page.goto(BASE);
    await sleep(3000);
    ok('the page shows no job rows', (await page.locator('#rows tr').count()) === 0);
    ok('it says the list is waiting for details', /waiting for your details/i.test(await page.textContent('#empty')));
    ok('the account window is open over it', await page.isVisible('#accountBackdrop'));

    await page.keyboard.press('Escape');
    await sleep(400);
    ok('Escape does not dismiss it', await page.isVisible('#accountBackdrop'));
    await page.locator('#accountBackdrop').click({ position: { x: 5, y: 5 } });
    await sleep(400);
    ok('clicking outside does not dismiss it', await page.isVisible('#accountBackdrop'));
    await context.close();
  } finally {
    await browser.close();
  }
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
} finally {
  board.kill('SIGKILL');
  await close().catch(() => {});
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
