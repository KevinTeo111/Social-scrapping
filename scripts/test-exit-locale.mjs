/**
 * Each identity presents the timezone and language of the address it comes out
 * of, and a list walk eases off at the depth where challenges actually start.
 *
 * Both exist for the same reason: the instance used to present one browser
 * identity -- Asia/Tokyo, en-US -- for every member, whatever country their
 * proxy exited, which is an impossible combination repeated across unrelated
 * accounts. The pacing half is measured rather than guessed; see config.js.
 *
 *   node scripts/test-exit-locale.mjs
 *
 * Temporary SQLite file, no browser and no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workana-locale-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATABASE_URL = '';
process.env.APP_SECRET = 'locale-test-secret';
process.env.EXIT_GEO_URL = ''; // no outbound lookup from a test
process.env.WORKANA_TZ = 'Asia/Tokyo';
process.env.WORKANA_LOCALE = 'en-US';
const { requireTestDatabase } = await import('./support/test-guard.mjs');
requireTestDatabase();

let fail = 0;
const ok = (n, c, x = '') => {
  if (!c) fail += 1;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};

const { initDatabase } = await import('../src/db.js');
const { close } = await import('../src/sql.js');
const { config } = await import('../src/config.js');
const locale = await import('../src/locale.js');
const auth = await import('../src/auth.js');

try {
  await initDatabase();

  /* ---- the country -> language map ---- */
  ok('Brazil writes Portuguese', locale.localeForCountry('BR') === 'pt-BR');
  ok('Argentina writes Spanish', locale.localeForCountry('AR') === 'es-AR');
  ok('lower case is accepted', locale.localeForCountry('br') === 'pt-BR');
  ok('an unknown country yields nothing, so the default stands', locale.localeForCountry('ZZ') === null);
  ok('no country yields nothing', locale.localeForCountry(null) === null);

  /* ---- Accept-Language has to agree with the rendered locale ---- */
  ok('Accept-Language leads with the locale', locale.acceptLanguage('pt-BR').startsWith('pt-BR,'));
  ok('...then the bare language', locale.acceptLanguage('pt-BR').includes('pt;q=0.9'));
  ok('...then English', locale.acceptLanguage('pt-BR').endsWith('en;q=0.8'));
  ok('English does not list itself twice', locale.acceptLanguage('en-US') === 'en-US,en;q=0.9');

  /* ---- nothing invalid ever reaches Chromium ---- */
  ok('a real zone passes', locale.isValidTimezone('America/Sao_Paulo'));
  ok('an invented zone is refused', !locale.isValidTimezone('Mars/Olympus'));
  ok('an empty zone is refused', !locale.isValidTimezone(''));
  ok('a real tag passes', locale.isValidLocale('pt-BR'));
  ok('junk is refused', !locale.isValidLocale('not a locale!'));

  /* ---- only languages parse.js can read back ---- */
  ok('Portuguese is readable', locale.isSupportedLocale('pt-BR'));
  ok('Spanish is readable', locale.isSupportedLocale('es-AR'));
  ok('English is readable', locale.isSupportedLocale('en-US'));
  ok('Japanese is not, so it must be refused', !locale.isSupportedLocale('ja-JP'));
  ok('...nor Italian', !locale.isSupportedLocale('it-IT'));
  ok('an exit in Japan gets no language of its own', locale.localeForCountry('JP') === null);
  ok('...nor one in Italy', locale.localeForCountry('IT') === null);
  ok('an exit in Brazil does', locale.localeForCountry('BR') === 'pt-BR');

  /* ---- storing it ---- */
  const u = await auth.registerUser({ email: 'exit@local.test', password: 'locale-test-1234', name: 'Exit' });

  let eff = await auth.getScrapeLocale(u.id);
  ok(
    'with nothing stored, the instance default is presented',
    eff.timezone === 'Asia/Tokyo' && eff.locale === 'en-US',
    `${eff.timezone} / ${eff.locale}`,
  );
  ok('...and it is not reported as detected', eff.detected === false);

  await auth.setScrapeLocale(u.id, { country: 'BR', timezone: 'America/Sao_Paulo', source: 'probe' });
  eff = await auth.getScrapeLocale(u.id);
  ok('a probed exit sets the zone', eff.timezone === 'America/Sao_Paulo', eff.timezone);
  ok('...and the language follows from the country', eff.locale === 'pt-BR', eff.locale);
  ok('...and the country is remembered', eff.country === 'BR');

  await auth.setScrapeLocale(u.id, { country: 'AR', timezone: 'America/Argentina/Buenos_Aires', source: 'probe' });
  eff = await auth.getScrapeLocale(u.id);
  ok('a later probe does not overwrite what is already set', eff.timezone === 'America/Sao_Paulo', eff.timezone);

  await auth.setScrapeLocale(u.id, { timezone: 'Europe/Lisbon', locale: 'pt-PT', source: 'member' });
  eff = await auth.getScrapeLocale(u.id);
  ok('the member overrides it', eff.timezone === 'Europe/Lisbon' && eff.locale === 'pt-PT');
  await auth.setScrapeLocale(u.id, { country: 'BR', timezone: 'America/Sao_Paulo', source: 'probe' });
  eff = await auth.getScrapeLocale(u.id);
  ok('...and a probe never overrides the member', eff.timezone === 'Europe/Lisbon', eff.timezone);

  await auth.setScrapeLocale(u.id, { timezone: 'Mars/Olympus', locale: 'junk!', source: 'member' });
  eff = await auth.getScrapeLocale(u.id);
  ok(
    'nonsense is dropped rather than stored, falling back to the default',
    eff.timezone === 'Asia/Tokyo' && eff.locale === 'en-US',
    `${eff.timezone} / ${eff.locale}`,
  );

  /*
   * The zone and the language are not the same risk. A zone only changes what
   * the page's own clock says; a language changes which translation Workana
   * serves, and the board reads its timestamps out of that text. So an exit in
   * a country this board cannot read keeps its own zone and the default
   * language -- it must never silently stop collecting posted dates.
   */
  // An exit in Italy is a real one here, and Italian is not a language the
  // board can read back.
  await auth.setScrapeLocale(u.id, { country: 'IT', timezone: 'Europe/Rome', source: 'probe' });
  eff = await auth.getScrapeLocale(u.id);
  ok('an unreadable country still gets its real zone', eff.timezone === 'Europe/Rome', eff.timezone);
  ok('...but keeps the default language', eff.locale === 'en-US', eff.locale);

  await auth.setScrapeLocale(u.id, { timezone: 'Europe/Rome', locale: 'it-IT', source: 'member' });
  eff = await auth.getScrapeLocale(u.id);
  ok('a member cannot set a language the board cannot read either', eff.locale === 'en-US', eff.locale);

  /* ---- changing the exit invalidates what was read from the old one ---- */
  // Start from nothing stored, so what follows tests a *detected* value.
  await auth.setScrapeLocale(u.id, { country: null, timezone: null, locale: null, source: 'member' });
  await auth.setScrapeLocale(u.id, { country: 'BR', timezone: 'America/Sao_Paulo', source: 'probe' });
  await auth.setWorkanaProxy(u.id, 'socks5://198.51.100.9:1080');
  eff = await auth.getScrapeLocale(u.id);
  ok(
    'a new proxy clears a detected zone, since the country may differ',
    eff.timezone === 'Asia/Tokyo' && eff.country === null,
    `${eff.timezone} / ${eff.country}`,
  );

  await auth.setScrapeLocale(u.id, { timezone: 'America/Bogota', locale: 'es-CO', source: 'member' });
  await auth.setWorkanaProxy(u.id, 'socks5://scrape-user:s3cret@198.51.100.10:1080');
  eff = await auth.getScrapeLocale(u.id);
  ok('...but keeps one the member typed', eff.timezone === 'America/Bogota', eff.timezone);

  /* ---- the panel sees it, the credentials stay put ---- */
  const shown = auth.publicUser(await auth.findUser(u.id));
  ok('the panel is told what is in use', shown.exit.effective.timezone === 'America/Bogota');
  ok('...and who set it', shown.exit.setBy === 'member');
  // Host and port are shown on purpose; the credentials never are, and the new
  // locale fields must not have opened a second way out for them.
  const json = JSON.stringify(shown);
  ok('the proxy password is still never handed back', !json.includes('s3cret'), json.slice(0, 160));
  ok('...nor its username', !json.includes('scrape-user'));

  /* ---- the rotation carries it, so the scraper needs no second query ---- */
  await auth.setWorkanaCookies(
    u.id,
    JSON.stringify([{ name: 'workana_session', value: 'x', domain: '.workana.com', path: '/' }]),
  );
  const [row] = await auth.scrapeCandidates();
  ok('the rotation hands over the zone with the id', row?.scrape_timezone === 'America/Bogota', String(row?.scrape_timezone));

  /* ---- pacing by depth ---- */
  ok('the shallow pages stay fast', config.minDelayMs <= 1200 && config.maxDelayMs <= 2000);
  ok('the slow depth is where challenges begin, not before', config.slowFromPage >= 5 && config.slowFromPage <= 10);
  ok('the deep pause is longer than the shallow one', config.slowMinDelayMs > config.maxDelayMs);
  ok('the per-identity ceiling is off by default, so no run is dropped', config.maxPagesPerIdentityHour === 0);

  /*
   * A full walk has to stay inside its 20-minute slot, or the schedule falls
   * behind and a run meets the next one. Worst case, every pause at its longest.
   */
  const pages = 40;
  let worst = 0;
  for (let p = 2; p <= pages; p++) worst += p >= config.slowFromPage ? config.slowMaxDelayMs : config.maxDelayMs;
  const minutes = (worst + pages * 3000) / 60_000; // plus a slow 3s per page load
  ok(`a ${pages}-page walk still fits its slot (worst case ${minutes.toFixed(1)} min)`, minutes < 15);
} catch (err) {
  fail += 1;
  console.log(`FAIL  ${err.message}`);
  console.log(err.stack);
} finally {
  await close().catch(() => {});
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
