/**
 * Rebuilds "did the client contact me" from the Project Insights page.
 *
 * The flag used to come from the job card's button, which flips to "Go to
 * messages" as soon as a proposal opens a thread — so it marked every bid as
 * contacted, whether or not the client ever wrote. The truth is on the insights
 * page, in the viewer's own row: badges for proposal sent, proposal read,
 * favourite, in contact and proposal selected.
 *
 * The old value cannot be salvaged, so it is cleared first and re-derived. One
 * page load per job, paced like any other scrape.
 *
 *   node scripts/refresh-my-bids.mjs --email you@example.com
 *   node scripts/refresh-my-bids.mjs --email you@example.com --apply
 *   node scripts/refresh-my-bids.mjs --email you@example.com --apply --limit 20
 */
import { all, get, run, initDatabase } from '../src/db.js';
import { getWorkanaCookies, getWorkanaProxy } from '../src/auth.js';
import { launchContext, saveState, jitter } from '../src/scraper/browser.js';
import { fetchInsightsOn } from '../src/scraper/scrape.js';

await initDatabase();

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const apply = process.argv.includes('--apply');
const limit = Number(arg('--limit', 0)) || null;
const email = arg('--email');

if (!email) {
  console.error('Which account? Pass --email you@example.com');
  console.table(await all('SELECT id, email, name FROM users ORDER BY id'));
  process.exit(1);
}
const user = await get('SELECT id, email, workana_name FROM users WHERE email = ?', [email]);
if (!user) { console.error(`No account with that address.`); process.exit(1); }

const before = await get(
  `SELECT COUNT(*) AS rows, SUM(has_own_bid) AS bid, SUM(was_contacted) AS contacted
     FROM user_jobs WHERE user_id = ?`,
  [user.id],
);
console.log(`${user.email}: ${before.rows} row(s), ${before.bid} bid, ${before.contacted} marked contacted`);

const targets = (
  await all(
    `SELECT job_slug FROM user_jobs WHERE user_id = ? AND has_own_bid = 1 ORDER BY updated_at DESC`
      + (limit ? ' LIMIT ?' : ''),
    limit ? [user.id, limit] : [user.id],
  )
).map((r) => r.job_slug);

console.log(`jobs to re-read: ${targets.length}`);
if (!apply) {
  console.log('\nDry run. Re-run with --apply to fetch the insights pages and rewrite the flags.');
  process.exit(0);
}

const cookies = await getWorkanaCookies(user.id);
if (!cookies) { console.error('That account has no Workana session stored.'); process.exit(1); }

// Every row is about to be re-derived, so the discredited value goes first.
await run('UPDATE user_jobs SET was_contacted = 0 WHERE user_id = ?', [user.id]);

const { browser, context } = await launchContext({
  cookies, userId: user.id, proxy: await getWorkanaProxy(user.id),
});
const page = await context.newPage();
const tally = { read: 0, contact: 0, favorite: 0, selected: 0, noRow: 0, failed: 0 };

try {
  for (const [i, slug] of targets.entries()) {
    try {
      const raw = await fetchInsightsOn(page, slug, user.id);
      if (!raw.self) tally.noRow += 1;
      else {
        if (raw.self.proposalRead) tally.read += 1;
        if (raw.self.inContact) tally.contact += 1;
        if (raw.self.isFavorite) tally.favorite += 1;
        if (raw.self.proposalSelected) tally.selected += 1;
      }
      if ((i + 1) % 10 === 0 || i === targets.length - 1) {
        console.log(`  ${i + 1}/${targets.length}  in contact so far: ${tally.contact}`);
      }
    } catch (err) {
      tally.failed += 1;
      if (err.code === 'CF_CHALLENGE' || err.code === 'BROWSER_CRASH') {
        console.log(`  stopped early at ${i + 1}: ${err.message.slice(0, 70)}`);
        break;
      }
    }
    await jitter();
  }
} finally {
  await saveState(context);
  await browser.close().catch(() => {});
}

const after = await get(
  `SELECT SUM(has_own_bid) AS bid, SUM(was_contacted) AS contacted,
          SUM(proposal_read) AS read_, SUM(client_favorite) AS fav, SUM(proposal_selected) AS selected
     FROM user_jobs WHERE user_id = ?`,
  [user.id],
);
console.log('\nafter:');
console.log(`  bid              ${after.bid}`);
console.log(`  client contacted ${after.contacted}   (was ${before.contacted}, from the wrong signal)`);
console.log(`  proposal read    ${after.read_}`);
console.log(`  favourited       ${after.fav}`);
console.log(`  selected         ${after.selected}`);
if (tally.noRow) console.log(`  ${tally.noRow} page(s) showed no row of mine`);
if (tally.failed) console.log(`  ${tally.failed} page(s) failed`);
