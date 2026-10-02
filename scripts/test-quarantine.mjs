/**
 * A session that keeps collecting nothing is set aside.
 *
 * What this is for: three accounts here spent six hours returning nothing on
 * every run -- two with expired Workana sessions, one behind a proxy refusing
 * the connection -- while the rotation kept giving them turns and the board
 * said nothing. Neither failure raises an error; both just produce an empty
 * page, so "empty, repeatedly" is the only signal there is.
 *
 *   node scripts/test-quarantine.mjs
 *
 * Uses a temporary SQLite file. Touches no real data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-quarantine-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'quarantine-test-secret';
process.env.REQUIRE_PROXY = '0'; // tested elsewhere; keep this about empty runs
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

const { initDatabase } = await import('../src/db.js');
const { close } = await import('../src/sql.js');
const auth = await import('../src/auth.js');

let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};

await initDatabase();
const cookieJson = JSON.stringify([{ name: 'workana_session', value: 'q', domain: '.workana.com', path: '/' }]);
const good = await auth.registerUser({ email: 'quarantine-good@local.test', password: 'quarantine-1234', name: 'Good' });
const bad = await auth.registerUser({ email: 'quarantine-bad@local.test', password: 'quarantine-1234', name: 'Bad' });
for (const u of [good, bad]) await auth.setWorkanaCookies(u.id, cookieJson);

const ids = async () => (await auth.scrapeCandidates()).map((u) => u.id);
const blocked = async (id) => auth.scrapeBlocker(await auth.findUser(id));

ok('both sessions start in the rotation', (await ids()).length === 2);

// Enrichment reads no list pages, so finding no jobs there means nothing.
for (let i = 0; i < 5; i++) await auth.recordRunOutcome(bad.id, { listPages: 0, seen: 0 });
ok('runs that read no list pages never count against a session', (await blocked(bad.id)) === null);

await auth.recordRunOutcome(bad.id, { listPages: 1, seen: 0 });
await auth.recordRunOutcome(bad.id, { listPages: 1, seen: 0 });
ok(`${auth.EMPTY_RUNS_BEFORE_BLOCK - 1} empty runs are not enough`, (await blocked(bad.id)) === null);
ok('...and it is still in the rotation', (await ids()).includes(bad.id));

const reason = await auth.recordRunOutcome(bad.id, { listPages: 1, seen: 0 });
ok(`${auth.EMPTY_RUNS_BEFORE_BLOCK} in a row sets the session aside`, Boolean(reason));
ok('the reason names both possible causes', /expired|proxy/i.test(reason || ''), (reason || '').slice(0, 70));
ok('it leaves the rotation', !(await ids()).includes(bad.id));
ok('the other session is untouched', (await ids()).includes(good.id) && (await blocked(good.id)) === null);
ok('the board can show it', auth.publicUser(await auth.findUser(bad.id)).scrapeBlocked === reason);

// A good run must clear the count, since throttling also looks like an empty page.
await auth.recordRunOutcome(good.id, { listPages: 1, seen: 0 });
await auth.recordRunOutcome(good.id, { listPages: 1, seen: 0 });
await auth.recordRunOutcome(good.id, { listPages: 1, seen: 22 });
await auth.recordRunOutcome(good.id, { listPages: 1, seen: 0 });
await auth.recordRunOutcome(good.id, { listPages: 1, seen: 0 });
ok('one good run resets the count, so a throttled page is forgiven', (await blocked(good.id)) === null);

// The two fixes a member can apply must let them try again at once.
await auth.setWorkanaCookies(bad.id, cookieJson);
ok('attaching a fresh session lifts it', (await blocked(bad.id)) === null && (await ids()).includes(bad.id));

await auth.recordRunOutcome(bad.id, { listPages: 1, seen: 0 });
await auth.recordRunOutcome(bad.id, { listPages: 1, seen: 0 });
await auth.recordRunOutcome(bad.id, { listPages: 1, seen: 0 });
ok('it can be set aside again', Boolean(await blocked(bad.id)));
await auth.setWorkanaProxy(bad.id, 'socks5://198.51.100.9:1080');
ok('saving a proxy lifts it too', (await blocked(bad.id)) === null && (await ids()).includes(bad.id));

await close();
console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
