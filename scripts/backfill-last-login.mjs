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

/*
 * The maximum alone is a bad estimator: one client whose profile reports a
 * nonsense login, or one row whose read time is older than the value stored
 * beside it, drags it up on its own. A real offset shows as a *cluster* of gaps
 * pressing right up against a whole number with nothing beyond it, because
 * clients keep logging in until the moment the page is read and never after.
 *
 * So the top of the distribution is printed, and the offset is only asserted
 * when several rows agree on it.
 */
const measured = gaps.length ? Math.ceil(gaps[0]) : null;
const supporting = measured === null ? 0 : gaps.filter((g) => g > measured - 1 && g <= measured).length;

console.log(`clients with a last login : ${rows.length}`);
console.log(`largest (login - read) gap: ${gaps[0]?.toFixed(2)}h`);
console.log(`top gaps                  : ${gaps.slice(0, 8).map((g) => g.toFixed(2)).join(', ')}`);
console.log(`rows in the hour below it : ${supporting}`);
console.log(`measured offset           : UTC+${measured}`);
console.log(`configured offset         : UTC+${config.workanaClockOffsetHours}`);

if (measured !== null && measured !== config.workanaClockOffsetHours) {
  if (supporting >= 5) {
    console.log(
      `
  ${supporting} rows cluster just under ${measured}h, which is what a real offset
` +
        `  looks like. Set WORKANA_CLOCK_OFFSET_HOURS=${measured} and re-run, or every
` +
        '  hour-of-day statistic will be shifted.',
    );
  } else {
    console.log(
      `
  Only ${supporting} row(s) sit near ${measured}h, so that looks like one stray
` +
        `  timestamp rather than the real offset. Keeping UTC+${config.workanaClockOffsetHours}.
` +
        '  Re-run once more clients have been scraped for a firmer reading.',
    );
  }
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
