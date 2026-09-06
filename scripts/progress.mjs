/** One line on how far enrichment has got. Safe to run while a scrape is going. */
import { get, initDatabase } from '../src/db.js';

await initDatabase();

console.log(
  await get(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN detail_fetched_at IS NOT NULL THEN 1 ELSE 0 END) AS enriched,
    SUM(CASE WHEN insights_fetched_at IS NOT NULL THEN 1 ELSE 0 END) AS with_insights,
    SUM(CASE WHEN category = 'IT & Programming' THEN 1 ELSE 0 END) AS it,
    SUM(CASE WHEN category IS NOT NULL AND category <> 'IT & Programming' THEN 1 ELSE 0 END) AS non_it,
    SUM(CASE WHEN category IS NULL THEN 1 ELSE 0 END) AS unknown_cat
    FROM jobs`),
);
