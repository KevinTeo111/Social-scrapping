/**
 * The board: every page and API route, and nothing that needs a browser.
 *
 * This module never imports the scraper. Anything that needs Chromium --
 * scraping, checking a Workana login, reading a job's insights -- is written
 * into the database for the scraper process to pick up (src/worker.js), under
 * the slot rules in src/control.js. That is what lets the same routes run in a
 * serverless function (api/index.js) as well as in the local server
 * (src/server.js), which runs a worker beside them.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { loadWorkanaCookies, hasSessionCookie, describeSession } from './cookies.js';
import { all, get, lastRun, upsertUserJob, adoptLegacyData, initDatabase, isPostgres, CLOSED_SQL } from './db.js';
import {
  readControl,
  claimSlot,
  describeSlot,
  workerOnline,
  requestStop,
  resume,
  enqueueTask,
  waitForTask,
} from './control.js';
import {
  SESSION_COOKIE,
  AuthError,
  attachUser,
  requireAuth,
  registerUser,
  authenticate,
  changePassword,
  createSession,
  destroySession,
  publicUser,
  userCount,
  setWorkanaCookies,
  getWorkanaCookies,
  clearWorkanaCookies,
  setWorkanaProxy,
  proxyBlocker,
  scrapeBlocker,
  setupBlocker,
  requireAdmin,
} from './auth.js';

export const app = express();

/**
 * Connects on first use, for a host that imports this module without running
 * src/server.js. Only connects: the scraper keeps the schema current, and a
 * serverless instance migrating on every cold start would be slow and would race
 * its siblings. A failed attempt is forgotten so the next request retries.
 */
let readiness = null;
export function ready() {
  readiness ??= initDatabase({ migrate: false }).catch((err) => {
    readiness = null;
    throw err;
  });
  return readiness;
}

/**
 * Holds back everything that reads the corpus until this member has supplied a
 * working session, and a proxy where one is required.
 *
 * Applied at the routes rather than in the page, because a page can be bypassed
 * with a fetch. What stays open is everything needed to put it right: the
 * account routes, /api/me, the status badge and signing out.
 */
function requireSetup(req, res, next) {
  const blocked = setupBlocker(req.user);
  if (!blocked) return next();
  res.status(403).json({ setupRequired: true, needs: blocked.needs, error: blocked.error });
}

const OFFLINE =
  'The scraper is offline: the computer that runs it is not connected. The board still ' +
  'works, and new postings will arrive once it is back.';

/*
 * How long a route waits on a one-off task before answering "still working".
 * Kept under the serverless function limit set in vercel.json.
 */
const TASK_WAIT_MS = 45_000;

// Only meaningful behind a reverse proxy we control; see config.trustProxy.
if (config.trustProxy) app.set('trust proxy', true);

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

/**
 * Host-header allowlist. Serving the board on a name rather than an IP opens the
 * door to DNS rebinding — an attacker points their own hostname at this address
 * so a page they control can talk to it with the victim's cookies. Rejecting
 * unexpected Host values closes that off, and costs nothing when the list is
 * configured to the names actually in use.
 */
const hostAllowed = (host) =>
  config.allowedHosts.some((allowed) =>
    // `*.trycloudflare.com` matches any subdomain of it, and nothing else. A
    // quick tunnel gets a fresh random hostname every time it starts, so an
    // exact list would have to be edited on each restart -- and an empty list
    // accepts anything, which is what this guard exists to prevent.
    allowed.startsWith('*.') ? host.endsWith(allowed.slice(1)) : host === allowed,
  );

app.use((req, res, next) => {
  if (!config.allowedHosts.length) return next();
  const host = String(req.headers.host || '').toLowerCase().split(':')[0];
  if (LOOPBACK.test(host) || hostAllowed(host)) return next();
  res.status(400).type('text/plain').send(`Host "${host}" is not allowed. Add it to ALLOWED_HOSTS.`);
});

app.use(express.json({ limit: '4mb' })); // cookie exports run large
app.use(attachUser);
app.use(express.static(path.join(config.rootDir, 'public')));

/**
 * `Secure` is set only when the request actually arrived over TLS, because a
 * Secure cookie is silently dropped over plain HTTP — hard-coding it would break
 * sign-in on a localhost install, and omitting it would leak the session on an
 * HTTPS one. `req.secure` is only trustworthy when trust proxy is on.
 */
