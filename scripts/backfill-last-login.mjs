/**
 * Fills in `clients.last_login_at` for rows scraped before it existed, and
 * measures the offset it depends on.
 *
 * Workana prints "Last login" as a wall clock with no timezone, and it is not
 * the browser's — driving the scraper as Asia/Tokyo still produced timestamps
 * two hours ahead of UTC. The offset has to be measured, and it can be: a client
 * cannot have logged in after the moment we read their row, so the largest
 * (login - read) gap across every client converges on the offset from below.
 *
 *   node scripts/backfill-last-login.mjs           # measure and report
 *   node scripts/backfill-last-login.mjs --apply   # also write the timestamps
 */
import { all, run, tx, initDatabase } from '../src/db.js';
import { parseWorkanaClock } from '../src/scraper/parse.js';
import { config } from '../src/config.js';

await initDatabase();
const apply = process.argv.includes('--apply');

const rows = await all(
  `SELECT id, last_login, last_login_at, updated_at FROM clients WHERE last_login IS NOT NULL`,
);

const gaps = rows
  .filter((r) => r.updated_at)
  .map((r) => (Date.parse(`${r.last_login} UTC`) - Date.parse(r.updated_at)) / 3600e3)
  .filter(Number.isFinite)
  .sort((a, b) => b - a);

const measured = gaps.length ? Math.ceil(gaps[0]) : null;
console.log(`clients with a last login : ${rows.length}`);
console.log(`largest (login - read) gap: ${gaps[0]?.toFixed(2)}h`);
console.log(`measured offset           : UTC+${measured}`);
console.log(`configured offset         : UTC+${config.workanaClockOffsetHours}`);
if (measured !== null && measured !== config.workanaClockOffsetHours) {
  console.log(
    `\n  These disagree. Set WORKANA_CLOCK_OFFSET_HOURS=${measured} and re-run,\n` +
      '  or every hour-of-day statistic will be shifted.',
  );
}

const todo = rows.filter((r) => !r.last_login_at);
console.log(`\nrows still needing a timestamp: ${todo.length}`);
if (!apply) {
  console.log('Dry run. Re-run with --apply to write them.');
  process.exit(0);
}

let written = 0;
await tx(async (t) => {
  for (const r of todo) {
    const at = parseWorkanaClock(r.last_login, config.workanaClockOffsetHours);
    if (!at) continue;
    await run('UPDATE clients SET last_login_at = ? WHERE id = ?', [at, r.id], t);
    written += 1;
  }
});
console.log(`wrote ${written} timestamp(s).`);
