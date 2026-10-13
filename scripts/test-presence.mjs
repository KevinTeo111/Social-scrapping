/**
 * Whether a client is at their desk, for the clients a member is already
 * talking to.
 *
 * Workana shows a live online dot in one place only: the chat sidebar, for the
 * signed-in member's own conversations. A project card, a project page and a
 * client profile all show nothing but "Last login". So this covers a handful of
 * clients rather than the board, it is private to the member who collected it,
 * and it rides on list pages the scraper was fetching anyway.
 *
 *   node scripts/test-presence.mjs
 *
 * Temporary SQLite file, no browser and no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-presence-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'presence-test-secret';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};

const { initDatabase, upsertJob, upsertChatPresence } = await import('../src/db.js');
const { get, all, close } = await import('../src/sql.js');

try {
  await initDatabase();

  const now = new Date().toISOString();
  await upsertJob({
    slug: 'presence-test-job',
    url: 'https://www.workana.com/job/presence-test-job',
    title: 'Desarrollo de Página Web Profesional',
    publishedText: 'Just now',
    publishedApproxAt: now,
    listedAt: now,
  });

  const read = (userId, label) =>
    get('SELECT * FROM chat_presence WHERE user_id = ? AND label = ?', [userId, label]);

  /* ---- a label that matches a project on the board ---- */
  await upsertChatPresence(7, [{ label: 'Desarrollo de Página Web Profesional', online: true }]);
  let r = await read(7, 'Desarrollo de Página Web Profesional');
  ok('an online contact is stored', r?.online === 1);
  ok('...linked to the job whose title it matches', r.job_slug === 'presence-test-job', String(r.job_slug));
  ok('...and the moment they were seen online is kept', Boolean(r.last_online_at));

  /* ---- the dot going out must not erase when they were last on ---- */
  const seenAt = r.last_online_at;
  await upsertChatPresence(7, [{ label: 'Desarrollo de Página Web Profesional', online: false }]);
  r = await read(7, 'Desarrollo de Página Web Profesional');
  ok('going offline updates the dot', r.online === 0);
  ok('...but keeps the last time they were seen online', r.last_online_at === seenAt, String(r.last_online_at));
  ok('...and records when we last looked', r.checked_at >= seenAt);

  /* ---- coming back online moves it forward ---- */
  await new Promise((r2) => setTimeout(r2, 15));
  await upsertChatPresence(7, [{ label: 'Desarrollo de Página Web Profesional', online: true }]);
  r = await read(7, 'Desarrollo de Página Web Profesional');
  ok('coming back online moves the last-seen forward', r.last_online_at > seenAt);

  /* ---- labels that match nothing are still worth keeping ---- */
  await upsertChatPresence(7, [{ label: 'Cristian Arrigada', online: true }]);
  r = await read(7, 'Cristian Arrigada');
  ok('a contact named by person rather than project is still stored', r?.online === 1);
  ok('...with no job attached', r.job_slug === null);

  /* ---- case and spacing differ between the sidebar and the card ---- */
  await upsertChatPresence(7, [{ label: 'desarrollo de página web profesional', online: true }]);
  ok('a differently-cased label still finds the job',
    (await read(7, 'desarrollo de página web profesional'))?.job_slug === 'presence-test-job');

  /* ---- one member's chat list says nothing about another's ---- */
  await upsertChatPresence(8, [{ label: 'Desarrollo de Página Web Profesional', online: false }]);
  ok('each member has their own row', (await read(8, 'Desarrollo de Página Web Profesional'))?.online === 0);
  ok("...and one member's state does not overwrite the other's",
    (await read(7, 'Desarrollo de Página Web Profesional'))?.online === 1);

  /* ---- nothing to store ---- */
  ok('an empty sidebar stores nothing', (await upsertChatPresence(7, [])) === 0);
  ok('no member means nothing is stored', (await upsertChatPresence(null, [{ label: 'x', online: true }])) === 0);
  await upsertChatPresence(7, [{ label: '   ', online: true }]);
  ok('a blank label is skipped', (await get('SELECT COUNT(*) AS n FROM chat_presence WHERE label = ?', ['   '])).n === 0);

  const rows = await all('SELECT user_id, label, online FROM chat_presence ORDER BY user_id, label');
  ok('no duplicate rows accumulate across repeated sweeps', rows.length === 4, String(rows.length));
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
  console.log(err.stack);
} finally {
  await close().catch(() => {});
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