const setSessionCookie = (req, res, token, expires) => {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/;` +
      `${secure && config.trustProxy ? ' Secure;' : ''} Expires=${expires.toUTCString()}`,
  );
};

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

/**
 * Unauthenticated liveness probe for the hosting platform. Deliberately says
 * nothing about the data — a health check should not become an anonymous
 * read of how many members or jobs the instance holds.
 */
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/me', async (req, res) => {
  res.json({
    user: publicUser(req.user),
    registrationOpen: config.allowRegistration,
    // A signed-in user is an account, so there is nothing to count.
    needsBootstrap: req.user ? false : (await userCount()) === 0,
  });
});

app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name, inviteCode } = req.body || {};
    const first = (await userCount()) === 0;

    // The very first account always may be created, otherwise a fresh install
    // could lock itself out; after that the operator's settings apply.
    if (!first) {
      if (!config.allowRegistration) throw new AuthError('Registration is closed on this instance.', 403);
      if (config.registrationCode && inviteCode !== config.registrationCode) {
        throw new AuthError('That invite code is not valid.', 403);
      }
    }

    const user = await registerUser({ email, password, name });
    if (first) {
      // Inheriting the pre-accounts history is a convenience; never let it
      // fail the registration that just succeeded.
      try {
        const adopted = await adoptLegacyData(user.id);
        if (adopted.flags || adopted.bids) {
          console.log(`[auth] Adopted pre-existing data (${adopted.bids} bid flags, ${adopted.flags} stars/notes).`);
        }
      } catch (err) {
        console.error('[auth] Could not adopt pre-existing data:', err.message);
      }
    }

    const { token, expires } = await createSession(user.id);
    setSessionCookie(req, res, token, expires);
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const user = await authenticate(req.body?.email, req.body?.password);
    const { token, expires } = await createSession(user.id);
    setSessionCookie(req, res, token, expires);
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
});

app.post('/api/logout', async (req, res) => {
  await destroySession(req.sessionToken);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.post('/api/password', requireAuth, async (req, res) => {
  try {
    await changePassword(req.user.id, req.body?.currentPassword, req.body?.newPassword);
    const { token, expires } = await createSession(req.user.id);
    setSessionCookie(req, res, token, expires);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Each member's own Workana session                                   */
/* ------------------------------------------------------------------ */

app.post('/api/session/cookies', requireAuth, async (req, res) => {
  try {
    const raw = req.body?.cookies;
    if (!raw || typeof raw !== 'string') throw new AuthError('Paste the exported cookie JSON.');
    const result = await setWorkanaCookies(req.user.id, raw);
    res.json({
      ok: true,
      ...result,
      warning: result.hasSession ? null : 'No `workana_session` cookie found — you may not be signed in.',
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.delete('/api/session/cookies', requireAuth, async (req, res) => {
  await clearWorkanaCookies(req.user.id);
  res.json({ ok: true });
});

/*
 * A local install usually already has an export sitting next to the code —
 * COOKIE_FILE, `Hiyashi.json` by default — which is what the CLI drives. Reading
 * it straight into the account saves exporting and pasting the same cookies a
 * second time.
 *
 * Owner-only, and deliberately so: the file is one specific person's live
 * Workana login, so on an instance with several members any other member being
 * able to adopt it would be credential theft with a button. Everyone else uses
 * the file picker in the browser, which never involves the server's disk.
 */
function describeCookieFile() {
  const file = path.resolve(config.cookieFile);
  if (!fs.existsSync(file)) return { available: false, file };
  try {
    const cookies = loadWorkanaCookies(file);
    return {
      available: true,
      file,
      count: cookies.length,
      hasSession: hasSessionCookie(cookies),
      session: describeSession(cookies),
      modifiedAt: fs.statSync(file).mtime.toISOString(),
    };
  } catch (err) {
    // A malformed or non-Workana export is "not available", with the reason.
    return { available: false, file, error: err.message };
  }
}

app.get('/api/session/file', requireAuth, (req, res) => {
  if (!req.user.is_admin) return res.json({ available: false, reason: 'owner-only' });
  res.json(describeCookieFile());
});

app.post('/api/session/file', requireAuth, requireAdmin, async (req, res) => {
  try {
    const file = path.resolve(config.cookieFile);
    if (!fs.existsSync(file)) throw new AuthError(`No cookie file at ${file}.`);
    const result = await setWorkanaCookies(req.user.id, fs.readFileSync(file, 'utf8'));
    res.json({
      ok: true,
      file,
      ...result,
      warning: result.hasSession ? null : 'No `workana_session` cookie in that file — you may not be signed in.',
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/**
 * Egress proxy for this member's Workana traffic. Scraping runs on the server,
 * so a member in another region needs their own exit or their session is driven
 * from the host's IP — see the README on remote members.
 */
app.post('/api/session/proxy', requireAuth, async (req, res) => {
  try {
    const described = await setWorkanaProxy(req.user.id, req.body?.proxy);
    res.json({ ok: true, proxy: described });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/**
 * Runs a browser task on the scraper's machine and answers with its result.
 *
 * The board has no browser, so it asks and waits. Too long a wait answers 202
 * rather than an error: the task is still running and its effect (a recorded
 * login check, fresh insights) will land in the database regardless.
 */
async function viaWorker(req, res, kind, payload, notYet) {
  if (!(await getWorkanaCookies(req.user.id))) {
    return res.status(400).json({ error: 'Add your Workana session first.' });
  }
  const needsProxy = proxyBlocker(req.user);
  if (needsProxy) return res.status(403).json({ proxyRequired: true, error: needsProxy });
  /*
   * Verify is the exception: checking the session is exactly how someone finds
   * out why it was set aside, so it must not be refused for being set aside.
   */
  const setAside = kind === 'verify' ? null : scrapeBlocker(req.user);
  if (setAside) return res.status(403).json({ scrapeBlocked: true, error: setAside });
  if (!workerOnline(await readControl())) return res.status(503).json({ offline: true, error: OFFLINE });

  const id = await enqueueTask(kind, req.user.id, payload);
  const outcome = await waitForTask(id, TASK_WAIT_MS);
  if (outcome.status === 'done') return res.json(outcome.result);
  if (outcome.status === 'failed') return res.status(502).json({ error: outcome.error });
  return res.status(202).json({ pending: true, error: notYet });
}

/** Opens Workana with this member's cookies and reports whether they still work. */
app.post('/api/session/verify', requireAuth, (req, res) =>
  viaWorker(req, res, 'verify', {}, 'Still checking your Workana session. Try again in a minute.'),
);

const jsonSafe = (row) => {
  if (!row) return row;
  const out = { ...row };
  if (typeof out.skills === 'string') {
    try {
      out.skills = JSON.parse(out.skills);
    } catch {
      out.skills = [];
    }
  }
  return out;
};

/* ------------------------------------------------------------------ */
/* Job listing                                                         */
/* ------------------------------------------------------------------ */

const SORTS = {
  newest: 'ORDER BY COALESCE(j.published_approx_at, j.published_at, j.first_seen_at) DESC',
  oldest: 'ORDER BY COALESCE(j.published_approx_at, j.published_at, j.first_seen_at) ASC',
  discovered: 'ORDER BY j.first_seen_at DESC',
  budget_high: 'ORDER BY COALESCE(j.budget_max, j.budget_min, 0) DESC',
  budget_low: 'ORDER BY COALESCE(j.budget_min, j.budget_max, 999999) ASC',
  bids_low: 'ORDER BY COALESCE(j.bids, 0) ASC, COALESCE(j.published_at, j.first_seen_at) DESC',
  bids_high: 'ORDER BY COALESCE(j.bids, 0) DESC',
  contacts_high: 'ORDER BY COALESCE(j.contacts_count, 0) DESC, COALESCE(j.bids, 0) DESC',
  collected: 'ORDER BY j.first_seen_at DESC',
  // Jobs with no reply at all sort last rather than first.
  reply_recent: "ORDER BY COALESCE(j.last_reply_at, '0000') DESC",
  // Clients we have never seen sort last rather than first.
  client_online: "ORDER BY COALESCE(c.last_login_at, '0000') DESC",
  client_rating: 'ORDER BY COALESCE(c.rating, -1) DESC, COALESCE(c.projects_paid,0) DESC',
  // Break ties on volume, so a 100% client with 8 paid outranks one with 1.
  hire_rate: 'ORDER BY COALESCE(c.hire_rate, -1) DESC, COALESCE(c.projects_paid, 0) DESC',
};

/**
 * Turns what the user typed into a search expression for whichever engine is
 * underneath.
 *
 * Both are given the same treatment: a bag of terms, all required, with a prefix
 * match on the last so results narrow as you type. Quoting every term is what
 * keeps a stray apostrophe or bracket from being read as syntax — FTS5 and
 * Postgres both have operator languages that a search box should never expose.
 */
function searchTerms(raw) {
  const terms = String(raw)
    .toLowerCase()
    .replace(/["*()&|!:]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return terms.length ? terms : null;
}

const ftsQuery = (raw) => {
  const terms = searchTerms(raw);
  if (!terms) return null;
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(' AND ');
};

/** `web & development:*` — the tsquery equivalent of the above. */
const tsQuery = (raw) => {
  const terms = searchTerms(raw);
  if (!terms) return null;
  return terms.map((t, i) => (i === terms.length - 1 ? `${t}:*` : t)).join(' & ');
};

function buildQuery(q, userId) {
  const where = [];
  // First placeholder in BASE_FROM is the user_jobs join.
  const params = [userId ?? -1];
  let join = '';

  /*
   * Postgres searches the row itself through its generated tsvector, so there is
   * nothing to join. SQLite's FTS5 index is a separate table and has to be.
   */
  if (q.search) {
    if (isPostgres) {
      const match = tsQuery(q.search);
      if (match) {
        where.push("j.search @@ to_tsquery('simple', ?)");
        params.push(match);
      }
    } else {
      const match = ftsQuery(q.search);
      if (match) {
        join += ' JOIN jobs_fts f ON f.slug = j.slug ';
        where.push('jobs_fts MATCH ?');
        params.push(match);
      }
    }
  }

  if (q.type === 'hourly') where.push('j.is_hourly = 1');
  else if (q.type === 'fixed') where.push('j.is_hourly = 0');

  const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => s.trim()).filter(Boolean);

  const cats = listOf(q.category);
  if (cats.length) {
    where.push(`(${cats.map(() => 'j.category_slug = ? OR j.category = ?').join(' OR ')})`);
    for (const c of cats) params.push(c, c);
  }

  const subs = listOf(q.subcategory);
  if (subs.length) {
    where.push(`(${subs.map(() => 'j.subcategory = ?').join(' OR ')})`);
    params.push(...subs);
  }

  const countries = listOf(q.country);
  if (countries.length) {
    where.push(`(${countries.map(() => 'c.country_code = ?').join(' OR ')})`);
    params.push(...countries);
  }

  // Skills are stored as a JSON array; a LIKE on the slug is precise enough
  // because slugs are delimited by quotes in the serialised form.
  const skills = listOf(q.skill);
  if (skills.length) {
    where.push(`(${skills.map(() => 'j.skills LIKE ?').join(q.skillMode === 'all' ? ' AND ' : ' OR ')})`);
    for (const s of skills) params.push(`%"slug":"${s}"%`);
  }

  if (q.minBudget) {
    where.push('COALESCE(j.budget_max, j.budget_min) >= ?');
    params.push(Number(q.minBudget));
  }
  if (q.maxBudget) {
    where.push('COALESCE(j.budget_min, j.budget_max) <= ?');
    params.push(Number(q.maxBudget));
  }
  if (q.maxBids) {
    where.push('COALESCE(j.bids, 0) <= ?');
    params.push(Number(q.maxBids));
  }
  if (q.verified === '1') where.push('c.payment_verified = 1');
  if (q.noBids === '1') where.push('COALESCE(j.bids, 0) = 0');
  if (q.hasContacts === '1') where.push('COALESCE(j.contacts_count, 0) > 0');
  if (q.noContacts === '1') where.push('COALESCE(j.contacts_count, 0) = 0');
  if (q.hasReply === '1') where.push('j.last_reply_at IS NOT NULL');
  if (q.hasHired === '1') where.push('COALESCE(c.projects_paid, 0) > 0');
  if (q.minHireRate) {
    where.push('COALESCE(c.hire_rate, 0) >= ?');
    params.push(Number(q.minHireRate));
  }

  /*
   * Whether the client is still around. Of 1312 clients, five were online in the
   * last hour and a thousand had not appeared for three days, so this separates
   * a posting somebody is watching from one nobody will read.
   *
   * It is a snapshot from when we last scraped that client, not a live presence
   * check -- for a client we have not seen in days, it is stale by that much.
   */
  if (q.clientSeen) {
    where.push('c.last_login_at >= ?');
    params.push(new Date(Date.now() - Number(q.clientSeen) * 3600e3).toISOString());
  }

  if (q.repliedWithin) {
    where.push('j.last_reply_at >= ?');
    params.push(new Date(Date.now() - Number(q.repliedWithin) * 3600e3).toISOString());
  }
  /*
   * The viewer's own dealings with the client, from their own overlay -- never
   * anybody else's. `uf` is joined on this member's id, so these stay private
   * the same way stars and notes do.
   */
  /*
   * The stages a proposal passes through, each from this member's own overlay:
   * sent, opened by the client, favourited, answered. Filtering on them is how
   * you find the ones worth chasing rather than re-reading all 157.
   */
  /*
   * Awarded, cancelled or simply gone from the list: not somewhere to bid, so
   * off the board unless asked for. See CLOSED_SQL for how that is decided.
   */
  /*
   * Except when the question is about my own history. "Bid by me" is asked to
   * review proposals, and most proposals end on a project that has since been
   * awarded -- hiding those would make 157 bids read as 58. Finding open work and
   * reviewing past work want opposite defaults, so the history filters bring the
   * closed ones back on their own.
   */
  const reviewingHistory = ['myBid', 'myRead', 'myFavourite', 'myContact'].some((k) => q[k] === '1');
  if (q.showClosed !== '1' && !reviewingHistory) where.push(`NOT ${CLOSED_SQL}`);

  if (q.myBid === '1') where.push('COALESCE(uf.has_own_bid, 0) = 1');
  if (q.myRead === '1') where.push('COALESCE(uf.proposal_read, 0) = 1');
  if (q.myFavourite === '1') where.push('COALESCE(uf.client_favorite, 0) = 1');

  if (q.myContact === '1') where.push('COALESCE(uf.was_contacted, 0) = 1');
  if (q.noMyContact === '1') where.push('COALESCE(uf.was_contacted, 0) = 0');

  if (q.starred === '1') where.push('COALESCE(uf.starred, 0) = 1');
  if (q.notBid === '1') where.push('COALESCE(uf.has_own_bid, 0) = 0');
  if (q.hidden !== '1') where.push('COALESCE(uf.hidden, 0) = 0');

  if (q.since) {
    where.push('COALESCE(j.published_approx_at, j.published_at, j.first_seen_at) >= ?');
    params.push(new Date(Date.now() - Number(q.since) * 3600e3).toISOString());
  }

  if (q.clientId) {
    where.push('j.client_id = ?');
    params.push(q.clientId);
  }

  // Jobs first collected after this instant -- what the browser alert asks for.
  if (q.seenAfter) {
    where.push('j.first_seen_at > ?');
    params.push(String(q.seenAfter));
  }

  return { join, where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/*
 * The job corpus is shared, so `user_jobs` is joined on the *viewer's* id: your
 * stars, notes, hides and "I bid on this" are yours alone, while the posting,
 * client and contact data everyone helped collect is common. The join parameter
 * is bound first in every query, which is why buildQuery() seeds its params array
 * with the user id.
 */
const BASE_FROM = `
  FROM jobs j
  LEFT JOIN clients c ON c.id = j.client_id
  LEFT JOIN user_jobs uf ON uf.job_slug = j.slug AND uf.user_id = ?
`;

const SELECT_COLUMNS = `
  j.seq AS no,
  j.slug, j.url, j.title, j.published_text, j.published_at, j.published_approx_at,
  j.first_seen_at, j.last_seen_at, j.detail_fetched_at,
  j.budget_text, j.currency, j.budget_min, j.budget_max, j.is_hourly, j.budget_is_max,
  j.summary, j.skills, j.category, j.category_slug, j.subcategory, j.subcategory_slug,
  j.project_size, j.project_duration, j.bids, j.interested, j.avg_bid_rate, j.status_label,
  j.is_featured, j.is_max_highlighted, j.bid_action_label, j.bid_action_url,
  COALESCE(uf.has_own_bid, 0)   AS has_own_bid,
  COALESCE(uf.was_contacted, 0) AS was_contacted,
  COALESCE(uf.proposal_read, 0)     AS proposal_read,
  COALESCE(uf.client_favorite, 0)   AS client_favorite,
  COALESCE(uf.proposal_selected, 0) AS proposal_selected,
  uf.own_budget,
  j.contacts_count, j.pre_selected_count, j.insights_fetched_at,
  j.last_reply_text, j.last_reply_at,
  j.client_id,
  c.name AS client_name, c.avatar_url AS client_avatar_url,
  c.country AS client_country, c.country_code AS client_country_code,
  c.rating AS client_rating, c.published_projects AS client_published, c.projects_paid AS client_paid,
  c.hire_rate AS client_hire_rate, c.payment_verified AS client_verified,
  c.member_since AS client_member_since, c.last_login AS client_last_login,
  c.last_login_at AS client_last_login_at,
  c.profile_url AS client_profile_url,
  COALESCE(uf.starred, 0) AS starred, COALESCE(uf.hidden, 0) AS hidden, uf.note,
  CASE WHEN ${CLOSED_SQL} THEN 1 ELSE 0 END AS is_closed
`;

app.get('/api/jobs', requireAuth, requireSetup, async (req, res) => {
  try {
    const q = req.query;
    const uid = req.user.id;
    const { join, where, params } = buildQuery(q, uid);
    const order = SORTS[q.sort] || SORTS.newest;
    const limit = Math.min(Number(q.limit) || 50, 200);
    const offset = Math.max(Number(q.offset) || 0, 0);

    // Tab counts respect every filter except the contract type itself.
    const tab = buildQuery({ ...q, type: undefined }, uid);

    // Three independent queries, issued together: one round trip, not three.
    const [totalRow, rows, counts] = await Promise.all([
      get(`SELECT COUNT(*) AS n ${BASE_FROM} ${join} ${where}`, params),
      all(
        `SELECT ${SELECT_COLUMNS} ${BASE_FROM} ${join} ${where} ${order} LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      get(
        `SELECT COUNT(*) AS all_count,
                SUM(CASE WHEN j.is_hourly = 1 THEN 1 ELSE 0 END) AS hourly,
                SUM(CASE WHEN j.is_hourly = 0 THEN 1 ELSE 0 END) AS fixed
         ${BASE_FROM} ${tab.join} ${tab.where}`,
        tab.params,
      ),
    ]);

    res.json({ total: totalRow.n, limit, offset, counts, jobs: rows.map(jsonSafe) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/jobs/:slug', requireAuth, requireSetup, async (req, res) => {
  const job = await get(`SELECT ${SELECT_COLUMNS}, j.description, j.raw ${BASE_FROM} WHERE j.slug = ?`, [
    req.user.id,
    req.params.slug,
  ]);
  if (!job) return res.status(404).json({ error: 'Not found' });

  const reviews = job.client_id
    ? await all('SELECT * FROM client_reviews WHERE client_id = ? ORDER BY id DESC LIMIT 25', [
        job.client_id,
      ])
    : [];
  /*
   * Contacted freelancers first — they are the headline of the drawer.
   *
   * `is_self` is resolved against the viewer's own Workana display name rather
   * than stored, so one shared contender list serves every member correctly. The
   * comparison is spelled as CASE WHEN because Postgres yields a boolean where
   * SQLite yields 0/1, and the ordering below is arithmetic.
   */
  const me = req.user.workana_name;

  /*
   * The computed column cannot also be called `is_self`: the table already has a
   * column of that name, `SELECT *` emits it, and two output columns sharing a
   * name make `ORDER BY is_self` ambiguous — which Postgres rejects outright
   * where SQLite just picked the later one. It is computed under its own name
   * and overwrites the stored value below, which is the legacy one and always 0.
   */
  const insights = (
    await all(
      `SELECT *, CASE WHEN freelancer = ? THEN 1 ELSE 0 END AS viewer_is_self
         FROM job_insights WHERE job_slug = ?
        ORDER BY in_contact DESC, proposal_selected DESC, viewer_is_self DESC,
                 is_hero DESC, COALESCE(rating, 0) DESC`,
      [me ?? '', req.params.slug],
    )
  ).map((row) => ({ ...row, is_self: row.viewer_is_self }));

  const otherJobs = job.client_id
    ? await all(
        `SELECT slug, title, budget_text, bids, published_text FROM jobs
          WHERE client_id = ? AND slug != ? ORDER BY first_seen_at DESC LIMIT 10`,
        [job.client_id, req.params.slug],
      )
    : [];

  res.json({ job: jsonSafe(job), reviews, insights, otherJobs });
});

