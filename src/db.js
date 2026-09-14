/**
 * Everything that reads or writes the corpus.
 *
 * All of it is async now, because the engine underneath may be Postgres — see
 * src/sql.js for why there are two and how one dialect is written for both.
 */
import { all, get, run, exec, insertReturning, isPostgres, connect } from './sql.js';
import { TABLES, SEARCH, LATE_COLUMNS, LATE_INDEXES } from './schema.js';
import { config } from './config.js';
import { parseWorkanaClock } from './scraper/parse.js';

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

/** True when `table` already has `column`, asked in whichever dialect applies. */
async function hasColumn(table, column) {
  if (isPostgres) {
    const row = await get(
      `SELECT 1 AS present FROM information_schema.columns
        WHERE table_name = ? AND column_name = ?`,
      [table, column],
    );
    return Boolean(row);
  }
  const cols = await all(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

/**
 * Brings the database up to date. Safe to run against an empty database, a
 * fully current one, or one that predates any of the columns added since.
 */
export async function initDatabase() {
  await connect();
  await exec(TABLES);
  await exec(SEARCH);

  for (const [table, column, decl] of LATE_COLUMNS) {
    if (await hasColumn(table, column)) continue;
    await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
  await exec(LATE_INDEXES);

  /*
   * A database that predates `seq` has it null everywhere, which would collapse
   * the list's numbering. SQLite can recover the original insertion order from
   * its own rowid; Postgres only ever sees rows that arrived with a seq.
   */
  if (!isPostgres) {
    await run('UPDATE jobs SET seq = rowid WHERE seq IS NULL');
  }

  /*
   * `published_at` was once stored as a full ISO instant built from a date-only
   * string — local midnight, which reads as the future in any timezone behind
   * UTC. Collapse those to the calendar date they always meant. Idempotent:
   * converted values no longer contain a 'T'.
   */
  await run(
    isPostgres
      ? `UPDATE jobs SET published_at = split_part(published_at, 'T', 1)
          WHERE published_at LIKE '%T%'`
      : `UPDATE jobs SET published_at = date(published_at, 'localtime')
          WHERE published_at LIKE '%T%'`,
  );

  /*
   * Rows migrated from SQLite arrive with their sequence already set, so the
   * identity generator has to be moved past them or the next insert collides.
   */
  if (isPostgres) {
    await run(`SELECT setval(
      pg_get_serial_sequence('jobs', 'seq'),
      GREATEST((SELECT COALESCE(MAX(seq), 0) FROM jobs), 1))`).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Full-text search                                                    */
/* ------------------------------------------------------------------ */

/**
 * Rebuilds the search row for one job.
 *
 * Only SQLite needs this: its FTS5 table is a separate index that has to be kept
 * in step by hand, and FTS5 has no upsert, hence delete-then-insert. On Postgres
 * the tsvector is a generated column of the row itself and is always correct, so
 * this is deliberately nothing.
 */
export async function reindex(slug) {
  if (isPostgres) return;

  const row = await get(
    `SELECT j.slug, j.title, j.summary, j.description, j.skills, c.name AS client
       FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.slug = ?`,
    [slug],
  );
  if (!row) return;

  let skills = '';
  try {
    skills = JSON.parse(row.skills || '[]')
      .map((s) => s.name)
      .join(' ');
  } catch {}

  await run('DELETE FROM jobs_fts WHERE slug = ?', [slug]);
  await run(
    `INSERT INTO jobs_fts (slug, title, summary, description, skills, client)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.slug, row.title || '', row.summary || '', row.description || '', skills, row.client || ''],
  );
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export async function upsertClient(client) {
  if (!client?.id) return null;
  await run(
    `INSERT INTO clients (id, name, profile_url, avatar_url, country, country_code, rating, rating_count,
                          published_projects, projects_paid, hire_rate, payment_verified, member_since,
                          last_login, last_login_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
       payment_verified   = GREATEST(excluded.payment_verified, clients.payment_verified),
       member_since       = COALESCE(excluded.member_since, clients.member_since),
       last_login         = COALESCE(excluded.last_login, clients.last_login),
       last_login_at      = COALESCE(excluded.last_login_at, clients.last_login_at),
       updated_at         = excluded.updated_at`,
    [
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
      parseWorkanaClock(client.lastLogin, config.workanaClockOffsetHours),
      new Date().toISOString(),
    ],
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
  'bid_action_url',
  'client_id',
  'detail_fetched_at',
  // Refreshed whenever the card shows one; a later scrape that omits it keeps
  // the last known value rather than blanking it.
  'last_reply_text',
  'last_reply_at',
];

const SETS = COALESCE_COLUMNS.map((c) => `${c} = COALESCE(excluded.${c}, jobs.${c})`).join(',\n       ');

/**
 * Inserts or refreshes a job.
 *
 * Fields scraped from the list page are thinner than the detail page's, so an
 * update must never blank out a richer value with a null: every optional column
 * is COALESCEd against what is already stored. `first_seen_at` is likewise never
 * overwritten, because the UI's "new job" badge is built on it.
 */
export async function upsertJob(job) {
  const now = new Date().toISOString();
  const existing = await get('SELECT slug FROM jobs WHERE slug = ?', [job.slug]);

  /*
   * `seq` backs the list's "#000123" and used to be SQLite's free `rowid`.
   * Postgres fills it from an identity generator, so the column is left out of
   * the insert entirely there; SQLite has to be told the next value.
   */
  const seqColumn = isPostgres ? '' : 'seq, ';
  const seqValue = isPostgres ? '' : '(SELECT COALESCE(MAX(seq), 0) + 1 FROM jobs), ';

  await run(
    `INSERT INTO jobs (
       ${seqColumn}slug, url, title, published_text, published_at, published_approx_at, first_seen_at, last_seen_at, last_listed_at,
       detail_fetched_at, budget_text, currency, budget_min, budget_max, is_hourly, budget_is_max,
       summary, description, skills, category, category_slug, subcategory, subcategory_slug,
       project_size, project_duration, language, bids, interested, avg_bid_rate, status_label,
       is_featured, is_max_highlighted, has_own_bid, bid_action_label, bid_action_url, was_contacted,
       client_id, raw, last_reply_text, last_reply_at
     ) VALUES (${seqValue}?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(slug) DO UPDATE SET
       url                = excluded.url,
       title              = excluded.title,
       last_seen_at       = excluded.last_seen_at,
       -- Only a list upsert carries this; a detail upsert must not refresh it.
       last_listed_at     = COALESCE(excluded.last_listed_at, jobs.last_listed_at),
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
       is_featured        = GREATEST(excluded.is_featured, jobs.is_featured),
       is_max_highlighted = GREATEST(excluded.is_max_highlighted, jobs.is_max_highlighted),
       has_own_bid        = GREATEST(excluded.has_own_bid, jobs.has_own_bid),
       was_contacted      = GREATEST(excluded.was_contacted, jobs.was_contacted),
       raw                = excluded.raw,
       ${SETS}`,
    [
      job.slug,
      job.url,
      job.title,
      job.publishedText ?? null,
      job.publishedAt ?? null,
      job.publishedApproxAt ?? null,
      now,
      now,
      job.listedAt ?? null,
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
      job.bidActionUrl ?? null,
      job.wasContacted ? 1 : 0,
      job.clientId ?? null,
      JSON.stringify(job.raw ?? job),
      job.lastReplyText ?? null,
      job.lastReplyAt ?? null,
    ],
  );

  await reindex(job.slug);
  return existing ? 'updated' : 'inserted';
}

export async function saveClientReviews(clientId, jobSlug, reviews = []) {
  if (!clientId || reviews.length === 0) return;
  for (const r of reviews) {
    // `INSERT OR IGNORE` is SQLite-only; the ON CONFLICT form works on both.
    await run(
      `INSERT INTO client_reviews
         (client_id, job_slug, project_title, freelancer, freelancer_url, avatar_url, rating, age_text, comment)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (client_id, project_title, freelancer, comment) DO NOTHING`,
      [
        clientId,
        jobSlug ?? null,
        r.projectTitle ?? null,
        r.freelancer ?? null,
        r.freelancerUrl ?? null,
        r.avatarUrl ?? null,
        r.rating ?? null,
        r.ageText ?? null,
        r.comment ?? null,
      ],
    );
  }
}

/**
 * Replaces the contender list for a job. It is a full replace rather than a
 * merge because a freelancer can drop off the shortlist, and a stale
 * "In contact" row would inflate the contact count shown in the list.
 */
export async function saveInsights(jobSlug, data = {}) {
  const proposals = data.proposals ?? [];
  const now = new Date().toISOString();

  await run('DELETE FROM job_insights WHERE job_slug = ?', [jobSlug]);

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
    await run(
      `INSERT INTO job_insights
         (job_slug, freelancer, profile_url, avatar_url, badge, ranking, projects_done, category_jobs,
          rehirings, is_self, proposal_state, own_budget, fetched_at,
          rating, is_hero, is_recommended, is_favorite, is_new, in_contact, pre_selected,
          proposal_selected, medals)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(job_slug, freelancer) DO NOTHING`,
      [
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
      ],
    );
  }

  await run(
    `UPDATE jobs SET contacts_count = ?, pre_selected_count = ?, avg_bid_rate = COALESCE(?, avg_bid_rate),
                     insights_fetched_at = ?
      WHERE slug = ?`,
    [
      data.contactsCount ?? proposals.filter((p) => p.inContact).length,
      data.preSelectedCount ?? proposals.filter((p) => p.preSelected).length,
      data.averageRate ?? null,
      now,
      jobSlug,
    ],
  );
}

/**
 * Records the part of a job that belongs to one person: whether they bid, whether
 * the client contacted them, and their stars/notes/hides. Boolean flags are
 * COALESCEd so a caller can update just one of them.
 */
export async function upsertUserJob(userId, slug, fields = {}) {
  if (!userId || !slug) return;
  const bit = (v) => (v === undefined || v === null ? null : v ? 1 : 0);

  await run(
    `INSERT INTO user_jobs (user_id, job_slug, has_own_bid, was_contacted, own_budget,
                            proposal_read, client_favorite, proposal_selected,
                            starred, hidden, note, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, job_slug) DO UPDATE SET
       has_own_bid   = COALESCE(excluded.has_own_bid,   user_jobs.has_own_bid),
       /*
        * COALESCE means "leave it alone if the caller said nothing". Passing an
        * explicit false still turns these off, which is what the insights page
        * needs: it states the client's current position, so a badge that goes
        * away has to be able to clear the flag.
        */
       was_contacted     = COALESCE(excluded.was_contacted, user_jobs.was_contacted),
       proposal_read     = COALESCE(excluded.proposal_read, user_jobs.proposal_read),
       client_favorite   = COALESCE(excluded.client_favorite, user_jobs.client_favorite),
       proposal_selected = COALESCE(excluded.proposal_selected, user_jobs.proposal_selected),
       own_budget    = COALESCE(excluded.own_budget,    user_jobs.own_budget),
       starred       = COALESCE(excluded.starred,       user_jobs.starred),
       hidden        = COALESCE(excluded.hidden,        user_jobs.hidden),
       note          = COALESCE(excluded.note,          user_jobs.note),
       updated_at    = excluded.updated_at`,
    [
      userId,
      slug,
      bit(fields.hasOwnBid),
      bit(fields.wasContacted),
      fields.ownBudget ?? null,
      bit(fields.proposalRead),
      bit(fields.clientFavorite),
      bit(fields.proposalSelected),
      bit(fields.starred),
      bit(fields.hidden),
      fields.note === undefined ? null : String(fields.note),
      new Date().toISOString(),
    ],
  );
}

/**
 * One-time hand-over of the pre-multi-user data. Before accounts existed, "did I
 * bid on this" lived on the jobs table and stars/notes lived in `user_flags`,
 * both implicitly belonging to whoever ran the scraper. When the instance owner
 * first registers, that history becomes theirs rather than being orphaned.
 */
export async function adoptLegacyData(userId) {
  const legacyFlags = (await get('SELECT COUNT(*) AS n FROM user_flags')).n;
  const legacyBids = (
    await get('SELECT COUNT(*) AS n FROM jobs WHERE has_own_bid = 1 OR was_contacted = 1')
  ).n;
  if (!legacyFlags && !legacyBids) return { flags: 0, bids: 0 };

  const now = new Date().toISOString();

  /*
   * The trailing `WHERE true` is required, not decorative: in an
   * INSERT ... SELECT ... ON CONFLICT, SQLite cannot tell whether "ON" opens a
   * join clause or the upsert, and reports `near "DO": syntax error`. A WHERE
   * clause closes the SELECT and resolves the ambiguity.
   */
  await run(
    `INSERT INTO user_jobs (user_id, job_slug, has_own_bid, was_contacted, updated_at)
       SELECT ?, slug, has_own_bid, was_contacted, ?
         FROM jobs WHERE (has_own_bid = 1 OR was_contacted = 1)
     ON CONFLICT(user_id, job_slug) DO UPDATE SET
       has_own_bid   = GREATEST(user_jobs.has_own_bid, excluded.has_own_bid),
       was_contacted = GREATEST(user_jobs.was_contacted, excluded.was_contacted)`,
    [userId, now],
  );

  await run(
    `INSERT INTO user_jobs (user_id, job_slug, starred, hidden, note, updated_at)
       SELECT ?, job_slug, COALESCE(starred,0), COALESCE(hidden,0), note, ?
         FROM user_flags WHERE true
     ON CONFLICT(user_id, job_slug) DO UPDATE SET
       starred = GREATEST(user_jobs.starred, excluded.starred),
       hidden  = GREATEST(user_jobs.hidden, excluded.hidden),
       note    = COALESCE(excluded.note, user_jobs.note)`,
    [userId, now],
  );

  return { flags: legacyFlags, bids: legacyBids };
}

/* ------------------------------------------------------------------ */
/* Scrape runs                                                         */
/* ------------------------------------------------------------------ */

export async function startRun(userId = null) {
  const id = await insertReturning(
    'INSERT INTO scrape_runs (started_at, user_id) VALUES (?, ?) RETURNING id',
    [new Date().toISOString(), userId],
  );
  return Number(id);
}

export async function finishRun(id, stats) {
  await run(
    `UPDATE scrape_runs SET finished_at = ?, ok = ?, pages = ?, seen = ?, inserted = ?, updated = ?,
                            details = ?, insights = ?, error = ?, complete = ? WHERE id = ?`,
    [
      new Date().toISOString(),
      stats.ok ? 1 : 0,
      stats.pages ?? 0,
      stats.seen ?? 0,
      stats.inserted ?? 0,
      stats.updated ?? 0,
      stats.details ?? 0,
      stats.insights ?? 0,
      stats.error ?? null,
      stats.complete ? 1 : 0,
      id,
    ],
  );
}

/*
 * Whether a job is still open, decided in one place.
 *
 * Two independent signals. The detail page states it outright once a project
 * is awarded -- "In progress", "Waiting for escrow" -- and any status other than
 * evaluating bids means the window has shut. The list states it by omission: a
 * job missing from the most recent *complete* walk of the list is no longer
 * listed, whether it was awarded, cancelled or withdrawn. Neither signal alone
 * catches everything: a status is only read once, and goes stale; absence needs
 * a complete walk to mean anything.
 *
 * Expects the jobs table aliased as `j`. With no complete walk recorded yet the
 * absence rule stays silent, so a fresh database hides nothing it cannot prove.
 */
export const LAST_COMPLETE_CRAWL = '(SELECT MAX(started_at) FROM scrape_runs WHERE complete = 1)';
export const CLOSED_SQL = `(
  (j.status_label IS NOT NULL AND j.status_label NOT LIKE 'Evaluat%'
     AND j.status_label NOT LIKE 'Avalia%' AND j.status_label NOT LIKE 'Evalua%')
  OR (${LAST_COMPLETE_CRAWL} IS NOT NULL
      AND (j.last_listed_at IS NULL OR j.last_listed_at < ${LAST_COMPLETE_CRAWL}))
)`;

/**
 * Deletes jobs that have been gone for long enough to be sure.
 *
 * Absence from a single walk is not proof: a posting can slide from page 40 to
 * 41 while the walk is between them, or a throttled page can end a walk early
 * without saying so. So a job is only deleted once it has been missing from the
 * last two complete walks. Anything a member has touched -- a bid, a contact, a
 * star, a note -- is kept regardless: it stops appearing on the board, but the
 * history behind the proposal statistics is not quietly thrown away.
 */
export async function pruneClosedJobs() {
  const walks = await all(
    'SELECT started_at FROM scrape_runs WHERE complete = 1 ORDER BY started_at DESC LIMIT 2',
  );
  if (walks.length < 2) return { deleted: 0, reason: 'needs two complete walks' };
  const olderWalk = walks[1].started_at;

  const doomed = (
    await all(
      `SELECT j.slug FROM jobs j
        WHERE (j.last_listed_at IS NULL OR j.last_listed_at < ?)
          AND NOT EXISTS (
            SELECT 1 FROM user_jobs uj
             WHERE uj.job_slug = j.slug
               AND (COALESCE(uj.has_own_bid, 0) = 1 OR COALESCE(uj.was_contacted, 0) = 1
                    OR COALESCE(uj.starred, 0) = 1 OR uj.note IS NOT NULL))`,
      [olderWalk],
    )
  ).map((r) => r.slug);

  for (const slug of doomed) {
    await run('DELETE FROM job_insights WHERE job_slug = ?', [slug]);
    await run('DELETE FROM user_jobs WHERE job_slug = ?', [slug]);
    if (!isPostgres) await run('DELETE FROM jobs_fts WHERE slug = ?', [slug]);
    await run('DELETE FROM jobs WHERE slug = ?', [slug]);
  }
  return { deleted: doomed.length };
}

export async function lastRun() {
  return get('SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1');
}

// The query helpers, re-exported so callers have one import for database work.
export { all, get, run, exec, insertReturning, tx, isPostgres, dialect, close } from './sql.js';
