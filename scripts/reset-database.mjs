/**
 * Empties the database, by scope.
 *
 * This is the blunt instrument. Most problems do not need it: a wrong flag is
 * repaired by refresh-my-bids, a wrong category set by prune-non-it, and both
 * keep the accounts and the history intact. What is deleted here is gone —
 * there is no undo and no backup taken.
 *
 *   node scripts/reset-database.mjs --scope corpus
 *   node scripts/reset-database.mjs --scope corpus --apply
 *
 * Scopes:
 *   corpus     jobs, clients, reviews, insights, scrape history.
 *              Accounts and everyone's private overlay survive.
 *   overlays   every member's bids, contacts, stars and notes. Nothing else.
 *   all        the above plus every account, password and stored Workana
 *              session. Needs --drop-accounts as well, so that a mistyped
 *              scope cannot take the accounts with it.
 *
 * DATABASE_URL selects Postgres; without it the local SQLite file is used.
 */
import { all, get, run, exec, tx, initDatabase, isPostgres, dialect } from '../src/db.js';
import { config } from '../src/config.js';

await initDatabase();

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const apply = process.argv.includes('--apply');
const dropAccounts = process.argv.includes('--drop-accounts');
const scope = arg('--scope');

if (!['corpus', 'overlays', 'all'].includes(scope)) {
  console.error('Pass --scope corpus | overlays | all');
  process.exit(1);
}
if (scope === 'all' && !dropAccounts) {
  console.error(
    '--scope all also deletes every account, password and stored Workana session.\n' +
      'Add --drop-accounts to confirm you mean that.',
  );
  process.exit(1);
}

/*
 * Order matters: a child row goes before whatever it points at. jobs references
 * clients, and sessions and user_jobs reference users.
 */
const CORPUS = ['job_insights', 'client_reviews', 'user_flags', 'jobs', 'clients', 'scrape_runs'];
const OVERLAYS = ['user_jobs'];
const ACCOUNTS = ['sessions', 'users'];

const tables =
  scope === 'corpus' ? CORPUS
  : scope === 'overlays' ? OVERLAYS
  : [...OVERLAYS, ...CORPUS, ...ACCOUNTS];

console.log(`engine : ${dialect}${isPostgres ? ` (${new URL(config.databaseUrl).host})` : ` (${config.dbFile})`}`);
console.log(`scope  : ${scope}\n`);

const counts = [];
for (const t of tables) {
  const n = (await get(`SELECT COUNT(*) AS n FROM ${t}`)).n;
  counts.push({ table: t, rows: Number(n) });
}
console.table(counts);
const total = counts.reduce((sum, c) => sum + c.rows, 0);
console.log(`${total} row(s) would be deleted.`);

// What survives is worth stating plainly, because it is the part people assume.
if (scope === 'corpus') {
  const u = (await get('SELECT COUNT(*) AS n FROM users')).n;
  const o = (await get('SELECT COUNT(*) AS n FROM user_jobs')).n;
  console.log(`Kept: ${u} account(s) and ${o} overlay row(s).`);
} else if (scope === 'overlays') {
  const j = (await get('SELECT COUNT(*) AS n FROM jobs')).n;
  console.log(`Kept: ${j} job(s) and every account.`);
} else {
  console.log('Kept: nothing. Every account, session and job is removed.');
}

if (!apply) {
  console.log('\nDry run. Re-run with --apply to delete.');
  process.exit(0);
}

await tx(async (t) => {
  for (const table of tables) await run(`DELETE FROM ${table}`, [], t);
});

// The FTS index is SQLite's alone; on Postgres the tsvector went with the row.
if (!isPostgres && tables.includes('jobs')) {
  await exec('DELETE FROM jobs_fts').catch(() => {});
}

/*
 * Postgres consumes a sequence value on every INSERT ... ON CONFLICT, including
 * the ones that only update, so `seq` climbs far past the row count — 67k for
 * 1.5k jobs. With the table empty it can go back to 1, which is also what makes
 * the list's "#000123" compact again.
 */
if (isPostgres && tables.includes('jobs')) {
  await exec(`SELECT setval(pg_get_serial_sequence('jobs', 'seq'), 1, false)`).catch(() => {});
}
if (isPostgres && tables.includes('users')) {
  await exec(`SELECT setval(pg_get_serial_sequence('users', 'id'), 1, false)`).catch(() => {});
}

console.log(`\nDeleted ${total} row(s).`);
for (const { table } of counts) {
  console.log(`  ${table.padEnd(16)} ${(await get(`SELECT COUNT(*) AS n FROM ${table}`)).n}`);
}
if (scope === 'all') {
  console.log('\nThe next person to register becomes the owner.');
}
