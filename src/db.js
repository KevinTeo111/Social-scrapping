import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new DatabaseSync(config.dbFile);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  slug                TEXT PRIMARY KEY,
  url                 TEXT NOT NULL,
  title               TEXT NOT NULL,

  -- timing
  published_text      TEXT,           -- "Published: 1 hour ago" as shown in the list
  published_at        TEXT,           -- ISO, exact date from the detail page when known
  published_approx_at TEXT,           -- ISO, derived from the relative text at first sight
  first_seen_at       TEXT NOT NULL,  -- when *we* first saw it; drives the NEW badge
  last_seen_at        TEXT NOT NULL,
  detail_fetched_at   TEXT,

  -- money
  budget_text         TEXT,
  currency            TEXT,
  budget_min          REAL,
  budget_max          REAL,
  is_hourly           INTEGER DEFAULT 0,
  budget_is_max       INTEGER DEFAULT 0,  -- "Less than USD 15 / hour"

  -- content
  summary             TEXT,           -- truncated blurb from the list card
  description         TEXT,           -- full text from the detail page
  skills              TEXT,           -- JSON [{name, slug}]

  -- taxonomy
  category            TEXT,
  category_slug       TEXT,
  subcategory         TEXT,
  subcategory_slug    TEXT,
  project_size        TEXT,
  project_duration    TEXT,
  language            TEXT,

  -- activity
  bids                INTEGER,
  interested          INTEGER,
  avg_bid_rate        TEXT,           -- "USD 1102" from the Project Insights tab
  status_label        TEXT,           -- "Evaluating bids"
  is_featured         INTEGER DEFAULT 0,
  is_max_highlighted  INTEGER DEFAULT 0,

  -- the viewer's own relationship to the job
  has_own_bid         INTEGER DEFAULT 0,
  bid_action_label    TEXT,           -- "Place a bid" / "Improve proposal"
  was_contacted       INTEGER DEFAULT 0,

  client_id           TEXT REFERENCES clients(id),
  raw                 TEXT            -- full scraped payload, so nothing is ever lost
);

CREATE TABLE IF NOT EXISTS clients (
  id                  TEXT PRIMARY KEY,   -- Workana profile hash from /e/<hash>
  name                TEXT,
  profile_url         TEXT,
  avatar_url          TEXT,
  country             TEXT,
  country_code        TEXT,
  rating              REAL,               -- 0..5
  rating_count        INTEGER,
  published_projects  INTEGER,
  projects_paid       INTEGER,
  hire_rate           REAL,               -- 0..100
  payment_verified    INTEGER DEFAULT 0,
  member_since        TEXT,
  last_login          TEXT,
  updated_at          TEXT
);

-- The client's feedback history ("Freelancer qualifications" on the detail page).
CREATE TABLE IF NOT EXISTS client_reviews (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id      TEXT NOT NULL,
  job_slug       TEXT,
  project_title  TEXT,
  freelancer     TEXT,
  freelancer_url TEXT,
  avatar_url     TEXT,
  rating         REAL,
  age_text       TEXT,
  comment        TEXT,
  UNIQUE(client_id, project_title, freelancer, comment)
);

-- Competing proposals surfaced by the Project Insights tab.
CREATE TABLE IF NOT EXISTS job_insights (
  job_slug       TEXT NOT NULL,
  freelancer     TEXT NOT NULL,
  profile_url    TEXT,
  avatar_url     TEXT,
  badge          TEXT,     -- HERO / Recommended / New
  ranking        TEXT,     -- "#75 in Sales & Marketing"
  projects_done  INTEGER,
  category_jobs  INTEGER,
  rehirings      INTEGER,
  is_self        INTEGER DEFAULT 0,
  proposal_state TEXT,     -- "Proposal sent Proposal read"
  own_budget     TEXT,
  fetched_at     TEXT,
  PRIMARY KEY (job_slug, freelancer)
);