/* ------------------------------------------------------------------ */
/* Facets, stats, local flags                                          */
/* ------------------------------------------------------------------ */

// NOTE: `GROUP BY <alias>` is a trap here -- SQLite binds the name to a real
// column when one exists, and both `jobs.slug` and `clients.name` collide with
// the aliases these queries want. Always group by the underlying expression.
app.get('/api/facets', requireAuth, requireSetup, async (_req, res) => {
  // Four independent queries, issued together: one round trip, not four.
  const [categories, subcategories, countries, skillRows] = await Promise.all([
    all(
      `SELECT COALESCE(j.category, 'Uncategorised') AS name, j.category_slug AS slug, COUNT(*) AS n
         FROM jobs j WHERE NOT ${CLOSED_SQL}
        GROUP BY COALESCE(j.category, 'Uncategorised'), j.category_slug ORDER BY n DESC`,
    ),
    all(
      `SELECT j.subcategory AS name, j.category AS parent, COUNT(*) AS n FROM jobs j
        WHERE j.subcategory IS NOT NULL AND NOT ${CLOSED_SQL}
        GROUP BY j.subcategory, j.category ORDER BY n DESC LIMIT 120`,
    ),
    all(
      `SELECT c.country AS name, c.country_code AS code, COUNT(*) AS n
         FROM jobs j JOIN clients c ON c.id = j.client_id
        WHERE c.country IS NOT NULL AND NOT ${CLOSED_SQL}
        GROUP BY c.country, c.country_code ORDER BY n DESC`,
    ),
    /*
     * Skills live inside each job's JSON array. Counting them used to mean
     * shipping every open job's array to the server and tallying in JS -- a
     * quarter of a megabyte per page load, which through a slow link cost more
     * than every other query here together. The database unpacks and counts
     * them instead and sends back only the totals.
     */
    all(
      isPostgres
        ? `SELECT s->>'slug' AS slug, MAX(s->>'name') AS name, COUNT(*) AS n
             FROM jobs j CROSS JOIN LATERAL jsonb_array_elements(j.skills::jsonb) AS s
            WHERE j.skills IS NOT NULL AND j.skills LIKE '[%' AND NOT ${CLOSED_SQL}
              AND s->>'slug' IS NOT NULL
            GROUP BY s->>'slug' ORDER BY n DESC, slug LIMIT 300`
        : `SELECT json_extract(s.value, '$.slug') AS slug, MAX(json_extract(s.value, '$.name')) AS name,
                  COUNT(*) AS n
             FROM jobs j, json_each(j.skills) AS s
            WHERE j.skills IS NOT NULL AND json_valid(j.skills) AND NOT ${CLOSED_SQL}
              AND json_extract(s.value, '$.slug') IS NOT NULL
            GROUP BY json_extract(s.value, '$.slug') ORDER BY n DESC, slug LIMIT 300`,
    ),
  ]);

  const skills = skillRows.map((r) => ({ name: r.name, slug: r.slug, n: Number(r.n) }));

  res.json({ categories, subcategories, countries, skills });
});

