/**
 * A client's "Last login" is converted with the zone that actually rendered it.
 *
 * Workana prints that field as a bare wall clock with no zone, drawn in the
 * zone of whoever is reading. While every scrape presented one zone a single
 * constant could stand in for it; once each member's identity presented its
 * own, that constant was wrong by a different amount per member, and the stored
 * instant drifted far enough that clients appeared to have posted projects
 * hours after they were last seen.
 *
 *   node scripts/test-client-clock.mjs
 *
 * Temporary SQLite file, no browser and no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-clock-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'clock-test-secret';
process.env.WORKANA_CLOCK_OFFSET_HOURS = '2';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};

const { initDatabase, upsertClient } = await import('../src/db.js');
const { get, close } = await import('../src/sql.js');
const { wallClockToUtc, offsetMinutesAt } = await import('../src/locale.js');

try {
  await initDatabase();

  /* ---- the conversion itself ---- */
  ok('a zone west of UTC pushes the instant later',
    wallClockToUtc('October 12, 2026 15:16', 'America/Los_Angeles') === '2026-10-12T22:16:00.000Z');
  ok('a zone east of UTC pulls it earlier',
    wallClockToUtc('October 12, 2026 15:16', 'Asia/Tokyo') === '2026-10-12T06:16:00.000Z');
  ok('UTC is a no-op',
    wallClockToUtc('October 12, 2026 15:16', 'UTC') === '2026-10-12T15:16:00.000Z');

  /* Daylight saving is followed, which a fixed offset cannot do. */
  ok('Rome is +2 in October', offsetMinutesAt('Europe/Rome', Date.parse('2026-10-12T12:00:00Z')) === 120);
  ok('...and +1 in January', offsetMinutesAt('Europe/Rome', Date.parse('2026-01-15T12:00:00Z')) === 60);
  ok('so the same wall clock converts differently across the year',
    wallClockToUtc('January 15, 2026 12:00', 'Europe/Rome') === '2026-01-15T11:00:00.000Z');

  ok('an unknown zone yields nothing, so the caller can fall back',
    wallClockToUtc('October 12, 2026 15:16', 'Mars/Olympus') === null);
  ok('unparseable text yields nothing', wallClockToUtc('whenever', 'UTC') === null);
  ok('no text yields nothing', wallClockToUtc(null, 'UTC') === null);

  /* ---- what gets stored ---- */
  const read = async (id) => get('SELECT last_login, last_login_at, clock_zone FROM clients WHERE id = ?', [id]);

  await upsertClient({ id: 'c-la', name: 'LA client', lastLogin: 'October 12, 2026 15:16' },
    { clockZone: 'America/Los_Angeles' });
  let r = await read('c-la');
  ok('the run zone decides the stored instant', r.last_login_at === '2026-10-12T22:16:00.000Z', r.last_login_at);
  ok('...the raw string is kept beside it', r.last_login === 'October 12, 2026 15:16');
  ok('...and the zone is recorded, so it can be re-derived', r.clock_zone === 'America/Los_Angeles');

  await upsertClient({ id: 'c-tokyo', name: 'Tokyo client', lastLogin: 'October 12, 2026 15:16' },
    { clockZone: 'Asia/Tokyo' });
  r = await read('c-tokyo');
  ok('the same wall clock read from another zone is a different instant',
    r.last_login_at === '2026-10-12T06:16:00.000Z', r.last_login_at);

  /* The whole point: one constant cannot serve both of the rows above. */
  const la = Date.parse((await read('c-la')).last_login_at);
  const tokyo = Date.parse((await read('c-tokyo')).last_login_at);
  ok('the two differ by exactly the gap between the zones',
    (la - tokyo) / 3600e3 === 16, String((la - tokyo) / 3600e3));

  /* ---- the fallback, for a read with no zone behind it ---- */
  await upsertClient({ id: 'c-none', name: 'No zone', lastLogin: 'October 12, 2026 15:16' });
  r = await read('c-none');
  ok('with no zone the configured constant still applies',
    r.last_login_at === '2026-10-12T13:16:00.000Z', r.last_login_at);
  ok('...and nothing is claimed about which zone it was', r.clock_zone === null);

  await upsertClient({ id: 'c-bad', name: 'Bad zone', lastLogin: 'October 12, 2026 15:16' },
    { clockZone: 'Mars/Olympus' });
  ok('an unusable zone falls back rather than storing nothing',
    (await read('c-bad')).last_login_at === '2026-10-12T13:16:00.000Z');

  /* ---- a re-read corrects an earlier row ---- */
  await upsertClient({ id: 'c-la', name: 'LA client', lastLogin: 'October 13, 2026 09:00' },
    { clockZone: 'America/Los_Angeles' });
  ok('a later read overwrites the instant', (await read('c-la')).last_login_at === '2026-10-13T16:00:00.000Z');

  /* ---- a client with no login at all ---- */
  await upsertClient({ id: 'c-empty', name: 'Never seen' }, { clockZone: 'Europe/Rome' });
  r = await read('c-empty');
  ok('a client with no last login stores none', r.last_login_at === null && r.clock_zone === null);

  /* ---- the invariant this was all about ---- */
  const posted = Date.parse('2026-10-12T20:25:00Z');
  const login = Date.parse(wallClockToUtc('October 12, 2026 15:16', 'America/Los_Angeles'));
  ok('a client read from Los Angeles is no longer last seen before they posted',
    login >= posted, `${new Date(login).toISOString()} vs ${new Date(posted).toISOString()}`);
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
  console.log(err.stack);
} finally {
  await close().catch(() => {});
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
