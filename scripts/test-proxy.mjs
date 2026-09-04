/** Per-member egress proxy: validation, isolation, and credential hiding. */
const BASE = process.env.BASE || 'http://127.0.0.1:4300';
let pass = 0;
let fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass += 1; console.log(`  ✓ ${n}`); }
  else { fail += 1; console.log(`  ✗ ${n} ${extra}`); }
};

function client() {
  let cookie = '';
  return async (path, options = {}) => {
    const res = await fetch(BASE + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) },
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      if (pair.startsWith('wk_session=')) cookie = pair;
    }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

const stamp = Date.now();
const a = client();
const b = client();
await a('/api/register', { method: 'POST', body: JSON.stringify({ email: `vhost-a${stamp}@example.com`, password: 'long enough passphrase' }) });
await b('/api/register', { method: 'POST', body: JSON.stringify({ email: `vhost-b${stamp}@example.com`, password: 'long enough passphrase' }) });

console.log('\n--- validation ---');
let r = await a('/api/session/proxy', { method: 'POST', body: JSON.stringify({ proxy: 'not a url' }) });
ok('rejects a non-URL', r.status === 400, JSON.stringify(r.body));

r = await a('/api/session/proxy', { method: 'POST', body: JSON.stringify({ proxy: 'ftp://host:21' }) });
ok('rejects an unsupported scheme', r.status === 400, JSON.stringify(r.body));

r = await a('/api/session/proxy', { method: 'POST', body: JSON.stringify({ proxy: 'socks5://sp.example.net:1080' }) });
ok('accepts socks5', r.status === 200 && r.body.proxy?.includes('sp.example.net'), JSON.stringify(r.body));

r = await a('/api/session/proxy', { method: 'POST', body: JSON.stringify({ proxy: 'http://tokyo-user:s3cret@jp.example.net:8080' }) });
ok('accepts http with credentials', r.status === 200, JSON.stringify(r.body));

console.log('\n--- credentials are never echoed back ---');
const meA = (await a('/api/me')).body.user;
const dump = JSON.stringify(meA);
ok('password not returned', !dump.includes('s3cret'), dump);
ok('username not returned', !dump.includes('tokyo-user'), dump);
ok('host still shown so it can be recognised', dump.includes('jp.example.net'), dump);
ok('marked as authenticated', /authenticated/.test(meA.proxy || ''), meA.proxy);

console.log('\n--- isolation ---');
const meB = (await b('/api/me')).body.user;
ok('another member has no proxy of their own', meB.proxy === null, String(meB.proxy));

console.log('\n--- clearing ---');
r = await a('/api/session/proxy', { method: 'POST', body: JSON.stringify({ proxy: '' }) });
ok('blank clears it', r.status === 200 && r.body.proxy === null, JSON.stringify(r.body));
ok('cleared in /api/me', (await a('/api/me')).body.user.proxy === null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