app.get('/api/stats', requireAuth, requireSetup, async (req, res) => {
  const totalsQ = get(
      `SELECT COUNT(*) AS jobs,
              SUM(CASE WHEN is_hourly=1 THEN 1 ELSE 0 END) AS hourly,
              SUM(CASE WHEN is_hourly=0 THEN 1 ELSE 0 END) AS fixed,
              SUM(CASE WHEN detail_fetched_at IS NOT NULL THEN 1 ELSE 0 END) AS enriched,
              SUM(CASE WHEN COALESCE(bids,0)=0 THEN 1 ELSE 0 END) AS no_bids,
              (SELECT COUNT(*) FROM user_jobs WHERE user_id = ? AND has_own_bid = 1) AS own_bids
         FROM jobs`,
      [req.user.id],
    );

  const byCategoryQ = all(
      `SELECT COALESCE(category,'Unknown') AS name, COUNT(*) AS n,
              -- Postgres has round(numeric, int) but no round(double, int), and
              -- AVG over these columns is a double. The cast satisfies both.
              ROUND(CAST(AVG(COALESCE(budget_max, budget_min)) AS NUMERIC), 0) AS avg_budget,
              ROUND(CAST(AVG(COALESCE(bids,0)) AS NUMERIC), 1) AS avg_bids
         FROM jobs GROUP BY COALESCE(category,'Unknown') ORDER BY n DESC LIMIT 15`,
    );

  const byDayQ = all(
      `SELECT substr(COALESCE(published_approx_at, published_at, first_seen_at), 1, 10) AS day,
              COUNT(*) AS n
         FROM jobs GROUP BY day ORDER BY day DESC LIMIT 21`,
    );

  const byCountryQ = all(
      `SELECT c.country AS name, c.country_code AS code, COUNT(*) AS n
         FROM jobs j JOIN clients c ON c.id=j.client_id
        WHERE c.country IS NOT NULL GROUP BY c.country, c.country_code ORDER BY n DESC LIMIT 12`,
    );

  const budgetsQ = all(
      `SELECT is_hourly,
              ROUND(CAST(AVG(COALESCE(budget_min, budget_max)) AS NUMERIC),0) AS avg_min,
              ROUND(CAST(AVG(COALESCE(budget_max, budget_min)) AS NUMERIC),0) AS avg_max,
              MAX(COALESCE(budget_max, budget_min)) AS max
         FROM jobs GROUP BY is_hourly`,
    );

  /*
   * The freelancers this member keeps running into.
   *
   * Every insights page collected names the competition on that job, so summing
   * across them says who is actually working this category — how often they
   * appear, how often the client engages them, and what they bring. The profile
   * fields are the same on every row for a given person, so MAX() is just a way
   * of carrying one of them through the GROUP BY.
   *
   * `appearances` counts jobs, not proposals: a freelancer shows up at most once
   * per insights page, since job_insights is keyed by (job_slug, freelancer).
   */
  const developersQ = all(
    `SELECT freelancer AS name,
            COUNT(*)                  AS appearances,
            SUM(in_contact)           AS contacted,
            SUM(pre_selected)         AS pre_selected,
            SUM(proposal_selected)    AS selected,
            MAX(rating)               AS rating,
            MAX(projects_done)        AS projects_done,
            MAX(category_jobs)        AS category_jobs,
            MAX(rehirings)            AS rehirings,
            MAX(is_hero)              AS is_hero,
            MAX(ranking)              AS ranking,
            MAX(avatar_url)           AS avatar_url,
            MAX(profile_url)          AS profile_url
       FROM job_insights
      GROUP BY freelancer
      ORDER BY COUNT(*) DESC, SUM(in_contact) DESC
      LIMIT 40`,
  );

  /*
   * When clients are actually at their keyboard.
   *
   * `last_login_at` is the only absolute clock Workana gives us — everything
   * else on the board is "3 days ago" resolved against whenever we happened to
   * scrape, which carries no hour of day worth reading. Hours are returned in
   * UTC and shifted to the viewer's own zone in the browser, since the useful
   * question is what time it is where *they* are.
   *
   * Posting hours come from the same idea but a poorer source, so they are
   * restricted to cards that said minutes or hours: a "5 days ago" card would
   * contribute the hour we scraped it, not the hour it was posted.
   */
  const loginHoursQ = all(
    `SELECT CAST(substr(last_login_at, 12, 2) AS INTEGER) AS hour, COUNT(*) AS n
       FROM clients WHERE last_login_at IS NOT NULL
      GROUP BY CAST(substr(last_login_at, 12, 2) AS INTEGER)`,
  );

  const postHoursQ = all(
    `SELECT CAST(substr(published_approx_at, 12, 2) AS INTEGER) AS hour, COUNT(*) AS n
       FROM jobs
      WHERE published_approx_at IS NOT NULL
        AND (LOWER(published_text) LIKE '%minute%' OR LOWER(published_text) LIKE '%minuto%'
          OR LOWER(published_text) LIKE '%hour%'   OR LOWER(published_text) LIKE '%hora%'
          OR LOWER(published_text) LIKE '%just now%')
      GROUP BY CAST(substr(published_approx_at, 12, 2) AS INTEGER)`,
  );

  const spread = (rows) => {
    const out = Array.from({ length: 24 }, () => 0);
    for (const r of rows) if (r.hour >= 0 && r.hour < 24) out[r.hour] = Number(r.n);
    return out;
  };

  // How stale the client is, which is the part that matters when deciding
  // whether a posting is still being watched by anyone.
  const now = Date.now();
  const at = (h) => new Date(now - h * 3600e3).toISOString();
  const recencyQ = get(
    `SELECT
       SUM(CASE WHEN last_login_at >= ? THEN 1 ELSE 0 END) AS h1,
       SUM(CASE WHEN last_login_at >= ? AND last_login_at < ? THEN 1 ELSE 0 END) AS h6,
       SUM(CASE WHEN last_login_at >= ? AND last_login_at < ? THEN 1 ELSE 0 END) AS h24,
       SUM(CASE WHEN last_login_at >= ? AND last_login_at < ? THEN 1 ELSE 0 END) AS d3,
       SUM(CASE WHEN last_login_at <  ? THEN 1 ELSE 0 END) AS older,
       COUNT(*) AS total
     FROM clients WHERE last_login_at IS NOT NULL`,
    [at(1), at(6), at(1), at(24), at(6), at(72), at(24), at(72)],
  );

  const topSkillsQ = all('SELECT skills FROM jobs WHERE skills IS NOT NULL');

  /*
   * Every query above is independent of the others, so they were all issued
   * without waiting and are collected here together: one round trip to the
   * database instead of ten, which from a workstation to a hosted Postgres is
   * the difference between a third of a second and several seconds.
   */
  const [totals, byCategory, byDay, byCountry, budgets, developers, loginHours, postHours, recency, topSkills] =
    await Promise.all([
      totalsQ,
      byCategoryQ,
      byDayQ,
      byCountryQ,
      budgetsQ,
      developersQ,
      loginHoursQ,
      postHoursQ,
      recencyQ,
      topSkillsQ,
    ]);

  const clientActivity = {
    loginByHourUtc: spread(loginHours),
    postedByHourUtc: spread(postHours),
    postedSample: postHours.reduce((sum, r) => sum + Number(r.n), 0),
    recency,
  };

  const tally = new Map();
  for (const r of topSkills) {
    let list = [];
    try {
      list = JSON.parse(r.skills);
    } catch {}
    for (const s of list) if (s?.name) tally.set(s.name, (tally.get(s.name) || 0) + 1);
  }

  /*
   * Two different counts, and the gap between them is the point: the board only
   * knows about bids on jobs it has scraped, while Workana's inbox remembers
   * every proposal ever sent. See scripts/sync-proposals.mjs.
   */
  totals.proposals_total = req.user.proposals_total ?? null;
  totals.proposals_synced_at = req.user.proposals_synced_at ?? null;

  res.json({
    totals,
    byCategory,
    byDay: byDay.reverse(),
    byCountry,
    budgets,
    // Marked here rather than in SQL so one shared table serves every member.
    developers: developers.map((d) => ({ ...d, is_me: d.name === req.user.workana_name })),
    clientActivity,
    topSkills: [...tally.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n).slice(0, 20),
  });
});

