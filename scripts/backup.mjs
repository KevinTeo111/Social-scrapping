/**
 * Copies the database to data\backups\, keeping the most recent few.
 *
 * With the board and the scraper on one machine, the SQLite file is the only
 * copy of the corpus, every account, and their encrypted Workana sessions --
 * there is no hosted database standing behind it any more.
 *
 *   run.cmd backup            keep the default number of copies
 *   run.cmd backup --keep=14
 *
 * It uses SQLite's own VACUUM INTO rather than copying the file: a plain copy
 * taken while the scraper is writing can catch a half-written page, and this
 * also compacts the copy. Backups are written beside the database, which means
 * data\ -- gitignored, but on the same disk, so keep one elsewhere too if the
 * corpus matters.
 *
 * Nothing to do on Postgres: DATABASE_URL means the database is hosted and
 * backed up there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { isPostgres, connect, close } from '../src/sql.js';

if (isPostgres) {
  console.log('DATABASE_URL is set, so the database is hosted; back it up there.');
  process.exit(0);
}

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const keep = Math.max(1, Number(arg('keep', 7)) || 7);

const dir = path.join(path.dirname(config.dbFile), 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const target = path.join(dir, `workana-${stamp}.db`);

const db = await connect();
// VACUUM INTO takes no parameters, and the path is ours, not user input.
await db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
await close();

const size = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`backed up to ${target}  (${size} MB)`);

const old = fs
  .readdirSync(dir)
  .filter((f) => /^workana-.*\.db$/.test(f))
  .sort()
  .slice(0, -keep);
for (const f of old) {
  fs.rmSync(path.join(dir, f));
  console.log(`  removed older copy ${f}`);
}
console.log(`keeping the ${keep} most recent`);
