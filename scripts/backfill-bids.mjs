/**
 * Copies the latched `jobs.has_own_bid` / `jobs.was_contacted` flags onto one
 * member's private overlay in `user_jobs`.
 *
 * Those two columns predate multi-user support. `adoptLegacyData()` moves them
 * across, but only once, when an account registers — so anything the scraper
 * latched afterwards stayed on the shared row and never reached the overlay the
 * UI actually reads. The visible symptom is the "Not bid by me" filter failing
 * to exclude jobs you did bid on.
 *
 * This is only correct on an instance whose history belongs to one person: the
 * columns are shared, so on a busy multi-member instance they say "somebody
 * bid", not "you bid". It therefore asks for the account explicitly and never
 * runs on its own.
 *
 *   node scripts/backfill-bids.mjs --email you@example.com
 *   node scripts/backfill-bids.mjs --email you@example.com --apply
 */
import { db } from '../src/db.js';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};

const apply = process.argv.includes('--apply');
const email = arg('--email');

if (!email) {
  console.error('Which account? Pass --email you@example.com');
  console.table(db.prepare('SELECT id, email, name, is_admin FROM users').all());
  process.exit(1);
}

const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No account with that address. Known accounts:`);
  console.table(db.prepare('SELECT id, email, name FROM users').all());
  process.exit(1);
}

const before = db
  .prepare(
    `SELECT SUM(has_own_bid) AS bids, SUM(was_contacted) AS contacted, COUNT(*) AS rows
       FROM user_jobs WHERE user_id = ?`,
  )
  .get(user.id);

const pending = db
  .prepare(
    `SELECT COUNT(*) AS n FROM jobs j
      WHERE (j.has_own_bid = 1 OR j.was_contacted = 1)
        AND NOT EXISTS (
          SELECT 1 FROM user_jobs uj
           WHERE uj.user_id = ? AND uj.job_slug = j.slug
             AND uj.has_own_bid >= j.has_own_bid
             AND uj.was_contacted >= j.was_contacted)`,
  )
  .get(user.id).n;

console.log(`account ${user.email} (id ${user.id})`);
console.log(`  overlay now:  ${before.rows} row(s), ${before.bids ?? 0} bid, ${before.contacted ?? 0} contacted`);
console.log(`  to adopt:     ${pending} job(s)`);

if (!apply) {
  console.log('\nDry run. Re-run with --apply to write them.');
  process.exit(0);
}

/*
 * MAX() rather than assignment: the overlay is the member's own record and may
 * already hold a flag the shared row lost, so this only ever adds.
 *
 * The `WHERE true` is required — in an INSERT ... SELECT ... ON CONFLICT, SQLite
 * cannot tell whether "ON" opens a join or the upsert without it.
 */
db.exec('BEGIN');
try {
  db.prepare(
    `INSERT INTO user_jobs (user_id, job_slug, has_own_bid, was_contacted, updated_at)
       SELECT ?, slug, has_own_bid, was_contacted, ?
         FROM jobs WHERE (has_own_bid = 1 OR was_contacted = 1)
     ON CONFLICT(user_id, job_slug) DO UPDATE SET
       has_own_bid   = MAX(user_jobs.has_own_bid, excluded.has_own_bid),
       was_contacted = MAX(user_jobs.was_contacted, excluded.was_contacted),
       updated_at    = excluded.updated_at`,
  ).run(user.id, new Date().toISOString());
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

const after = db
  .prepare(
    `SELECT SUM(has_own_bid) AS bids, SUM(was_contacted) AS contacted, COUNT(*) AS rows
       FROM user_jobs WHERE user_id = ?`,
  )
  .get(user.id);

console.log(`  overlay after: ${after.rows} row(s), ${after.bids} bid, ${after.contacted} contacted`);