app.post('/api/flags/:slug', requireAuth, requireSetup, async (req, res) => {
  const { starred, hidden, note } = req.body || {};
  await upsertUserJob(req.user.id, req.params.slug, { starred, hidden, note });
  res.json(
    await get('SELECT * FROM user_jobs WHERE user_id = ? AND job_slug = ?', [req.user.id, req.params.slug]),
  );
});

/* ------------------------------------------------------------------ */
/* Scraping control                                                    */
/* ------------------------------------------------------------------ */

app.get('/api/status', requireAuth, async (req, res) => {
  /*
   * The backlog is what explains a badge that never goes out. Each run enriches
   * only DETAIL_BUDGET jobs, so a freshly filled corpus has hundreds of pending
   * detail pages and will keep working for hours. Reporting the remainder turns
   * "still scraping?" into a number that visibly counts down.
   */
  const [run, control, backlog, total] = await Promise.all([
    lastRun(),
    readControl(),
    get(
      `SELECT
         (SELECT COUNT(*) FROM jobs WHERE detail_fetched_at IS NULL) AS details,
         (SELECT COUNT(*) FROM jobs
           WHERE insights_fetched_at IS NULL AND COALESCE(bids, 0) > 0) AS insights`,
    ),
    get('SELECT COUNT(*) AS n FROM jobs'),
  ]);

  res.json({
    ...describeSlot(control, req.user.id),
    canStop: Boolean(req.user.is_admin),
    backlog,
    lastRun: run,
    total: total.n,
  });
});

