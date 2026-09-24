/**
 * The Vercel front door: api/index.js with BOARD_ORIGIN set, forwarding to the
 * board on this machine.
 *
 * Checks the things a proxy usually gets wrong: the page and its static files
 * come through, sign-in cookies survive (and are marked Secure, because TLS
 * ended at the front door), the invite gate still refuses strangers, signed-in
 * data arrives, and a board that is switched off produces a plain 502 rather
 * than a timeout.
 *
 *   run.cmd start                     (the board must be running)
 *   node --env-file=data\local.env scripts/test-frontdoor.mjs
 *
 * It registers an account ending in @local.test on whatever board BOARD is
 * pointing at, and deletes it afterwards.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BOARD = process.env.BOARD || 'http://127.0.0.1:4300';
const PORT = Number(process.env.FRONT_PORT || 4420);
const DEAD_PORT = PORT + 1;
const FRONT = `http://127.0.0.1:${PORT}`;
const email = 'frontdoor-probe@local.test';
const password = 'frontdoor-probe-1234';

let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SP = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-front-'));
const start = (name, env) =>
  spawn(process.execPath, ['scripts/support/vercel-harness.mjs'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', fs.openSync(path.join(SP, `${name}.log`), 'w'), 'inherit'],
  });

const front = start('front', { PORT: String(PORT), BOARD_ORIGIN: BOARD });
// A second front door aimed at nothing, for the "board is off" case.
const orphan = start('orphan', { PORT: String(DEAD_PORT), BOARD_ORIGIN: 'http://127.0.0.1:9' });

const jar = [];
const call = async (p, opts = {}, base = FRONT) => {
  const res = await fetch(base + p, {
    ...opts,
    redirect: 'manual',
    headers: { 'content-type': 'application/json', cookie: jar.join('; '), ...(opts.headers || {}) },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) jar.push(c.split(';')[0]);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, setCookie, type: res.headers.get('content-type') || '' };
};

try {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${FRONT}/healthz`)).ok) break; } catch {}
    await sleep(500);
  }
  const code = (fs.readFileSync('data/local.env', 'utf8').match(/^REGISTRATION_CODE=(.+)$/m) || [])[1]?.trim();

  let r = await call('/healthz');
  ok('health check passes through', r.status === 200 && r.body?.ok === true, `http ${r.status}`);

  r = await call('/');
  ok('the board page comes through', r.status === 200 && /Workana/i.test(r.body) && r.type.includes('html'), `http ${r.status}`);
  r = await call('/app.js');
  ok('its static files come through', r.status === 200 && r.body.length > 10_000, `${r.body.length} bytes`);

  r = await call('/api/register', { method: 'POST', body: JSON.stringify({ email, password, name: 'Probe' }) });
  ok('the invite gate still refuses strangers', r.status === 403, `http ${r.status}`);

  r = await call('/api/register', { method: 'POST', body: JSON.stringify({ email, password, name: 'Probe', inviteCode: code }) });
  if (r.status !== 200) r = await call('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  ok('signing in works through the front door', r.status === 200, `http ${r.status}`);
  ok('the session cookie survives and is marked Secure', r.setCookie.some((c) => /wk_session=/.test(c) && /Secure/.test(c)),
    r.setCookie.join(' | ').replace(/wk_session=[^;]+/, 'wk_session=***'));

  r = await call('/api/jobs?limit=5&sort=newest');
  ok('signed-in data arrives', r.status === 200 && Array.isArray(r.body.jobs) && r.body.jobs.length === 5,
    `${r.body?.total} jobs total`);
  r = await call('/api/status');
  ok('status (and the scraper it reports) arrives', r.status === 200 && typeof r.body.workerOnline === 'boolean',
    `scraper online: ${r.body?.workerOnline}`);

  r = await call('/api/flags/' + encodeURIComponent(r.body?.lastRun ? 'nope' : 'nope'), { method: 'POST', body: JSON.stringify({ starred: true }) });
  ok('writes pass through too', r.status === 200 || r.status === 404, `http ${r.status}`);

  const t0 = Date.now();
  r = await call('/healthz', {}, `http://127.0.0.1:${DEAD_PORT}`);
  ok('a board that is off gives a clear 502, quickly', r.status === 502 && /not reachable/i.test(r.body?.error || ''),
    `http ${r.status} in ${Date.now() - t0} ms`);
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
} finally {
  front.kill('SIGKILL');
  orphan.kill('SIGKILL');
}

// Tidy up the probe account on whichever board was used.
try {
  const { initDatabase } = await import('../src/db.js');
  const { all, run, close } = await import('../src/sql.js');
  await initDatabase();
  for (const u of await all('SELECT id, email FROM users WHERE email = ?', [email])) {
    await run('DELETE FROM user_jobs WHERE user_id = ?', [u.id]);
    await run('DELETE FROM sessions WHERE user_id = ?', [u.id]);
    await run('DELETE FROM users WHERE id = ?', [u.id]);
    console.log(`      (removed probe account ${u.email})`);
  }
  await close();
} catch (err) {
  console.log(`      (could not remove the probe account: ${err.message})`);
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
