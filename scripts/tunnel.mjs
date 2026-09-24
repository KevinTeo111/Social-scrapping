/**
 * Keeps the board published, whatever the network does.
 *
 * A Cloudflare quick tunnel is handed a new hostname each time it starts, and on
 * a machine whose DNS goes through a VPN it does not always stay up -- observed
 * here as `lookup region1.v2.argotunnel.com: i/o timeout`, after which the
 * hostname stops resolving and the board is quietly unreachable. So this runs
 * cloudflared, watches whether the tunnel is actually answering, restarts it
 * when it is not, and -- given a Vercel token -- points the front door at the
 * new address so nobody has to be told a new link.
 *
 *   run.cmd tunnel
 *
 * Optional, in data\local.env, to update the front door automatically:
 *   VERCEL_TOKEN=...        Vercel → Account Settings → Tokens
 *   VERCEL_PROJECT=workana-job-scrapping
 *   VERCEL_TEAM_ID=team_... (only if the project lives in a team)
 *
 * Without those it just keeps the tunnel up and prints the address, which is
 * what a single user needs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, '.tools', 'cloudflared.exe');
const port = Number(process.env.PORT) || 4300;
const urlFile = path.join(root, 'data', 'tunnel-url.txt');

/** How often to ask whether the tunnel still answers, and how long to wait. */
const CHECK_MS = 60_000;
const CHECK_TIMEOUT_MS = 25_000;
/** Two misses before restarting: one slow answer is not an outage. */
const MISSES_BEFORE_RESTART = 2;

const { VERCEL_TOKEN, VERCEL_PROJECT, VERCEL_TEAM_ID } = process.env;
const api = (p) => `https://api.vercel.com${p}${VERCEL_TEAM_ID ? `${p.includes('?') ? '&' : '?'}teamId=${VERCEL_TEAM_ID}` : ''}`;
const log = (...a) => console.log(`[tunnel] ${new Date().toLocaleTimeString()}`, ...a);

if (!fs.existsSync(exe)) {
  console.error(`cloudflared is not at ${exe}\nDownload it from https://github.com/cloudflare/cloudflared/releases/latest`);
  process.exit(1);
}

/**
 * Points the Vercel front door at `url`: replaces BOARD_ORIGIN and redeploys,
 * because a function only sees an environment variable as it was when it was
 * built.
 */
async function updateFrontDoor(url) {
  if (!VERCEL_TOKEN || !VERCEL_PROJECT) return;
  const headers = { authorization: `Bearer ${VERCEL_TOKEN}`, 'content-type': 'application/json' };
  const call = async (p, init) => {
    const res = await fetch(api(p), { ...init, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${p}: ${res.status} ${body?.error?.message || ''}`);
    return body;
  };
  try {
    const { envs } = await call(`/v9/projects/${VERCEL_PROJECT}/env?decrypt=false`);
    const existing = envs?.find((e) => e.key === 'BOARD_ORIGIN');
    if (existing) {
      await call(`/v9/projects/${VERCEL_PROJECT}/env/${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ value: url, target: ['production', 'preview', 'development'] }),
      });
    } else {
      await call(`/v10/projects/${VERCEL_PROJECT}/env`, {
        method: 'POST',
        body: JSON.stringify({ key: 'BOARD_ORIGIN', value: url, type: 'plain', target: ['production', 'preview', 'development'] }),
      });
    }
    // Redeploy the newest production deployment so the new value takes effect.
    const { deployments } = await call(`/v6/deployments?app=${VERCEL_PROJECT}&target=production&limit=1`);
    const last = deployments?.[0];
    if (!last) return log('no production deployment to redeploy yet — deploy once from the dashboard');
    await call('/v13/deployments', {
      method: 'POST',
      body: JSON.stringify({ name: VERCEL_PROJECT, deploymentId: last.uid, target: 'production' }),
    });
    log(`front door updated and redeploying → ${url}`);
  } catch (err) {
    log(`could not update the front door: ${err.message}`);
  }
}

let child = null;
let current = null;
let misses = 0;

function startTunnel() {
  current = null;
  child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (buf) => {
    const text = buf.toString();
    const m = text.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== current) {
      current = m[0];
      fs.writeFileSync(urlFile, `${current}\n`);
      log(`published: ${current}`);
      updateFrontDoor(current);
    }
    // cloudflared's own errors are worth seeing, its chatter is not.
    for (const line of text.split('\n')) {
      if (/ERR|error/.test(line) && !/Incoming request ended abruptly/.test(line)) log(line.trim().slice(0, 160));
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    log(`cloudflared exited (${code}) — restarting`);
    child = null;
    setTimeout(startTunnel, 3000);
  });
}

/** Answers only if the tunnel is genuinely serving the board from outside. */
async function tunnelAnswers() {
  if (!current) return false;
  const control = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${current}/healthz`, { signal: control, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

function restart(why) {
  log(why);
  misses = 0;
  if (child) child.kill(); // the exit handler starts a fresh one
  else startTunnel();
}

startTunnel();
setInterval(async () => {
  if (!child || !current) return;
  if (await tunnelAnswers()) {
    misses = 0;
    return;
  }
  misses += 1;
  log(`no answer from ${current} (${misses}/${MISSES_BEFORE_RESTART})`);
  if (misses >= MISSES_BEFORE_RESTART) restart('tunnel is not answering — restarting it');
}, CHECK_MS);

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    child?.kill();
    process.exit(0);
  });
}
