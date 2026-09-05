/** Removes accounts created by the test suites, leaving real members alone. */
import fs from 'node:fs';
import { db } from '../src/db.js';
import { statePathFor } from '../src/scraper/browser.js';

// Every address the test suites have ever generated, all under example.com so a
// real member's address can never match.
const TEST_EMAIL =
  "email LIKE 'vhost%@example.com' OR email LIKE 'alice%@example.com' " +
  "OR email LIKE 'bob%@example.com' OR email LIKE 'statuscheck%@example.com' " +
  "OR email = 'preview@example.com'";

const doomed = db.prepare(`SELECT id, email FROM users WHERE ${TEST_EMAIL}`).all();
if (!doomed.length) {
  console.log('no test accounts present.');
} else {
  console.table(doomed);
  db.exec('BEGIN');
  try {
    for (const u of doomed) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM user_jobs WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      // A verified account also left a browser profile behind, holding the
      // Cloudflare clearance it earned. Deleting the row without it would leave
      // an orphaned credential on disk.
      fs.rmSync(statePathFor(u.id), { force: true });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`removed ${doomed.length} test account(s).`);
}

console.log('\nremaining members:');
console.table(
  db.prepare('SELECT id, email, name, is_admin, workana_cookies IS NOT NULL AS has_session FROM users').all(),
);
