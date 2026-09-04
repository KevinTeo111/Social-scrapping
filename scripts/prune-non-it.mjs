/**
 * Removes jobs outside IT & Programming, left over from crawls that ran before
 * the category was narrowed.
 *
 * Reports by default and changes nothing; pass --apply to actually delete.
 * Jobs whose category is still unknown (never enriched) are always kept — a
 * missing category is not evidence of the wrong category.
 */
import { db } from '../src/db.js';

const KEEP = process.env.KEEP_CATEGORY || 'IT & Programming';
const apply = process.argv.includes('--apply');

const doomed = db
  .prepare('SELECT slug, category, title FROM jobs WHERE category IS NOT NULL AND category <> ?')
  .all(KEEP);

const byCategory = db
  .prepare(
    `SELECT category, COUNT(*) n FROM jobs
      WHERE category IS NOT NULL AND category <> ?
      GROUP BY category ORDER BY n DESC`,
  )
  .all(KEEP);

console.log(`Keeping: ${KEEP}`);
console.table(byCategory);
console.log(`${doomed.length} jobs would be removed.`);
console.log(
  `${db.prepare('SELECT COUNT(*) n FROM jobs WHERE category IS NULL').get().n} jobs have no category yet and are kept.`,
);

if (!apply) {
  console.log('\nDry run — nothing deleted. Re-run with --apply to delete.');
  process.exit(0);
}

const slugs = doomed.map((d) => d.slug);
db.exec('BEGIN');
try {
  const delJob = db.prepare('DELETE FROM jobs WHERE slug = ?');
  const delFts = db.prepare('DELETE FROM jobs_fts WHERE slug = ?');
  const delIns = db.prepare('DELETE FROM job_insights WHERE job_slug = ?');
  const delFlag = db.prepare('DELETE FROM user_flags WHERE job_slug = ?');
  for (const slug of slugs) {
    delJob.run(slug);
    delFts.run(slug);
    delIns.run(slug);
    delFlag.run(slug);
  }
  // Clients with no remaining jobs, and their orphaned reviews.
  db.exec('DELETE FROM client_reviews WHERE client_id NOT IN (SELECT DISTINCT client_id FROM jobs WHERE client_id IS NOT NULL)');
  db.exec('DELETE FROM clients WHERE id NOT IN (SELECT DISTINCT client_id FROM jobs WHERE client_id IS NOT NULL)');
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

console.log(`Deleted ${slugs.length} jobs.`);
console.log(db.prepare('SELECT COUNT(*) jobs FROM jobs').get());
