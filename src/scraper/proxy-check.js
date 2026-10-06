/**
 * Asks a proxy, without a browser, whether it will carry traffic to Workana.
 *
 * This exists to tell two indistinguishable failures apart. An expired Workana
 * session and a proxy refusing the connection both end the same way -- an empty
 * list page, no error -- and a member staring at "nothing was collected" cannot
 * tell which of the two to fix. A browser takes twenty seconds to find out and
 * still only says "no jobs"; one CONNECT says exactly what the proxy said.
 *
 * It is the same request Chromium makes: CONNECT host:443 for an HTTP proxy, or
 * the SOCKS5 greeting and connect request for a SOCKS one.
 */
import net from 'node:net';

const TIMEOUT_MS = 12_000;

/*
 * Proxies are chatty about why they refused, and at least one provider quotes
 * the credentials back in the error -- which then lands in a log, a database
 * column, and the account panel. Strip anything that looks like one.
 */
export function redact(text) {
  return String(text || '')
    .replace(/(user(name)?|pass(word)?|pwd|token|key)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@')
    .trim();
}

const fail = (detail) => ({ ok: false, detail: redact(detail) });

function httpConnect({ hostname, port, username, password }, target) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port, timeout: TIMEOUT_MS });
    let buffer = '';
    socket.on('connect', () => {
      const auth = username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password || '')}`).toString('base64')}\r\n`
        : '';
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}Connection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      /*
       * The status line is enough, but a refusal usually explains itself in the
       * body, and that explanation is the useful part for whoever has to fix
       * it. Line endings are normalised first: the proxy in use here separates
       * headers from body with bare newlines, so looking only for CRLF left the
       * whole raw response as the "status line".
       */
      const text = buffer.replace(/\r\n/g, '\n');
      if (!text.includes('\n\n') && buffer.length < 2048) return;
      socket.destroy();
      // Headers are noise to whoever has to fix this; the status line and
      // whatever the proxy wrote in the body are the whole story.
      const [head, ...bodyParts] = text.split('\n\n');
      const status = head.split('\n')[0].trim();
      const body = bodyParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      const code = Number(status.split(' ')[1]);
      if (code === 200) return resolve({ ok: true, detail: 'the proxy connected to Workana' });
      resolve(
        fail(
          code === 407 || /auth/i.test(buffer)
            ? `the proxy rejected its credentials — ${body || status}`
            : `the proxy refused the connection — ${body || status}`,
        ),
      );
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(fail(`the proxy accepted the connection but never answered (${TIMEOUT_MS / 1000}s)`));
    });
    socket.on('error', (err) => resolve(fail(`could not reach the proxy (${err.code || err.message})`)));
  });
}

function socksConnect({ hostname, port, username, password }, host, targetPort) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port, timeout: TIMEOUT_MS });
    let stage = 'greeting';
    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02])));
    socket.on('data', (data) => {
      if (stage === 'greeting') {
        if (data[0] !== 0x05) return resolve(fail('not a SOCKS5 proxy')) && socket.destroy();
        if (data[1] === 0xff) {
          socket.destroy();
          return resolve(fail('the proxy accepted no authentication method offered'));
        }
        if (data[1] === 0x02) {
          const u = Buffer.from(decodeURIComponent(username || ''));
          const p = Buffer.from(decodeURIComponent(password || ''));
          stage = 'auth';
          return socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        }
        stage = 'request';
      } else if (stage === 'auth') {
        if (data[1] !== 0x00) {
          socket.destroy();
          return resolve(fail('the proxy rejected its credentials'));
        }
        stage = 'request';
      } else {
        socket.destroy();
        const code = data[1];
        return resolve(
          code === 0x00
            ? { ok: true, detail: 'the proxy connected to Workana' }
            : fail(`the proxy refused the connection (SOCKS error ${code})`),
        );
      }
      const name = Buffer.from(host);
      socket.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
          name,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]),
      );
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(fail(`the proxy accepted the connection but never answered (${TIMEOUT_MS / 1000}s)`));
    });
    socket.on('error', (err) => resolve(fail(`could not reach the proxy (${err.code || err.message})`)));
  });
}

/**
 * `{ ok, detail }` — whether this proxy will carry traffic to Workana, and what
 * it said if not. A member with no proxy is fine (`ok: true`): the scrape then
 * goes out through the machine's own connection.
 */
export async function checkProxy(proxyUrl, target = 'www.workana.com:443') {
  if (!proxyUrl) return { ok: true, detail: 'no proxy — using this machine\'s connection' };
  let url;
  try {
    url = new URL(proxyUrl);
  } catch {
    return fail('the proxy address is not a valid URL');
  }
  const [host, port] = target.split(':');
  const parts = {
    hostname: url.hostname,
    port: Number(url.port) || (url.protocol.startsWith('socks') ? 1080 : 8080),
    username: url.username,
    password: url.password,
  };
  return url.protocol.startsWith('socks')
    ? socksConnect(parts, host, Number(port))
    : httpConnect(parts, target);
}

