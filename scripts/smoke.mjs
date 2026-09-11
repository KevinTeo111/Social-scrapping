/**
 * Exercises every query the board makes, against whichever database is
 * configured. Point DATABASE_URL at Postgres and this is the fastest way to find
 * a dialect problem without waiting for a deploy and clicking around.
 *
 *   $env:DATABASE_URL = "<public connection string>"
 *   node scripts/smoke.mjs
 *
 * It reads and never writes, so it is safe to run against live data.
 */
import { all, get, initDatabase, isPostgres, dialect } from '../src/db.js';

await initDatabase();
console.log(`engine: ${dialect}\n`);

let failed = 0;
async function check(name, fn) {
  try {
    const result = await fn();
    const summary =
      Array.isArray(result) ? `${result.length} row(s)`
      : result && typeof result === 'object' ? JSON.stringify(result).slice(0, 90)
      : String(result);
    console.log(`PASS  ${name.padEnd(34)} ${summary}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name.padEnd(34)} ${err.message}`);
  }
}

// The list query, in the shape /api/jobs builds it: the per-user overlay join is
// the first bound parameter, and the "#000123" column comes from jobs.seq.
const BASE_FROM = `
  FROM jobs j
  LEFT JOIN clients c ON c.id = j.client_id
  LEFT JOIN user_jobs uf ON uf.job_slug = j.slug AND uf.user_id = ?
`;

await check('count', () => get(`SELECT COUNT(*) AS n ${BASE_FROM}`, [-1]));
await check('list page', () =>
  all(
    `SELECT j.seq AS no, j.slug, j.title, c.name AS client_name, c.avatar_url AS client_avatar_url,
            COALESCE(uf.has_own_bid, 0) AS has_own_bid
     ${BASE_FROM}
     ORDER BY COALESCE(j.published_approx_at, j.published_at, j.first_seen_at) DESC
     LIMIT ? OFFSET ?`,
    [-1, 5, 0],
  ),
);
await check('contract-type counts', () =>
  get(
    `SELECT COUNT(*) AS all_count,
            SUM(CASE WHEN j.is_hourly = 1 THEN 1 ELSE 0 END) AS hourly,
            SUM(CASE WHEN j.is_hourly = 0 THEN 1 ELSE 0 END) AS fixed
     ${BASE_FROM}`,
    [-1],
  ),
);

// Full-text search: a generated tsvector on Postgres, a separate FTS5 table on
// SQLite. This is the query most likely to differ between them.
await check('search', () =>
  isPostgres
    ? all(`SELECT slug FROM jobs WHERE search @@ to_tsquery('simple', ?) LIMIT 5`, ['web:*'])
    : all(`SELECT j.slug FROM jobs j JOIN jobs_fts f ON f.slug = j.slug WHERE jobs_fts MATCH ? LIMIT 5`, ['"web"*']),
);

await check('facets: categories', () =>
  all(`SELECT COALESCE(category, 'Uncategorised') AS name, category_slug AS slug, COUNT(*) AS n
         FROM jobs GROUP BY COALESCE(category, 'Uncategorised'), category_slug ORDER BY n DESC`),
);
await check('facets: countries', () =>
  all(`SELECT c.country AS name, c.country_code AS code, COUNT(*) AS n
         FROM jobs j JOIN clients c ON c.id = j.client_id
        WHERE c.country IS NOT NULL GROUP BY c.country, c.country_code ORDER BY n DESC`),
);

// ROUND over an average is the other classic difference: Postgres has
// round(numeric, int) but no round(double, int).
await check('stats: by category', () =>
  all(`SELECT COALESCE(category,'Unknown') AS name, COUNT(*) AS n,
              ROUND(CAST(AVG(COALESCE(budget_max, budget_min)) AS NUMERIC), 0) AS avg_budget,
              ROUND(CAST(AVG(COALESCE(bids,0)) AS NUMERIC), 1) AS avg_bids
         FROM jobs GROUP BY COALESCE(category,'Unknown') ORDER BY n DESC LIMIT 15`),
);
await check('stats: by day', () =>
  all(`SELECT substr(COALESCE(published_approx_at, published_at, first_seen_at), 1, 10) AS day,
              COUNT(*) AS n FROM jobs GROUP BY day ORDER BY day DESC LIMIT 21`),
);
await check('stats: budgets', () =>
  all(`SELECT is_hourly,
              ROUND(CAST(AVG(COALESCE(budget_min, budget_max)) AS NUMERIC),0) AS avg_min,
              MAX(COALESCE(budget_max, budget_min)) AS max
         FROM jobs GROUP BY is_hourly`),
);

