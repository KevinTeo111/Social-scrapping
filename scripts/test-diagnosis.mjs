/**
 * Naming the cause when a member's scraping stops.
 *
 * An expired Workana session and a proxy refusing the connection end a run the
 * same way -- an empty list page, no error -- so a member is told "nothing was
 * collected" and has no idea which of the two to fix. Here the proxy is asked
 * directly (one CONNECT, no browser) and the answer is recorded against the
 * field that puts it right, so the account panel can ask for exactly that.
 *
 *   node scripts/test-diagnosis.mjs
 *
 * Runs real proxies of its own -- one that authenticates, one that demands
 * credentials, one that accepts and then says nothing -- on a temporary
 * database. Touches no real data and reaches no real network.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-diagnosis-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'diagnosis-test-secret';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

const { initDatabase } = await import('../src/db.js');
const { close } = await import('../src/sql.js');
const auth = await import('../src/auth.js');
const { checkProxy, redact } = await import('../src/scraper/proxy-check.js');

let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};

/** A proxy that behaves however the test needs it to. */
function fakeProxy(behaviour) {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () => {
      if (behaviour === 'ok') return socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (behaviour === 'auth') {
        // Quoting the credentials back is exactly what a real provider did.
        return socket.write(
          'HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 64\r\n\r\n' +
            'auth err user=bgjay4pjmc74 pass=XX4tjy7vB7ljEVv1 and ip not in white',
        );
      }
      if (behaviour === 'silent') return; // accepts, never answers
      socket.destroy();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const servers = {};
for (const b of ['ok', 'auth', 'silent']) servers[b] = await fakeProxy(b);
const url = (b) => `http://user:secret@127.0.0.1:${servers[b].address().port}`;

try {
  await initDatabase();

  /* ---- the proxy check itself ---- */
  let r = await checkProxy(url('ok'));
  ok('a working proxy reports ok', r.ok === true, r.detail);
  r = await checkProxy(url('auth'));
  ok('a proxy rejecting credentials is reported as such', r.ok === false && /credential/i.test(r.detail), r.detail);
  ok('and its reply never carries the credentials onward',
    !/bgjay4pjmc74|XX4tjy7vB7ljEVv1/.test(r.detail), r.detail);
  // A port that was listening a moment ago and is not any more: certainly closed.
  const closed = await fakeProxy('ok');
  const closedPort = closed.address().port;
  await new Promise((done) => closed.close(done));
  r = await checkProxy(`http://127.0.0.1:${closedPort}`);
  ok('an unreachable proxy says so', r.ok === false && /reach/i.test(r.detail), r.detail);
  r = await checkProxy(null);
  ok('no proxy at all is not a fault', r.ok === true, r.detail);
  ok('redaction covers the url form too', redact('socks5://me:pw@h:1080') === 'socks5://***:***@h:1080');

  const slow = Date.now();
  r = await checkProxy(url('silent'));
  ok('a proxy that never answers times out rather than hanging', r.ok === false && Date.now() - slow < 20_000,
    `${Math.round((Date.now() - slow) / 1000)}s: ${r.detail}`);

  /* ---- what the member is then asked to fix ---- */
  const user = await auth.registerUser({ email: 'diagnosis@local.test', password: 'diagnosis-1234', name: 'D' });
  await auth.setWorkanaCookies(user.id, JSON.stringify([{ name: 'workana_session', value: 'x', domain: '.workana.com', path: '/' }]));
  ok('a healthy account is asked for nothing', auth.brokenInputs(await auth.findUser(user.id)).length === 0);

  await auth.recordProxyCheck(user.id, await checkProxy(url('auth')));
  let needs = auth.brokenInputs(await auth.findUser(user.id));
  ok('a refused proxy asks for the proxy', needs.length === 1 && needs[0].field === 'proxy', JSON.stringify(needs[0]?.problem));

  await auth.recordCookieCheck(user.id, { valid: false });
  needs = auth.brokenInputs(await auth.findUser(user.id));
  ok('a rejected session asks for both fields', needs.length === 2 && needs.map((n) => n.field).sort().join() === 'proxy,session');
  ok('the board receives them', (auth.publicUser(await auth.findUser(user.id)).brokenInputs || []).length === 2);

  await auth.recordProxyCheck(user.id, await checkProxy(url('ok')));
  needs = auth.brokenInputs(await auth.findUser(user.id));
  ok('fixing the proxy leaves only the session', needs.length === 1 && needs[0].field === 'session');

  await auth.setWorkanaCookies(user.id, JSON.stringify([{ name: 'workana_session', value: 'y', domain: '.workana.com', path: '/' }]));
  ok('re-entering the session clears the last one', auth.brokenInputs(await auth.findUser(user.id)).length === 0);

  await auth.recordProxyCheck(user.id, await checkProxy(url('auth')));
  await auth.setWorkanaProxy(user.id, 'socks5://198.51.100.4:1080');
  ok('re-entering the proxy clears its own complaint', auth.brokenInputs(await auth.findUser(user.id)).length === 0);
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
} finally {
  for (const s of Object.values(servers)) s.close();
  await close().catch(() => {});
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
