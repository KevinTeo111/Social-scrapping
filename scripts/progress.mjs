import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.js';

const db = new DatabaseSync(config.dbFile, { readOnly: true });
console.log(
  db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN detail_fetched_at IS NOT NULL THEN 1 ELSE 0 END) enriched,
    SUM(CASE WHEN insights_fetched_at IS NOT NULL THEN 1 ELSE 0 END) with_insights,
    SUM(CASE WHEN category = 'IT & Programming' THEN 1 ELSE 0 END) it,
    SUM(CASE WHEN category IS NOT NULL AND category <> 'IT & Programming' THEN 1 ELSE 0 END) non_it,
    SUM(CASE WHEN category IS NULL THEN 1 ELSE 0 END) unknown_cat
    FROM jobs`).get(),
);
