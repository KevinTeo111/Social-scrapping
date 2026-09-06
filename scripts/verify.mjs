/** A quick read of how complete and well-parsed the corpus is. */
import { all, get, initDatabase } from '../src/db.js';

await initDatabase();

console.log('-- coverage --');
console.log(
  await get(`SELECT
  (SELECT COUNT(*) FROM jobs) AS jobs,
  (SELECT COUNT(*) FROM jobs WHERE category = 'IT & Programming') AS it,
  (SELECT COUNT(*) FROM jobs WHERE detail_fetched_at IS NOT NULL) AS enriched,
  (SELECT COUNT(*) FROM jobs WHERE insights_fetched_at IS NOT NULL) AS with_insights,
  (SELECT COUNT(*) FROM jobs WHERE last_reply_at IS NOT NULL) AS with_reply,
  (SELECT COUNT(*) FROM jobs WHERE budget_text IS NOT NULL) AS with_budget,
  (SELECT COUNT(*) FROM jobs WHERE was_contacted = 1) AS contacted_flag,
  (SELECT COUNT(*) FROM clients WHERE payment_verified = 1) AS verified_clients`),
);

console.log('\n-- most recently replied clients --');
console.table(
  await all(`SELECT substr(title,1,40) AS title, last_reply_text, last_reply_at, bids, budget_text
               FROM jobs WHERE last_reply_at IS NOT NULL
              ORDER BY last_reply_at DESC LIMIT 8`),
);

console.log('\n-- reply-time spread --');
console.table(
  await all(`SELECT last_reply_text, COUNT(*) AS n FROM jobs
              WHERE last_reply_text IS NOT NULL
              GROUP BY last_reply_text ORDER BY n DESC LIMIT 10`),
);

console.log('\n-- budget parsing spread --');
console.table(
  await all(`SELECT is_hourly, COUNT(*) AS n,
                    SUM(CASE WHEN budget_min IS NULL AND budget_max IS NULL THEN 1 ELSE 0 END) AS unparsed
               FROM jobs GROUP BY is_hourly`),
);
