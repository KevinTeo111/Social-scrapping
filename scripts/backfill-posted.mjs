/**
 * Re-parses `published_text` for jobs that ended up with no posting date.
 *
 * Earlier runs could not read Workana's "Last month" / "Last year" wording, so
 * those jobs were stored with a null date and the board fell back to when it
 * collected them — making months-old projects look brand new and sorting them to
 * the top of "Newest posted". The parser handles that wording now; this fixes
 * the rows already in the database.
 *
 * The relative phrase is resolved against `first_seen_at`, not the current time:
 * "last month" meant one month before the page was read, which may itself have
 * been a while ago.
 *
 *   node scripts/backfill-posted.mjs            # report only
 *   node scripts/backfill-posted.mjs --apply    # write the dates
 */
import { all, run, tx, initDatabase } from '../src/db.js';
import { parseRelative } from '../src/scraper/parse.js';

await initDatabase();

const apply = process.argv.includes('--apply');

const rows = await all(
  `SELECT slug, published_text, first_seen_at
     FROM jobs
    WHERE published_approx_at IS NULL AND published_text IS NOT NULL`,
);

const fixes = [];
for (const r of rows) {
  const base = Date.parse(r.first_seen_at);
  const at = parseRelative(r.published_text, Number.isNaN(base) ? Date.now() : base);
  if (at) fixes.push({ slug: r.slug, text: r.published_text, at });
}

console.log(`${rows.length} job(s) without a parsed posting date; ${fixes.length} now parse.`);

const bySample = new Map();
for (const f of fixes) if (!bySample.has(f.text)) bySample.set(f.text, f.at);
if (bySample.size) {
  console.table([...bySample].map(([text, at]) => ({ text, resolves_to: at })));
}

const fixed = new Set(fixes.map((f) => f.slug));
const stuck = rows.filter((r) => !fixed.has(r.slug));
if (stuck.length) {
  console.log('\nstill unparsed:');
  console.table([...new Set(stuck.map((r) => r.published_text))].slice(0, 20).map((text) => ({ text })));
}

if (!apply) {
  console.log('\nDry run. Re-run with --apply to write these dates.');
  process.exit(0);
}

await tx(async (t) => {
  for (const f of fixes) {
    await run('UPDATE jobs SET published_approx_at = ? WHERE slug = ?', [f.at, f.slug], t);
  }
});

console.log(`\nupdated ${fixes.length} job(s).`);
