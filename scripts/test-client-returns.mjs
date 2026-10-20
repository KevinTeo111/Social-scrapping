/**
 * When a client comes back to an old project, that is news.
 *
 * Everyone who bid on a week-old posting did so days ago and has stopped
 * watching it. The client replying is the opening, and it is the one kind of
 * news the competition has not already used up -- so it is announced whatever
 * the posting's age and however crowded it is.
 *
 * The hard part is telling a reply from a card simply ageing. Workana prints
 * the time as "2 weeks ago" or "Yesterday" -- of 999 jobs carrying one, only 59
 * were precise to the minute -- and that text is re-parsed against the clock on
 * every read, so the instant it yields creeps forward by however long it has
 * been since we last looked. Comparing timestamps alone would call that a reply
 * and announce every job on every walk.
 *
 *   node scripts/test-client-returns.mjs
 *
 * Temporary SQLite file, no browser and no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-returns-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'returns-test-secret';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};

const { initDatabase, upsertJob, saveInsights } = await import('../src/db.js');
const { get, close } = await import('../src/sql.js');

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 3600e3;
const DAY = 24 * HOUR;

const put = (slug, { text, at }) =>
  upsertJob({
    slug,
    url: `https://www.workana.com/job/${slug}`,
    title: 'Returning client test',
    publishedText: '2 weeks ago',
    publishedApproxAt: ago(14 * DAY),
    listedAt: new Date().toISOString(),
    lastReplyText: text,
    lastReplyAt: at,
  });
const stamp = async (slug) => (await get('SELECT reply_changed_at FROM jobs WHERE slug = ?', [slug])).reply_changed_at;

try {
  await initDatabase();

  /* ---- finding an old posting is not the client doing anything ---- */
  await put('r-first', { text: '2 weeks ago', at: ago(14 * DAY) });
  ok('a posting found for the first time is not a reply', (await stamp('r-first')) === null);

  /* ---- the trap: the same text re-read later ---- */
  await put('r-first', { text: '2 weeks ago', at: ago(14 * DAY - 20 * 60_000) });
  ok('the same card read again is not a reply, though its instant crept forward',
    (await stamp('r-first')) === null, 'this is what would announce every job on every walk');

  await put('r-first', { text: '2 weeks ago', at: ago(14 * DAY - 6 * HOUR) });
  ok('...not even after six hours of creeping', (await stamp('r-first')) === null);

  /* ---- ageing is not a reply either ---- */
  await put('r-age', { text: '1 hour ago', at: ago(HOUR) });
  ok('a first sighting with a recent reply is still not a change', (await stamp('r-age')) === null);
  await put('r-age', { text: '2 hours ago', at: ago(2 * HOUR) });
  ok('"1 hour ago" becoming "2 hours ago" is ageing, not news', (await stamp('r-age')) === null);
  await put('r-age', { text: 'Yesterday', at: ago(DAY) });
  ok('...and so is falling back to "Yesterday"', (await stamp('r-age')) === null);

  /* ---- the real thing ---- */
  const before = Date.now();
  await put('r-age', { text: 'Just now', at: new Date().toISOString() });
  const changed = await stamp('r-age');
  ok('the client coming back is recorded', Boolean(changed), String(changed));
  ok('...stamped with our own clock, not the time Workana printed',
    Date.parse(changed) >= before - 2000, String(changed));

  /* ---- a fortnight-old post whose client returns ---- */
  await put('r-old', { text: '2 weeks ago', at: ago(14 * DAY) });
  ok('an old post starts with no reply stamp', (await stamp('r-old')) === null);
  await put('r-old', { text: '3 minutes ago', at: ago(3 * 60_000) });
  ok('a fortnight-old post whose client replies is recorded', Boolean(await stamp('r-old')),
    'the case this exists for');

  /* ---- and is not re-stamped while nothing further happens ---- */
  const first = await stamp('r-old');
  await put('r-old', { text: '3 minutes ago', at: ago(3 * 60_000 - 60_000) });
  ok('re-reading the same reply does not stamp it again', (await stamp('r-old')) === first);

  /* ---- a second reply moves it forward ---- */
  await new Promise((r) => setTimeout(r, 15));
  await put('r-old', { text: 'Just now', at: new Date().toISOString() });
  ok('a further reply moves the stamp forward', (await stamp('r-old')) > first);

  /* ---- a job that has never had a reply ---- */
  await put('r-none', { text: null, at: null });
  ok('a job with no reply at all stays unstamped', (await stamp('r-none')) === null);

  /* ---- the client starting to shortlist ---- */
  const contacts = async (slug) => (await get('SELECT contacts_changed_at FROM jobs WHERE slug = ?', [slug])).contacts_changed_at;
  // The count is written by the insights pass, which is where it changes.
  const putContacts = async (slug, n) => {
    await upsertJob({ slug, url: `https://www.workana.com/job/${slug}`, title: 'Shortlist test',
      listedAt: new Date().toISOString() });
    await saveInsights(slug, { contactsCount: n, proposals: [] });
  };

  await putContacts('c-job', 0);
  ok('a job nobody has been contacted on is unstamped', (await contacts('c-job')) === null);
  await putContacts('c-job', 1);
  ok('the first contact is recorded', Boolean(await contacts('c-job')), 'the 17x signal');
  const firstContact = await contacts('c-job');
  await putContacts('c-job', 1);
  ok('re-reading the same count does not stamp it again', (await contacts('c-job')) === firstContact);
  await new Promise((r) => setTimeout(r, 15));
  await putContacts('c-job', 3);
  ok('the client contacting someone else moves it forward', (await contacts('c-job')) > firstContact);

  /*
   * A list-only walk carries no contact count at all. Reading null as "the
   * client let everyone go" would wipe the signal on every refresh.
   */
  const beforeNull = await contacts('c-job');
  await upsertJob({ slug: 'c-job', url: 'https://www.workana.com/job/c-job', title: 'Shortlist test',
    listedAt: new Date().toISOString() });
  ok('a list-only refresh does not disturb it', (await contacts('c-job')) === beforeNull);
  await saveInsights('c-job', { contactsCount: 1, proposals: [] });
  ok('...nor does the count falling back', (await contacts('c-job')) === beforeNull);

  /* ---- the board has to hand the field to the page ---- */
  const appSource = fs.readFileSync('src/app.js', 'utf8');
  ok('the board serves reply_changed_at to the page', appSource.includes('j.reply_changed_at'));
  const pageSource = fs.readFileSync('public/app.js', 'utf8');
  ok('...and the alert rule reads it', pageSource.includes('reply_changed_at'));
  ok('the board still records when a client starts contacting people',
    appSource.includes('j.contacts_changed_at'));
  /*
   * Alerts and the filter read the reply time, not the contact count: the
   * count only arrives with an enrichment pass, a cycle behind the list, while
   * the reply comes off the card on every walk. A weaker signal known now
   * beats a stronger one known too late to answer.
   */
  ok('the alert rule reads replies, not contact counts',
    !pageSource.includes('contacts_changed_at'));
  ok('a reply on a job you bid on is its own kind of news',
    /has_own_bid && clientJustReplied/.test(pageSource));
  ok('...and is tested before a reply on any other job',
    pageSource.indexOf("'reply-yours'") < pageSource.indexOf("clientJustReplied(job, now)) return 'reply'"));
  ok('...before the bid and age tests, so an old crowded job still gets through',
    pageSource.indexOf('clientJustReplied(job, now)') < pageSource.indexOf("prefs?.mode === 'bid_now'"));
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
  console.log(err.stack);
} finally {
  await close().catch(() => {});
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
