/**
 * Re-collects Project Insights for jobs already fetched, after the badge-timing
 * fix. Clears the marker so the normal enrichment path picks them up.
 */
import { db } from '../src/db.js';
import { launchContext, saveState, jitter } from '../src/scraper/browser.js';
import { fetchInsightsOn } from '../src/scraper/scrape.js';

const slugs = db
  .prepare('SELECT slug FROM jobs WHERE insights_fetched_at IS NOT NULL ORDER BY first_seen_at DESC')
  .all()
  .map((r) => r.slug);

console.log(`re-fetching insights for ${slugs.length} jobs`);

const { browser, context } = await launchContext();
const page = await context.newPage();
let ok = 0;
try {
  for (const slug of slugs) {
    try {
      const r = await fetchInsightsOn(page, slug);
      ok += 1;
      const newCount = r.proposals.filter((p) => p.isNew).length;
      console.log(
        `  ${String(ok).padStart(3)}/${slugs.length} ${slug.slice(0, 40).padEnd(40)} ` +
          `contenders=${r.proposals.length} new=${newCount} contact=${r.contactsCount}`,
      );
    } catch (err) {
      console.log(`  !! ${slug}: ${err.message.slice(0, 70)}`);
      if (err.code === 'CF_CHALLENGE') break;
    }
    await jitter();
  }
} finally {
  await saveState(context);
  await browser.close().catch(() => {});
}
console.log(`done: ${ok}/${slugs.length}`);
