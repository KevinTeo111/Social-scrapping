/**
 * Removes jobs outside IT & Programming, left over from crawls that ran before
 * the category was narrowed.
 *
 * Reports by default and changes nothing; pass --apply to actually delete.
 * Jobs whose category is still unknown (never enriched) are always kept — a
 * missing category is not evidence of the wrong category.
 */
import { all, get, run, tx, initDatabase, isPostgres } from '../src/db.js';

await initDatabase();

const KEEP = process.env.KEEP_CATEGORY || 'IT & Programming';
const apply = process.argv.includes('--apply');

const doomed = await all(
  'SELECT slug, category, title FROM jobs WHERE category IS NOT NULL AND category <> ?',
  [KEEP],
);

const byCategory = await all(
  `SELECT category, COUNT(*) AS n FROM jobs
    WHERE category IS NOT NULL AND category <> ?
    GROUP BY category ORDER BY n DESC`,
  [KEEP],
);

console.log(`Keeping: ${KEEP}`);
console.table(byCategory);
console.log(`${doomed.length} jobs would be removed.`);
console.log(
  `${(await get('SELECT COUNT(*) AS n FROM jobs WHERE category IS NULL')).n} jobs have no category yet and are kept.`,
);

if (!apply) {
  console.log('\nDry run — nothing deleted. Re-run with --apply to delete.');
  process.exit(0);
}

const slugs = doomed.map((d) => d.slug);

await tx(async (t) => {
  for (const slug of slugs) {
    await run('DELETE FROM jobs WHERE slug = ?', [slug], t);
    // The FTS index is SQLite's alone; on Postgres the tsvector went with the row.
    if (!isPostgres) await run('DELETE FROM jobs_fts WHERE slug = ?', [slug], t);
    await run('DELETE FROM job_insights WHERE job_slug = ?', [slug], t);
    await run('DELETE FROM user_flags WHERE job_slug = ?', [slug], t);
    await run('DELETE FROM user_jobs WHERE job_slug = ?', [slug], t);
  }

  // Clients with no remaining jobs, and their orphaned reviews.
  await run(
    `DELETE FROM client_reviews
      WHERE client_id NOT IN (SELECT DISTINCT client_id FROM jobs WHERE client_id IS NOT NULL)`,
    [],
    t,
  );
  await run(
    `DELETE FROM clients
      WHERE id NOT IN (SELECT DISTINCT client_id FROM jobs WHERE client_id IS NOT NULL)`,
    [],
    t,
  );
});

console.log(`Deleted ${slugs.length} jobs.`);
console.log(await get('SELECT COUNT(*) AS jobs FROM jobs'));
