/**
 * Extraction functions.
 *
 * The `pageExtract*` functions are serialised and run inside the browser, so they
 * must be self-contained (no imports, no closures over Node state). Everything
 * they return is plain JSON which the `normalise*` helpers below then clean up on
 * the Node side.
 */

/* ------------------------------------------------------------------ */
/* In-page extractors                                                  */
/* ------------------------------------------------------------------ */

export function pageExtractList() {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const abs = (href) => {
    if (!href) return null;
    try {
      return new URL(href, location.origin).toString();
    } catch {
      return null;
    }
  };

  /**
   * Each author button carries an escaped HTML popover with the richest client
   * data on the page (hire rate, last login, registration date). Parsing it via a
   * detached element is far more robust than regexing the escaped string.
   */
  const parsePopover = (html) => {
    if (!html) return {};
    const box = document.createElement('div');
    box.innerHTML = html;
    const t = box.textContent.replace(/\s+/g, ' ');
    const out = {};

    const rating = t.match(/Rating:\s*([\d.]+)\s*out of\s*([\d.]+)/i);
    if (rating) out.rating = parseFloat(rating[1]);

    const projects = t.match(/Published:\s*(\d+)\s*\/\s*Payments:\s*(\d+)\s*\(\s*([\d.]+)\s*%\s*\)/i);
    if (projects) {
      out.publishedProjects = parseInt(projects[1], 10);
      out.projectsPaid = parseInt(projects[2], 10);
      out.hireRate = parseFloat(projects[3]);
    }

    for (const span of box.querySelectorAll('span.date')) {
      const label = span.parentElement?.textContent || '';
      const exact = span.getAttribute('title');
      if (/Last login/i.test(label)) out.lastLogin = exact || span.textContent.trim();
      else if (/Registered since/i.test(label)) out.memberSince = span.textContent.trim();
    }

    const flag = box.querySelector('img.flag, span.flag');
    if (flag) {
      out.country = flag.getAttribute('title') || flag.getAttribute('alt') || null;
      const cls = [...flag.classList].find((c) => /^flag-[a-z]{2}$/i.test(c));
      if (cls) out.countryCode = cls.slice(5).toUpperCase();
    }
    const countryName = text(box.querySelector('.country-name'));
    if (countryName) out.country = countryName;

    return out;
  };

  const cards = [...document.querySelectorAll('.project-item')];

  return cards.map((card) => {
    const link = card.querySelector('.project-title a[href*="/job/"]');
    const href = link?.getAttribute('href') || '';
    const slug = (href.match(/\/job\/([^/?#]+)/) || [])[1] || null;

    const titleSpan = card.querySelector('.project-title a span[title]');
    const title = titleSpan?.getAttribute('title') || text(link);

    const cardText = card.textContent.replace(/\s+/g, ' ');

    // Client block
    const author = card.querySelector('.project-author');
    const profileLink = author?.querySelector('a[href*="/e/"]');
    const profileHref = profileLink?.getAttribute('href') || '';
    const clientId = (profileHref.match(/\/e\/([0-9a-f]+)/i) || [])[1] || null;
    const popoverBtn = author?.querySelector('button[data-content]');
    const popover = parsePopover(popoverBtn?.getAttribute('data-content'));

    const flagImg = author?.querySelector('.country img.flag, .country .flag');
    const flagClass = flagImg ? [...flagImg.classList].find((c) => /^flag-[a-z]{2}$/i.test(c)) : null;

    const starsBg = author?.querySelector('.rating .stars-bg');
    const starsTitle = starsBg?.getAttribute('title') || '';
    const starsFill = author?.querySelector('.rating .stars-fill');
    const widthPct = parseFloat((starsFill?.style?.width || '').replace('%', ''));

    /*
     * "Last reply: 9 hours ago" — how recently this client last answered anyone.
     * It sits in the client's block, not the project's, and the data bears that
     * out: it regularly predates the posting date, so it measures the client's
     * responsiveness in general rather than activity on this thread. Still one of
     * the better signals on the board — it separates clients who talk to
     * freelancers from ones who post and vanish. The label and the value are two
     * sibling spans, so read the last one rather than stripping the localised
     * label off the combined text.
     */
    const replyEl = author?.querySelector('.message-created');
    const replySpans = replyEl ? [...replyEl.querySelectorAll('span')] : [];
    const lastReplyText = replySpans.length
      ? text(replySpans[replySpans.length - 1])
      : text(replyEl)?.replace(/^[^:]*:\s*/, '') || null;

    return {
      slug,
      url: abs(href),
      title,
      publishedText: text(card.querySelector('.project-main-details .date')),
      bidsText: text(card.querySelector('.project-main-details .bids')),
      summary: text(card.querySelector('.project-details .text-expander-content'))
        ?.replace(/\s*\.\.\.\s*View more$/i, '')
        .trim(),
      budgetText: text(card.querySelector('.project-actions .budget .values span')),
      bidActionLabel: text(card.querySelector('.project-actions .btn-group a')),
      isFeatured: card.classList.contains('project-item-featured'),
      isMaxHighlighted: Boolean(card.querySelector('.icon-workana, .featured-block')),
      lastReplyText,
      // These live in dedicated spans; matching on card text would also hit the
      // popover markup and the description.
      wasContacted: Boolean(author?.querySelector('.bid')),
      paymentVerifiedOnCard: Boolean(author?.querySelector('.payment')),
      skills: [...card.querySelectorAll('.skills a.skill')].map((a) => ({
        name: text(a),
        slug: (a.getAttribute('href')?.match(/[?&]skills=([^&]+)/) || [])[1] || null,
      })),
      client: {
        id: clientId,
        name: text(author?.querySelector('.author-info span')) || text(popoverBtn),
        profileUrl: abs(profileHref),
        avatarUrl: author?.querySelector('.author-avatar img')?.getAttribute('src') || null,
        country: text(author?.querySelector('.country .country-name')) || popover.country || null,
        countryCode: flagClass ? flagClass.slice(5).toUpperCase() : popover.countryCode || null,
        rating:
          Number.isFinite(popover.rating)
            ? popover.rating
            : starsTitle.match(/([\d.]+)\s*of/)
              ? parseFloat(starsTitle.match(/([\d.]+)\s*of/)[1])
              : Number.isFinite(widthPct)
                ? (widthPct / 100) * 5
                : null,
        publishedProjects: popover.publishedProjects ?? null,
        projectsPaid: popover.projectsPaid ?? null,
        hireRate: popover.hireRate ?? null,
        memberSince: popover.memberSince ?? null,
        lastLogin: popover.lastLogin ?? null,
        paymentVerified: Boolean(author?.querySelector('.payment')),
      },
    };
  });
}

export function pageExtractDetail() {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const abs = (href) => {
    if (!href) return null;
    try {
      return new URL(href, location.origin).toString();
    } catch {
      return null;
    }
  };

  const root = document.querySelector('.project-view-v3') || document.body;

  // "Published on the September 04, 2026 in Admin Support"
  const header = text(root.querySelector('header#productName p.h4')) || '';
  const publishedMatch = header.match(/Published on the\s+(.+?)\s+in\s+(.+)$/i);

  // The taxonomy block is a single <p> of "Label <b>Value</b><br>" pairs.
  const meta = {};
  for (const p of root.querySelectorAll('.block-detail p')) {
    for (const b of p.querySelectorAll('b')) {
      const label = (b.previousSibling?.textContent || '').replace(/\s+/g, ' ').trim();
      if (label) meta[label.toLowerCase()] = text(b);
    }
  }

  const durationText = [...root.querySelectorAll('.block-detail p')]
    .map((p) => text(p))
    .find((t) => t && /^Project duration/i.test(t));

  // Hidden <h2> carries the machine-readable taxonomy: "admin-support / virtual-assistant-1"
  const slugPair = text(root.querySelector('.block-detail h2.hidden')) || '';
  const [categorySlug, subcategorySlug] = slugPair.split('/').map((s) => s.trim());

  const expander = root.querySelector('.block-detail .expander');

  // Sidebar "item-data" tiles: a number plus its label, or a plain sentence.
  const tiles = [...root.querySelectorAll('aside .item-data')].map((d) => ({
    value: text(d.querySelector('.h4')),
    label: text(d.querySelector('p:not(.h4)')),
    all: text(d),
  }));

  const findTile = (re) => tiles.find((t) => t.label && re.test(t.label));
  const activityTiles = [...root.querySelectorAll('aside article')].find((a) =>
    /Project activity/i.test(a.textContent),
  );
  const activity = activityTiles
    ? [...activityTiles.querySelectorAll('.item-data')].map((d) => ({
        value: text(d.querySelector('.h4')),
        label: text(d.querySelector('p:not(.h4)')),
      }))
    : [];

  const profileLink = root.querySelector('aside a[href*="/e/"]');
  const profileHref = profileLink?.getAttribute('href') || '';
  const starsFill = root.querySelector('aside .wk-user-info .stars-fill');
  const widthPct = parseFloat((starsFill?.style?.width || '').replace('%', ''));
  const flagEl = root.querySelector('aside .wk-user-info .flag');
  const flagClass = flagEl ? [...flagEl.classList].find((c) => /^flag-[a-z]{2}$/i.test(c)) : null;

  const bidBtn = root.querySelector('#bid_button');

  const reviews = [...root.querySelectorAll('section.client-ratings li')].map((li) => {
    const fill = li.querySelector('.stars-fill');
    const w = parseFloat((fill?.style?.width || '').replace('%', ''));
    const nameLink = li.querySelector('a.user-name');
    const paras = [...li.querySelectorAll('p')];
    return {
      projectTitle: text(li.querySelector('p.h5.bold')),
      freelancer: text(nameLink),
      freelancerUrl: abs(nameLink?.getAttribute('href')),
      avatarUrl: li.querySelector('img')?.getAttribute('src') || null,
      rating: Number.isFinite(w) ? (w / 100) * 5 : null,
      ageText: text(li.querySelector('.text-info')),
      comment: text(paras[paras.length - 1]) === text(li.querySelector('p.h5.bold')) ? null : text(paras[paras.length - 1]),
    };
  });

  return {
    title: text(root.querySelector('header#productName h1')),
    statusLabel: text(root.querySelector('header#productName .label')),
    publishedDateText: publishedMatch ? publishedMatch[1] : null,
    categoryFromHeader: publishedMatch ? publishedMatch[2] : null,
    budgetText: text(root.querySelector('.block-detail .budget')),
    description: expander ? expander.textContent.trim() : text(root.querySelector('.block-detail article')),
    category: meta['category'] || null,
    subcategory: meta['subcategory'] || null,
    projectSize: meta['project size'] || null,
    projectDuration: durationText ? durationText.replace(/^Project duration\s*/i, '').trim() : null,
    categorySlug: categorySlug || null,
    subcategorySlug: subcategorySlug || null,
    skills: [...root.querySelectorAll('.block-detail .skills a.skill')].map((a) => ({
      name: text(a),
      slug: (a.getAttribute('href')?.match(/[?&]skills=([^&]+)/) || [])[1] || null,
    })),
    isFeatured: Boolean(root.querySelector('aside .featured-block')),
    bidActionLabel: text(bidBtn),
    // Kept in sync with OWN_BID_LABEL below; this runs inside the page, where
    // module scope is not available.
    hasOwnBid: /improve|edit|melhorar|mejorar|ver\s+(propuesta|proposta)/i.test(text(bidBtn) || ''),
    bids: activity.find((a) => /bids/i.test(a.label || ''))?.value ?? null,
    interested: activity.find((a) => /interested/i.test(a.label || ''))?.value ?? null,
    client: {
      id: (profileHref.match(/\/e\/([0-9a-f]+)/i) || [])[1] || null,
      name: text(root.querySelector('aside a.user-name')),
      profileUrl: abs(profileHref),
      avatarUrl: root.querySelector('aside .wk-user-info img')?.getAttribute('src') || null,
      countryCode: flagClass ? flagClass.slice(5).toUpperCase() : null,
      rating: Number.isFinite(widthPct) ? (widthPct / 100) * 5 : null,
      publishedProjects: findTile(/Published projects/i)?.value ?? null,
      projectsPaid: findTile(/Projects paid/i)?.value ?? null,
      paymentVerified: /Verified payment method/i.test(root.querySelector('aside')?.textContent || ''),
      memberSince: (tiles.find((t) => /Member since/i.test(t.all || ''))?.all || '')
        .replace(/^Member since:\s*/i, '')
        .trim() || null,
    },
    reviews,
  };
}

/**
 * Project Insights: the freelancers competing for a job.
 *
 * The one thing that must not be done naively here is badge detection. Workana
 * renders *every* badge on *every* card and hides the inactive ones with an
 * inline `display: none`, so a `textContent` test marks all 20 contenders as
 * "In contact". Visibility has to be checked explicitly.
 */
export function pageExtractInsights() {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const abs = (href) => {
    if (!href) return null;
    try {
      return new URL(href, location.origin).toString();
    } catch {
      return null;
    }
  };
  const visible = (el) => Boolean(el) && el.style.display !== 'none' && el.offsetParent !== null;

  // "USD 644" sitting above the words "Average rate".
  let averageRate = null;
  for (const node of document.querySelectorAll('div, p, span')) {
    if (node.children.length > 4) continue;
    const t = text(node) || '';
    const m = t.match(/^([A-Z]{3}\s*[\d.,]+)\s*Average rate$/i);
    if (m) {
      averageRate = m[1].replace(/\s+/g, ' ').trim();
      break;
    }
  }

  const bodyText = document.body.innerText.replace(/\r/g, '');
  // "USD 400 / Your budget" — the panel Workana shows only to the freelancer who
  // bid, in whichever of the three languages the account is set to.
  const ownBudget = bodyText.match(
    /([A-Z]{3}\s*[\d.,]+)\s*\n\s*(?:your budget|tu presupuesto|seu or[çc]amento)/i,
  );

  const proposals = [];
  for (const card of document.querySelectorAll('.contender-card')) {
    const nameLink = card.querySelector('.user-name a[href*="/freelancer/"]');
    const freelancer = text(nameLink);
    if (!freelancer) continue;

    const badges = {};
    for (const b of card.querySelectorAll('.user-name .badge')) {
      const label = text(b);
      if (label) badges[label.toLowerCase()] = visible(b);
    }

    const starsBg = card.querySelector('.profile-stars .stars-bg');
    const ratingTitle = starsBg?.getAttribute('title') || '';
    const ratingMatch = ratingTitle.match(/([\d.]+)\s*of/);

    // "#2 in IT & Programming"
    const stat = text(card.querySelector('.stat'));

    // Three "<value> <label>" tiles: projects worked on / <category> projects / rehirings.
    const tiles = [...card.querySelectorAll('.bid-profile-item-container .item-data')].map((d) => ({
      value: parseInt((text(d.querySelector('.value')) || '').replace(/[^\d]/g, ''), 10),
      label: (text(d) || '').replace(/^\d[\d,]*\s*/, '').toLowerCase(),
    }));
    const tile = (re) => {
      const hit = tiles.find((t) => re.test(t.label));
      return hit && Number.isFinite(hit.value) ? hit.value : null;
    };

    proposals.push({
      freelancer,
      profileUrl: abs(nameLink.getAttribute('href')),
      avatarUrl: card.querySelector('.profile-photo img')?.getAttribute('src') || null,
      isHero: Boolean(card.querySelector('.hero-label')) || card.classList.contains('hero'),
      isRecommended: Boolean(badges['recommended']),
      isFavorite: Boolean(badges['favorite']),
      isNew: Boolean(badges['new']),
      inContact: Boolean(badges['in contact']),
      proposalSelected: Boolean(badges['proposal selected']),
      preSelected: Boolean(badges['pre-selected'] || badges['preselected']),
      rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
      ranking: stat && /^#/.test(stat) ? stat : null,
      projectsDone: tile(/projects worked on/),
      categoryJobs: tile(/projects$/) ?? tile(/ projects/),
      rehirings: tile(/rehiring/),
      medals: [...card.querySelectorAll('.medals .profile-badge')]
        .map((m) => m.getAttribute('title'))
        .filter(Boolean)
        .join('; ') || null,
      isSelf: false,
    });
  }

  /*
   * Mark the viewer's own proposal. The name sits on the line above a "Proposal
   * sent" status, localised like everything else here. Matching only the English
   * wording is why this never once fired against a Spanish or Portuguese board.
   */
  const self = bodyText.match(
    /([^\n]+?)\s*\n\s*(?:proposal sent|propuesta enviada|proposta enviada)/i,
  );
  if (self) {
    const me = self[1].trim();
    for (const p of proposals) if (p.freelancer === me) p.isSelf = true;
  }

  /*
   * On some projects Workana never computes the per-freelancer standing badges
   * and leaves "New" (and sometimes "Recommended") switched on for the whole
   * list -- HEROes with 179 completed projects included. A badge that is true
   * for effectively everyone carries no information, so rather than assert
   * something visibly false we record it as unknown for that page. "In contact",
   * "Favorite" and "Proposal selected" are always resolved properly and are
   * never blanked.
   */
  const degenerate = (key) => {
    if (proposals.length < 5) return false;
    return proposals.filter((p) => p[key]).length / proposals.length >= 0.9;
  };
  for (const key of ['isNew', 'isRecommended']) {
    if (degenerate(key)) for (const p of proposals) p[key] = null;
  }

  return {
    averageRate,
    ownBudget: ownBudget ? ownBudget[1].replace(/\s+/g, ' ').trim() : null,
    proposals,
    contactsCount: proposals.filter((p) => p.inContact).length,
    preSelectedCount: proposals.filter((p) => p.preSelected).length,
  };
}

/* ------------------------------------------------------------------ */
/* Node-side normalisation                                             */
/* ------------------------------------------------------------------ */

const NUM = (v) => {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const INT = (v) => {
  const n = NUM(v);
  return n === null ? null : Math.round(n);
};

/**
 * Workana budget strings seen in the wild:
 *   "USD 1,000 - 3,000"          fixed range
 *   "USD 15 - 45 / hour"         hourly range
 *   "Less than USD 15 / hour"    open-ended lower bracket
 *   "More than USD 5,000"        open-ended upper bracket
 *   "USD 500"                    single value
 */
export function parseBudget(raw) {
  const out = {
    budgetText: raw ? raw.replace(/\s+/g, ' ').trim() : null,
    currency: null,
    budgetMin: null,
    budgetMax: null,
    isHourly: false,
    budgetIsMax: false,
  };
  if (!out.budgetText) return out;

  const text = out.budgetText;
  out.isHourly = /\/\s*hour|por hora|\/\s*hora/i.test(text);

  const cur = text.match(/\b([A-Z]{3})\b/);
  if (cur) out.currency = cur[1];

  const numbers = (text.match(/[\d][\d.,]*/g) || [])
    .map((n) => Number(n.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));

  if (/less than|menos de|menos que/i.test(text)) {
    out.budgetMax = numbers[0] ?? null;
    out.budgetIsMax = true;
  } else if (/more than|over|m[aá]s de|mais de|acima de/i.test(text)) {
    // Open-ended upper bracket: "Over USD 3,000" has a floor but no ceiling.
    out.budgetMin = numbers[0] ?? null;
    out.budgetMax = null;
  } else if (numbers.length >= 2) {
    out.budgetMin = numbers[0];
    out.budgetMax = numbers[1];
  } else if (numbers.length === 1) {
    out.budgetMin = out.budgetMax = numbers[0];
  }

  return out;
}

const UNITS = {
  second: 1e3,
  minute: 60e3,
  hour: 3600e3,
  day: 86400e3,
  week: 604800e3,
  month: 2592000e3,
  year: 31536000e3,
};

/**
 * "Published: 3 days ago" / "hace 2 horas" / "Yesterday" -> approximate ISO timestamp.
 * Workana mixes relative counts with bare day words, so both forms are handled.
 */
export function parseRelative(text, now = Date.now()) {
  if (!text) return null;
  const t = text.toLowerCase();

  if (/just now|seconds? ago|hace unos segundos|agora|ahora/.test(t)) return new Date(now).toISOString();
  if (/^today\b|\bhoy\b|\bhoje\b/.test(t)) return new Date(now).toISOString();
  if (/^yesterday\b|\bayer\b|\bontem\b/.test(t)) return new Date(now - UNITS.day).toISOString();

  /*
   * "Last month" is Workana's wording once a posting ages past a few weeks, and
   * it carries no digit for the numeric branch below to find. Left unparsed the
   * job ends up with no date at all, and the board then falls back to when *we*
   * collected it -- which reads as "posted minutes ago" for a project that is
   * actually months old. One unit back is an approximation, but a truthful one.
   */
  const last = t.match(/\blast\s+(week|month|year)\b/);
  if (last) return new Date(now - UNITS[last[1]]).toISOString();
  if (/\bsemana\s+(pasada|passada)\b/.test(t)) return new Date(now - UNITS.week).toISOString();
  if (/\bm[eê]s\s+(pasado|passado)\b/.test(t)) return new Date(now - UNITS.month).toISOString();
  if (/\ba[nñ]o\s+(pasado|passado)\b/.test(t)) return new Date(now - UNITS.year).toISOString();

  // "an hour ago" / "a day ago" carry an article rather than a digit.
  const article = t.match(/\ban?\s+(minute|hour|day|week|month|year)\b/);
  if (article) return new Date(now - UNITS[article[1]]).toISOString();

  const m = t.match(
    /(\d+)\s*(second|sec|minute|min|hour|hora|day|d[ií]a|week|semana|month|m[eê]s|mes|year|a[nñ]o)/i,
  );
  if (!m) return null;

  const n = parseInt(m[1], 10);
  const word = m[2];
  let unit =
    /sec/.test(word) ? 'second'
    : /min/.test(word) ? 'minute'
    : /hour|hora/.test(word) ? 'hour'
    : /day|d[ií]a/.test(word) ? 'day'
    : /week|semana/.test(word) ? 'week'
    : /month|m[eê]s|mes/.test(word) ? 'month'
    : /year|a[nñ]o/.test(word) ? 'year'
    : null;

  if (!unit) return null;
  return new Date(now - n * UNITS[unit]).toISOString();
}

/**
 * "September 04, 2026" -> "2026-09-04".
 *
 * Deliberately date-only: Workana states just a calendar date, and turning that
 * into an instant would silently pick local midnight, which in a UTC-behind
 * timezone lands in the future and makes fresh jobs read as "just now".
 */
export function parseAbsoluteDate(text) {
  if (!text) return null;
  const d = new Date(text.replace(/^the\s+/i, ''));
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The bid button's label is what betrays that this account already bid: it reads
 * "Place a bid" to everyone else and "Improve proposal" to the bidder. Workana
 * serves the board in three languages, so all three wordings are matched.
 *
 * Deliberately absent: "Go to messages", which replaces the button once a
 * conversation exists. A client can open one by inviting a freelancer who never
 * bid, so it proves contact, not a proposal — that is what `wasContacted` is for.
 */
export const OWN_BID_LABEL = /improve|edit|melhorar|mejorar|ver\s+(propuesta|proposta)/i;

/** Turns a raw list card into the shape `upsertJob` expects. */
export function normaliseListJob(raw, now = Date.now()) {
  const budget = parseBudget(raw.budgetText);
  const publishedText = (raw.publishedText || '').replace(/^Published:\s*/i, '').trim() || null;

  return {
    slug: raw.slug,
    url: raw.url,
    title: raw.title,
    publishedText,
    publishedApproxAt: parseRelative(publishedText, now),
    lastReplyText: raw.lastReplyText || null,
    lastReplyAt: parseRelative(raw.lastReplyText, now),
    summary: raw.summary || null,
    bids: INT((raw.bidsText || '').replace(/^Bids:\s*/i, '')),
    skills: raw.skills?.filter((s) => s.name) ?? [],
    isFeatured: Boolean(raw.isFeatured),
    isMaxHighlighted: Boolean(raw.isMaxHighlighted),
    wasContacted: Boolean(raw.wasContacted),
    bidActionLabel: raw.bidActionLabel || null,
    hasOwnBid: OWN_BID_LABEL.test(raw.bidActionLabel || ''),
    clientId: raw.client?.id || null,
    client: raw.client?.id
      ? {
          ...raw.client,
          rating: NUM(raw.client.rating),
          publishedProjects: INT(raw.client.publishedProjects),
          projectsPaid: INT(raw.client.projectsPaid),
          hireRate: NUM(raw.client.hireRate),
        }
      : null,
    ...budget,
    raw,
  };
}

/** Merges detail-page data on top of what the list gave us. */
export function normaliseDetail(raw) {
  const budget = parseBudget(raw.budgetText);
  return {
    title: raw.title || null,
    statusLabel: raw.statusLabel || null,
    publishedAt: parseAbsoluteDate(raw.publishedDateText),
    description: raw.description || null,
    category: raw.category || raw.categoryFromHeader || null,
    categorySlug: raw.categorySlug || null,
    subcategory: raw.subcategory || null,
    subcategorySlug: raw.subcategorySlug || null,
    projectSize: raw.projectSize || null,
    projectDuration: raw.projectDuration || null,
    skills: raw.skills?.filter((s) => s.name) ?? [],
    isFeatured: Boolean(raw.isFeatured),
    bidActionLabel: raw.bidActionLabel || null,
    hasOwnBid: Boolean(raw.hasOwnBid),
    bids: INT(raw.bids),
    interested: INT(raw.interested),
    clientId: raw.client?.id || null,
    client: raw.client?.id
      ? {
          ...raw.client,
          rating: NUM(raw.client.rating),
          publishedProjects: INT(raw.client.publishedProjects),
          projectsPaid: INT(raw.client.projectsPaid),
          hireRate:
            INT(raw.client.publishedProjects) > 0
              ? (INT(raw.client.projectsPaid) / INT(raw.client.publishedProjects)) * 100
              : null,
        }
      : null,
    reviews: raw.reviews?.filter((r) => r.freelancer || r.projectTitle) ?? [],
    ...budget,
  };
}
