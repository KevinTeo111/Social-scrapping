/**
 * One member can narrow their alerts to the jobs still worth bidding on,
 * without changing what anybody else is told about.
 *
 * The thresholds are not a matter of taste. Of the bids placed from this
 * board, those on a job carrying fewer than ten proposals were answered 15.4%
 * of the time; past fifty, 1.1%. Bids pile up fast -- a median of 25 by the
 * sixth hour -- so what decides the outcome is arriving while the field is
 * still small. An alert that only fires then means "drop what you are doing",
 * which is worth more than one that means "something was posted".
 *
 *   node scripts/test-bid-now.mjs
 *
 * Board on a temporary SQLite file; the rule is evaluated in a real browser,
 * because that is where it runs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-bidnow-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'bid-now-test-secret';
process.env.REQUIRE_SETUP = '0';
process.env.REQUIRE_PROXY = '0';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

const PORT = Number(process.env.PORT || 4481);
const BASE = `http://127.0.0.1:${PORT}`;
let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const board = spawn(process.execPath, ['src/server.js', '--role=web'], {
  env: { ...process.env, PORT: String(PORT), AUTO_SCRAPE_MINUTES: '0', SWEEP_MINUTES: '0', DEEP_MINUTES: '0' },
  stdio: ['ignore', fs.openSync(path.join(dir, 'board.log'), 'w'), 'inherit'],
});

try {
  const { initDatabase } = await import('../src/db.js');
  const { close } = await import('../src/sql.js');
  const auth = await import('../src/auth.js');
  await initDatabase();
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch {}
    await sleep(500);
  }

  const mine = await auth.registerUser({ email: 'picky@local.test', password: 'bid-now-1234', name: 'Picky' });
  const other = await auth.registerUser({ email: 'everyone@local.test', password: 'bid-now-1234', name: 'Other' });

  /* ---- the controls exist only for a granted account ---- */
  ok('a new member is not offered the settings at all',
    auth.publicUser(await auth.findUser(mine.id)).canTuneAlerts === false);
  const { run } = await import('../src/sql.js');
  await run('UPDATE users SET alert_tuning = 1 WHERE id = ?', [mine.id]);
  ok('granting it turns them on for that account', auth.publicUser(await auth.findUser(mine.id)).canTuneAlerts === true);
  ok('...and for nobody else', auth.publicUser(await auth.findUser(other.id)).canTuneAlerts === false);

  /* ---- the default is unchanged for everybody ---- */
  ok('a new member is alerted about everything', auth.alertPrefs(await auth.findUser(mine.id)).mode === 'all');
  ok('...and the thresholds come from the measured numbers',
    auth.ALERT_DEFAULTS.maxBids === 25 && auth.ALERT_DEFAULTS.maxAgeMin === 60,
    `<= ${auth.ALERT_DEFAULTS.maxBids} bids, ${auth.ALERT_DEFAULTS.maxAgeMin} min`);
  ok('...set where there is actually something to catch (13% of jobs reach 15 bids, 25% reach 25)',
    auth.ALERT_DEFAULTS.maxBids >= 20);

  await auth.setAlertPrefs(mine.id, { mode: 'bid_now', maxBids: 15, maxAgeMin: 60 });
  ok('one member can narrow their own alerts', auth.alertPrefs(await auth.findUser(mine.id)).mode === 'bid_now');
  ok('...and nobody else is touched', auth.alertPrefs(await auth.findUser(other.id)).mode === 'all');

  /* ---- nonsense is clamped rather than stored ---- */
  let p = await auth.setAlertPrefs(mine.id, { mode: 'bid_now', maxBids: 99999, maxAgeMin: -5 });
  ok('an absurd bid ceiling is clamped', p.maxBids <= 500, String(p.maxBids));
  ok('...as is a negative age', p.maxAgeMin >= 5, String(p.maxAgeMin));
  p = await auth.setAlertPrefs(mine.id, { mode: 'bid_now', maxBids: 'abc', maxAgeMin: null });
  ok('junk falls back to the defaults', p.maxBids === 25 && p.maxAgeMin === 60, JSON.stringify(p));

  /* ---- the rule itself, in the browser ---- */
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.waitForFunction(() => typeof window.alertReason === 'function', null, { timeout: 15_000 });

    const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

    /*
     * Signed in for real, because `me` is module state in the page: the rule
     * reads the preferences the board served, not anything a test can poke in.
     */
    const signIn = async (email) => {
      await page.evaluate(async (e) => {
        await fetch('/api/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: e, password: 'bid-now-1234' }),
        });
      }, email);
      await page.goto(BASE);
      await page.waitForFunction(() => typeof window.alertReason === 'function', null, { timeout: 15_000 });
      // `me` is module state in the page and deliberately not global, so what
      // the board served is read back the way the page itself read it.
      return page.evaluate(async () => (await (await fetch('/api/me')).json()).user);
    };
    const reason = (job) => page.evaluate((j) => window.alertReason(j, Date.now()), job);

    await auth.setAlertPrefs(mine.id, { mode: 'bid_now', maxBids: 15, maxAgeMin: 60 });
    const served = await signIn('picky@local.test');
    ok('the granted member is served their own settings',
      served.canTuneAlerts === true && served.alerts.mode === 'bid_now', JSON.stringify(served.alerts));

    const fresh = { published_approx_at: ago(10), first_seen_at: ago(1), bids: 4 };
    ok('fresh and uncrowded -> announced', (await reason(fresh)) === 'new');
    ok('fresh but already crowded -> silent',
      (await reason({ ...fresh, bids: 60 })) === null, 'this is the whole point');
    ok('uncrowded but hours old -> silent',
      (await reason({ ...fresh, published_approx_at: ago(180) })) === null);
    ok('right on the bid ceiling -> announced', (await reason({ ...fresh, bids: 15 })) === 'new');
    ok('one bid over it -> silent', (await reason({ ...fresh, bids: 16 })) === null);
    ok('no bid count yet -> given the benefit of the doubt',
      (await reason({ ...fresh, bids: null })) === 'new');
    ok('a client replying on an old crowded job still gets through',
      (await reason({ published_approx_at: ago(3000), first_seen_at: ago(3000), bids: 120, last_reply_at: ago(2) })) === 'reply');
    ok('a reply on a job this member bid on is its own, sharper news',
      (await reason({ published_approx_at: ago(20000), first_seen_at: ago(20000), bids: 120,
                      has_own_bid: 1, last_reply_text: '2 weeks ago', last_reply_at: ago(20000),
                      reply_changed_at: ago(4) })) === 'reply-yours');
    ok('...and so does one we only know came back because we watched it change',
      (await reason({ published_approx_at: ago(20000), first_seen_at: ago(20000), bids: 120,
                      last_reply_text: '2 weeks ago', last_reply_at: ago(20000), reply_changed_at: ago(4) })) === 'reply',
      'the case Workana prints too coarsely to see');

    /* ---- what it cuts, on the measured distribution ---- */
    const sample = [];
    for (const [bids, count] of [[5, 3], [20, 9], [40, 22], [70, 31], [120, 15]])
      for (let i = 0; i < count; i++) sample.push({ published_approx_at: ago(10), first_seen_at: ago(1), bids });
    const kept = await page.evaluate((rows) => rows.filter((r) => window.alertReason(r, Date.now())).length, sample);
    ok(`of 80 fresh postings shaped like the real board, ${kept} are worth interrupting for`,
      kept === 3, `${kept} announced`);

    /* ---- the same jobs, for a member who was never granted it ---- */
    const theirs = await signIn('everyone@local.test');
    ok('the other member is offered no settings', theirs.canTuneAlerts === false);
    /* ---- a notice each time a run ends, for the granted account ---- */
    const notice = (run, opts) => page.evaluate(([r, o]) => window.runNotice(r, o), [run, opts]);
    const ended = {
      started_at: ago(8), finished_at: ago(0.5), // ago() takes minutes
      pages: 37, seen: 742, inserted: 3, details: 0, insights: 0, complete: 1, error: null,
    };
    const granted = { granted: true, on: true };

    let n = await notice(ended, granted);
    ok('a finished deep walk is announced', n?.title === 'Deep walk finished', JSON.stringify(n));
    ok('...with what it actually did', /37 pages/.test(n.body) && /742 jobs/.test(n.body) && /3 new/.test(n.body), n.body);
    ok('...how long it took, in minutes that mean something',
      n.body.includes('7.5 min'), n.body);
    ok('...and that it reached the end, which is what lets closed jobs go', /walked to the end/.test(n.body));

    n = await notice({ ...ended, pages: 1, seen: 22, inserted: 1, complete: 0 }, granted);
    ok('a quick check is named as one', n?.title === 'Quick check finished', JSON.stringify(n));
    n = await notice({ ...ended, pages: 0, seen: 0, inserted: 0, details: 12, complete: 0 }, granted);
    ok('so is an enrichment pass', n?.title === 'Enrichment finished', JSON.stringify(n));
    ok('...reporting the job pages it opened', /12 detail/.test(n.body), n.body);

    n = await notice({ ...ended, error: 'Cloudflare challenge on page 13 (stopped early, kept 262 jobs)' }, granted);
    ok('a run that stopped early says so', n?.title === 'Deep walk stopped', JSON.stringify(n));
    ok('...and says why', /Cloudflare challenge on page 13/.test(n.body), n.body);

    ok('a run still going is not announced',
      (await notice({ ...ended, finished_at: null }, granted)) === null);
    ok('nothing is announced with alerts switched off',
      (await notice(ended, { granted: true, on: false })) === null);
    ok('...nor to an account that was not granted them',
      (await notice(ended, { granted: false, on: true })) === null);

    /*
     * A new posting is news for anyone watching the board, so those still
     * reach every member. A client reply is somebody else's conversation, and
     * reaches only the account granted it.
     */
    ok('a fresh posting still reaches them', (await reason(fresh)) === 'new');
    ok('...crowded or not', (await reason({ ...fresh, bids: 60 })) === 'new');
    ok('but a client replying does NOT',
      (await reason({ published_approx_at: ago(3000), first_seen_at: ago(3000), bids: 120, last_reply_at: ago(2) })) === null);
    ok('...nor a client returning to an old post',
      (await reason({ published_approx_at: ago(20000), first_seen_at: ago(20000), bids: 120,
                      last_reply_text: '2 weeks ago', last_reply_at: ago(20000), reply_changed_at: ago(4) })) === null);
    ok('...nor a reply on a job they bid on themselves',
      (await reason({ published_approx_at: ago(20000), first_seen_at: ago(20000), bids: 120,
                      has_own_bid: 1, last_reply_at: ago(20000), reply_changed_at: ago(4) })) === null);
    const keptAll = await page.evaluate((rows) => rows.filter((r) => window.alertReason(r, Date.now())).length, sample);
    ok('...and all 80 postings do, exactly as before', keptAll === 80, `${keptAll} announced`);

    /* ---- a member without the grant cannot set it even by hand ---- */
    const jar = [];
    const call = async (email) => {
      const login = await fetch(`${BASE}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'bid-now-1234' }),
      });
      jar.length = 0;
      for (const c of login.headers.getSetCookie?.() ?? []) jar.push(c.split(';')[0]);
      return fetch(`${BASE}/api/me/alerts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: jar.join('; ') },
        body: JSON.stringify({ mode: 'bid_now', maxBids: 10, maxAgeMin: 30 }),
      });
    };
    ok('an ungranted member is refused by the route, not just by the panel',
      (await call('everyone@local.test')).status === 403);
    ok('...while the granted one is allowed', (await call('picky@local.test')).status === 200);

  } finally {
    await browser.close();
  }
  await close().catch(() => {});
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
} finally {
  board.kill('SIGKILL');
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
