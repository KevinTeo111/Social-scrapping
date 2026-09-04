/** Screenshots the local UI so the layout can be checked without a browser. */
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:4300';
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1660, height: 940 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const out = process.env.SHOT_DIR || 'data/debug';

await page.goto(base, { waitUntil: 'networkidle' });

// Signed out: capture the gate, then sign in as the demo member.
if (await page.locator('#gate:visible').count()) {
  await page.screenshot({ path: `${out}/ui-signin.png` });
  const email = process.env.SHOT_EMAIL;
  const password = process.env.SHOT_PASSWORD;
  if (!email) { console.log('signed out; set SHOT_EMAIL/SHOT_PASSWORD to continue'); await browser.close(); process.exit(0); }
  await page.fill('#authEmail', email);
  await page.fill('#authPassword', password);
  await page.click('#gateSubmit');
  await page.waitForSelector('#gate', { state: 'hidden', timeout: 15000 });
}

// The account panel opens automatically when a member has no Workana session,
// but only after the board finishes booting — so wait for it rather than racing.
await page.waitForTimeout(1500);
if (await page.locator('#accountBackdrop:visible').count()) {
  await page.screenshot({ path: `${out}/ui-account.png` });
  await page.click('#accountBackdrop', { position: { x: 8, y: 8 } });
  await page.waitForSelector('#accountBackdrop', { state: 'hidden', timeout: 5000 });
}

await page.waitForSelector('.jobs tbody tr', { timeout: 15000 });
await page.screenshot({ path: `${out}/ui-list.png` });
console.log('rows:', await page.locator('.jobs tbody tr').count());

// Detail drawer — pick a job that actually has contacted freelancers, so the
// avatar strip is exercised rather than the empty state.
await page.check('#hasContacts');
await page.waitForTimeout(900);
console.log('jobs with contacts:', await page.locator('.jobs tbody tr').count());
await page.locator('.jobs tbody tr').first().click();
await page.waitForSelector('.drawer-body .person', { timeout: 20000 });
// Remote avatars need a moment; checking too early reports a false zero.
await page.waitForFunction(
  () => [...document.querySelectorAll('.person-av')].every((i) => i.complete),
  { timeout: 15000 },
).catch(() => {});
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/ui-drawer.png` });
console.log('contacted people rendered:', await page.locator('.person.contacted').count());
console.log('avatars loaded:', await page.evaluate(() =>
  [...document.querySelectorAll('.person-av')].filter((i) => i.naturalWidth > 0).length));

await page.keyboard.press('Escape');
await page.uncheck('#hasContacts');
await page.waitForTimeout(600);

// Statistics
await page.keyboard.press('Escape');
await page.click('#statsBtn');
await page.waitForSelector('#statsModal .stat-cards', { timeout: 15000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/ui-stats.png` });

// Dark theme list
await page.keyboard.press('Escape');
await page.click('#themeBtn');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/ui-dark.png` });

console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
