/**
 * Checks the virtual-domain plumbing: Host allowlisting and the conditional
 * `Secure` cookie flag. Assumes a server running with
 *   ALLOWED_HOSTS=jobs.example.com  TRUST_PROXY=1
 */
import http from 'node:http';

const BASE = process.env.BASE || 'http://127.0.0.1:4300';
const { hostname, port } = new URL(BASE);
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
};

/**
 * Raw http.request rather than fetch(): `Host` is a forbidden header for fetch,
 * which drops it silently — so a Host-allowlist test written with fetch passes
 * no matter what the server does.
 */
function raw(path, { headers = {}, method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname, port, path, method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, text, setCookie: res.headers['set-cookie'] || [] }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const call = (path, headers = {}) => raw(path, { headers });

console.log('\n--- Host allowlist ---');
let r = await call('/api/me');
ok('loopback Host always allowed', r.status === 200, `got ${r.status}`);

r = await call('/api/me', { Host: 'jobs.example.com' });
ok('allowlisted host accepted', r.status === 200, `got ${r.status}`);

r = await call('/api/me', { Host: 'evil.attacker.test' });
ok('unknown host rejected (DNS rebinding)', r.status === 400, `got ${r.status}`);
ok('rejection explains itself', r.text.includes('ALLOWED_HOSTS'), r.text.slice(0, 60));

r = await call('/api/me', { Host: 'jobs.example.com:8443' });
ok('port is ignored when matching host', r.status === 200, `got ${r.status}`);

console.log('\n--- Secure cookie only over TLS ---');
const login = async (proto) => {
  const res = await raw('/api/register', {
    method: 'POST',
    headers: { Host: 'jobs.example.com', ...(proto ? { 'X-Forwarded-Proto': proto } : {}) },
    body: JSON.stringify({
      email: `vhost-test-${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`,
      password: 'a sufficiently long passphrase',
    }),
  });
  return res.setCookie.find((c) => c.startsWith('wk_session=')) || '';
};

const plain = await login(null);
ok('no Secure flag over plain HTTP', plain && !/;\s*Secure/i.test(plain), plain);
ok('HttpOnly always set', /HttpOnly/i.test(plain), plain);
ok('SameSite always set', /SameSite=Lax/i.test(plain), plain);

const tls = await login('https');
ok('Secure flag set when proxied over HTTPS', /;\s*Secure/i.test(tls), tls);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
