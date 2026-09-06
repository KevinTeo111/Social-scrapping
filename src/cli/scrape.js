import { scrape } from '../scraper/scrape.js';
import { config } from '../config.js';
import { get, initDatabase } from '../db.js';
import { findUserByEmail, getWorkanaCookies } from '../auth.js';

await initDatabase();

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};

/**
 * The CLI can run as a registered member (`--user=email`, using their stored
 * session) or standalone from the cookie file. Attributing a file-based run to
 * the owner account keeps "I bid on this" attached to a real person rather than
 * being dropped.
 */
async function resolveActor() {
  const email = arg('user', '');
  if (email) {
    const user = await findUserByEmail(email);
    if (!user) {
      console.error(`No account registered with email "${email}".`);
      process.exit(1);
    }
    const cookies = await getWorkanaCookies(user.id);
    if (!cookies) {
      console.error(`${email} has not added a Workana session yet.`);
      process.exit(1);
    }
    return { userId: user.id, cookies, label: `${email} (stored session)` };
  }

  const owner = await get('SELECT id, email FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1');
  return {
    userId: owner?.id ?? null,
    cookies: null, // falls back to the on-disk cookie file
    label: owner ? `${owner.email} (cookie file)` : 'no account (cookie file)',
  };
}

const actor = await resolveActor();

const options = {
  // No page target by default: walk until the results run out.
  pages: Number(arg('pages', config.maxListPages)),
  language: arg('language', config.language),
  category: arg('category', config.category),
  query: arg('query', ''),
  withDetails: arg('details', 'true') !== 'false',
  detailBudget: Number(arg('detail-budget', config.detailBudget)),
  insightBudget: Number(arg('insight-budget', config.insightBudget)),
  userId: actor.userId,
  cookies: actor.cookies,
  onProgress: (p) => {
    if (p.phase === 'list-done') {
      console.log(
        `  page ${String(p.page).padStart(3)}  ${String(p.count).padStart(2)} cards ` +
          `(${p.fresh} new to this run)  ·  total seen ${p.seen}`,
      );
    } else if (p.phase === 'list-retry') {
      console.log(`  page ${p.page} came back empty — retry ${p.attempt}`);
    } else if (p.phase === 'detail' && p.done % 10 === 0) {
      console.log(`  details ${p.done}/${p.total}`);
    } else if (p.phase === 'insights' && p.done % 10 === 0) {
      console.log(`  insights ${p.done}/${p.total}`);
    }
  },
};

console.log('Scraping Workana:', {
  as: actor.label,
  category: options.category || '(all categories)',
  language: options.language,
  pageCap: options.pages,
  detailBudget: options.detailBudget,
  insightBudget: options.insightBudget,
});

const t0 = Date.now();
try {
  const stats = await scrape(options);
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(stats);
  if (stats.endedAt) {
    console.log(
      stats.clamped
        ? `Reached the end of the list at page ${stats.endedAt} (Workana re-served an earlier page).`
        : `Reached the end of the list at page ${stats.endedAt}.`,
    );
  }
} catch (err) {
  console.error('\nScrape failed:', err.message);
  process.exitCode = 1;
}

const row = await get(`SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN detail_fetched_at IS NOT NULL THEN 1 ELSE 0 END) AS enriched,
  SUM(CASE WHEN insights_fetched_at IS NOT NULL THEN 1 ELSE 0 END) AS with_insights,
  SUM(CASE WHEN category = 'IT & Programming' THEN 1 ELSE 0 END) AS it
  FROM jobs`);
console.log(
  `DB: ${row.total} jobs (${row.enriched} enriched, ${row.with_insights} with contacts, ${row.it} IT & Programming)`,
);