/* ------------------------------------------------------------------------- *
 * Where does this proxy come out?
 *
 * The answer sets the timezone and language the member's browser presents, so
 * that it agrees with the address the traffic arrives from (see src/locale.js).
 * One plain-HTTP request, through the member's own proxy, to a geolocation
 * service -- which learns only the proxy's address, something its own provider
 * already knows. Best effort throughout: a failure leaves the instance default
 * in place and is never allowed to block registering a proxy.
 *
 * EXIT_GEO_URL repoints it; empty disables the lookup entirely, and the member
 * can still set their zone by hand.
 * ------------------------------------------------------------------------- */

/*
 * Shorter than the connectivity check's: nothing is waiting on the answer, and
 * a proxy that accepts the connection and then says nothing should not hold a
 * socket open for twelve seconds to tell us a timezone.
 */
const GEO_TIMEOUT_MS = 6_000;

const GEO_URL = process.env.EXIT_GEO_URL === undefined
  ? 'http://ip-api.com/json/?fields=status,message,countryCode,timezone'
  : process.env.EXIT_GEO_URL;

/** Reads one plain-HTTP response off a socket that is already pointed at the host. */
function readBody(socket, request, resolve) {
  let buffer = '';
  socket.write(request);
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 64_000) socket.destroy();
  });
  const done = () => {
    const text = buffer.replace(/\r\n/g, '\n');
    const body = text.slice(text.indexOf('\n\n') + 2);
    resolve(body.trim());
  };
  socket.on('end', done);
  socket.on('close', done);
}

function geoThroughHttp({ hostname, port, username, password }, target) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port, timeout: GEO_TIMEOUT_MS });
    const auth = username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password || '')}`).toString('base64')}\r\n`
      : '';
    socket.on('connect', () =>
      // Absolute-form request line: how a client asks an HTTP proxy to fetch
      // something for it, with no CONNECT tunnel needed for plain HTTP.
      readBody(
        socket,
        `GET ${target.href} HTTP/1.1\r\nHost: ${target.host}\r\n${auth}User-Agent: workana-board\r\nConnection: close\r\n\r\n`,
        resolve,
      ),
    );
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => resolve(''));
  });
}

function geoThroughSocks({ hostname, port, username, password }, target) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port, timeout: GEO_TIMEOUT_MS });
    const request = `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: workana-board\r\nConnection: close\r\n\r\n`;
    let stage = 'greeting';
    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02])));
    const onData = (data) => {
      if (stage === 'greeting') {
        if (data[0] !== 0x05 || data[1] === 0xff) return socket.destroy();
        if (data[1] === 0x02) {
          const u = Buffer.from(decodeURIComponent(username || ''));
          const p = Buffer.from(decodeURIComponent(password || ''));
          stage = 'auth';
          return socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        }
        stage = 'request';
      } else if (stage === 'auth') {
        if (data[1] !== 0x00) return socket.destroy();
        stage = 'request';
      } else {
        if (data[1] !== 0x00) return socket.destroy();
        socket.off('data', onData);
        return readBody(socket, request, resolve);
      }
      const name = Buffer.from(target.hostname);
      socket.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
          name,
          Buffer.from([0x00, 80]),
        ]),
      );
    };
    socket.on('data', onData);
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => resolve(''));
  });
}

function geoDirect(target) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.hostname, port: 80, timeout: GEO_TIMEOUT_MS });
    socket.on('connect', () =>
      readBody(
        socket,
        `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: workana-board\r\nConnection: close\r\n\r\n`,
        resolve,
      ),
    );
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => resolve(''));
  });
}

/**
 * `{ country, timezone }` for the address this proxy comes out of, or an empty
 * object when it cannot be told. Never throws.
 */
export async function probeExit(proxyUrl) {
  if (!GEO_URL) return {};
  let target;
  try {
    target = new URL(GEO_URL);
  } catch {
    return {};
  }

  let body = '';
  try {
    if (!proxyUrl) {
      body = await geoDirect(target);
    } else {
      const url = new URL(proxyUrl);
      const parts = {
        hostname: url.hostname,
        port: Number(url.port) || (url.protocol.startsWith('socks') ? 1080 : 8080),
        username: url.username,
        password: url.password,
      };
      body = url.protocol.startsWith('socks')
        ? await geoThroughSocks(parts, target)
        : await geoThroughHttp(parts, target);
    }
  } catch {
    return {};
  }

  try {
    const data = JSON.parse(body);
    if (data.status && data.status !== 'success') return {};
    return {
      country: data.countryCode || data.country_code || data.country || null,
      timezone: data.timezone || null,
    };
  } catch {
    return {};
  }
}
