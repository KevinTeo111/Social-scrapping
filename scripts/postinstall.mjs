/**
 * Downloads the Chromium build Playwright drives -- except where nothing scrapes.
 *
 * The board on Vercel never starts a browser (src/app.js does not import the
 * scraper), so downloading one there only slows every build and risks failing
 * it. Vercel sets VERCEL=1 during builds; PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is
 * Playwright's own switch for the same thing, honoured here too.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.VERCEL || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
  console.log('[postinstall] Skipping the Chromium download: this build does not scrape.');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', 'playwright', 'cli.js');
const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
