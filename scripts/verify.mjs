import { db } from '../src/db.js';

const q = (sql, ...p) => db.prepare(sql).all(...p);

console.log('-- coverage --');
console.log(db.prepare(`SELECT
  (SELECT COUNT(*) FROM jobs) jobs,
  (SELECT COUNT(*) FROM jobs WHERE category = 'IT & Programming') it,
  (SELECT COUNT(*) FROM jobs WHERE detail_fetched_at IS NOT NULL) enriched,
  (SELECT COUNT(*) FROM jobs WHERE insights_fetched_at IS NOT NULL) with_insights,
  (SELECT COUNT(*) FROM jobs WHERE last_reply_at IS NOT NULL) with_reply,
  (SELECT COUNT(*) FROM jobs WHERE budget_text IS NOT NULL) with_budget,
  (SELECT COUNT(*) FROM jobs WHERE was_contacted = 1) contacted_flag,
  (SELECT COUNT(*) FROM clients WHERE payment_verified = 1) verified_clients`).get());

console.log('\n-- most recently replied clients --');
console.table(q(`SELECT substr(title,1,40) title, last_reply_text, last_reply_at, bids, budget_text
                   FROM jobs WHERE last_reply_at IS NOT NULL
                  ORDER BY last_reply_at DESC LIMIT 8`));

console.log('\n-- reply-time spread --');
console.table(q(`SELECT last_reply_text, COUNT(*) n FROM jobs
                  WHERE last_reply_text IS NOT NULL
                  GROUP BY last_reply_text ORDER BY n DESC LIMIT 10`));

console.log('\n-- budget parsing spread --');
console.table(q(`SELECT is_hourly, COUNT(*) n,
                        SUM(CASE WHEN budget_min IS NULL AND budget_max IS NULL THEN 1 ELSE 0 END) unparsed
                   FROM jobs GROUP BY is_hourly`));
