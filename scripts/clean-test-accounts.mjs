/** Removes accounts created by the test suites, leaving real members alone. */
import fs from 'node:fs';
import { all, run, tx, initDatabase } from '../src/db.js';
import { statePathFor } from '../src/scraper/browser.js';

await initDatabase();

// Every address the test suites have ever generated, all under example.com so a
// real member's address can never match.
const TEST_EMAIL =
  "email LIKE 'vhost%@example.com' OR email LIKE 'alice%@example.com' " +
  "OR email LIKE 'bob%@example.com' OR email LIKE 'statuscheck%@example.com' " +
  "OR email = 'preview@example.com'";

const doomed = await all(`SELECT id, email FROM users WHERE ${TEST_EMAIL}`);
if (!doomed.length) {
  console.log('no test accounts present.');
} else {
  console.table(doomed);
  await tx(async (t) => {
    for (const u of doomed) {
      await run('DELETE FROM sessions WHERE user_id = ?', [u.id], t);
      await run('DELETE FROM user_jobs WHERE user_id = ?', [u.id], t);
      await run('DELETE FROM users WHERE id = ?', [u.id], t);
    }
  });
  /*
   * Browser state lives on the row now and goes with it, but an account created
   * before that change may still have left a profile on disk holding the
   * Cloudflare clearance it earned. Clear those too.
   */
  for (const u of doomed) fs.rmSync(statePathFor(u.id), { force: true });
  console.log(`removed ${doomed.length} test account(s).`);
}

console.log('\nremaining members:');
console.table(
  await all(`SELECT id, email, name, is_admin,
                    CASE WHEN workana_cookies IS NULL THEN 0 ELSE 1 END AS has_session,
                    CASE WHEN browser_state   IS NULL THEN 0 ELSE 1 END AS has_browser_state
               FROM users ORDER BY id`),
);
