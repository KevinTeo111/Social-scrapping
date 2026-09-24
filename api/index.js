/**
 * The board on Vercel, in one of two modes.
 *
 * **Front door** (BOARD_ORIGIN set). Vercel holds the permanent address and
 * forwards every request to the board running on the workstation, reached over
 * its tunnel. Nothing about the board lives here: no database, no browser, no
 * session key. It exists because a quick tunnel is given a new hostname every
 * time it starts, and a team should not have to be handed a new link each time;
 * when the tunnel changes, only BOARD_ORIGIN changes.
 *
 * **Board** (BOARD_ORIGIN unset). The Express app runs here and talks to a
 * hosted Postgres, with the scraper on a workstation picking up its requests --
 * see src/app.js. That needs DATABASE_URL and APP_SECRET.
 *
 * The board is imported only in the second mode: importing it demands a
 * database and a session key that a front door has no business holding.
 */
const BOARD_ORIGIN = (process.env.BOARD_ORIGIN || '').replace(/\/+$/, '');

/*
 * Headers that describe one hop rather than the message, plus the ones the
 * platform sets for itself. Forwarding them corrupts the response: a
 * content-length copied from a compressed body, say, against a body fetch has
 * already decompressed.
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-length', 'content-encoding', 'host',
]);

/** The body as bytes, however the platform decided to hand it over. */
async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return req.body;
    return JSON.stringify(req.body);
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function frontDoor(req, res) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  }
  /*
   * The board decides whether to mark the session cookie Secure from this, and
   * TLS ended here. Identity encoding keeps the response bytes as they are, so
   * the headers copied back below still describe the body.
   */
  headers['x-forwarded-proto'] = 'https';
  headers['accept-encoding'] = 'identity';

  let upstream;
  try {
    upstream = await fetch(BOARD_ORIGIN + req.url, {
      method: req.method,
      headers,
      body: await readBody(req),
      redirect: 'manual',
    });
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error:
          'The board is not reachable right now. The computer that runs it may be switched off, ' +
          'or its tunnel may have restarted with a new address.',
        detail: err.message,
      }),
    );
    return;
  }

  res.statusCode = upstream.status;
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie') {
      res.setHeader(name, value);
    }
  });
  // Several cookies must stay several headers, not one joined by commas.
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length) res.setHeader('set-cookie', cookies);

  const body = Buffer.from(await upstream.arrayBuffer());
  res.end(req.method === 'HEAD' ? undefined : body);
}

export default async function handler(req, res) {
  if (BOARD_ORIGIN) return frontDoor(req, res);

  const { app, ready } = await import('../src/app.js');
  try {
    await ready();
  } catch (err) {
    console.error('[board] database not ready:', err.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `The database is not reachable: ${err.message}` }));
    return;
  }
  return app(req, res);
}
