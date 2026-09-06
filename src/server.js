import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { loadWorkanaCookies, hasSessionCookie, describeSession } from './cookies.js';
import { all, get, lastRun, upsertUserJob, adoptLegacyData, initDatabase } from './db.js';
import {
  scrape,
  isScraping,
  scrapingUserId,
  queueLength,
  runStateFor,
  currentProgress,
  fetchInsights,
  checkLogin,
} from './scraper/scrape.js';
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
  purgeExpiredSessions,
  publicUser,
  userCount,
  setWorkanaCookies,
  getWorkanaCookies,
  clearWorkanaCookies,
  recordCookieCheck,
  setWorkanaProxy,
  getWorkanaProxy,
  findUser,
  requireAdmin,
  scrapeCandidates,
} from './auth.js';

const app = express();

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
app.use((req, res, next) => {
  if (!config.allowedHosts.length) return next();
  const host = String(req.headers.host || '').toLowerCase().split(':')[0];
  if (LOOPBACK.test(host) || config.allowedHosts.includes(host)) return next();
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
    needsBootstrap: (await userCount()) === 0,
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

/** Opens Workana with this member's cookies and reports whether they still work. */
app.post('/api/session/verify', requireAuth, async (req, res) => {
  const cookies = await getWorkanaCookies(req.user.id);
  if (!cookies) return res.status(400).json({ error: 'No Workana session stored yet.' });
  try {
    const result = await checkLogin({
      cookies,
      userId: req.user.id,
      proxy: await getWorkanaProxy(req.user.id),
    });
    await recordCookieCheck(req.user.id, { valid: result.loggedIn, workanaName: result.user });
    res.json(result);
  } catch (err) {
    await recordCookieCheck(req.user.id, { valid: false });
    res.status(502).json({ error: err.message });
  }
});

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
  client_rating: 'ORDER BY COALESCE(c.rating, -1) DESC, COALESCE(c.projects_paid,0) DESC',
  // Break ties on volume, so a 100% client with 8 paid outranks one with 1.
  hire_rate: 'ORDER BY COALESCE(c.hire_rate, -1) DESC, COALESCE(c.projects_paid, 0) DESC',
};

/**
 * Escapes a user's words for FTS5. Anything the user types is treated as a bag of
 * quoted terms with a prefix match on the last one, which avoids FTS5 syntax
 * errors on stray quotes/operators while still feeling like a search box.
 */
function ftsQuery(raw) {
  const terms = String(raw)
    .toLowerCase()
    .replace(/["*()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(' AND ');
}

function buildQuery(q, userId) {
  const where = [];
  // First placeholder in BASE_FROM is the user_jobs join.
  const params = [userId ?? -1];
  let join = '';

  if (q.search) {
    const match = ftsQuery(q.search);
    if (match) {
      join += ' JOIN jobs_fts f ON f.slug = j.slug ';
      where.push('jobs_fts MATCH ?');
      params.push(match);
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

  if (q.repliedWithin) {
    where.push('j.last_reply_at >= ?');
    params.push(new Date(Date.now() - Number(q.repliedWithin) * 3600e3).toISOString());
  }
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
  j.rowid AS no,
  j.slug, j.url, j.title, j.published_text, j.published_at, j.published_approx_at,
  j.first_seen_at, j.last_seen_at, j.detail_fetched_at,
  j.budget_text, j.currency, j.budget_min, j.budget_max, j.is_hourly, j.budget_is_max,
  j.summary, j.skills, j.category, j.category_slug, j.subcategory, j.subcategory_slug,
  j.project_size, j.project_duration, j.bids, j.interested, j.avg_bid_rate, j.status_label,
  j.is_featured, j.is_max_highlighted, j.bid_action_label,
  COALESCE(uf.has_own_bid, 0)   AS has_own_bid,
  COALESCE(uf.was_contacted, 0) AS was_contacted,
  uf.own_budget,
  j.contacts_count, j.pre_selected_count, j.insights_fetched_at,
  j.last_reply_text, j.last_reply_at,
  j.client_id,
  c.name AS client_name, c.avatar_url AS client_avatar_url,
  c.country AS client_country, c.country_code AS client_country_code,
  c.rating AS client_rating, c.published_projects AS client_published, c.projects_paid AS client_paid,
  c.hire_rate AS client_hire_rate, c.payment_verified AS client_verified,
  c.member_since AS client_member_since, c.last_login AS client_last_login,
  c.profile_url AS client_profile_url,
  COALESCE(uf.starred, 0) AS starred, COALESCE(uf.hidden, 0) AS hidden, uf.note
`;

app.get('/api/jobs', requireAuth, async (req, res) => {
  try {
    const q = req.query;
    const uid = req.user.id;
    const { join, where, params } = buildQuery(q, uid);
    const order = SORTS[q.sort] || SORTS.newest;
    const limit = Math.min(Number(q.limit) || 50, 200);
    const offset = Math.max(Number(q.offset) || 0, 0);

    const total = (await get(`SELECT COUNT(*) AS n ${BASE_FROM} ${join} ${where}`, params)).n;
    const rows = await all(
      `SELECT ${SELECT_COLUMNS} ${BASE_FROM} ${join} ${where} ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    // Tab counts respect every filter except the contract type itself.
    const tab = buildQuery({ ...q, type: undefined }, uid);
    const counts = await get(
      `SELECT COUNT(*) AS all_count,
              SUM(CASE WHEN j.is_hourly = 1 THEN 1 ELSE 0 END) AS hourly,
              SUM(CASE WHEN j.is_hourly = 0 THEN 1 ELSE 0 END) AS fixed
       ${BASE_FROM} ${tab.join} ${tab.where}`,
      tab.params,
    );

    res.json({ total, limit, offset, counts, jobs: rows.map(jsonSafe) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/jobs/:slug', requireAuth, async (req, res) => {
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
  const insights = await all(
    `SELECT *, CASE WHEN freelancer = ? THEN 1 ELSE 0 END AS is_self
       FROM job_insights WHERE job_slug = ?
      ORDER BY in_contact DESC, proposal_selected DESC, is_self DESC,
               is_hero DESC, COALESCE(rating, 0) DESC`,
    [me ?? '', req.params.slug],
  );

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
app.get('/api/facets', requireAuth, async (_req, res) => {
  const categories = await all(
      `SELECT COALESCE(category, 'Uncategorised') AS name, category_slug AS slug, COUNT(*) AS n
         FROM jobs GROUP BY COALESCE(category, 'Uncategorised'), category_slug ORDER BY n DESC`,
    );
  const subcategories = await all(
      `SELECT subcategory AS name, category AS parent, COUNT(*) AS n FROM jobs
        WHERE subcategory IS NOT NULL GROUP BY subcategory, category ORDER BY n DESC LIMIT 120`,
    );
  const countries = await all(
      `SELECT c.country AS name, c.country_code AS code, COUNT(*) AS n
         FROM jobs j JOIN clients c ON c.id = j.client_id
        WHERE c.country IS NOT NULL GROUP BY c.country, c.country_code ORDER BY n DESC`,
    );

  // Skills live inside a JSON blob, so tally them in JS rather than SQL.
  const tally = new Map();
  for (const row of await all('SELECT skills FROM jobs WHERE skills IS NOT NULL')) {
    let list = [];
    try {
      list = JSON.parse(row.skills);
    } catch {}
    for (const s of list) {
      if (!s?.slug) continue;
      const entry = tally.get(s.slug) || { name: s.name, slug: s.slug, n: 0 };
      entry.n += 1;
      tally.set(s.slug, entry);
    }
  }
  const skills = [...tally.values()].sort((a, b) => b.n - a.n).slice(0, 300);

  res.json({ categories, subcategories, countries, skills });
});

app.get('/api/stats', requireAuth, async (req, res) => {
  const totals = await get(
      `SELECT COUNT(*) AS jobs,
              SUM(CASE WHEN is_hourly=1 THEN 1 ELSE 0 END) AS hourly,
              SUM(CASE WHEN is_hourly=0 THEN 1 ELSE 0 END) AS fixed,
              SUM(CASE WHEN detail_fetched_at IS NOT NULL THEN 1 ELSE 0 END) AS enriched,
              SUM(CASE WHEN COALESCE(bids,0)=0 THEN 1 ELSE 0 END) AS no_bids,
              (SELECT COUNT(*) FROM user_jobs WHERE user_id = ? AND has_own_bid = 1) AS own_bids
         FROM jobs`,
      [req.user.id],
    );

  const byCategory = await all(
      `SELECT COALESCE(category,'Unknown') AS name, COUNT(*) AS n,
              ROUND(AVG(COALESCE(budget_max, budget_min)), 0) AS avg_budget,
              ROUND(AVG(COALESCE(bids,0)), 1) AS avg_bids
         FROM jobs GROUP BY COALESCE(category,'Unknown') ORDER BY n DESC LIMIT 15`,
    );

  const byDay = await all(
      `SELECT substr(COALESCE(published_approx_at, published_at, first_seen_at), 1, 10) AS day,
              COUNT(*) AS n
         FROM jobs GROUP BY day ORDER BY day DESC LIMIT 21`,
    );

  const byCountry = await all(
      `SELECT c.country AS name, c.country_code AS code, COUNT(*) AS n
         FROM jobs j JOIN clients c ON c.id=j.client_id
        WHERE c.country IS NOT NULL GROUP BY c.country, c.country_code ORDER BY n DESC LIMIT 12`,
    );

  const budgets = await all(
      `SELECT is_hourly,
              ROUND(AVG(COALESCE(budget_min, budget_max)),0) AS avg_min,
              ROUND(AVG(COALESCE(budget_max, budget_min)),0) AS avg_max,
              MAX(COALESCE(budget_max, budget_min)) AS max
         FROM jobs GROUP BY is_hourly`,
    );

  const topSkills = await all('SELECT skills FROM jobs WHERE skills IS NOT NULL');
  const tally = new Map();
  for (const r of topSkills) {
    let list = [];
    try {
      list = JSON.parse(r.skills);
    } catch {}
    for (const s of list) if (s?.name) tally.set(s.name, (tally.get(s.name) || 0) + 1);
  }

  res.json({
    totals,
    byCategory,
    byDay: byDay.reverse(),
    byCountry,
    budgets,
    topSkills: [...tally.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n).slice(0, 20),
  });
});

app.post('/api/flags/:slug', requireAuth, async (req, res) => {
  const { starred, hidden, note } = req.body || {};
  await upsertUserJob(req.user.id, req.params.slug, { starred, hidden, note });
  res.json(
    await get('SELECT * FROM user_jobs WHERE user_id = ? AND job_slug = ?', [req.user.id, req.params.slug]),
  );
});

/* ------------------------------------------------------------------ */
/* Scraping control                                                    */
/* ------------------------------------------------------------------ */

let lastError = null;

app.get('/api/status', requireAuth, async (req, res) => {
  const run = await lastRun();

  /*
   * The backlog is what explains a badge that never goes out. Each run enriches
   * only DETAIL_BUDGET jobs, so a freshly filled corpus has hundreds of pending
   * detail pages and will keep working for hours. Reporting the remainder turns
   * "still scraping?" into a number that visibly counts down.
   */
  const backlog = await get(
      `SELECT
         (SELECT COUNT(*) FROM jobs WHERE detail_fetched_at IS NULL) AS details,
         (SELECT COUNT(*) FROM jobs
           WHERE insights_fetched_at IS NULL AND COALESCE(bids, 0) > 0) AS insights`,
    );

  res.json({
    scraping: isScraping(),
    scrapingMine: scrapingUserId() === req.user.id,
    queued: queueLength(),
    progress: currentProgress(),
    backlog,
    lastRun: run,
    lastError,
    autoScrapeMinutes: config.autoScrapeMinutes,
    nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : null,
    total: (await get('SELECT COUNT(*) AS n FROM jobs')).n,
  });
});

/** Scrapes using the signed-in member's own Workana session. */
app.post('/api/scrape', requireAuth, async (req, res) => {
  const cookies = await getWorkanaCookies(req.user.id);
  if (!cookies) {
    return res.status(400).json({ error: 'Add your Workana session first, then refresh.' });
  }

  const { pages, category, query, detailBudget } = req.body || {};

  /*
   * Answer before starting, and say which of the three things happened: this
   * request started a run, joined the one this member already had, or lined up
   * behind somebody else's. Previously it always claimed "started", so a member
   * clicking Refresh during another member's run had no way to tell that their
   * click had done nothing new.
   */
  const already = runStateFor(req.user.id);
  const deeper = (Number(pages) || config.refreshPages) > config.refreshPages;
  res.json({
    started: !already || deeper,
    state: already,
    scrapingMine: scrapingUserId() === req.user.id,
    queued: queueLength(),
  });

  try {
    await scrape({
      pages: Number(pages) || config.refreshPages,
      category: category ?? config.category,
      query: query || '',
      detailBudget: Number(detailBudget) ?? config.detailBudget,
      userId: req.user.id,
      cookies,
      proxy: await getWorkanaProxy(req.user.id),
    });
    lastError = null;
    await recordCookieCheck(req.user.id, { valid: true });
  } catch (err) {
    lastError = err.message;
  } finally {
    scheduleNext();
  }
});

app.post('/api/insights/:slug', requireAuth, async (req, res) => {
  const cookies = await getWorkanaCookies(req.user.id);
  if (!cookies) return res.status(400).json({ error: 'Add your Workana session first.' });
  try {
    res.json(
      await fetchInsights(req.params.slug, {
        userId: req.user.id,
        cookies,
        proxy: await getWorkanaProxy(req.user.id),
      }),
    );
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */

let nextRunAt = null;
let timer = null;

/** Re-check this soon when the tick lands on top of a run already in progress. */
const BUSY_RETRY_MS = 60_000;

function scheduleNext(delay = config.autoScrapeMinutes * 60_000) {
  clearTimeout(timer);
  if (!config.autoScrapeMinutes) {
    nextRunAt = null;
    return;
  }
  nextRunAt = Date.now() + delay;
  timer = setTimeout(async () => {
    /*
     * Never queue a second run behind the one in flight: the queue only grows,
     * and each run in it would start by re-walking pages the previous one just
     * fetched. Re-checking in a minute keeps runs effectively back to back
     * without stacking — waiting a whole interval would leave the scraper idle
     * for no reason.
     */
    if (isScraping() || queueLength()) {
      scheduleNext(BUSY_RETRY_MS);
      return;
    }

    // Take turns between members so one account does not carry every refresh,
    // and so a member whose cookies expired does not stall the rotation.
    const [candidate] = await scrapeCandidates();

    if (!candidate) {
      nextRunAt = null;
      scheduleNext();
      return;
    }

    try {
      const cookies = await getWorkanaCookies(candidate.id);
      if (cookies) {
        await scrape({
          pages: config.refreshPages,
          userId: candidate.id,
          cookies,
          proxy: await getWorkanaProxy(candidate.id),
        });
        lastError = null;
      }
    } catch (err) {
      lastError = err.message;
      console.error('[auto-scrape]', err.message);
    } finally {
      scheduleNext();
    }
  }, delay);
}

/*
 * The schema has to exist before the first request is served, and creating it is
 * asynchronous now, so the listener starts only once the database is ready. A
 * failure here is fatal on purpose: serving a board with no database behind it
 * would just produce a wall of confusing 500s.
 */
await initDatabase().catch((err) => {
  console.error(`\n  Could not open the database: ${err.message}\n`);
  if (config.databaseUrl) {
    console.error('  DATABASE_URL is set, so this is Postgres. Check the service is running');
    console.error('  and that the host in the URL is reachable from here — Railway\'s');
    console.error('  *.railway.internal names only resolve inside Railway.\n');
  }
  process.exit(1);
});

await purgeExpiredSessions();
setInterval(() => purgeExpiredSessions().catch(() => {}), 6 * 3600e3).unref();

app.listen(config.port, config.host, async () => {
  console.log(`\n  Workana job board  →  http://${config.host}:${config.port}\n`);
  const n = (await get('SELECT COUNT(*) AS n FROM jobs')).n;
  const members = await userCount();
  const store = config.databaseUrl ? `Postgres (${new URL(config.databaseUrl).host})` : config.dbFile;
  console.log(`  ${n} jobs · ${members} member(s) · ${store}`);
  // Worth printing: the lane counts are derived from memory, so this is the one
  // place that explains why a small container scrapes narrower than a laptop.
  console.log(
    `  ${Math.round(config.memoryLimitBytes / 1024 / 1024)} MB available · ` +
      `${config.detailConcurrency} detail / ${config.insightConcurrency} insight lane(s)`,
  );

  if (members === 0) {
    console.log('  No accounts yet — the first person to register becomes the owner.');
  }

  /*
   * On a container platform the filesystem is wiped on redeploy unless a volume
   * is mounted, which would silently discard the corpus, every stored Workana
   * session and the key that decrypts them. Detect the hosted case and say so
   * loudly, because the failure only shows up one deploy later.
   */
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME) {
    if (!process.env.APP_SECRET) {
      console.warn(
        '\n  ⚠ APP_SECRET is not set on a hosted deployment.\n' +
          '    It is being generated into data/secret.key; if that volume is ever replaced,\n' +
          "    every member's stored Workana session becomes permanently unreadable.\n",
      );
    }
    if (config.host === '127.0.0.1') {
      console.warn('  ⚠ HOST is 127.0.0.1 — the platform router cannot reach this. Set HOST=0.0.0.0.');
    }
  }

  // This instance stores other people's live Workana logins. Say so plainly if
  // it is reachable from outside the machine.
  const exposed = config.host !== '127.0.0.1' && config.host !== 'localhost';
  if (exposed) {
    console.warn(`\n  ⚠ Listening on ${config.host} — reachable from the network.`);
    console.warn(`    This server can use every member's stored Workana login.`);
    if (!config.allowedHosts.length) {
      console.warn(`    · ALLOWED_HOSTS is unset: any Host header is accepted (DNS-rebinding risk).`);
    }
    if (!config.trustProxy) {
      console.warn(`    · TRUST_PROXY is off: sessions will not be marked Secure, so put a`);
      console.warn(`      TLS-terminating proxy in front and set TRUST_PROXY=1.`);
    }
    if (!process.env.APP_SECRET) {
      console.warn(`    · APP_SECRET is auto-generated; set it explicitly before others join.`);
    }
    console.warn('');
  }
  if (config.allowedHosts.length) {
    console.log(`  Accepting hosts: ${config.allowedHosts.join(', ')} (plus localhost)`);
  }
  if (!config.allowRegistration) console.log('  Registration is closed (ALLOW_REGISTRATION=0).');
  else if (config.registrationCode) console.log('  Registration requires an invite code.');

  if (config.autoScrapeMinutes) {
    console.log(`  Auto-refresh every ${config.autoScrapeMinutes} min (AUTO_SCRAPE_MINUTES=0 to disable)\n`);
    scheduleNext();
  } else {
    console.log('  Auto-refresh disabled\n');
  }
});
