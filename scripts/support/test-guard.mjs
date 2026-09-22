/**
 * Refuses to let a destructive test touch a real database.
 *
 * The control and split tests reset the scrape slot, create accounts and start
 * scrapes with fake sessions. Pointed at the live database by mistake -- easy,
 * since `data\local.env` holds its URL -- they would free a real run's slot and
 * leave test members behind. So they only run against a database whose name (or
 * SQLite file) says "test", unless told otherwise with --force.
 */
export function requireTestDatabase() {
  const url = process.env.DATABASE_URL || '';
  const target = url ? decodeURIComponent(new URL(url).pathname.slice(1)) : process.env.DB_FILE || '';
  if (/test/i.test(target) || process.argv.includes('--force')) return target;
  console.error(
    `\n  Refusing to run: "${target || 'the default SQLite file'}" does not look like a test database.\n` +
      '  This test resets the scrape slot and creates accounts. Point DATABASE_URL at a database\n' +
      '  whose name contains "test" (or DB_FILE at a file that does), or pass --force.\n',
  );
  process.exit(2);
}