/**
 * Asks for a run with the signed-in member's own Workana session.
 *
 * The claim is the whole decision: one conditional UPDATE that only one request
 * can win, however many board instances are answering. The scraper picks the
 * run up within a few seconds; this route does not wait for it.
 */
app.post('/api/scrape', requireAuth, async (req, res) => {
  if (!(await getWorkanaCookies(req.user.id))) {
    return res.status(400).json({ error: 'Add your Workana session first, then refresh.' });
  }
  /*
   * Checked before the slot is claimed: a run that may not use this member's
   * session should never hold the one slot, however briefly.
   */
  const needsProxy = proxyBlocker(req.user);
  if (needsProxy) return res.status(403).json({ proxyRequired: true, error: needsProxy });
  const setAside = scrapeBlocker(req.user);
  if (setAside) return res.status(403).json({ scrapeBlocked: true, error: setAside });
  if (!workerOnline(await readControl())) return res.status(503).json({ offline: true, error: OFFLINE });

  const { pages, category, query, detailBudget } = req.body || {};
  // The Refresh button sends no page count; Full crawl does.
  const refresh = !Number(pages);
  const options = {
    pages: Number(pages) || config.manualRefreshPages,
    onlyListed: refresh,
    category: category ?? config.category,
    query: query || '',
    // `Number(undefined) ?? default` is NaN, not the default, and a NaN budget
    // fails every `> 0` check -- which is how a button press used to skip the
    // detail pages entirely.
    detailBudget: Number(detailBudget) || config.detailBudget,
  };

  const token = await claimSlot({ userId: req.user.id, trigger: 'manual', options, state: 'requested' });
  if (token) return res.json({ started: true, scrapingMine: true });

  // Three different situations, and telling them apart matters: only one of
  // them is another person, and only one of them is worth waiting on.
  const held = describeSlot(await readControl(), req.user.id);
  res.status(409).json({
    busy: true,
    scrapingAuto: held.scrapingAuto,
    scrapingMine: held.scrapingMine,
    since: held.scrapingSince,
    error: held.scrapingAuto
      ? 'The board is refreshing itself right now. Wait for it to finish, then try again.'
      : held.scrapingMine
        ? 'Your scrape is still running. Wait for it to finish before starting another.'
        : 'Another member is scraping right now. The board is being refreshed — wait for it to finish.',
  });
});