const sampleSlug = (await get('SELECT slug FROM jobs LIMIT 1'))?.slug ?? 'no-such-job';
// The computed column is deliberately not called is_self: job_insights already
// has one, and two output columns of the same name make the ORDER BY ambiguous.
await check('drawer: insights', () =>
  all(
    `SELECT *, CASE WHEN freelancer = ? THEN 1 ELSE 0 END AS viewer_is_self
       FROM job_insights WHERE job_slug = ?
      ORDER BY in_contact DESC, proposal_selected DESC, viewer_is_self DESC,
               is_hero DESC, COALESCE(rating, 0) DESC`,
    ['nobody', sampleSlug],
  ),
);
await check('drawer: job row', () =>
  get(
    `SELECT j.seq AS no, j.slug, j.title, j.description, j.raw, c.name AS client_name
       FROM jobs j
       LEFT JOIN clients c ON c.id = j.client_id
       LEFT JOIN user_jobs uf ON uf.job_slug = j.slug AND uf.user_id = ?
      WHERE j.slug = ?`,
    [-1, sampleSlug],
  ),
);
await check('drawer: client reviews', () =>
  all('SELECT * FROM client_reviews ORDER BY id DESC LIMIT 25'),
);
// Columns added after the first Postgres deploy. CREATE TABLE IF NOT EXISTS
// leaves an existing table alone, so these exist only if initDatabase() added
// them — checking them here is what proves the migration actually ran.
await check('late columns: client last login', () =>
  get('SELECT COUNT(last_login_at) AS with_at, COUNT(*) AS total FROM clients'),
);
await check('late columns: my proposal state', () =>
  get(`SELECT SUM(has_own_bid) AS bid, SUM(was_contacted) AS contacted,
              SUM(proposal_read) AS read_, SUM(client_favorite) AS favourite,
              SUM(proposal_selected) AS selected
         FROM user_jobs`),
);
await check('late columns: bid action url', () =>
  get('SELECT COUNT(bid_action_url) AS n FROM jobs'),
);

await check('stats: developers', () =>
  all(`SELECT freelancer AS name, COUNT(*) AS appearances, SUM(in_contact) AS contacted,
              MAX(rating) AS rating, MAX(projects_done) AS projects_done,
              MAX(is_hero) AS is_hero, MAX(ranking) AS ranking, MAX(avatar_url) AS avatar_url
         FROM job_insights GROUP BY freelancer
        ORDER BY COUNT(*) DESC, SUM(in_contact) DESC LIMIT 40`),
);
await check('status: backlog', () =>
  get(`SELECT
        (SELECT COUNT(*) FROM jobs WHERE detail_fetched_at IS NULL) AS details,
        (SELECT COUNT(*) FROM jobs
          WHERE insights_fetched_at IS NULL AND COALESCE(bids, 0) > 0) AS insights`),
);
await check('scrape candidates', () =>
  all(`SELECT id FROM users
        WHERE workana_cookies IS NOT NULL AND COALESCE(cookies_valid, 1) = 1
        ORDER BY COALESCE(
          (SELECT MAX(started_at) FROM scrape_runs WHERE scrape_runs.user_id = users.id), '') ASC`),
);
await check('accounts', () =>
  all(`SELECT id, email,
              CASE WHEN workana_cookies IS NULL THEN 0 ELSE 1 END AS has_session,
              CASE WHEN browser_state IS NULL THEN 0 ELSE 1 END AS has_browser_state
         FROM users ORDER BY id`),
);

console.log(failed ? `\n${failed} failing` : '\nall pass');
process.exit(failed ? 1 : 0);
