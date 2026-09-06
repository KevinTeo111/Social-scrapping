/** Removes all accounts (and their stored Workana sessions) from this instance. */
import { all, get, exec, initDatabase } from '../src/db.js';

await initDatabase();

const before = await all(
  `SELECT id, email,
          CASE WHEN workana_cookies IS NULL THEN 0 ELSE 1 END AS creds,
          CASE WHEN browser_state   IS NULL THEN 0 ELSE 1 END AS state
     FROM users ORDER BY id`,
);
console.log('accounts before:');
console.table(
  before.map((u) => ({
    id: u.id,
    email: u.email,
    hasWorkanaSession: Boolean(u.creds),
    hasBrowserState: Boolean(u.state),
  })),
);

// Browser state and cookies live on the row, so deleting the row takes the
// credentials with it — there is nothing left behind on disk to clean up.
await exec('DELETE FROM sessions');
await exec('DELETE FROM user_jobs');
await exec('DELETE FROM users');

console.log('\nall accounts and stored Workana sessions removed.');
console.log('legacy data still available for the next owner to adopt:');
console.log(
  await get(`SELECT
    (SELECT COUNT(*) FROM jobs WHERE has_own_bid = 1) AS own_bids,
    (SELECT COUNT(*) FROM jobs WHERE was_contacted = 1) AS contacted,
    (SELECT COUNT(*) FROM user_flags) AS stars_and_notes,
    (SELECT COUNT(*) FROM jobs) AS jobs`),
);
