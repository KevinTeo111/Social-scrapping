/**
 * Repairs `clients.last_login_at` for rows stored before the conversion knew
 * which zone had rendered them.
 *
 * Workana prints "Last login" as a bare wall clock drawn in the reader's zone.
 * Until 6 October 2026 every scrape here ran as Asia/Tokyo, so those rows were
 * rendered at UTC+9 while the code subtracted a fixed 2 -- leaving them seven
 * hours too late. Rows read after that date come from a mix of per-member
 * zones that was never recorded, so they cannot be repaired from the stored
 * value alone; they are left for the next scrape, which now records the zone it
 * used and will overwrite them correctly.
 *
 *   node scripts/fix-last-login.mjs           what it would change
 *   node scripts/fix-last-login.mjs --apply   change it
 *
 * The raw string in `clients.last_login` is never touched, so this can be run
 * again, and re-derived differently later if the evidence changes.
 */
import { initDatabase } from '../src/db.js';
import { all, run, close } from '../src/sql.js';
import { wallClockToUtc } from '../src/locale.js';

const apply = process.argv.includes('--apply');

/** When each identity began presenting its own zone; before this, all Tokyo. */
const SPLIT = '2026-10-06T14:00:00Z';
const ZONE_BEFORE = 'Asia/Tokyo';

await initDatabase();

const rows = await all(
  `SELECT id, name, last_login, last_login_at, updated_at FROM clients
    WHERE last_login IS NOT NULL AND clock_zone IS NULL`,
);

const older = rows.filter((r) => r.updated_at && r.updated_at < SPLIT);
const newer = rows.filter((r) => !r.updated_at || r.updated_at >= SPLIT);

console.log(`${rows.length} client rows carry a last login with no zone recorded`);
console.log(`  ${older.length} read before ${SPLIT} — rendered as ${ZONE_BEFORE}, repairable`);
console.log(`  ${newer.length} read after it — zone unknown, left for the next scrape\n`);

let changed = 0;
let impossible = 0;
const samples = [];

for (const r of older) {
  const corrected = wallClockToUtc(r.last_login, ZONE_BEFORE);
  if (!corrected || corrected === r.last_login_at) continue;
  changed += 1;
  // A login later than the moment we read it is the signature of the old bug.
  if (r.last_login_at && r.updated_at && Date.parse(r.last_login_at) > Date.parse(r.updated_at)) impossible += 1;
  if (samples.length < 6) samples.push({ ...r, corrected });
  if (apply) {
    await run('UPDATE clients SET last_login_at = ?, clock_zone = ? WHERE id = ?', [corrected, ZONE_BEFORE, r.id]);
  }
}

for (const s of samples) {
  const shift = (Date.parse(s.corrected) - Date.parse(s.last_login_at)) / 3600e3;
  console.log(`  ${(s.name ?? s.id).slice(0, 22).padEnd(22)} "${s.last_login}"`);
  console.log(`      ${s.last_login_at}  ->  ${s.corrected}   (${shift > 0 ? '+' : ''}${shift.toFixed(0)} h)`);
}

console.log(
  `\n${apply ? 'corrected' : 'would correct'} ${changed} rows` +
    `, of which ${impossible} were stored later than the moment they were read`,
);
if (!apply) console.log('run again with --apply to write them');

await close();
