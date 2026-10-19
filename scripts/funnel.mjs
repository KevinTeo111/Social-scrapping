/**
 * Publishes the board on an address that does not change.
 *
 * The Cloudflare quick tunnel this replaces was handed a new hostname every
 * time it restarted, which it did several times a day on this machine -- the
 * VPN's resolver cannot reliably look up `region1.v2.argotunnel.com`. Everything
 * built to cope with that churn became its own problem: a Vercel function stood
 * in front to hold the permanent address, every hostname change redeployed it,
 * the redeploys tripped GitHub's rate limit, and the function was billed for
 * provisioned memory on every proxied request until the free tier ran out and
 * the project was deleted.
 *
 * A Tailscale Funnel address is permanent. Nothing has to be redeployed when
 * the tunnel restarts, nothing stands in front of the board, and there is no
 * quota to exhaust -- so the whole apparatus goes away.
 *
 *   run.cmd funnel
 *
 * Needs Tailscale installed and signed in once:
 *   winget install tailscale.tailscale     (or https://tailscale.com/download)
 *   tailscale up
 * and Funnel allowed for this machine, which the admin console asks about the
 * first time. See docs/tunnel.md.
 *
 * Unlike the cloudflared keeper there is no child process to mind: `funnel
 * --bg` hands the job to the Tailscale service, which survives this script
 * exiting, a reboot and a network change. What is left is worth doing anyway --
 * confirm the address really serves the board, and put the configuration back
 * if something clears it.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 4300;
const urlFile = path.join(root, 'data', 'tunnel-url.txt');

/** How often to confirm the address still answers. */
const CHECK_MS = 2 * 60_000;
/** Two misses before re-applying: one slow answer is not an outage. */
const MISSES_BEFORE_REAPPLY = 2;

const log = (...a) => console.log(`[funnel] ${new Date().toLocaleTimeString()}`, ...a);

/*
 * Tailscale installs outside PATH often enough on Windows that looking in the
 * usual place first saves a confusing "not installed" when it plainly is.
 */
const CANDIDATES = [
  'tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

let exe = null;

async function findTailscale() {
  for (const candidate of CANDIDATES) {
    try {
      await run(candidate, ['version'], { timeout: 10_000 });
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const ts = (args, timeout = 20_000) => run(exe, args, { timeout });

/**
 * The machine's permanent name on the tailnet, as a URL.
 *
 * `status --json` reports it with a trailing dot, the way DNS writes a fully
 * qualified name; a URL must not have one.
 */
async function funnelUrl() {
  const { stdout } = await ts(['status', '--json']);
  const status = JSON.parse(stdout);
  const name = status?.Self?.DNSName?.replace(/\.$/, '');
  if (!name) return null;
  return `https://${name}`;
}

/** Why the tailnet is not usable yet, in words that say what to do about it. */
function notReady(status) {
  if (status?.BackendState === 'NeedsLogin' || status?.BackendState === 'NoState') {
    return 'Tailscale is installed but not signed in. Run:  tailscale up';
  }
  if (status?.BackendState === 'Stopped') {
    return 'Tailscale is stopped. Start it from the tray, or run:  tailscale up';
  }
  return null;
}

async function apply() {
  // `--bg` hands the serving to the Tailscale service, so it outlives this
  // script; re-applying an identical configuration is a no-op.
  await ts(['funnel', '--bg', String(port)], 60_000);
}

/**
 * Does the public address actually serve the board?
 *
 * Asked over the open internet rather than through the tailnet, because that is
 * what a member's browser will do, and the two can differ: Funnel can be
 * switched off for the machine while the tailnet itself works perfectly.
 */
async function answers(url) {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(20_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  exe = await findTailscale();
  if (!exe) {
    console.error(
      [
        'Tailscale is not installed, so there is no permanent address to publish on.',
        '',
        '  winget install tailscale.tailscale      (or https://tailscale.com/download)',
        '  tailscale up',
        '',
        'Then run this again. The cloudflared tunnel still works meanwhile:  run.cmd tunnel',
      ].join('\n'),
    );
    process.exit(1);
  }

  let status;
  try {
    status = JSON.parse((await ts(['status', '--json'])).stdout);
  } catch (err) {
    console.error(`Could not ask Tailscale what it is doing: ${err.message}`);
    process.exit(1);
  }
  const blocked = notReady(status);
  if (blocked) {
    console.error(blocked);
    process.exit(1);
  }

  const url = await funnelUrl();
  if (!url) {
    console.error('Tailscale is signed in but reports no name for this machine.');
    process.exit(1);
  }

  try {
    await apply();
  } catch (err) {
    console.error(
      [
        `Could not publish the board: ${err.message}`,
        '',
        'Funnel has to be allowed for this machine once, in the admin console:',
        '  https://login.tailscale.com/admin/dns  -> enable HTTPS certificates',
        '  https://login.tailscale.com/admin/acls -> add this machine to nodeAttrs "funnel"',
      ].join('\n'),
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(urlFile), { recursive: true });
  fs.writeFileSync(urlFile, `${url}\n`);
  log(`published: ${url}  ->  127.0.0.1:${port}`);
  log('this address does not change: share it once and it keeps working');

  if (!(await answers(url))) {
    log('the address does not answer yet — it can take a minute for the certificate');
  }

  let misses = 0;
  setInterval(async () => {
    if (await answers(url)) {
      if (misses) log('answering again');
      misses = 0;
      return;
    }
    misses += 1;
    log(`no answer from ${url} (${misses}/${MISSES_BEFORE_REAPPLY})`);
    if (misses < MISSES_BEFORE_REAPPLY) return;
    misses = 0;
    // The address itself is permanent, so there is nothing to republish and
    // nobody to tell: just put the serving configuration back.
    try {
      await apply();
      log('re-applied the funnel configuration');
    } catch (err) {
      log(`could not re-apply it: ${err.message}`);
    }
  }, CHECK_MS);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => process.exit(0));
}

await main();
