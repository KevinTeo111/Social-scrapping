/**
 * Counts the proposals this account has written, from Workana's own inbox.
 *
 * The board's own figure only counts bids on jobs it has scraped, and the feed
 * drops postings as they age, so it reads low and drifts further low over time.
 * Sending a proposal opens a thread, and the thread outlives the listing, so the
 * inbox is the one place that still knows the real number.
 *
 * It also repairs the overlay: any project in the inbox that the board holds is
 * marked as bid, which catches proposals whose job card never gave us a usable
 * signal.
 *
 *   node scripts/sync-proposals.mjs --email you@example.com
 *   node scripts/sync-proposals.mjs --email you@example.com --apply
 */
import { all, get, run, initDatabase, upsertUserJob } from '../src/db.js';
import { getWorkanaCookies, getWorkanaProxy, recordProposalCount } from '../src/auth.js';
import { launchContext, saveState } from '../src/scraper/browser.js';
import { fetchMyProposals } from '../src/scraper/proposals.js';

await initDatabase();

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const apply = process.argv.includes('--apply');
const email = arg('--email');

if (!email) {
  console.error('Which account? Pass --email you@example.com');
  console.table(await all('SELECT id, email, name FROM users ORDER BY id'));
  process.exit(1);
}
const user = await get('SELECT id, email, proposals_total FROM users WHERE email = ?', [email]);
if (!user) { console.error('No account with that address.'); process.exit(1); }

const known = (await get(
  'SELECT COUNT(*) AS n FROM user_jobs WHERE user_id = ? AND has_own_bid = 1', [user.id],
)).n;
console.log(`${user.email}`);
console.log(`  the board can see : ${known} bid(s)`);
console.log(`  last counted      : ${user.proposals_total ?? 'never'}`);

const cookies = await getWorkanaCookies(user.id);
if (!cookies) { console.error('That account has no Workana session stored.'); process.exit(1); }

const { browser, context } = await launchContext({
  cookies, userId: user.id, proxy: await getWorkanaProxy(user.id),
});
let projects = [];
try {
  const page = await context.newPage();
  projects = await fetchMyProposals(page, {
    onProgress: ({ page: p, total }) => console.log(`  inbox page ${p}: ${total} so far`),
  });
} finally {
  await saveState(context);
  await browser.close().catch(() => {});
}

// Which of them the board actually holds, and which it had not marked.
const slugs = projects.map((p) => p.slug).filter(Boolean);
const inCorpus = new Set(
  (await all(`SELECT slug FROM jobs`)).map((r) => r.slug).filter((s) => slugs.includes(s)),
);
const unmarked = [];
for (const slug of inCorpus) {
  const row = await get(
    'SELECT has_own_bid FROM user_jobs WHERE user_id = ? AND job_slug = ?', [user.id, slug],
  );
  if (!row || !row.has_own_bid) unmarked.push(slug);
}

console.log(`\nproposals written : ${projects.length}`);
console.log(`  of those, jobs the board holds : ${inCorpus.size}`);
console.log(`  not yet marked as mine         : ${unmarked.length}`);
console.log(`  never scraped (job long gone)  : ${projects.length - inCorpus.size}`);

if (!apply) {
  console.log('\nDry run. Re-run with --apply to store the count and mark the missing bids.');
  process.exit(0);
}

await recordProposalCount(user.id, projects.length);
for (const slug of unmarked) await upsertUserJob(user.id, slug, { hasOwnBid: true });

console.log(`\nstored: ${projects.length} proposal(s); marked ${unmarked.length} additional bid(s).`);
