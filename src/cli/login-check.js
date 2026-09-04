import { checkLogin } from '../scraper/scrape.js';
import { loadWorkanaCookies, describeSession, hasSessionCookie } from '../cookies.js';
import { config } from '../config.js';

const cookies = loadWorkanaCookies();

console.log(`Cookie file : ${config.cookieFile}`);
console.log(`Workana cookies found: ${cookies.length}`);
console.log(`Session cookie present: ${hasSessionCookie(cookies) ? 'yes' : 'NO'}`);
for (const c of describeSession(cookies)) {
  const state = !c.present ? 'missing' : c.expired ? 'EXPIRED' : `ok (until ${c.expiresAt})`;
  console.log(`  ${c.name.padEnd(22)} ${state}`);
}

console.log('\nOpening Workana to confirm the session still authenticates…');
try {
  const result = await checkLogin();
  console.log(result);
  if (result.loggedIn) {
    console.log(`\n✓ Logged in. ${result.cards} job cards visible on the first page.`);
  } else {
    console.log(
      '\n✗ Not logged in. Re-export your workana.com cookies from a browser where you are ' +
        'signed in, and overwrite the cookie file.',
    );
    process.exitCode = 1;
  }
} catch (err) {
  console.error('\n✗ Could not reach Workana:', err.message);
  process.exitCode = 1;
}