/**
 * Stops the scrape in flight, and holds the automatic refresh until resumed.
 *
 * Owner-only. There is one scraper for the whole instance, so a stop is never
 * just personal -- it ends the run whichever member's session is driving it.
 * That is a decision for whoever runs the instance rather than for any member
 * who happens to be impatient.
 *
 * Nothing is undone: jobs are written as they are read, so a stop costs the
 * remainder of the run rather than its results.
 */
app.post('/api/scrape/stop', requireAuth, requireAdmin, async (req, res) => {
  const result = await requestStop();
  console.log(
    `[scrape] stopped and paused by ${req.user.email}` +
      (result.stalled ? ' (a stalled run was holding the slot)' : ''),
  );
  res.json({ ok: true, stopped: result.wasRunning, paused: true, ...result });
});

/** Lets the clock run again. Only an explicit act lifts a pause. */
app.post('/api/scrape/resume', requireAuth, requireAdmin, async (req, res) => {
  const nextRunAt = await resume();
  console.log(`[scrape] resumed by ${req.user.email}`);
  res.json({ ok: true, paused: false, nextRunAt });
});

app.post('/api/insights/:slug', requireAuth, (req, res) =>
  viaWorker(req, res, 'insights', { slug: req.params.slug }, 'Still reading this project. Reopen it in a minute.'),
);
