/** Removes all accounts (and their stored Workana sessions) from this instance. */
import { db } from '../src/db.js';

const before = db.prepare('SELECT id, email, workana_cookies IS NOT NULL AS creds FROM users').all();
console.log('accounts before:');
console.table(before.map((u) => ({ id: u.id, email: u.email, hasWorkanaSession: Boolean(u.creds) })));

db.exec('DELETE FROM sessions');
db.exec('DELETE FROM user_jobs');
db.exec('DELETE FROM users');

console.log('\nall accounts and stored Workana sessions removed.');
console.log('legacy data still available for the next owner to adopt:');
console.log(
  db.prepare(`SELECT
    (SELECT COUNT(*) FROM jobs WHERE has_own_bid = 1) own_bids,
    (SELECT COUNT(*) FROM jobs WHERE was_contacted = 1) contacted,
    (SELECT COUNT(*) FROM user_flags) stars_and_notes,
    (SELECT COUNT(*) FROM jobs) jobs`).get(),
);
