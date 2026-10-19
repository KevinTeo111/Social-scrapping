/**
 * A walk that comes back signed out stops, and says so.
 *
 * A Workana session can expire without anything looking broken. The page still
 * loads, the walk still collects, and the run reports hundreds of jobs -- but
 * they are the thinner list Workana shows a visitor: nine to a page instead of
 * twenty-two, no client name, country, rating or hire rate, and running far
 * deeper into old postings. Two accounts here spent weeks like that, still
 * taking their turn in the rotation, filling the board with anonymous rows and
 * announcing fortnight-old projects as new. The quarantine never fired, because
 * a run that collects 449 jobs does not look empty.
 *
 *   node scripts/test-signed-out.mjs
 *
 * Temporary SQLite file; the rotation and the gate are exercised directly,
 * since the browser half is one DOM query.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-signedout-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'signed-out-test-secret';
process.env.REQUIRE_PROXY = '0';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};

const { initDatabase } = await import('../src/db.js');
const { close } = await import('../src/sql.js');
const auth = await import('../src/auth.js');

const cookieJson = JSON.stringify([
  { name: 'workana_session', value: 's', domain: '.workana.com', path: '/' },
]);

try {
  await initDatabase();

  const u = await auth.registerUser({ email: 'out@local.test', password: 'signed-out-1234', name: 'Out' });
  await auth.setWorkanaCookies(u.id, cookieJson);

  const inRotation = async () => (await auth.scrapeCandidates()).some((c) => c.id === u.id);

  ok('a fresh session is in the rotation', await inRotation());

  /*
   * What the scraper does on finding itself signed out, which is the whole
   * mechanism: mark the session invalid. Everything else follows from that.
   */
  await auth.recordCookieCheck(u.id, { valid: false });

  ok('a session found signed out leaves the rotation at once', !(await inRotation()));

  const user = await auth.findUser(u.id);
  const needs = auth.brokenInputs(user);
  ok('...and the board is told what to ask for', needs.some((n) => n.field === 'session'), JSON.stringify(needs));
  ok('...with a reason worth showing someone',
    needs.find((n) => n.field === 'session')?.problem?.length > 10);
  ok('...and the list is closed to them until it is fixed', Boolean(auth.setupBlocker(user)));

  /* Re-entering the session has to undo all of it. */
  await auth.setWorkanaCookies(u.id, cookieJson);
  ok('re-entering the session puts them back in the rotation', await inRotation());
  ok('...and clears the complaint', auth.brokenInputs(await auth.findUser(u.id)).length === 0);

  /*
   * The case this exists for: a session that is not empty, merely degraded.
   * Collecting plenty must not be mistaken for being signed in.
   */
  const setAside = await auth.recordRunOutcome(u.id, { listPages: 50, seen: 449 });
  ok('a big anonymous haul never trips the empty-run quarantine by itself', !setAside);
  ok('...so it is still in the rotation on that evidence alone', await inRotation());
  await auth.recordCookieCheck(u.id, { valid: false });
  ok('...and only the signed-out check takes it out', !(await inRotation()));

  /* A session that is merely unverified must not be treated as broken. */
  const fresh = await auth.registerUser({ email: 'new@local.test', password: 'signed-out-1234', name: 'New' });
  await auth.setWorkanaCookies(fresh.id, cookieJson);
  const freshUser = await auth.findUser(fresh.id);
  ok('a session nobody has checked yet is given the benefit of the doubt',
    (await auth.scrapeCandidates()).some((c) => c.id === fresh.id));
  ok('...and is not reported as broken', auth.brokenInputs(freshUser).length === 0);

  /* The detection itself: the signed-in marker Workana puts on every page. */
  const marker = (html) => /logout/.test(html);
  ok('a page with a logout link reads as signed in', marker('<a href="/logout">Log out</a>'));
  ok('a page without one reads as signed out', !marker('<a href="/login">Sign in</a>'));
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
  console.log(err.stack);
} finally {
  await close().catch(() => {});
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