-- Local-only annotations; never sent anywhere.
CREATE TABLE IF NOT EXISTS user_flags (
  job_slug   TEXT PRIMARY KEY,
  starred    INTEGER DEFAULT 0,
  hidden     INTEGER DEFAULT 0,
  note       TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT UNIQUE NOT NULL,
  name               TEXT,
  password_hash      TEXT NOT NULL,
  password_salt      TEXT NOT NULL,
  -- Encrypted at rest (see src/secrets.js): a live Workana login.
  workana_cookies    TEXT,
  workana_name       TEXT,      -- display name detected from their session
  cookies_updated_at TEXT,
  cookies_valid      INTEGER,   -- last known state: 1 ok, 0 rejected, NULL untested
  is_admin           INTEGER DEFAULT 0,
  created_at         TEXT NOT NULL,
  last_login_at      TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

/*
 * The job corpus itself is shared — a posting is the same posting whoever fetched
 * it, and re-scraping it per account would multiply the load on Workana for no
 * gain. Everything that differs per person lives here instead: whether *you* bid,
 * whether the client contacted *you*, and your own stars, notes and hides.
 */
CREATE TABLE IF NOT EXISTS user_jobs (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_slug      TEXT NOT NULL,
  has_own_bid   INTEGER DEFAULT 0,
  was_contacted INTEGER DEFAULT 0,
  own_budget    TEXT,
  starred       INTEGER DEFAULT 0,
  hidden        INTEGER DEFAULT 0,
  note          TEXT,
  updated_at    TEXT,
  PRIMARY KEY (user_id, job_slug)
);

CREATE INDEX IF NOT EXISTS idx_user_jobs_user ON user_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  ok            INTEGER,
  pages         INTEGER DEFAULT 0,
  seen          INTEGER DEFAULT 0,
  inserted      INTEGER DEFAULT 0,
  updated       INTEGER DEFAULT 0,
  details       INTEGER DEFAULT 0,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_first_seen  ON jobs(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_published   ON jobs(published_approx_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_category    ON jobs(category_slug);
CREATE INDEX IF NOT EXISTS idx_jobs_hourly      ON jobs(is_hourly);
CREATE INDEX IF NOT EXISTS idx_jobs_client      ON jobs(client_id);
CREATE INDEX IF NOT EXISTS idx_reviews_client   ON client_reviews(client_id);
`);

/**
 * Adds a column when an existing database predates it. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so check the table info first.
 */
function addColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

// Insights-derived fields, added after the first release.
addColumn('jobs', 'contacts_count', 'INTEGER');
addColumn('jobs', 'pre_selected_count', 'INTEGER');
addColumn('jobs', 'insights_fetched_at', 'TEXT');
addColumn('scrape_runs', 'insights', 'INTEGER DEFAULT 0');
// "Last reply: 9 hours ago" from the list card — client responsiveness.
addColumn('jobs', 'last_reply_text', 'TEXT');
addColumn('jobs', 'last_reply_at', 'TEXT');
addColumn('scrape_runs', 'user_id', 'INTEGER');
// Per-member egress proxy: scraping happens on the server, so a remote member's
// Workana session would otherwise be driven from the host's IP, not their own.
addColumn('users', 'workana_proxy', 'TEXT');
for (const [col, decl] of [
  ['rating', 'REAL'],
  ['is_hero', 'INTEGER DEFAULT 0'],
  ['is_recommended', 'INTEGER DEFAULT 0'],
  ['is_favorite', 'INTEGER DEFAULT 0'],
  ['is_new', 'INTEGER DEFAULT 0'],
  ['in_contact', 'INTEGER DEFAULT 0'],
  ['pre_selected', 'INTEGER DEFAULT 0'],
  ['proposal_selected', 'INTEGER DEFAULT 0'],
  ['medals', 'TEXT'],
]) {
  addColumn('job_insights', col, decl);
}

/*
 * Migration: `published_at` used to be stored as a full ISO instant built from a
 * date-only string, i.e. local midnight, which reads as the future in any
 * timezone behind UTC. Collapse those back to the plain calendar date they
 * always meant. Idempotent -- converted values no longer contain a 'T'.
 */
db.exec(`UPDATE jobs SET published_at = date(published_at, 'localtime')
          WHERE published_at LIKE '%T%'`);

// Full-text search over title + summary + description + skills.
db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
  slug UNINDEXED, title, summary, description, skills, client,
  tokenize = 'unicode61 remove_diacritics 2'
);
`);

/** Rebuilds the FTS row for one job. FTS5 has no upsert, so delete-then-insert. */
const ftsDelete = db.prepare('DELETE FROM jobs_fts WHERE slug = ?');
const ftsInsert = db.prepare(
  'INSERT INTO jobs_fts (slug, title, summary, description, skills, client) VALUES (?, ?, ?, ?, ?, ?)',
);

export function reindex(slug) {
  const row = db
    .prepare(
      `SELECT j.slug, j.title, j.summary, j.description, j.skills, c.name AS client
         FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.slug = ?`,
    )
    .get(slug);
  if (!row) return;
  let skills = '';
  try {
    skills = JSON.parse(row.skills || '[]')
      .map((s) => s.name)
      .join(' ');
  } catch {}
  ftsDelete.run(slug);
  ftsInsert.run(row.slug, row.title || '', row.summary || '', row.description || '', skills, row.client || '');
}

export function upsertClient(client) {
  if (!client?.id) return null;
  db.prepare(
    `INSERT INTO clients (id, name, profile_url, avatar_url, country, country_code, rating, rating_count,
                          published_projects, projects_paid, hire_rate, payment_verified, member_since,
                          last_login, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name               = COALESCE(excluded.name, clients.name),
       profile_url        = COALESCE(excluded.profile_url, clients.profile_url),
       avatar_url         = COALESCE(excluded.avatar_url, clients.avatar_url),
       country            = COALESCE(excluded.country, clients.country),
       country_code       = COALESCE(excluded.country_code, clients.country_code),
       rating             = COALESCE(excluded.rating, clients.rating),
       rating_count       = COALESCE(excluded.rating_count, clients.rating_count),
       published_projects = COALESCE(excluded.published_projects, clients.published_projects),
       projects_paid      = COALESCE(excluded.projects_paid, clients.projects_paid),
       hire_rate          = COALESCE(excluded.hire_rate, clients.hire_rate),
       payment_verified   = MAX(excluded.payment_verified, clients.payment_verified),
       member_since       = COALESCE(excluded.member_since, clients.member_since),
       last_login         = COALESCE(excluded.last_login, clients.last_login),
       updated_at         = excluded.updated_at`,
  ).run(
    client.id,
    client.name ?? null,
    client.profileUrl ?? null,
    client.avatarUrl ?? null,
    client.country ?? null,
    client.countryCode ?? null,
    client.rating ?? null,
    client.ratingCount ?? null,
    client.publishedProjects ?? null,
    client.projectsPaid ?? null,
    client.hireRate ?? null,
    client.paymentVerified ? 1 : 0,
    client.memberSince ?? null,
    client.lastLogin ?? null,
    new Date().toISOString(),
  );
  return client.id;
}

const COALESCE_COLUMNS = [
  'published_text',
  'published_at',
  'summary',
  'description',
  'skills',
  'category',
  'category_slug',
  'subcategory',
  'subcategory_slug',
  'project_size',
  'project_duration',
  'language',
  'bids',
  'interested',
  'avg_bid_rate',
  'status_label',
  'bid_action_label',
  'client_id',
  'detail_fetched_at',
  // Refreshed whenever the card shows one; a later scrape that omits it keeps
  // the last known value rather than blanking it.
  'last_reply_text',
  'last_reply_at',
];

/**
 * Inserts or refreshes a job.
 *
 * Fields scraped from the list page are thinner than the detail page's, so an
 * update must never blank out a richer value with a null: every optional column
 * is COALESCEd against what is already stored. `first_seen_at` is likewise never
 * overwritten, because the UI's "new job" badge is built on it.
 */
export function upsertJob(job) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT slug FROM jobs WHERE slug = ?').get(job.slug);

  const sets = COALESCE_COLUMNS.map((c) => `${c} = COALESCE(excluded.${c}, jobs.${c})`).join(',\n       ');

  db.prepare(
    `INSERT INTO jobs (
       slug, url, title, published_text, published_at, published_approx_at, first_seen_at, last_seen_at,
       detail_fetched_at, budget_text, currency, budget_min, budget_max, is_hourly, budget_is_max,
       summary, description, skills, category, category_slug, subcategory, subcategory_slug,
       project_size, project_duration, language, bids, interested, avg_bid_rate, status_label,
       is_featured, is_max_highlighted, has_own_bid, bid_action_label, was_contacted, client_id, raw,
       last_reply_text, last_reply_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(slug) DO UPDATE SET
       url                = excluded.url,
       title              = excluded.title,
       last_seen_at       = excluded.last_seen_at,
       is_hourly          = excluded.is_hourly,
       budget_is_max      = excluded.budget_is_max,
       -- Keep the first estimate, but backfill it if we never managed to derive one.
       published_approx_at = COALESCE(jobs.published_approx_at, excluded.published_approx_at),
       -- Budget fields move as a unit: whichever source supplied a budget string
       -- also supplied its parse, so a COALESCE per-column would let a corrected
       -- parse (e.g. an open-ended "Over USD 3,000") keep a stale bound.
       budget_text = CASE WHEN excluded.budget_text IS NOT NULL THEN excluded.budget_text ELSE jobs.budget_text END,
       currency    = CASE WHEN excluded.budget_text IS NOT NULL THEN excluded.currency    ELSE jobs.currency    END,
       budget_min  = CASE WHEN excluded.budget_text IS NOT NULL THEN excluded.budget_min  ELSE jobs.budget_min  END,
       budget_max  = CASE WHEN excluded.budget_text IS NOT NULL THEN excluded.budget_max  ELSE jobs.budget_max  END,
       is_featured        = MAX(excluded.is_featured, jobs.is_featured),
       is_max_highlighted = MAX(excluded.is_max_highlighted, jobs.is_max_highlighted),
       has_own_bid        = MAX(excluded.has_own_bid, jobs.has_own_bid),
       was_contacted      = MAX(excluded.was_contacted, jobs.was_contacted),
       raw                = excluded.raw,
       ${sets}`,
  ).run(
    job.slug,
    job.url,
    job.title,
    job.publishedText ?? null,
    job.publishedAt ?? null,
    job.publishedApproxAt ?? null,
    now,
    now,
    job.detailFetchedAt ?? null,
    job.budgetText ?? null,
    job.currency ?? null,
    job.budgetMin ?? null,
    job.budgetMax ?? null,
    job.isHourly ? 1 : 0,
    job.budgetIsMax ? 1 : 0,
    job.summary ?? null,
    job.description ?? null,
    job.skills ? JSON.stringify(job.skills) : null,
    job.category ?? null,
    job.categorySlug ?? null,
    job.subcategory ?? null,
    job.subcategorySlug ?? null,
    job.projectSize ?? null,
    job.projectDuration ?? null,
    job.language ?? null,
    job.bids ?? null,
    job.interested ?? null,
    job.avgBidRate ?? null,
    job.statusLabel ?? null,
    job.isFeatured ? 1 : 0,
    job.isMaxHighlighted ? 1 : 0,
    job.hasOwnBid ? 1 : 0,
    job.bidActionLabel ?? null,
    job.wasContacted ? 1 : 0,
    job.clientId ?? null,
    JSON.stringify(job.raw ?? job),
    job.lastReplyText ?? null,
    job.lastReplyAt ?? null,
  );

  reindex(job.slug);
  return existing ? 'updated' : 'inserted';
}

export function saveClientReviews(clientId, jobSlug, reviews = []) {
  if (!clientId || reviews.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO client_reviews
       (client_id, job_slug, project_title, freelancer, freelancer_url, avatar_url, rating, age_text, comment)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of reviews) {
    stmt.run(
      clientId,
      jobSlug ?? null,
      r.projectTitle ?? null,
      r.freelancer ?? null,
      r.freelancerUrl ?? null,
      r.avatarUrl ?? null,
      r.rating ?? null,
      r.ageText ?? null,
      r.comment ?? null,
    );
  }
}

/**
 * Replaces the contender list for a job. It is a full replace rather than a
 * merge because a freelancer can drop off the shortlist, and a stale
 * "In contact" row would inflate the contact count shown in the list.
 */
export function saveInsights(jobSlug, data = {}) {
  const proposals = data.proposals ?? [];
  const now = new Date().toISOString();

  db.prepare('DELETE FROM job_insights WHERE job_slug = ?').run(jobSlug);

  const stmt = db.prepare(
    `INSERT INTO job_insights
       (job_slug, freelancer, profile_url, avatar_url, badge, ranking, projects_done, category_jobs,
        rehirings, is_self, proposal_state, own_budget, fetched_at,
        rating, is_hero, is_recommended, is_favorite, is_new, in_contact, pre_selected,
        proposal_selected, medals)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(job_slug, freelancer) DO NOTHING`,
  );

  for (const i of proposals) {
    const badge = i.isHero
      ? 'HERO'
      : i.isRecommended
        ? 'Recommended'
        : i.isFavorite
          ? 'Favorite'
          : i.isNew
            ? 'New'
            : null;
    stmt.run(
      jobSlug,
      i.freelancer,
      i.profileUrl ?? null,
      i.avatarUrl ?? null,
      badge,
      i.ranking ?? null,
      i.projectsDone ?? null,
      i.categoryJobs ?? null,
      i.rehirings ?? null,
      i.isSelf ? 1 : 0,
      i.proposalState ?? null,
      data.ownBudget ?? null,
      now,
      i.rating ?? null,
      i.isHero ? 1 : 0,
      // null means "Workana did not resolve this badge on that page" — distinct
      // from a definite false, so the UI can stay silent instead of lying.
      i.isRecommended === null ? null : i.isRecommended ? 1 : 0,
      i.isFavorite ? 1 : 0,
      i.isNew === null ? null : i.isNew ? 1 : 0,
      i.inContact ? 1 : 0,
      i.preSelected ? 1 : 0,
      i.proposalSelected ? 1 : 0,
      i.medals ?? null,
    );
  }

  db.prepare(
    `UPDATE jobs SET contacts_count = ?, pre_selected_count = ?, avg_bid_rate = COALESCE(?, avg_bid_rate),
                     insights_fetched_at = ?
      WHERE slug = ?`,
  ).run(
    data.contactsCount ?? proposals.filter((p) => p.inContact).length,
    data.preSelectedCount ?? proposals.filter((p) => p.preSelected).length,
    data.averageRate ?? null,
    now,
    jobSlug,
  );
}

/**
 * Records the part of a job that belongs to one person: whether they bid, whether
 * the client contacted them, and their stars/notes/hides. Boolean flags are
 * COALESCEd so a caller can update just one of them.
 */
export function upsertUserJob(userId, slug, fields = {}) {
  if (!userId || !slug) return;
  const bit = (v) => (v === undefined || v === null ? null : v ? 1 : 0);

  db.prepare(
    `INSERT INTO user_jobs (user_id, job_slug, has_own_bid, was_contacted, own_budget,
                            starred, hidden, note, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, job_slug) DO UPDATE SET
       has_own_bid   = COALESCE(excluded.has_own_bid,   user_jobs.has_own_bid),
       was_contacted = COALESCE(excluded.was_contacted, user_jobs.was_contacted),
       own_budget    = COALESCE(excluded.own_budget,    user_jobs.own_budget),
       starred       = COALESCE(excluded.starred,       user_jobs.starred),
       hidden        = COALESCE(excluded.hidden,        user_jobs.hidden),
       note          = COALESCE(excluded.note,          user_jobs.note),
       updated_at    = excluded.updated_at`,
  ).run(
    userId,
    slug,
    bit(fields.hasOwnBid),
    bit(fields.wasContacted),
    fields.ownBudget ?? null,
    bit(fields.starred),
    bit(fields.hidden),
    fields.note === undefined ? null : String(fields.note),
    new Date().toISOString(),
  );
}

/**
 * One-time hand-over of the pre-multi-user data. Before accounts existed, "did I
 * bid on this" lived on the jobs table and stars/notes lived in `user_flags`,
 * both implicitly belonging to whoever ran the scraper. When the instance owner
 * first registers, that history becomes theirs rather than being orphaned.
 */
export function adoptLegacyData(userId) {
  const legacyFlags = db.prepare('SELECT COUNT(*) n FROM user_flags').get().n;
  const legacyBids = db.prepare('SELECT COUNT(*) n FROM jobs WHERE has_own_bid = 1 OR was_contacted = 1').get().n;
  if (!legacyFlags && !legacyBids) return { flags: 0, bids: 0 };

  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    /*
     * The trailing `WHERE true` is required, not decorative: in an
     * INSERT ... SELECT ... ON CONFLICT, SQLite cannot tell whether "ON" opens a
     * join clause or the upsert, and reports `near "DO": syntax error`. A WHERE
     * clause closes the SELECT and resolves the ambiguity.
     */
    db.prepare(
      `INSERT INTO user_jobs (user_id, job_slug, has_own_bid, was_contacted, updated_at)
         SELECT ?, slug, has_own_bid, was_contacted, ?
           FROM jobs WHERE (has_own_bid = 1 OR was_contacted = 1)
       ON CONFLICT(user_id, job_slug) DO UPDATE SET
         has_own_bid   = MAX(user_jobs.has_own_bid, excluded.has_own_bid),
         was_contacted = MAX(user_jobs.was_contacted, excluded.was_contacted)`,
    ).run(userId, now);

    db.prepare(
      `INSERT INTO user_jobs (user_id, job_slug, starred, hidden, note, updated_at)
         SELECT ?, job_slug, COALESCE(starred,0), COALESCE(hidden,0), note, ?
           FROM user_flags WHERE true
       ON CONFLICT(user_id, job_slug) DO UPDATE SET
         starred = MAX(user_jobs.starred, excluded.starred),
         hidden  = MAX(user_jobs.hidden, excluded.hidden),
         note    = COALESCE(excluded.note, user_jobs.note)`,
    ).run(userId, now);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { flags: legacyFlags, bids: legacyBids };
}

export function startRun(userId = null) {
  const info = db
    .prepare('INSERT INTO scrape_runs (started_at, user_id) VALUES (?, ?)')
    .run(new Date().toISOString(), userId);
  return Number(info.lastInsertRowid);
}

export function finishRun(id, stats) {
  db.prepare(
    `UPDATE scrape_runs SET finished_at = ?, ok = ?, pages = ?, seen = ?, inserted = ?, updated = ?,
                            details = ?, insights = ?, error = ? WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    stats.ok ? 1 : 0,
    stats.pages ?? 0,
    stats.seen ?? 0,
    stats.inserted ?? 0,
    stats.updated ?? 0,
    stats.details ?? 0,
    stats.insights ?? 0,
    stats.error ?? null,
    id,
  );
}

export function lastRun() {
  return db.prepare('SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1').get();
}
