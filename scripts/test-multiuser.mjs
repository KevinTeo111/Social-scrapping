/**
 * End-to-end check of registration, sessions, isolation between members, and
 * per-user Workana credentials. Runs against a live server on PORT.
 */
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:4300';
let pass = 0;
let fail = 0;

const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
};

/** Minimal cookie-aware client, one jar per simulated member. */
function client() {
  let cookie = '';
  return async (path, options = {}) => {
    const res = await fetch(BASE + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.headers || {}),
      },
      redirect: 'manual',
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const c of setCookie) {
      const [pair] = c.split(';');
      if (pair.startsWith('wk_session=')) cookie = pair;
    }
    let body = null;
    try { body = await res.json(); } catch {}
    return { status: res.status, body };
  };
}

const alice = client();
const bob = client();
const anon = client();

console.log('\n--- anonymous access is refused ---');
for (const path of ['/api/jobs?limit=1', '/api/facets', '/api/stats', '/api/status']) {
  const r = await anon(path);
  ok(`401 for ${path}`, r.status === 401, `got ${r.status}`);
}

console.log('\n--- registration ---');
const stamp = Date.now();
const aliceEmail = `alice${stamp}@example.com`;
const bobEmail = `bob${stamp}@example.com`;

// Whether the ownership rule applies depends on whether this instance already
// has members — the suite must not assume it is running against a fresh install.
const fresh = (await anon('/api/me')).body?.needsBootstrap === true;

let r = await alice('/api/register', {
  method: 'POST',
  body: JSON.stringify({ email: aliceEmail, password: 'correct horse battery', name: 'Alice' }),
});
ok('account registers', r.status === 200, JSON.stringify(r.body));
ok(
  fresh ? 'first account becomes owner' : 'later account is not made owner',
  r.body?.user?.isAdmin === fresh,
  `fresh=${fresh} isAdmin=${r.body?.user?.isAdmin}`,
);
ok('no secrets leaked in user payload',
  r.body?.user && !('password_hash' in r.body.user) && !('workana_cookies' in r.body.user));

r = await bob('/api/register', {
  method: 'POST',
  body: JSON.stringify({ email: bobEmail, password: 'another good passphrase', name: 'Bob' }),
});
ok('second account registers', r.status === 200, JSON.stringify(r.body));
ok('second account is not admin', r.body?.user?.isAdmin === false);

r = await anon('/api/register', {
  method: 'POST',
  body: JSON.stringify({ email: aliceEmail, password: 'whatever12345' }),
});
ok('duplicate email rejected', r.status === 409, `got ${r.status}`);

r = await anon('/api/register', { method: 'POST', body: JSON.stringify({ email: 'x@y.z', password: 'short' }) });
ok('short password rejected', r.status === 400);

console.log('\n--- login ---');
r = await anon('/api/login', { method: 'POST', body: JSON.stringify({ email: aliceEmail, password: 'wrong' }) });
ok('wrong password rejected', r.status === 401);

r = await anon('/api/login', { method: 'POST', body: JSON.stringify({ email: 'nobody@nowhere.io', password: 'x' }) });
ok('unknown email rejected the same way', r.status === 401);

console.log('\n--- authenticated access ---');
r = await alice('/api/jobs?limit=2');
ok('alice can list jobs', r.status === 200 && r.body.total > 0, `total=${r.body?.total}`);
r = await bob('/api/jobs?limit=2');
ok('bob can list jobs', r.status === 200 && r.body.total > 0);

console.log('\n--- per-member state is isolated ---');
const slug = (await alice('/api/jobs?limit=1')).body.jobs[0].slug;
await alice(`/api/flags/${slug}`, { method: 'POST', body: JSON.stringify({ starred: true, note: 'alice note' }) });

const aliceStarred = (await alice('/api/jobs?starred=1&limit=200')).body;
const bobStarred = (await bob('/api/jobs?starred=1&limit=200')).body;
ok('alice sees her star', aliceStarred.total === 1, `got ${aliceStarred.total}`);
ok('bob does not see alice\'s star', bobStarred.total === 0, `got ${bobStarred.total}`);

const aliceJob = (await alice(`/api/jobs/${slug}`)).body.job;
const bobJob = (await bob(`/api/jobs/${slug}`)).body.job;
ok('alice sees her note', aliceJob.note === 'alice note', `got ${aliceJob.note}`);
ok('bob does not see alice\'s note', !bobJob.note, `got ${bobJob.note}`);

await bob(`/api/flags/${slug}`, { method: 'POST', body: JSON.stringify({ hidden: true }) });
const aliceAll = (await alice('/api/jobs?limit=1')).body.total;
const bobAll = (await bob('/api/jobs?limit=1')).body.total;
ok('bob hiding a job does not hide it for alice', aliceAll === bobAll + 1, `alice=${aliceAll} bob=${bobAll}`);

console.log('\n--- Workana credentials ---');
r = await alice('/api/scrape', { method: 'POST', body: JSON.stringify({}) });
ok('scrape refused without a stored session', r.status === 400, `got ${r.status}`);

r = await alice('/api/session/cookies', { method: 'POST', body: JSON.stringify({ cookies: 'not json' }) });
ok('invalid cookie JSON rejected', r.status === 400);

r = await alice('/api/session/cookies', { method: 'POST', body: JSON.stringify({ cookies: '[{"domain":"example.com","name":"a","value":"b"}]' }) });
ok('cookie export with no workana.com entries rejected', r.status === 400, JSON.stringify(r.body));

const real = fs.readFileSync('Hiyashi.json', 'utf8');
r = await alice('/api/session/cookies', { method: 'POST', body: JSON.stringify({ cookies: real }) });
ok('real export accepted', r.status === 200 && r.body.count > 0, JSON.stringify(r.body));
ok('only workana cookies retained', r.body?.count && r.body.count < 30, `kept ${r.body?.count} of ~120`);
ok('session cookie detected', r.body?.hasSession === true);

const aliceMe = (await alice('/api/me')).body.user;
ok('alice now has cookies', aliceMe.hasCookies === true);
ok('cookie blob never returned to the client', !JSON.stringify(aliceMe).includes('workana_session'));

const bobMe = (await bob('/api/me')).body.user;
ok('bob has no cookies of his own', bobMe.hasCookies === false);
r = await bob('/api/scrape', { method: 'POST', body: JSON.stringify({}) });
ok('bob cannot scrape with alice\'s session', r.status === 400, `got ${r.status}`);

console.log('\n--- at-rest encryption ---');
// Read the token from the local export rather than hard-coding it: a literal
// session value in a committed test is a live credential published to the repo.
const sessionValue = JSON.parse(real).find(
  (c) => c.name === 'workana_session' && /workana\.com$/.test(String(c.domain).replace(/^\./, '')),
)?.value;
const db = fs.readFileSync('data/workana.db');
ok(
  'workana_session value not stored in plaintext',
  Boolean(sessionValue) && !db.includes(Buffer.from(sessionValue)),
  sessionValue ? '' : '(no session cookie in the export to test with)',
);

console.log('\n--- logout ---');
await alice('/api/logout', { method: 'POST' });
r = await alice('/api/jobs?limit=1');
ok('session invalid after logout', r.status === 401, `got ${r.status}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
