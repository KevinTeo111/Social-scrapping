/**
 * What a member's browser should say about where it is.
 *
 * Every scrape used to present one identity's worth of locale: `en-US` and
 * `Asia/Tokyo`, from WORKANA_LOCALE/WORKANA_TZ, for every member. But each
 * member's traffic leaves through their own proxy, in their own country, so
 * Workana saw a freelancer in São Paulo whose browser insisted it was in Tokyo
 * and reading in American English -- while browsing Portuguese projects. That
 * combination is impossible, it is identical across unrelated accounts, and it
 * is a far stronger tell than any request rate.
 *
 * The fix is accuracy rather than disguise: ask the proxy where it comes out,
 * and let the browser say that. A member can override it, because they know
 * where they are better than an IP database does.
 */

/**
 * The only languages this board may ask Workana for.
 *
 * Not a question of taste: `Accept-Language` is how Workana chooses which
 * translation to serve, and every timestamp on the board comes out of
 * parse.js reading phrases like "3 hours ago", "hace 2 horas" and "há 2
 * horas". Those three it knows. Ask for a fourth and the posted dates, the
 * "posted within" filter and the new-posting alerts all quietly stop working
 * on whatever Workana serves instead -- which is why an exit in Japan or
 * Italy keeps the instance default rather than getting its own language.
 *
 * Widen this only alongside parse.js, never on its own.
 */
export const SUPPORTED_LANGUAGES = ['en', 'es', 'pt'];

/**
 * Country -> the language a freelancer there writes proposals in, for the
 * countries whose language this board can actually read back. Workana is
 * Latin-American, so Spanish and Portuguese cover most of it. An unmapped
 * country keeps the instance default, which is the safe outcome rather than a
 * degraded one.
 */
const LANGUAGES = {
  BR: 'pt-BR', PT: 'pt-PT', AO: 'pt-PT', MZ: 'pt-PT',
  AR: 'es-AR', BO: 'es-BO', CL: 'es-CL', CO: 'es-CO', CR: 'es-CR', CU: 'es-CU',
  DO: 'es-DO', EC: 'es-EC', GT: 'es-GT', HN: 'es-HN', MX: 'es-MX', NI: 'es-NI',
  PA: 'es-PA', PE: 'es-PE', PR: 'es-PR', PY: 'es-PY', SV: 'es-SV', UY: 'es-UY',
  VE: 'es-VE', ES: 'es-ES',
  US: 'en-US', CA: 'en-CA', GB: 'en-GB', AU: 'en-AU', IE: 'en-IE', NZ: 'en-NZ',
  IN: 'en-IN', PH: 'en-PH', NG: 'en-NG', ZA: 'en-ZA', KE: 'en-KE', PK: 'en-PK',
};

/** `null` when the country is unknown, so the caller can keep its default. */
export function localeForCountry(code) {
  if (!code) return null;
  return LANGUAGES[String(code).trim().toUpperCase()] ?? null;
}

/**
 * Whether a tag names a language the board can read back. Guards the member's
 * own override as well as detection: typing `ja-JP` would break their posted
 * dates just as surely as detecting it would.
 */
export function isSupportedLocale(tag) {
  if (!isValidLocale(tag)) return false;
  return SUPPORTED_LANGUAGES.includes(String(tag).split('-')[0].toLowerCase());
}

/**
 * The `Accept-Language` a browser in that locale sends: the locale itself, then
 * its bare language, then English as the usual last resort. Workana reads this
 * to choose which translation to serve, so it has to agree with the locale the
 * page is rendered in -- disagreeing was half the original mismatch.
 */
export function acceptLanguage(locale) {
  const tag = String(locale || 'en-US');
  const base = tag.split('-')[0];
  const parts = [tag];
  if (base && base !== tag) parts.push(`${base};q=0.9`);
  if (base !== 'en') parts.push('en;q=0.8');
  return parts.join(',');
}

/**
 * A sanity check before a value from an IP database, or from a member's own
 * typing, is handed to Chromium: an unknown zone makes `newContext` throw and
 * would take the whole run down.
 */
export function isValidTimezone(zone) {
  if (!zone || typeof zone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function isValidLocale(tag) {
  if (!tag || typeof tag !== 'string') return false;
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) return false;
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

/**
 * How far ahead of UTC `timeZone` is at a given instant, in minutes.
 *
 * Derived from Intl rather than a table, so it follows daylight saving without
 * anything here needing to know the rules: render the instant in the zone, read
 * that wall clock back as if it were UTC, and the difference is the offset.
 */
export function offsetMinutesAt(timeZone, instantMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  // `hour12: false` renders midnight as 24 in some engines.
  const hour = p.hour === 24 ? 0 : p.hour;
  return (Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second) - instantMs) / 60_000;
}

/**
 * "October 12, 2026 15:16" as read in `timeZone` -> the real instant.
 *
 * Workana prints its clocks with no zone at all, so the string is meaningless
 * until it is told which zone rendered it. Two passes: the offset at the naive
 * instant, then the offset at the corrected one, which is what settles a time
 * that falls near a daylight-saving change. Returns null if the zone is unknown
 * or the text does not parse, so the caller can fall back rather than store a
 * number it cannot justify.
 */
export function wallClockToUtc(text, timeZone) {
  if (!text || !isValidTimezone(timeZone)) return null;
  const naive = Date.parse(String(text).trim() + ' UTC');
  if (!Number.isFinite(naive)) return null;
  const first = offsetMinutesAt(timeZone, naive);
  let utc = naive - first * 60_000;
  const second = offsetMinutesAt(timeZone, utc);
  if (second !== first) utc = naive - second * 60_000;
  return new Date(utc).toISOString();
}
