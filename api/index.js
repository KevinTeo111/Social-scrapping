/**
 * The board as a Vercel serverless function.
 *
 * Every /api/* request (and /healthz) is routed here by vercel.json; the page
 * itself -- public/ -- is served by Vercel's CDN without touching this. The
 * Express app is a plain (req, res) handler, so it is handed the request as is.
 *
 * This process never scrapes. Refresh, Full crawl, login checks and insights are
 * written into the database for the scraper on the workstation to pick up (see
 * src/control.js), and the board reports "scraper offline" when nothing is
 * picking them up.
 */
import { app, ready } from '../src/app.js';

export default async function handler(req, res) {
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
