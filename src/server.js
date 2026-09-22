/**
 * The local entry point: the board and the scraper, in one process or either
 * one alone.
 *
 *   ROLE=all     (default) serve the board and run the scraper beside it
 *   ROLE=web     serve the board only; some other process scrapes
 *   ROLE=worker  scrape only; the board is served elsewhere (Vercel)
 *
 * `--role=worker` on the command line does the same as the variable.
 *
 * The two halves share nothing in memory -- only the database -- so a board on
 * Vercel and this process on a workstation cooperate exactly as the two halves
 * of one process do. See src/control.js.
 */
import { config } from './config.js';
import { get, initDatabase } from './db.js';
import { userCount } from './auth.js';

const roleFlag = process.argv.find((a) => a.startsWith('--role='))?.slice('--role='.length);
const ROLE = String(roleFlag || process.env.ROLE || 'all').toLowerCase();
if (!['all', 'web', 'worker'].includes(ROLE)) {
  console.error(`\n  Unknown ROLE "${ROLE}" -- use all, web or worker.\n`);
  process.exit(1);
}
const serveBoard = ROLE !== 'worker';
const runScraper = ROLE !== 'web';

/*
 * The schema has to exist before the first request is served, and this process
 * is the one that keeps it current (a serverless board only connects).
 *
 * A hosted database over the internet occasionally stalls a connection -- from
 * a workstation to Neon, one in a few dozen takes longer than the pool's 20
 * seconds -- and a scraper meant to run unattended must not quit over one slow
 * handshake. So a connection failure is retried a few times first. Anything else
 * is fatal at once: serving a board with no database behind it would only
 * produce a wall of confusing 500s.
 */
const TRANSIENT = /timeout|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i;
for (let attempt = 1; ; attempt += 1) {
  try {
    await initDatabase();
    break;
  } catch (err) {
    if (config.databaseUrl && TRANSIENT.test(err.message) && attempt < 5) {
      const wait = attempt * 5;
      console.warn(`  Database not reachable yet (${err.message}) — retrying in ${wait}s (${attempt}/4)`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    console.error(`\n  Could not open the database: ${err.message}\n`);
    if (config.databaseUrl) {
      console.error('  DATABASE_URL is set, so this is Postgres. Check the database is running');
      console.error('  and that the host in the URL is reachable from this machine.\n');
    }
    process.exit(1);
  }
}

let worker = null;
if (runScraper) {
  const { startWorker } = await import('./worker.js');
  worker = startWorker();
}

/*
 * Ctrl+C, or the terminal closing, hands the slot back straight away so the board
 * shows the scraper as gone and the slot as free now, rather than a minute and a
 * half later when the lease would have lapsed on its own.
 */
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log('\n  Shutting down…');
    await worker?.shutdown().catch(() => {});
    process.exit(0);
  });
}

async function banner() {
  const n = (await get('SELECT COUNT(*) AS n FROM jobs')).n;
  const members = await userCount();
  const store = config.databaseUrl ? `Postgres (${new URL(config.databaseUrl).host})` : config.dbFile;
  console.log(`  ${n} jobs · ${members} member(s) · ${store}`);
  if (runScraper) {
    // Worth printing: the lane counts are derived from memory, so this is the
    // one place that explains why a small machine scrapes narrower than a big one.
    console.log(
      `  Scraper: ${Math.round(config.memoryLimitBytes / 1024 / 1024)} MB available · ` +
        `${config.detailConcurrency} detail / ${config.insightConcurrency} insight lane(s)`,
    );
    console.log(
      config.autoScrapeMinutes
        ? `  Auto-refresh every ${config.autoScrapeMinutes} min (AUTO_SCRAPE_MINUTES=0 to disable)`
        : '  Auto-refresh disabled',
    );
  } else {
    console.log('  Scraper: not in this process (ROLE=web) — another process must run ROLE=worker');
  }
  if (members === 0) console.log('  No accounts yet — the first person to register becomes the owner.');
}

if (!serveBoard) {
  console.log('\n  Workana scraper running (ROLE=worker) — the board is served elsewhere.');
  await banner();
  console.log('');
} else {
  const { app } = await import('./app.js');
  app.listen(config.port, config.host, async () => {
    console.log(`\n  Workana job board  →  http://${config.host}:${config.port}\n`);
    await banner();

    // This instance can use every member's stored Workana login. Say so plainly
    // if it is reachable from outside the machine.
    const exposed = config.host !== '127.0.0.1' && config.host !== 'localhost';
    if (exposed) {
      console.warn(`\n  ⚠ Listening on ${config.host} — reachable from the network.`);
      console.warn('    This server can use every member\'s stored Workana login.');
      if (!config.allowedHosts.length) {
        console.warn('    · ALLOWED_HOSTS is unset: any Host header is accepted (DNS-rebinding risk).');
      }
      if (!config.trustProxy) {
        console.warn('    · TRUST_PROXY is off: sessions will not be marked Secure, so put a');
        console.warn('      TLS-terminating proxy in front and set TRUST_PROXY=1.');
      }
      if (!process.env.APP_SECRET) {
        console.warn('    · APP_SECRET is auto-generated; set it explicitly before others join.');
      }
    }
    if (config.allowedHosts.length) {
      console.log(`  Accepting hosts: ${config.allowedHosts.join(', ')} (plus localhost)`);
    }
    if (!config.allowRegistration) console.log('  Registration is closed (ALLOW_REGISTRATION=0).');
    else if (config.registrationCode) console.log('  Registration requires an invite code.');
    console.log('');
  });
}
