/**
 * A member's Workana session may only be used once they have registered a proxy.
 *
 * Scraping happens on one machine, so without the rule a member's session goes
 * out through *that* machine's address -- Workana sees the account signing in
 * from another country, and Cloudflare challenges both of them. The owner is
 * exempt: the scraper runs on their machine, so their traffic is already theirs.
 *
 *   node scripts/test-require-proxy.mjs
 *
 * Runs its own board on a temporary SQLite file (ROLE=web, so nothing scrapes)
 * and creates two accounts there. Touches no real data.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-proxytest-'));
/*
 * Before anything imports config.js, which reads these once. Setting them later
 * pointed this test's own queries at the real database -- the board child had
 * the right file, so only the last checks were wrong, and quietly.
 */
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

const PORT = Number(process.env.PORT || 4440);
const BASE = `http://127.0.0.1:${PORT}`;
let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const board = spawn(process.execPath, ['src/server.js', '--role=web'], {
  env: {
    ...process.env,
    APP_SECRET: 'require-proxy-test-secret',
    PORT: String(PORT),
    REQUIRE_PROXY: '1',
    ALLOW_REGISTRATION: '1',
    REGISTRATION_CODE: '',
    AUTO_SCRAPE_MINUTES: '0',
    SWEEP_MINUTES: '0',
  },
  stdio: ['ignore', fs.openSync(path.join(dir, 'board.log'), 'w'), 'inherit'],
});

async function member(email) {
  const jar = [];
  const call = async (p, opts = {}) => {
    const res = await fetch(BASE + p, {
      ...opts,
      headers: { 'content-type': 'application/json', cookie: jar.join('; '), ...(opts.headers || {}) },
    });
    for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(';')[0]);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const creds = JSON.stringify({ email, password: 'proxy-test-1234', name: email });
  let r = await call('/api/register', { method: 'POST', body: creds });
  if (r.status !== 200) r = await call('/api/login', { method: 'POST', body: creds });
  if (r.status !== 200) throw new Error(`auth ${email}: ${JSON.stringify(r.body)}`);
  const cookies = JSON.stringify([{ name: 'workana_session', value: 'proxy-test', domain: '.workana.com', path: '/' }]);
  await call('/api/session/cookies', { method: 'POST', body: JSON.stringify({ cookies }) });
  return call;
}

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch {}
    await sleep(500);
  }

  const owner = await member('proxy-owner@local.test'); // registers first, so the owner
  const mate = await member('proxy-mate@local.test');

  let r = await mate('/api/me');
  ok('a member with no proxy is told one is required', r.body?.user?.proxyRequired === true);
  r = await owner('/api/me');
  ok('the owner is not, since the scraper is on their machine', r.body?.user?.proxyRequired === false);

  r = await mate('/api/scrape', { method: 'POST', body: '{}' });
  ok('Refresh is refused without a proxy', r.status === 403 && /proxy/i.test(r.body?.error || ''), `http ${r.status}`);
  ok('...and says so in a way the board can act on', r.body?.proxyRequired === true);
  r = await mate('/api/session/verify', { method: 'POST' });
  ok('Verify is refused too', r.status === 403, `http ${r.status}`);
  r = await mate('/api/insights/some-job', { method: 'POST' });
  ok('contact lookups are refused too', r.status === 403, `http ${r.status}`);

  /*
   * The owner gets past the proxy rule and is stopped by the next thing instead
   * -- no scraper is running in this test -- which is what proves the rule let
   * them through rather than the request failing for some other reason.
   */
  r = await owner('/api/scrape', { method: 'POST', body: '{}' });
  ok('the owner is allowed past the proxy rule', r.status === 503 && /offline/i.test(r.body?.error || ''), `http ${r.status}`);

  r = await mate('/api/session/proxy', { method: 'POST', body: JSON.stringify({ proxy: 'socks5://198.51.100.7:1080' }) });
  ok('a member can register a proxy', r.status === 200, `http ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
  r = await mate('/api/me');
  ok('the requirement then lifts', r.body?.user?.proxyRequired === false && Boolean(r.body?.user?.proxy));
  r = await mate('/api/scrape', { method: 'POST', body: '{}' });
  ok('and Refresh gets past the rule', r.status === 503, `http ${r.status}`);

  // The scheduler must not borrow a session it may not use.
  const { initDatabase } = await import('../src/db.js');
  const { run, close } = await import('../src/sql.js');
  await initDatabase();
  let ids = await scrapeCandidateIds();
  ok('the background refresh will use both now', ids.length === 2, ids.join(','));
  await run("UPDATE users SET workana_proxy = NULL WHERE email = 'proxy-mate@local.test'");
  ids = await scrapeCandidateIds();
  ok('a member without a proxy is skipped by the background refresh', ids.length === 1, ids.join(','));
  await close();

  async function scrapeCandidateIds() {
    const { scrapeCandidates } = await import('../src/auth.js');
    return (await scrapeCandidates()).map((u) => u.id);
  }
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
} finally {
  board.kill('SIGKILL');
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
