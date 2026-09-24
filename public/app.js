/* Workana job board — client. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  search: '',
  type: '',
  sort: 'newest',
  country: new Set(),
  category: new Set(),
  skill: new Set(),
  starred: false,
  verified: false,
  noBids: false,
  notBid: false,
  hasContacts: false,
  noContacts: false,
  hasReply: false,
  hasHired: false,
  repliedWithin: '',
  clientSeen: '',
  showClosed: false,
  myBid: false,
  myRead: false,
  myFavourite: false,
  myContact: false,
  noMyContact: false,
  minBudget: '',
  maxBudget: '',
  maxBids: '',
  since: '',
  limit: 100,
  offset: 0,
};

let facets = { categories: [], countries: [], skills: [] };

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * Country flag as an <img>. Regional-indicator emoji are not an option: Windows
 * ships no flag glyphs, so they render as bare letter pairs ("ZA").
 */
function flagImg(code) {
  if (!code || code.length !== 2) return '<span class="flag-none">·</span>';
  const c = code.toLowerCase();
  return `<img class="flag-img" src="https://flagcdn.com/24x18/${c}.png" width="18" height="13.5" alt="${esc(code)}" loading="lazy">`;
}

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Compact "Sep 04 09:12" for the single-line columns. */
function shortStamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fullStamp = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * The relative estimate is preferred over `published_at`, which Workana states
 * only to the day — ordering by it would flatten everything posted today into a
 * single timestamp.
 */
const postedAt = (j) => j.published_approx_at || j.published_at || j.first_seen_at;

/**
 * Whether that timestamp is Workana's or ours. When neither published field
 * survives parsing the fallback above is our own collection time, and showing
 * that as "Posted" turns a months-old project into a brand-new one — which is
 * exactly how a job whose client last replied 14 days ago can appear to have
 * been posted four minutes ago. Such rows show Workana's own wording instead.
 */
const hasPostedDate = (j) => Boolean(j.published_approx_at || j.published_at);

const money = (n) => (n === null || n === undefined ? '' : n.toLocaleString('en-US'));

/**
 * Compact budget for the table column, built from the parsed numbers rather than
 * Workana's prose. "Less than USD 50" and "USD 1,000 - 3,000" are far too wide to
 * sit in a column; "< $50" and "$1,000–3,000" carry the same information. The
 * hourly/fixed tag beside it already says which, so "/ hour" is dropped.
 */
function shortBudget(job) {
  const sym = job.currency === 'USD' ? '$' : job.currency ? `${job.currency} ` : '';
  const { budget_min: min, budget_max: max } = job;

  if (min === null && max === null) return job.budget_text || 'Not specified';
  if (job.budget_is_max) return `< ${sym}${money(max)}`;
  if (min !== null && max === null) return `> ${sym}${money(min)}`;
  if (min === max) return `${sym}${money(min)}`;
  return `${sym}${money(min)}–${money(max)}`;
}

const stars = (r) => {
  if (r === null || r === undefined) return '';
  const full = Math.round(r);
  return '★'.repeat(full) + '☆'.repeat(Math.max(0, 5 - full));
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

/** Minimal Markdown renderer — Workana descriptions are frequently Markdown. */
function markdown(src) {
  const lines = String(src || '').split('\n');
  let html = '';
  let list = null;

  const inline = (s) =>
    esc(s)
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

  const closeList = () => {
    if (list) { html += `</${list}>`; list = null; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { closeList(); html += `<h3>${inline(heading[2])}</h3>`; continue; }
    if (/^([-*_])\1{2,}$/.test(line.trim())) { closeList(); html += '<hr>'; continue; }

    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inline(ul[1])}</li>`;
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inline(ol[1])}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

function queryString() {
  const p = new URLSearchParams();
  const add = (k, v) => { if (v !== '' && v !== false && v != null) p.set(k, v); };
  add('search', state.search);
  add('type', state.type);
  add('sort', state.sort);
  add('limit', state.limit);
  add('offset', state.offset);
  add('minBudget', state.minBudget);
  add('maxBudget', state.maxBudget);
  add('maxBids', state.maxBids);
  add('since', state.since);
  add('repliedWithin', state.repliedWithin);
  add('clientSeen', state.clientSeen);
  for (const k of ['verified', 'noBids', 'notBid', 'starred', 'hasContacts', 'noContacts', 'hasReply', 'hasHired',
    'myContact', 'noMyContact', 'myBid', 'myRead', 'myFavourite', 'showClosed'])
    if (state[k]) p.set(k, '1');
  if (state.country.size) p.set('country', [...state.country].join(','));
  if (state.category.size) p.set('category', [...state.category].join(','));
  if (state.skill.size) p.set('skill', [...state.skill].join(','));
  return p.toString();
}

/** A 401 anywhere means the session lapsed; drop back to the sign-in gate. */
function handleAuthLoss(res) {
  if (res.status !== 401) return false;
  clearInterval(statusTimer);
  me = null;
  mode = 'login';
  renderGate();
  showGate(true);
  return true;
}

async function load() {
  const res = await fetch(`/api/jobs?${queryString()}`);
  if (handleAuthLoss(res)) return;
  const data = await res.json();
  if (data.error) return toast(data.error);
  render(data);
}

async function loadFacets() {
  const res = await fetch('/api/facets');
  if (handleAuthLoss(res)) return;
  facets = await res.json();
  buildFacet('category', facets.categories.filter((c) => c.slug).map((c) => ({ key: c.slug, label: c.name, n: c.n })));
  buildFacet('country', facets.countries.map((c) => ({ key: c.code, label: c.name, icon: flagImg(c.code), n: c.n })));
  buildFacet('skill', facets.skills.map((s) => ({ key: s.slug, label: s.name, n: s.n })));
}

/* ------------------------------------------------------------------ */
/* Rendering — one line per job                                        */
/* ------------------------------------------------------------------ */

function render(data) {
  $('#cAll').textContent = data.counts.all_count ?? 0;
  $('#cHourly').textContent = data.counts.hourly ?? 0;
  $('#cFixed').textContent = data.counts.fixed ?? 0;

  const from = data.total === 0 ? 0 : data.offset + 1;
  $('#resultCount').textContent = data.total
    ? `${from}–${Math.min(data.offset + data.limit, data.total)} of ${data.total}`
    : 'no results';

  const tbody = $('#rows');
  tbody.replaceChildren();
  $('#empty').hidden = data.jobs.length > 0;
  for (const job of data.jobs) tbody.appendChild(rowFor(job));

  renderChips();
  renderPager(data);
}

function rowFor(job) {
  const tr = el('tr');
  tr.dataset.slug = job.slug;
  if (job.has_own_bid) tr.classList.add('mine');

  const posted = postedAt(job);
  const dated = hasPostedDate(job);
  const ageMin = dated ? (Date.now() - new Date(posted).getTime()) / 60000 : Infinity;

  /* # */
  const tdNo = el('td');
  tdNo.appendChild(el('span', 'j-no', String(job.no).padStart(6, '0')));
  tr.appendChild(tdNo);

  /* Posted */
  const tdPosted = el('td');
  // Relative, like LAST REPLY beside it — "15m ago" answers "is this still warm?"
  // faster than a date does. The exact stamp stays one hover away.
  const pt = dated
    ? el('span', `j-time${ageMin < 60 ? ' fresh' : ''}`, timeAgo(posted))
    : el('span', 'j-time j-time-guess', job.published_text || '—');
  pt.title = dated
    ? `Posted ${fullStamp(posted)}`
    : `Workana gave no date we could read${job.published_text ? ` — it said “${job.published_text}”` : ''}. ` +
      `Ordered by when we collected it, ${fullStamp(job.first_seen_at)}.`;
  tdPosted.appendChild(pt);
  tr.appendChild(tdPosted);

  /* Last reply — how recently the client answered anyone on this project */
  const tdReply = el('td');
  if (job.last_reply_at) {
    const hrs = (Date.now() - new Date(job.last_reply_at).getTime()) / 3600e3;
    const cls = hrs <= 24 ? 'hot' : hrs <= 72 ? 'warm' : '';
    const r = el('span', `j-reply ${cls}`, timeAgo(job.last_reply_at));
    r.title = `Client last replied ${fullStamp(job.last_reply_at)}`;
    tdReply.appendChild(r);
  } else {
    const r = el('span', 'j-reply none', '—');
    r.title = 'No client reply shown on this project';
    tdReply.appendChild(r);
  }
  tr.appendChild(tdReply);

  /* Title */
  const tdTitle = el('td');
  const wrap = el('div', 'j-title');
  if (job.is_featured) {
    const m = el('span', 'mark', '🏆');
    m.title = "Workana's selection";
    wrap.appendChild(m);
  }
  const tx = el('span', 'tx', job.title);
  tx.title = job.title;
  wrap.appendChild(tx);
  if (job.has_own_bid) wrap.appendChild(el('span', 'tag mine', '✓ bid'));
  /*
   * Contact is a step past bidding, and the two are shown together: a bid with a
   * reply is not the same row as a bid into silence. Next to the bid tag the
   * envelope carries the meaning on its own, so the words are dropped and only
   * a standalone contact keeps them.
   */
  if (job.was_contacted) {
    const t = el('span', 'tag contacted', '✉ contacted');
    t.title = 'The client has opened contact with you on this project';
    wrap.appendChild(t);
  }
  /*
   * Read but no contact is the other state worth seeing: the proposal landed and
   * was opened, and the client has not written. Shown only when it is not already
   * superseded by contact.
   */
  if (job.proposal_read && !job.was_contacted) {
    const t = el('span', 'tag read', '👁 read');
    t.title = 'The client opened your proposal but has not made contact';
    wrap.appendChild(t);
  }
  tdTitle.appendChild(wrap);
  tr.appendChild(tdTitle);

  /* Budget */
  const tdBudget = el('td');
  const bw = el('div', 'j-budget');
  const kind = el('span', `tag ${job.is_hourly ? 'hourly' : 'fixed'}`, job.is_hourly ? 'HR' : 'FIX');
  kind.title = job.is_hourly ? 'Hourly rate' : 'Fixed price';
  bw.appendChild(kind);
  const amt = el('span', `amt${job.budget_text ? '' : ' none'}`, shortBudget(job));
  // The full Workana wording stays available on hover.
  amt.title = job.budget_text || 'Not specified';
  bw.appendChild(amt);
  tdBudget.appendChild(bw);
  tr.appendChild(tdBudget);

  /* Client — who is actually posting this */
  const tdCli = el('td');
  const cliw = el('div', 'j-cli');
  cliw.innerHTML =
    `<img class="j-cli-av" src="${esc(job.client_avatar_url || AVATAR_PLACEHOLDER)}" ` +
    `alt="" loading="lazy" onerror="${AVATAR_FALLBACK}">` +
    `<span class="nm">${esc(job.client_name || 'Unknown')}</span>`;
  cliw.title = job.client_name
    ? `${job.client_name}${job.client_country ? ` · ${job.client_country}` : ''}` +
      (job.client_published ? ` · ${job.client_published} project(s) posted` : '')
    : 'Workana did not name this client';
  tdCli.appendChild(cliw);
  tr.appendChild(tdCli);

  /* Country */
  const tdCountry = el('td');
  const cw = el('div', 'j-country');
  cw.innerHTML = `${flagImg(job.client_country_code)}<span class="cn">${esc(job.client_country || '—')}</span>`;
  cw.title = job.client_name ? `${job.client_name} · ${job.client_country || 'unknown'}` : '';
  tdCountry.appendChild(cw);
  tr.appendChild(tdCountry);

  /* Hire rate — does this client actually pay anyone? */
  const tdClient = el('td');
  const published = job.client_published;
  const paid = job.client_paid;
  const rate = job.client_hire_rate;

  let cls = 'none';
  let pct = '—';
  if (rate !== null && rate !== undefined && published) {
    pct = `${Math.round(rate)}%`;
    cls = rate >= 50 ? 'good' : rate > 0 ? 'mid' : 'never';
  }

  const cl = el('div', `j-client ${cls}`);
  cl.appendChild(el('span', 'pct', pct));
  if (published) cl.appendChild(el('span', 'ratio', `${paid ?? 0}/${published}`));
  if (job.client_verified) {
    const v = el('span', 'verified', '✓');
    v.title = 'Payment method verified';
    cl.appendChild(v);
  }
  cl.title = published
    ? `${job.client_name || 'Client'} paid ${paid ?? 0} of ${published} projects posted` +
      (job.client_verified ? ' · payment method verified' : '')
    : 'No project history for this client yet';
  tdClient.appendChild(cl);
  tr.appendChild(tdClient);

  /* Bids */
  const bids = job.bids ?? 0;
  const tdBids = el('td', 'c-num');
  tdBids.appendChild(el('span', `num ${bids === 0 ? 'zero' : bids > 30 ? 'busy' : ''}`, String(bids)));
  tr.appendChild(tdBids);

  /* Contacts — freelancers the client is in contact with (Workana's own flag) */
  const tdContacts = el('td', 'c-num');
  if (job.insights_fetched_at) {
    const n = job.contacts_count ?? 0;
    const c = el('span', `num ${n > 0 ? 'contact' : 'none'}`, String(n));
    c.title = n ? `${n} freelancer(s) in contact with the client` : 'Nobody contacted yet';
    tdContacts.appendChild(c);
  } else {
    const c = el('span', 'num pending', '·');
    c.title = 'Contact data not collected yet — open the job to fetch it';
    tdContacts.appendChild(c);
  }
  tr.appendChild(tdContacts);

  /* Actions */
  const tdAct = el('td');
  const acts = el('div', 'j-act');

  const star = el('button', job.starred ? 'starred' : '', job.starred ? '★' : '☆');
  star.title = 'Star';
  star.onclick = async (e) => {
    e.stopPropagation();
    const r = await fetch(`/api/flags/${job.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: !job.starred }),
    }).then((x) => x.json());
    job.starred = r.starred;
    star.textContent = r.starred ? '★' : '☆';
    star.className = r.starred ? 'starred' : '';
  };
  acts.appendChild(star);

  const open = el('button', '', '↗');
  open.title = 'Open on Workana';
  open.onclick = (e) => { e.stopPropagation(); window.open(job.url, '_blank', 'noopener'); };
  acts.appendChild(open);

  const hide = el('button', '', '⨯');
  hide.title = 'Hide';
  hide.onclick = async (e) => {
    e.stopPropagation();
    await fetch(`/api/flags/${job.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: true }),
    });
    tr.remove();
    toast('Hidden');
  };
  acts.appendChild(hide);

  tdAct.appendChild(acts);
  tr.appendChild(tdAct);

  tr.onclick = () => openDrawer(job.slug, tr);
  return tr;
}

function renderPager(data) {
  const pager = $('#pager');
  pager.replaceChildren();
  if (data.total <= data.limit) return;

  const prev = el('button', 'btn', '← Previous');
  prev.disabled = data.offset === 0;
  prev.onclick = () => { state.offset = Math.max(0, state.offset - state.limit); load(); scrollTo(0, 0); };

  const next = el('button', 'btn', 'Next →');
  next.disabled = data.offset + data.limit >= data.total;
  next.onclick = () => { state.offset += state.limit; load(); scrollTo(0, 0); };

  const from = data.offset + 1;
  pager.append(prev, el('span', 'info', `${from}–${Math.min(data.offset + data.limit, data.total)} of ${data.total}`), next);
}

/* ------------------------------------------------------------------ */
/* Filter rail                                                         */
/* ------------------------------------------------------------------ */

const FACET_NAME = { category: 'Category', country: 'Country', skill: 'Skill' };

function buildFacet(name, items) {
  const box = document.querySelector(`[data-facet="${name}"]`);
  const list = box.querySelector('[data-list]');
  const search = box.querySelector('[data-search]');

  const paint = (filter = '') => {
    list.replaceChildren();
    const f = filter.toLowerCase();
    const matched = items.filter((i) => !f || i.label.toLowerCase().includes(f));
    // Selected entries stay visible even when they fall outside the top slice.
    const shown = [...matched.filter((i) => state[name].has(i.key)),
                   ...matched.filter((i) => !state[name].has(i.key))].slice(0, 120);

    for (const it of shown) {
      const row = el('label', 'facet-item');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = state[name].has(it.key);
      cb.onchange = () => {
        cb.checked ? state[name].add(it.key) : state[name].delete(it.key);
        updateFacetCount(name);
        reload();
      };
      const nm = el('span', 'nm');
      if (it.icon) nm.innerHTML = `${it.icon} ${esc(it.label)}`;
      else nm.textContent = it.label;
      row.append(cb, nm, el('span', 'n', it.n));
      list.appendChild(row);
    }
  };

  if (search) search.oninput = () => paint(search.value);
  box._paint = paint;
  paint(search?.value || '');
  updateFacetCount(name);
}

function updateFacetCount(name) {
  const n = state[name].size;
  document.querySelector(`[data-facet="${name}"] [data-selected]`).textContent = n ? `(${n})` : '';
}

function renderChips() {
  const box = $('#chips');
  box.replaceChildren();

  const add = (label, onRemove) => {
    const chip = el('span', 'chip');
    chip.appendChild(el('span', 't', label));
    const b = el('button', '', '×');
    b.onclick = onRemove;
    chip.appendChild(b);
    box.appendChild(chip);
  };

  const nameOf = (arr, key, k = 'slug') => arr.find((x) => x[k] === key)?.name || key;

  for (const c of state.category)
    add(nameOf(facets.categories, c), () => { state.category.delete(c); updateFacetCount('category'); repaint('category'); reload(); });
  for (const c of state.country)
    add(nameOf(facets.countries, c, 'code'), () => { state.country.delete(c); updateFacetCount('country'); repaint('country'); reload(); });
  for (const s of state.skill)
    add(nameOf(facets.skills, s), () => { state.skill.delete(s); updateFacetCount('skill'); repaint('skill'); reload(); });

  const toggles = [
    ['starred', '★ Starred'],
    ['verified', 'Payment verified'],
    ['noBids', 'No bids yet'],
    ['notBid', 'Not bid by me'],
    ['hasContacts', 'Client contacting someone'],
    ['noContacts', 'Nobody contacted'],
    ['hasReply', 'Client has replied'],
    ['hasHired', 'Client has hired before'],
  ];
  for (const [key, label] of toggles) {
    if (!state[key]) continue;
    add(label, () => { state[key] = false; $(`#${key}`).checked = false; reload(); });
  }
  if (state.since)
    add(`Within ${$('#since').selectedOptions[0].textContent}`, () => { state.since = ''; $('#since').value = ''; reload(); });
  for (const [key, label] of [
    ['showClosed', 'Including awarded / closed'],
    ['myBid', '✓ Bid by me'],
    ['myRead', '👁 Proposal read'],
    ['myFavourite', '★ Client favourited me'],
    ['myContact', '✉ The client contacted me'],
    ['noMyContact', 'No contact from the client yet'],
  ]) {
    if (state[key]) add(label, () => { state[key] = false; $(`#${key}`).checked = false; reload(); });
  }
  if (state.clientSeen)
    add(`Client online ${$('#clientSeen').selectedOptions[0].textContent.toLowerCase()}`, () => {
      state.clientSeen = ''; $('#clientSeen').value = ''; reload();
    });
  if (state.repliedWithin)
    add(`Replied ${$('#repliedWithin').selectedOptions[0].textContent}`, () => {
      state.repliedWithin = ''; $('#repliedWithin').value = ''; reload();
    });
  if (state.minBudget) add(`≥ $${state.minBudget}`, () => { state.minBudget = ''; $('#minBudget').value = ''; reload(); });
  if (state.maxBudget) add(`≤ $${state.maxBudget}`, () => { state.maxBudget = ''; $('#maxBudget').value = ''; reload(); });
  if (state.maxBids) add(`≤ ${state.maxBids} bids`, () => { state.maxBids = ''; $('#maxBids').value = ''; reload(); });
  if (state.search) add(`"${state.search}"`, () => { state.search = ''; $('#search').value = ''; reload(); });
}

function repaint(name) {
  const box = document.querySelector(`[data-facet="${name}"]`);
  box?._paint?.(box.querySelector('[data-search]')?.value || '');
}

/* ------------------------------------------------------------------ */
/* Drawer                                                              */
/* ------------------------------------------------------------------ */

async function openDrawer(slug, tr) {
  document.querySelectorAll('tr.is-open').forEach((r) => r.classList.remove('is-open'));
  tr?.classList.add('is-open');

  const drawer = $('#drawer');
  drawer.hidden = false;
  $('#backdrop').hidden = false;
  drawer.innerHTML = '<div class="drawer-body">Loading…</div>';

  let data = await (await fetch(`/api/jobs/${slug}`)).json();
  if (data.error) { drawer.innerHTML = `<div class="drawer-body">${esc(data.error)}</div>`; return; }
  drawer.innerHTML = drawerHtml(data);
  wireDrawer(drawer, data);
  drawer.scrollTop = 0;

  // Contact data is what makes this view worth opening, so fetch it on demand
  // the first time a job is viewed rather than making the user ask.
  if (!data.job.insights_fetched_at) {
    const btn = drawer.querySelector('[data-insights]');
    if (btn) { btn.disabled = true; btn.textContent = 'Fetching contacts…'; }
    try {
      const got = await requestInsights(slug);
      if (!got.ok) {
        // Quietly: this runs on every open, and a toast each time the scraper
        // is offline would be noise. The button says why instead.
        if (btn) { btn.disabled = false; btn.textContent = '⚡ Fetch contacts'; btn.title = got.message; }
        return;
      }
      data = await (await fetch(`/api/jobs/${slug}`)).json();
      drawer.innerHTML = drawerHtml(data);
      wireDrawer(drawer, data);
      load();
    } catch {
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Fetch contacts'; }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Browser alerts for new postings                                     */
/* ------------------------------------------------------------------ */

/*
 * Being among the first to bid is much of what wins a project, so the board can
 * say when a new posting that fits your filters arrives -- a desktop
 * notification and a short chime -- instead of relying on someone watching it.
 *
 * It works while the board is open in a tab, including a background one. The
 * switch is remembered per browser, which is also where the permission lives,
 * so localStorage is the right home for it.
 */
const ALERTS_KEY = 'wk.alerts';
let alertsOn = false;
/** `first_seen_at` of the newest job already accounted for. */
let alertCursor = null;
const alerted = new Set();
let audio = null;
let unseen = 0;
const baseTitle = document.title;

function readAlertPref() {
  try { return localStorage.getItem(ALERTS_KEY) === '1'; } catch { return false; }
}
function writeAlertPref(on) {
  try { localStorage.setItem(ALERTS_KEY, on ? '1' : '0'); } catch { /* private window */ }
}

function paintAlertsBtn() {
  const btn = $('#alertsBtn');
  if (!btn) return;
  const blocked = !('Notification' in window) || Notification.permission === 'denied';
  btn.classList.toggle('btn-go', alertsOn);
  btn.querySelector('.ico').textContent = alertsOn ? '🔔' : '🔕';
  btn.title = !alertsOn
    ? 'Get a notification and a chime when a new job matching your filters appears'
    : blocked
      ? 'Alerts are on, but this browser blocks notifications for the site, so only the chime plays. Click to turn off.'
      : 'Alerts are on: a notification and a chime for each new job matching your filters. Click to turn off.';
}

/** Counts from now, so switching alerts on does not announce the whole board. */
async function resetAlertCursor() {
  try {
    const data = await (await fetch('/api/jobs?sort=discovered&limit=1&showClosed=1')).json();
    alertCursor = data.jobs?.[0]?.first_seen_at || new Date(0).toISOString();
  } catch {
    alertCursor = new Date().toISOString();
  }
}

/** A short two-note chime, made on the spot so there is no sound file to ship. */
function chime() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    [880, 1320].forEach((freq, i) => {
      const at = t + i * 0.18;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.17);
    });
  } catch { /* no audio available */ }
}

/*
 * Browsers only let a page make sound after the person has interacted with it.
 * With alerts remembered from an earlier visit there has been no click yet, so
 * the first interaction of any kind unlocks the chime.
 */
for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, () => {
    try { audio ??= new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch { /* ignore */ }
  }, { once: true });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { unseen = 0; document.title = baseTitle; }
});

function announce(jobs) {
  chime();
  if (document.hidden) {
    unseen += jobs.length;
    document.title = `(${unseen}) ${baseTitle}`;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const first = jobs[0];
  const title = jobs.length === 1
    ? `New job: ${first.title}`
    : `${jobs.length}${jobs.length >= 20 ? '+' : ''} new jobs on Workana`;
  const body = jobs.length === 1
    ? [first.budget_text, first.client_country].filter(Boolean).join(' · ')
    : jobs.slice(0, 3).map((j) => `• ${j.title}`).join('\n');
  const n = new Notification(title, { body, tag: 'workana-new-jobs', renotify: true });
  n.onclick = () => {
    window.focus();
    if (jobs.length === 1) openDrawer(first.slug);
    n.close();
  };
}

/**
 * Asks for jobs first collected since the last check that match the filters as
 * they are set right now, and announces any not announced before.
 */
async function checkNewJobs() {
  if (!alertsOn || !alertCursor) return;
  const p = new URLSearchParams(queryString());
  for (const k of ['sort', 'limit', 'offset']) p.delete(k);
  p.set('sort', 'discovered');
  p.set('limit', '20');
  p.set('seenAfter', alertCursor);
  let data;
  try {
    const res = await fetch(`/api/jobs?${p}`);
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  const jobs = data.jobs || [];
  for (const j of jobs) if (j.first_seen_at > alertCursor) alertCursor = j.first_seen_at;
  const fresh = jobs.filter((j) => !alerted.has(j.slug));
  if (!fresh.length) return;
  for (const j of fresh) alerted.add(j.slug);
  announce(fresh);
}

$('#alertsBtn').onclick = async () => {
  if (alertsOn) {
    alertsOn = false;
    writeAlertPref(false);
    paintAlertsBtn();
    toast('Alerts off');
    return;
  }
  /*
   * "From now" is fixed first, before anything that can take a while: the
   * permission prompt waits on a person, and a job arriving meanwhile must
   * still be announced rather than counted as already seen.
   */
  // The button answers at once; announcing starts once the cursor is set
  // (checkNewJobs() waits for it).
  alertsOn = true;
  writeAlertPref(true);
  paintAlertsBtn();
  await resetAlertCursor();
  // This click is the gesture browsers require before a page may make sound.
  // Not awaited: starting audio can be slow, and nothing here depends on it.
  try { audio ??= new (window.AudioContext || window.webkitAudioContext)(); audio.resume().catch(() => {}); } catch { /* ignore */ }
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  paintAlertsBtn();
  const granted = 'Notification' in window && Notification.permission === 'granted';
  toast(granted
    ? 'Alerts on: you will be told when a new job matching your filters appears'
    : 'Notifications are blocked for this site, so alerts will only chime. Allow them in the browser to see them.');
  chime(); // so the sound is recognisable when it matters
};

/**
 * Asks the scraper's machine for one job's insights.
 *
 * The board has no browser of its own, so the answer can be a refusal (the
 * scraper is offline) or "still working" (202) as well as success. Reporting
 * "Contacts updated" whatever came back used to hide both.
 */
async function requestInsights(slug) {
  const res = await fetch(`/api/insights/${slug}`, { method: 'POST' });
  if (res.ok && res.status !== 202) return { ok: true };
  const body = await res.json().catch(() => ({}));
  return { ok: false, message: body.error || `Could not fetch contacts (${res.status})` };
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#backdrop').hidden = true;
  document.querySelectorAll('tr.is-open').forEach((r) => r.classList.remove('is-open'));
}

/**
 * Workana's own slug form: lower case, accents stripped, everything else a
 * hyphen. "Hiyashi Kari" becomes "hiyashi-kari".
 */
const slugifyName = (name) =>
  String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * The conversation with the client about this job.
 *
 * Workana addresses a thread as /inbox/<job slug>/<your handle>, both of which
 * are already known — so the link is built rather than waiting for a scrape to
 * observe it. A stored href is preferred only when it is an inbox link itself:
 * the same button reads "Improve proposal" on some jobs and points at the
 * proposal form, which is not what this button promises.
 */
function messagesUrl(job) {
  if (/\/inbox\//.test(job.bid_action_url || '')) return job.bid_action_url;
  const handle = slugifyName(me?.workanaName);
  return handle
    ? `https://www.workana.com/inbox/${encodeURIComponent(job.slug)}/${handle}`
    : 'https://www.workana.com/messages';
}

/** The whole job as plain text, for the drawer's Copy details button. */
function jobAsText({ job, insights = [] }) {
  const contacted = insights.filter((p) => p.in_contact);
  const line = (label, value) => (value === null || value === undefined || value === '' ? null : `${label}: ${value}`);
  // `skills` arrives already parsed from the API, as [{name, slug}].
  const skills = (job.skills || []).map((s) => s.name);

  return [
    job.title,
    '',
    line('Posted', hasPostedDate(job) ? fullStamp(postedAt(job)) : job.published_text || 'unknown'),
    line('Budget', job.budget_text || shortBudget(job)),
    line('Type', job.is_hourly ? 'Hourly' : 'Fixed price'),
    line('Category', [job.category, job.subcategory].filter(Boolean).join(' › ')),
    line('Project size', job.project_size),
    line('Duration', job.project_duration),
    line('Skills', skills.join(', ')),
    '',
    line('Bids', job.bids ?? 0),
    line('Interested', job.interested),
    line('In contact', job.contacts_count ?? contacted.length),
    line('Average bid', job.avg_bid_rate),
    line('Status', job.status_label),
    line('Last client reply', job.last_reply_at ? `${timeAgo(job.last_reply_at)} (${fullStamp(job.last_reply_at)})` : 'none'),
    '',
    'CLIENT',
    line('Name', job.client_name),
    line('Country', job.client_country),
    line('Rating', job.client_rating ? `${Number(job.client_rating).toFixed(2)} / 5` : 'no feedback yet'),
    line('Hire rate', job.client_hire_rate === null || job.client_hire_rate === undefined
      ? null
      : `${Math.round(job.client_hire_rate)}% (${job.client_paid ?? 0} paid of ${job.client_published ?? 0} posted)`),
    line('Payment method', job.client_verified ? 'verified' : 'not verified'),
    line('Profile', job.client_profile_url),
    contacted.length
      ? `\nIN CONTACT WITH\n${contacted
          .map(
            (p) =>
              `- ${p.freelancer}${p.rating ? ` · ${Number(p.rating).toFixed(2)}★` : ''}` +
              `${p.projects_done ? ` · ${p.projects_done} done` : ''}${p.ranking ? ` · ${p.ranking}` : ''}`,
          )
          .join('\n')}`
      : null,
    job.description ? `\nDESCRIPTION\n${job.description}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

function kv(label, value, big) {
  if (value === null || value === undefined || value === '') return '';
  return `<div class="kv"><label>${esc(label)}</label><div class="v${big ? ' big' : ''}">${value}</div></div>`;
}

/*
 * Placeholder shown when a freelancer's avatar 404s. Fully percent-encoded: a
 * `<` escape inside this string would survive as a literal backslash into
 * the HTML attribute and break the data URI.
 */
const AVATAR_PLACEHOLDER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
      '<rect width="40" height="40" fill="#dfe3ea"/>' +
      '<circle cx="20" cy="15" r="7" fill="#aeb6c2"/>' +
      '<path d="M6 40c0-8 7-13 14-13s14 5 14 13" fill="#aeb6c2"/></svg>',
  );
const AVATAR_FALLBACK = `this.onerror=null;this.src='${AVATAR_PLACEHOLDER}'`;

/** One competing/contacted freelancer. */
function personHtml(p) {
  const cls = p.in_contact ? 'contacted' : p.is_self ? 'self' : '';
  const badges = [
    p.in_contact ? '<span class="badge-s contact">In contact</span>' : '',
    p.proposal_selected ? '<span class="badge-s sel">Selected</span>' : '',
    p.is_hero ? '<span class="badge-s hero">HERO</span>' : '',
    p.is_recommended ? '<span class="badge-s rec">Recommended</span>' : '',
    p.is_favorite ? '<span class="badge-s fav">Favorite</span>' : '',
    p.is_new ? '<span class="badge-s new">New</span>' : '',
    p.is_self ? '<span class="badge-s sel">You</span>' : '',
  ].join('');

  return `<div class="person ${cls}">
    <img class="person-av" src="${esc(p.avatar_url || '')}" alt="${esc(p.freelancer)}" loading="lazy" onerror="${AVATAR_FALLBACK}">
    <div class="person-main">
      <div class="person-name">
        ${p.profile_url ? `<a href="${esc(p.profile_url)}" target="_blank" rel="noopener">${esc(p.freelancer)}</a>` : esc(p.freelancer)}
        ${badges}
      </div>
      <div class="person-meta">
        ${p.rating ? `<span class="stars">${stars(p.rating)}</span> ${p.rating.toFixed(2)}` : '<span>No rating</span>'}
        ${p.ranking ? `<span>${esc(p.ranking)}</span>` : ''}
        ${p.medals ? `<span title="${esc(p.medals)}">🏅</span>` : ''}
      </div>
    </div>
    <div class="person-stats">
      <div class="person-stat"><div class="n">${p.projects_done ?? '—'}</div><div class="l">Done</div></div>
      <div class="person-stat"><div class="n">${p.category_jobs ?? '—'}</div><div class="l">In cat.</div></div>
      <div class="person-stat"><div class="n">${p.rehirings ?? '—'}</div><div class="l">Rehired</div></div>
    </div>
  </div>`;
}

function drawerHtml({ job, reviews, insights, otherJobs }) {
  const contacted = insights.filter((p) => p.in_contact);
  const others = insights.filter((p) => !p.in_contact);

  const contactedHtml = contacted.length
    ? `<div class="people">${contacted.map(personHtml).join('')}</div>`
    : job.insights_fetched_at
      ? '<p class="hint">The client has not contacted any freelancer on this project yet.</p>'
      : '<p class="hint">Contact data not collected yet.</p>';

  const othersHtml = others.length
    ? `<div class="people">${others.slice(0, 20).map(personHtml).join('')}</div>`
    : '';

  const skills = (job.skills || []).map((s) => `<span class="skill-tag">${esc(s.name)}</span>`).join(' ');

  const reviewHtml = reviews.length
    ? reviews
        .map(
          (r) => `<div class="review">
            <div class="review-title">${esc(r.project_title || 'Untitled project')}</div>
            <div class="review-meta">
              <span class="stars">${stars(r.rating)}</span>
              ${r.freelancer ? `<span>${esc(r.freelancer)}</span>` : ''}
              ${r.age_text ? `<span>· ${esc(r.age_text)}</span>` : ''}
            </div>
            ${r.comment ? `<div class="review-body">${esc(r.comment)}</div>` : ''}
          </div>`,
        )
        .join('')
    : '<p class="hint">No feedback history captured yet.</p>';

  const otherJobsHtml = otherJobs.length
    ? `<table class="mini-table"><tbody>${otherJobs
        .map(
          (o) => `<tr data-goto="${esc(o.slug)}" style="cursor:pointer">
            <td>${esc(o.title)}</td><td>${esc(o.budget_text || '')}</td>
            <td>${o.bids ?? 0} bids</td><td>${esc(o.published_text || '')}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '';

  const posted = postedAt(job);

  return `
  <div class="drawer-head">
    <button class="drawer-close" data-close>×</button>
    <h2>${esc(job.title)}</h2>
    <div class="drawer-sub">
      No. ${String(job.no).padStart(6, '0')} · posted ${esc(hasPostedDate(job) ? timeAgo(posted) : job.published_text || 'at an unknown date')} · collected ${esc(timeAgo(job.first_seen_at))}
      ${job.status_label ? ` · ${esc(job.status_label)}` : ''}
    </div>
    <div class="drawer-tools">
      <span class="pill">${job.is_hourly ? 'Hourly' : 'Fixed price'}</span>
      ${job.category ? `<span class="pill">${esc(job.category)}</span>` : ''}
      ${job.subcategory ? `<span class="pill">${esc(job.subcategory)}</span>` : ''}
      ${job.is_featured ? '<span class="pill gold">🏆 Workana\'s selection</span>' : ''}
      ${job.is_closed ? '<span class="pill closed">⛔ Awarded or closed — no longer listed</span>' : ''}
      ${job.has_own_bid ? '<span class="pill mine">✓ You bid on this</span>' : ''}
      ${job.was_contacted ? '<span class="pill mine">✉ The client has contacted you</span>' : ''}
      ${job.proposal_read ? '<span class="pill">👁 Proposal read</span>' : ''}
      ${job.client_favorite ? '<span class="pill">★ Marked favourite by the client</span>' : ''}
      ${job.proposal_selected ? '<span class="pill mine">✓ Proposal selected</span>' : ''}
      ${contacted.length ? `<span class="pill hot">${contacted.length} in contact</span>` : ''}
      <a class="btn btn-primary" href="${esc(job.url)}" target="_blank" rel="noopener">Open on Workana ↗</a>
      ${
        /*
         * Once you have bid, the useful next action is the conversation, not
         * the posting. See messagesUrl() for how that link is worked out.
         */
        job.has_own_bid
          ? `<a class="btn btn-go" href="${esc(messagesUrl(job))}"
                target="_blank" rel="noopener">💬 Go to messages ↗</a>`
          : '<button class="btn" data-copy>📋 Copy details</button>'
      }
      <button class="btn" data-star>${job.starred ? '★ Starred' : '☆ Star'}</button>
      <button class="btn" data-insights>⚡ Refresh contacts</button>
    </div>
  </div>

  <div class="drawer-body">
    <div class="section">
      <h3>Freelancers the client is in contact with</h3>
      ${contactedHtml}
    </div>

    <div class="section">
      <h3>Activity</h3>
      <div class="kv-grid">
        ${kv('Bids', job.bids ?? 0, true)}
        ${kv('Interested', job.interested)}
        ${kv('In contact', job.contacts_count ?? (job.insights_fetched_at ? 0 : null))}
        ${kv('Pre-selected', job.pre_selected_count)}
        ${kv('Average bid', esc(job.avg_bid_rate))}
        ${kv('Budget', esc(job.budget_text || '—'))}
        ${kv(
          'Last client reply',
          job.last_reply_at
            ? `${esc(timeAgo(job.last_reply_at))}<span style="color:var(--text-mute)"> · ${esc(fullStamp(job.last_reply_at))}</span>`
            : '<span style="color:var(--text-mute)">No reply yet</span>',
        )}
        ${kv('Project size', esc(job.project_size))}
        ${kv('Duration', esc(job.project_duration))}
        ${kv(
          'Posted',
          hasPostedDate(job)
            ? `${esc(shortStamp(posted))}${job.published_text ? ` (${esc(job.published_text)})` : ''}`
            : `<span style="color:var(--text-mute)">${esc(job.published_text || 'Unknown')} — no exact date</span>`,
        )}
        ${kv('Collected', esc(fullStamp(job.first_seen_at)))}
        ${kv('Status', esc(job.status_label))}
      </div>
    </div>

    <div class="section">
      <h3>Client</h3>
      <div class="kv-grid">
        ${kv('Name', `${flagImg(job.client_country_code)} ${esc(job.client_name || 'Unknown')}`, true)}
        ${kv('Country', esc(job.client_country))}
        ${kv('Rating', job.client_rating ? `<span class="stars">${stars(job.client_rating)}</span> ${job.client_rating.toFixed(2)}` : 'No feedback yet')}
        ${kv('Payment method', job.client_verified ? '<span style="color:var(--green)">✓ Verified</span>' : 'Not verified')}
        ${kv('Projects published', job.client_published)}
        ${kv('Projects paid', job.client_paid)}
        ${kv('Hire rate', job.client_hire_rate != null ? `${Math.round(job.client_hire_rate)}%` : null)}
        ${kv('Member since', esc(job.client_member_since))}
        ${kv(
          'Last online',
          job.client_last_login_at
            ? `${esc(timeAgo(job.client_last_login_at))}<span style="color:var(--text-mute)"> · ${esc(fullStamp(job.client_last_login_at))}</span>`
            : esc(job.client_last_login),
        )}
        ${kv('Profile', job.client_profile_url ? `<a href="${esc(job.client_profile_url)}" target="_blank" rel="noopener">View ↗</a>` : null)}
      </div>
    </div>

    <div class="section">
      <h3>Description</h3>
      <div class="desc">${job.description ? markdown(job.description) : `<p>${esc(job.summary || 'Not fetched yet.')}</p>`}</div>
    </div>

    ${skills ? `<div class="section"><h3>Skills (${(job.skills || []).length})</h3><div class="job-skills">${skills}</div></div>` : ''}

    ${othersHtml ? `<div class="section"><h3>Other bidders (${others.length})</h3>${othersHtml}</div>` : ''}

    <div class="section"><h3>Client's feedback history</h3>${reviewHtml}</div>

    ${otherJobsHtml ? `<div class="section"><h3>Other projects from this client</h3>${otherJobsHtml}</div>` : ''}

    <div class="section">
      <h3>Your notes</h3>
      <textarea class="note-box" data-note placeholder="Private notes — stored locally only.">${esc(job.note || '')}</textarea>
      <div style="margin-top:8px"><button class="btn" data-save-note>Save note</button></div>
    </div>
  </div>`;
}

function wireDrawer(drawer, data) {
  const job = data.job;
  drawer.querySelector('[data-close]').onclick = closeDrawer;

  drawer.querySelector('[data-star]').onclick = async (e) => {
    const r = await fetch(`/api/flags/${job.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: !job.starred }),
    }).then((x) => x.json());
    job.starred = r.starred;
    e.target.textContent = r.starred ? '★ Starred' : '☆ Star';
    load();
  };

  drawer.querySelector('[data-save-note]').onclick = async () => {
    await fetch(`/api/flags/${job.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: drawer.querySelector('[data-note]').value }),
    });
    toast('Note saved');
  };

  /*
   * Everything worth pasting into a proposal draft, in one go: what the job
   * asks for, what the client is like, and who you are up against. Plain text
   * rather than JSON because it is going into a message or a notes file.
   */
  const copyBtn = drawer.querySelector('[data-copy]');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const text = jobAsText(data);
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => (copyBtn.textContent = '📋 Copy details'), 2000);
      } catch {
        // Clipboard access needs a secure context and can be refused outright;
        // selecting the text is the fallback that always works.
        const box = document.createElement('textarea');
        box.value = text;
        box.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(box);
        box.select();
        const ok = document.execCommand?.('copy');
        box.remove();
        toast(ok ? 'Copied to clipboard' : 'Could not copy — check clipboard permissions');
      }
    };
  }

  const btn = drawer.querySelector('[data-insights]');
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    try {
      const got = await requestInsights(job.slug);
      if (!got.ok) {
        toast(got.message);
        btn.disabled = false;
        btn.textContent = '⚡ Refresh contacts';
        return;
      }
      const fresh = await (await fetch(`/api/jobs/${job.slug}`)).json();
      drawer.innerHTML = drawerHtml(fresh);
      wireDrawer(drawer, fresh);
      load();
      toast('Contacts updated');
    } catch {
      toast('Could not fetch contacts');
      btn.disabled = false;
      btn.textContent = '⚡ Refresh contacts';
    }
  };

  for (const row of drawer.querySelectorAll('[data-goto]')) {
    row.onclick = () => openDrawer(row.dataset.goto);
  }
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

function bars(rows, labelKey, valueKey) {
  const max = Math.max(1, ...rows.map((r) => r[valueKey] || 0));
  return rows
    .map(
      (r) => `<div class="bar-row">
        <div class="lbl" title="${esc(r[labelKey])}">${esc(r[labelKey])}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${((r[valueKey] || 0) / max) * 100}%"></div></div>
        <div class="val">${r[valueKey] ?? 0}</div>
      </div>`,
    )
    .join('');
}

/**
 * The freelancers who keep turning up on the same projects, most frequent first.
 *
 * "Seen" is how many of the collected jobs they appeared on; "in contact" is how
 * many of those the client actually engaged them for. The ratio between the two
 * is the interesting part — someone on 40 projects who is never contacted is
 * noise, someone on 6 who is contacted on 5 is the competition.
 */
function developerRows(devs) {
  if (!devs?.length) {
    return '<p class="hint">No contender data collected yet — insights are fetched per job as the scraper runs.</p>';
  }
  const max = Math.max(1, ...devs.map((d) => d.appearances || 0));

  return `<div class="dev-list">${devs
    .map((d) => {
      const rate = d.appearances ? Math.round((d.contacted / d.appearances) * 100) : 0;
      return `<div class="dev-row${d.is_me ? ' me' : ''}">
        <img class="dev-av" src="${esc(d.avatar_url || AVATAR_PLACEHOLDER)}" alt="" loading="lazy"
             onerror="${AVATAR_FALLBACK}">
        <div class="dev-main">
          <div class="dev-name">
            ${
              d.profile_url
                ? `<a href="${esc(d.profile_url)}" target="_blank" rel="noopener">${esc(d.name)}</a>`
                : esc(d.name)
            }
            ${d.is_me ? '<span class="badge-s sel">You</span>' : ''}
            ${d.is_hero ? '<span class="badge-s hero">HERO</span>' : ''}
          </div>
          <div class="dev-meta">
            ${d.rating ? `<span>${Number(d.rating).toFixed(2)}★</span>` : '<span>No rating</span>'}
            ${d.projects_done ? `<span>${d.projects_done} done</span>` : ''}
            ${d.rehirings ? `<span>${d.rehirings} rehired</span>` : ''}
            ${d.ranking ? `<span>${esc(d.ranking)}</span>` : ''}
          </div>
        </div>
        <div class="dev-bar" title="Seen on ${d.appearances} job(s)">
          <div class="bar-track"><div class="bar-fill" style="width:${((d.appearances || 0) / max) * 100}%"></div></div>
        </div>
        <div class="dev-n" title="Jobs this freelancer appeared on">${d.appearances}</div>
        <div class="dev-n contact" title="Jobs where the client was in contact with them">${d.contacted || 0}</div>
        <div class="dev-n rate" title="Share of their appearances where the client engaged them">${rate}%</div>
      </div>`;
    })
    .join('')}</div>`;
}

/**
 * A 24-hour clock of when something happens, drawn in the viewer's own timezone.
 *
 * The server counts by UTC hour because that is the only zone it can be sure
 * of; the shift here is what makes the answer useful, since "bid at 14:00" only
 * means anything in the time you keep. The peak is called out in words, because
 * that is the one number anybody acts on.
 */
function hourChart(byHourUtc, label) {
  if (!byHourUtc?.some((n) => n > 0)) return '<p class="hint">Not enough data yet.</p>';

  const shift = -new Date().getTimezoneOffset() / 60;
  const local = Array.from({ length: 24 }, (_, h) => {
    const utc = (((h - shift) % 24) + 24) % 24;
    return byHourUtc[Math.round(utc)] || 0;
  });

  const max = Math.max(...local);
  const total = local.reduce((a, b) => a + b, 0);
  // The busiest stretch, as a window rather than a single hour: three
  // consecutive hours is something you can actually plan a morning around.
  let best = 0;
  let bestSum = -1;
  for (let h = 0; h < 24; h++) {
    const sum = local[h] + local[(h + 1) % 24] + local[(h + 2) % 24];
    if (sum > bestSum) { bestSum = sum; best = h; }
  }
  const pad = (n) => String(n).padStart(2, '0');

  return `
    <div class="hours">
      ${local
        .map(
          (n, h) => `<div class="hour${n === max ? ' peak' : ''}" title="${pad(h)}:00 — ${n} ${label}">
              <div class="hour-bar" style="height:${max ? (n / max) * 100 : 0}%"></div>
            </div>`,
        )
        .join('')}
    </div>
    <div class="hours-axis">${[0, 6, 12, 18, 23].map((h) => `<span>${pad(h)}</span>`).join('')}</div>
    <p class="hint">
      Busiest stretch: <strong>${pad(best)}:00–${pad((best + 3) % 24)}:00</strong> your time
      (${Math.round((bestSum / total) * 100)}% of all ${label}). Times shown in your own timezone.
    </p>`;
}

/** How long ago each client was last seen on Workana. */
function recencyBars(r) {
  if (!r || !r.total) return '';
  const rows = [
    ['Online in the last hour', r.h1],
    ['1–6 hours ago', r.h6],
    ['6–24 hours ago', r.h24],
    ['1–3 days ago', r.d3],
    ['More than 3 days ago', r.older],
  ];
  return bars(rows.map(([name, n]) => ({ name, n: Number(n) || 0 })), 'name', 'n');
}

async function showStats() {
  const s = await (await fetch('/api/stats')).json();
  const maxDay = Math.max(1, ...s.byDay.map((d) => d.n));

  $('#statsModal').innerHTML = `
    <h2>Statistics</h2>
    <div class="stat-cards">
      <div class="stat-card"><div class="n">${s.totals.jobs}</div><div class="l">Jobs stored</div></div>
      <div class="stat-card"><div class="n">${s.totals.hourly}</div><div class="l">Hourly</div></div>
      <div class="stat-card"><div class="n">${s.totals.fixed}</div><div class="l">Fixed price</div></div>
      <div class="stat-card"><div class="n">${s.totals.no_bids}</div><div class="l">With zero bids</div></div>
      <div class="stat-card"><div class="n">${s.totals.enriched}</div><div class="l">Fully enriched</div></div>
      <div class="stat-card"><div class="n">${s.totals.own_bids}</div><div class="l">You bid on</div></div>
      ${
        /*
         * The lifetime figure, which is larger than the one beside it: the board
         * cannot see a bid on a job that has already left the feed.
         */
        s.totals.proposals_total != null
          ? `<div class="stat-card" title="Counted from your Workana inbox on ${esc(fullStamp(s.totals.proposals_synced_at))}">
               <div class="n">${s.totals.proposals_total}</div>
               <div class="l">Proposals written</div>
             </div>`
          : `<div class="stat-card muted" title="Run: run.cmd proposals --email you@example.com --apply">
               <div class="n">—</div><div class="l">Proposals written</div>
             </div>`
      }
    </div>
    <div class="section"><h3>Jobs per day</h3>
      <div class="spark">${s.byDay.map((d) => `<div style="height:${(d.n / maxDay) * 100}%" title="${d.day}: ${d.n}"></div>`).join('')}</div>
      <div class="spark-labels">${s.byDay.map((d) => `<span>${(d.day || '').slice(5)}</span>`).join('')}</div>
    </div>
    <div class="section"><h3>By category</h3>${bars(s.byCategory, 'name', 'n')}</div>
    <div class="section"><h3>By client country</h3>${bars(s.byCountry, 'name', 'n')}</div>
    <div class="section"><h3>Most requested skills</h3>${bars(s.topSkills, 'name', 'n')}</div>
    <div class="section">
      <h3>When clients are online</h3>
      ${hourChart(s.clientActivity?.loginByHourUtc, 'client logins')}
    </div>
    <div class="section">
      <h3>When jobs are posted</h3>
      ${hourChart(s.clientActivity?.postedByHourUtc, 'postings')}
      <p class="hint">From ${s.clientActivity?.postedSample ?? 0} postings whose age was still
         given in minutes or hours — anything older only records when we collected it.</p>
    </div>
    <div class="section">
      <h3>How recently the client was last seen</h3>
      ${recencyBars(s.clientActivity?.recency)}
    </div>
    <div class="section">
      <h3>Developers you compete with
        <span class="dev-head">seen · in contact · rate</span>
      </h3>
      ${developerRows(s.developers)}
    </div>
    <div style="text-align:right"><button class="btn" id="closeStats">Close</button></div>`;

  $('#statsBackdrop').hidden = false;
  $('#closeStats').onclick = () => ($('#statsBackdrop').hidden = true);
}

/* ------------------------------------------------------------------ */
/* Status polling                                                      */
/* ------------------------------------------------------------------ */

/**
 * Turns the run's current phase into a few words. A run walks list pages, then
 * detail pages, then insight pages, and can easily take five minutes — a badge
 * that only ever says "scraping" looks identical to one that has hung.
 */
function describeProgress(p) {
  if (!p) return ' Workana…';
  switch (p.phase) {
    case 'list':
    case 'list-done':
      return ` list page ${p.page}${p.seen ? ` · ${p.seen} seen` : ''}`;
    case 'list-retry':
      return ` list page ${p.page} (retry ${p.attempt})`;
    case 'detail':
      return ` details ${p.done}/${p.total}`;
    case 'insights':
      return ` insights ${p.done}/${p.total}`;
    default:
      return ' Workana…';
  }
}

/** Explains why the badge keeps lighting up: enrichment runs on a per-run budget. */
function describeBacklog(b) {
  if (!b) return '';
  if (!b.details && !b.insights) return 'Every job is fully enriched.';
  return (
    `Still to enrich: ${b.details} detail page(s), ${b.insights} insight page(s). ` +
    'Each run takes a fixed budget of these, so the scraper keeps working through ' +
    'the backlog across several runs.'
  );
}

/*
 * True from the moment a scrape is asked for until the server has answered.
 * Only one run may be in flight instance-wide and a second request is refused,
 * so both buttons stay locked for that window rather than inviting a click that
 * can only come back as an error.
 */
let scrapeRequested = false;
const REFRESH_TIP = 'Fetch the newest two pages of postings, with their details and contacts';
const CRAWL_TIP = 'Walk the whole category to the end — slow, but fills an empty instance';

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    if (handleAuthLoss(res)) return;
    const s = await res.json();
    const dot = $('#statusDot');
    const text = $('#statusText');

    if (s.workerOnline === false) {
      /*
       * The board and the scraper can run on different machines now, and the
       * scraper's may simply be switched off. That is not an error in the board
       * and nothing here can fix it, so say plainly what is missing.
       */
      dot.className = 'status-dot error';
      text.textContent = 'Scraper offline';
      text.title =
        'The computer that runs the scraper is not connected. The board still works; ' +
        'new postings arrive once it is back.';
    } else if (s.stalled) {
      /*
       * Holding the slot but past its deadline. Saying "Scraping" here is how a
       * board ends up lit up over nothing for hours, so say what is true: it
       * stopped moving, and it will be cleared.
       */
      dot.className = 'status-dot error';
      text.textContent = 'Last run stalled — clearing it';
      text.title =
        'A run stopped reporting progress and is being abandoned. The next ' +
        'refresh will start a fresh one; the owner can clear it now with Stop.';
    } else if (s.scraping) {
      dot.className = 'status-dot busy';
      /*
       * The scheduled refresh runs as one of the members, because a scrape is
       * only possible as somebody — but it is the system's work, not theirs.
       * Calling it "another member" sent people off to ask a colleague what
       * they were doing to the board.
       */
      const sweep = s.scrapingAuto && s.scrapingKind === 'sweep';
      const who = sweep
        ? 'Checking for new jobs'
        : s.scrapingAuto
          ? 'Auto-refreshing'
          : s.scrapingMine
            ? 'Scraping'
            : 'Another member is scraping';
      // A quick check is one page; its progress would only repeat "page 1".
      text.textContent = sweep ? `${who}…` : who + describeProgress(s.progress);
      text.title = sweep
        ? `The board looks at the newest postings every ${s.sweepMinutes} minutes.`
        : s.scrapingAuto
          ? `The board refreshes itself every ${s.autoScrapeMinutes} minutes. ` + describeBacklog(s.backlog)
          : describeBacklog(s.backlog);
    } else if (s.lastError) {
      dot.className = 'status-dot error';
      text.textContent = s.lastError.slice(0, 60);
    } else {
      dot.className = s.paused ? 'status-dot error' : 'status-dot';
      const loaded = s.lastRun?.finished_at ? new Date(s.lastRun.finished_at).toLocaleTimeString() : '—';
      text.textContent = s.paused ? `Paused · loaded ${loaded}` : `Loaded ${loaded}`;
      text.title =
        (!s.paused && s.nextSweepAt
          ? `Next check for new jobs ${new Date(s.nextSweepAt).toLocaleTimeString()} ` +
            `(every ${s.sweepMinutes} min). `
          : '') + describeBacklog(s.backlog);
    }
    $('#totalCount').textContent = `${s.total} total`;

    /*
     * One run at a time for the whole instance, and a second request is refused
     * rather than queued — so the buttons that would send one go grey while a
     * run is in flight, whoever started it. The server refuses regardless; this
     * is so nobody has to be refused to find out.
     */
    const since = s.scrapingSince ? `, started ${timeAgo(s.scrapingSince)}` : '';
    const whyBusy = s.scraping
      ? s.scrapingAuto
        ? `The board is refreshing itself${since}. Wait for it to finish.`
        : s.scrapingMine
          ? `Your scrape is still running${since}. Wait for it to finish.`
          : `Another member is scraping right now${since}. The board is being refreshed for everyone.`
      : null;
    // `scrapeRequested` covers the gap between the click and the server
    // claiming the slot: without it a poll landing in those few milliseconds
    // would see scraping:false and hand the button straight back.
    const offline = s.workerOnline === false;
    const lock = Boolean(s.scraping) || scrapeRequested || offline;
    for (const [id, idle] of [['#refreshBtn', REFRESH_TIP], ['#fullCrawlBtn', CRAWL_TIP]]) {
      const btn = $(id);
      if (!btn) continue;
      btn.disabled = lock;
      btn.title = offline ? 'The scraper is offline, so nothing can pick up a new run.' : whyBusy || idle;
    }

    /*
     * Owner-only: one browser serves the whole instance, so stopping is not a
     * personal action.
     *
     * Three states, because a stop now holds the clock too: something is
     * running and can be stopped, the clock is held and can be released, or
     * neither and the button is not there at all.
     */
    const stop = $('#stopBtn');
    // A stalled run still holds the slot, so Stop must stay reachable for it —
    // that is the button an owner needs when the board is stuck.
    const busy = Boolean(s.scraping || s.stalled);
    stop.hidden = !s.canStop || (!busy && !s.paused);
    stop.disabled = Boolean(s.stopping);
    stop.classList.toggle('btn-go', Boolean(s.paused && !busy));
    stop.classList.toggle('btn-stop', !(s.paused && !busy));
    stop.textContent = s.stopping ? 'Stopping…' : s.paused && !busy ? '▶ Resume' : '■ Stop';
    stop.title =
      s.paused && !busy
        ? 'Automatic refreshing is paused. Start it again.'
        : 'Stop the run and hold off the automatic refresh';

    /*
     * When to redraw the list.
     *
     * New postings are in the database as soon as their list page is read, but
     * the list used to redraw only when the whole run ended -- up to eight
     * minutes later on a full refresh, while the details and contacts of other
     * jobs were being fetched. Now it redraws as soon as a run reports new jobs,
     * and again when a run finishes. "Finished" is taken from the last run's
     * record rather than from having watched it scrape: a quick check can start
     * and end between two of these polls.
     */
    const found = s.scraping ? Number(s.progress?.newJobs || 0) : 0;
    const sameRun = s.scrapingSince && s.scrapingSince === pollStatus.runSince;
    if (found > 0 && (!sameRun || found > pollStatus.found)) {
      load();
      checkNewJobs();
    }
    pollStatus.runSince = s.scrapingSince;
    pollStatus.found = found;

    const finished = s.lastRun?.finished_at ? `${s.lastRun.id}:${s.lastRun.finished_at}` : null;
    if (pollStatus.finished !== undefined && finished && finished !== pollStatus.finished) {
      load();
      if (s.lastRun.inserted > 0) loadFacets();
      checkNewJobs();
    }
    pollStatus.finished = finished;
  } catch { /* server restarting */ }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function reload() {
  state.offset = 0;
  load();
}

let debounce;
const defer = (fn) => { clearTimeout(debounce); debounce = setTimeout(fn, 300); };

$('#search').oninput = (e) => { state.search = e.target.value.trim(); defer(reload); };
$('#search').onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(debounce); reload(); } };

$('#typeSeg').onclick = (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.type = btn.dataset.type;
  reload();
};

$('#sort').onchange = (e) => { state.sort = e.target.value; reload(); };
$('#since').onchange = (e) => { state.since = e.target.value; reload(); };
$('#repliedWithin').onchange = (e) => { state.repliedWithin = e.target.value; reload(); };
$('#clientSeen').onchange = (e) => { state.clientSeen = e.target.value; reload(); };
for (const id of ['myContact', 'noMyContact', 'myBid', 'myRead', 'myFavourite', 'showClosed']) {
  $(`#${id}`).onchange = (e) => { state[id] = e.target.checked; reload(); };
}

for (const id of ['minBudget', 'maxBudget', 'maxBids']) {
  $(`#${id}`).oninput = (e) => { state[id] = e.target.value; defer(reload); };
}
for (const id of ['starred', 'verified', 'noBids', 'notBid', 'hasContacts', 'noContacts', 'hasReply', 'hasHired']) {
  $(`#${id}`).onchange = (e) => {
    state[id] = e.target.checked;
    // "has contacts" and "nobody contacted" are mutually exclusive.
    if (id === 'hasContacts' && e.target.checked) { state.noContacts = false; $('#noContacts').checked = false; }
    if (id === 'noContacts' && e.target.checked) { state.hasContacts = false; $('#hasContacts').checked = false; }
    reload();
  };
}

$('#clearFilters').onclick = () => {
  Object.assign(state, {
    search: '', minBudget: '', maxBudget: '', maxBids: '', since: '', type: '',
    repliedWithin: '', clientSeen: '', showClosed: false, myBid: false, myRead: false, myFavourite: false,
    myContact: false, noMyContact: false, verified: false, noBids: false, notBid: false, starred: false,
    hasContacts: false, noContacts: false, hasReply: false, hasHired: false, offset: 0,
  });
  state.country.clear(); state.category.clear(); state.skill.clear();
  $('#search').value = '';
  for (const id of ['minBudget', 'maxBudget', 'maxBids', 'since', 'repliedWithin', 'clientSeen'])
    $(`#${id}`).value = '';
  for (const id of ['starred', 'verified', 'noBids', 'notBid', 'hasContacts', 'noContacts', 'hasReply', 'hasHired',
    'myContact', 'noMyContact', 'myBid', 'myRead', 'myFavourite', 'showClosed'])
    $(`#${id}`).checked = false;
  document.querySelectorAll('.seg-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  ['category', 'country', 'skill'].forEach((n) => { updateFacetCount(n); repaint(n); });
  load();
};

/**
 * Asks for a run, and leaves the buttons locked if one started.
 *
 * The lock is a courtesy, not the rule — the server refuses a second run
 * whatever the page does, including from a stale tab or a hand-rolled request.
 * All this does is spare anyone the round trip to be told no.
 */
async function requestScrape(body, what) {
  scrapeRequested = true;
  $('#refreshBtn').disabled = true;
  $('#fullCrawlBtn').disabled = true;
  try {
    await api('/api/scrape', { method: 'POST', body: JSON.stringify(body) });
    toast(`${what} started`);
  } catch (ex) {
    toast(ex.message);
    // Almost always "add your Workana session first" — take them there.
    if (/session/i.test(ex.message)) openAccount();
  } finally {
    // Nothing of ours is in flight any more; from here the buttons follow
    // whatever the server says is running, which pollStatus applies.
    scrapeRequested = false;
    pollStatus();
  }
}

$('#refreshBtn').onclick = () => requestScrape({}, 'Scrape');

/**
 * A fresh instance starts empty and the periodic refresh only sweeps the first
 * few pages, so it would take many cycles to reach the whole catalogue. This
 * walks the category to the end in one run — the same thing `start.ps1 scrape`
 * does locally, which is otherwise unavailable on a hosted deployment.
 */
$('#fullCrawlBtn').onclick = async () => {
  const proceed = confirm(
    'Walk the entire category to the end?\n\n' +
      'This takes several minutes and paces itself deliberately to avoid being ' +
      'rate-limited. You can keep using the board while it runs.',
  );
  if (!proceed) return;
  await requestScrape({ pages: 250 }, 'Full crawl');
};

/**
 * Stops the run in flight. Nothing is rolled back — jobs are written as they are
 * read — so the confirmation is about the remaining work, not the results.
 */
$('#stopBtn').onclick = async () => {
  const btn = $('#stopBtn');
  // Read which action this is before overwriting the label that says so.
  const resuming = btn.textContent.includes('Resume');
  btn.disabled = true;
  btn.textContent = resuming ? 'Resuming…' : 'Stopping…';
  try {
    const r = await api(resuming ? '/api/scrape/resume' : '/api/scrape/stop', { method: 'POST' });
    toast(
      resuming
        ? 'Automatic refreshing is on again'
        : `${r.stopped ? 'Stopped' : 'Nothing was running'} — automatic ` +
          'refreshing is paused until you resume',
    );
    pollStatus();
  } catch (ex) {
    toast(ex.message);
    btn.disabled = false;
    btn.textContent = '■ Stop';
  }
};

$('#statsBtn').onclick = showStats;
$('#statsBackdrop').onclick = (e) => { if (e.target.id === 'statsBackdrop') $('#statsBackdrop').hidden = true; };
$('#backdrop').onclick = closeDrawer;
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeDrawer();
  $('#statsBackdrop').hidden = true;
  // The account panel stays open while a member still has no session to scrape with.
  if (me?.hasCookies) $('#accountBackdrop').hidden = true;
});

const applyTheme = (t) => {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('wk-theme', t);
};
$('#themeBtn').onclick = () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
applyTheme(localStorage.getItem('wk-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

let me = null;
let registrationOpen = true;
let mode = 'login'; // or 'register'

const api = async (url, options = {}) => {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

function renderGate() {
  const registering = mode === 'register';
  $('#gateSub').textContent = registering
    ? me === null && bootstrap
      ? 'Create the owner account for this instance'
      : 'Create your account'
    : 'Sign in to your account';
  $('#nameField').hidden = !registering;
  $('#codeField').hidden = !(registering && needsCode);
  $('#gateSubmit').textContent = registering ? 'Create account' : 'Sign in';
  $('#authPassword').setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
  $('#gateSwitchText').textContent = registering ? 'Already registered?' : 'New here?';
  $('#gateSwitch').textContent = registering ? 'Sign in' : 'Create an account';
  $('#gateSwitch').hidden = !registrationOpen && !registering;
  $('#gateError').hidden = true;
}

let bootstrap = false;
let needsCode = false;

function showGate(show) {
  $('#gate').hidden = !show;
  document.body.style.overflow = show ? 'hidden' : '';
}

async function refreshMe() {
  const data = await api('/api/me');
  me = data.user;
  registrationOpen = data.registrationOpen;
  bootstrap = data.needsBootstrap;
  if (bootstrap) mode = 'register';
  return me;
}

$('#gateSwitch').onclick = () => {
  mode = mode === 'login' ? 'register' : 'login';
  renderGate();
};

$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#gateError');
  const btn = $('#gateSubmit');
  btn.disabled = true;
  try {
    const body = {
      email: $('#authEmail').value.trim(),
      password: $('#authPassword').value,
    };
    if (mode === 'register') {
      body.name = $('#authName').value.trim();
      body.inviteCode = $('#authCode').value.trim();
    }
    const data = await api(mode === 'register' ? '/api/register' : '/api/login', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    me = data.user;
    showGate(false);
    await startApp();
    if (!me.hasCookies) openAccount();
  } catch (ex) {
    // An invite code is only mentioned once the server asks for one.
    if (/invite code/i.test(ex.message)) { needsCode = true; renderGate(); }
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
};

function accountHtml() {
  const state = me.cookiesValid === null
    ? me.hasCookies ? '<span class="pill warn">Not verified yet</span>' : '<span class="pill">Not added</span>'
    : me.cookiesValid
      ? '<span class="pill ok">Working</span>'
      : '<span class="pill bad">Rejected — re-export</span>';

  return `
    <h2>Your account</h2>
    <div class="acct-row"><span class="k">Signed in as</span><span class="v">${esc(me.name || me.email)}</span></div>
    <div class="acct-row"><span class="k">Email</span><span class="v">${esc(me.email)}</span></div>
    ${me.isAdmin ? '<div class="acct-row"><span class="k">Role</span><span class="v">Owner</span></div>' : ''}
    <div class="acct-row"><span class="k">Workana session</span><span class="v">${state}</span></div>
    ${me.workanaName ? `<div class="acct-row"><span class="k">Workana account</span><span class="v">${esc(me.workanaName)}</span></div>` : ''}
    ${me.cookiesUpdatedAt ? `<div class="acct-row"><span class="k">Session added</span><span class="v">${esc(fullStamp(me.cookiesUpdatedAt))}</span></div>` : ''}

    <h3 style="margin:22px 0 8px;font-size:13px">Your Workana session</h3>
    <p class="acct-help">
      The board scrapes Workana <em>as you</em>, so it needs your own cookies. In Chrome, install a
      cookie-editor extension, open <code>workana.com</code> while signed in, and export as JSON —
      then attach the downloaded file below. Only <code>workana.com</code> cookies are kept — the
      rest of the export is discarded — and what is stored is encrypted.
      <strong>This is a live login to your Workana account; only add it to an instance you trust.</strong>
    </p>
    <div class="acct-actions" style="margin-bottom:10px">
      <button class="btn btn-primary" id="pickCookieFile">📂 Attach export file…</button>
      <span id="serverFileSlot"></span>
      <input type="file" id="cookieFileInput" accept=".json,application/json" hidden>
    </div>
    <p class="acct-help" id="fileResult" hidden></p>

    <details style="margin-bottom:8px">
      <summary style="cursor:pointer;font-size:12px;color:var(--text-mute)">…or paste the JSON</summary>
      <textarea class="cookie-box" id="cookieBox" placeholder='[{"domain":".workana.com","name":"workana_session", ...}]'></textarea>
    </details>
    <div class="acct-actions">
      <button class="btn btn-primary" id="saveCookies">Save session</button>
      <button class="btn" id="verifyCookies" ${me.hasCookies ? '' : 'disabled'}>Verify</button>
      ${me.hasCookies ? '<button class="btn" id="removeCookies">Remove</button>' : ''}
      <button class="btn" id="signOut" style="margin-left:auto">Sign out</button>
    </div>
    <p class="acct-help" id="cookieResult" hidden></p>

    <h3 style="margin:22px 0 8px;font-size:13px">Your region
      <span style="font-weight:400;color:${me.proxyRequired ? 'var(--red, #e5484d)' : 'var(--text-mute)'}">
        ${me.proxyRequired ? '(required)' : '(optional)'}</span></h3>
    <p class="acct-help">
      Scraping runs on the server, so by default your Workana session is driven from
      <em>this machine's</em> IP rather than yours. If you are in another country, set an exit
      proxy in your own region — Workana ties its Cloudflare clearance to the IP that earned
      it, and a session that suddenly appears from elsewhere is what account-security checks
      look for.
    </p>
    ${me.proxyRequired
      ? `<p class="acct-help" style="color:var(--red, #e5484d)">
           <strong>Your session is not being used yet.</strong> Until you set a proxy here,
           Refresh, Verify and contact lookups are refused, and the background refresh skips
           your account — so neither your Workana account nor this machine's gets challenged
           for signing in from the wrong country.
         </p>`
      : '<p class="acct-help">Leave blank to use the server\'s connection.</p>'}
    <input class="f-control" id="proxyBox" placeholder="socks5://host:1080 or http://user:pass@host:8080"
           value="${esc(me.proxy || '')}">
    <div class="acct-actions" style="margin-top:8px">
      <button class="btn" id="saveProxy">Save region</button>
      ${me.proxy ? '<button class="btn" id="clearProxy">Use server connection</button>' : ''}
    </div>
    <p class="acct-help" id="proxyResult" hidden></p>`;
}

function openAccount() {
  $('#accountModal').innerHTML = accountHtml();
  $('#accountBackdrop').hidden = false;

  const say = (msg, bad) => {
    const p = $('#cookieResult');
    p.innerHTML = bad ? `<span style="color:var(--red)">${esc(msg)}</span>` : esc(msg);
    p.hidden = false;
  };

  const sayFile = (msg, bad) => {
    const p = $('#fileResult');
    p.innerHTML = bad ? `<span style="color:var(--red)">${esc(msg)}</span>` : msg;
    p.hidden = false;
  };

  /**
   * Attaching the exported file directly. The file is read in the browser and
   * posted as text to the same endpoint the textarea uses, so nothing new has to
   * be trusted server-side — it only removes the copy-and-paste step, which is
   * where a truncated export usually comes from.
   */
  $('#pickCookieFile').onclick = () => $('#cookieFileInput').click();

  $('#cookieFileInput').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const r = await api('/api/session/cookies', { method: 'POST', body: JSON.stringify({ cookies: raw }) });
      await refreshMe();
      openAccount();
      sayFile(`Attached ${r.count} Workana cookies from ${esc(file.name)}.${r.warning ? ` ${esc(r.warning)}` : ' Verifying…'}`);
      if (r.hasSession) document.getElementById('verifyCookies')?.click();
    } catch (ex) {
      sayFile(ex.message, true);
    }
  };

  // The server-side export exists only on a local install, and only its owner
  // may adopt it, so the button is drawn once the server says both are true.
  fetch('/api/session/file')
    .then((r) => r.json())
    .then((info) => {
      const slot = $('#serverFileSlot');
      if (!slot || !info.available) return;
      const name = info.file.split(/[\\/]/).pop();
      slot.innerHTML = `<button class="btn" id="loadServerFile">⤓ Load ${esc(name)}</button>`;
      const btn = $('#loadServerFile');
      btn.title =
        `${info.count} Workana cookie(s) in ${info.file}` +
        (info.hasSession ? '' : ' — no workana_session, you may not be signed in') +
        `\nLast changed ${fullStamp(info.modifiedAt)}`;
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const r = await api('/api/session/file', { method: 'POST' });
          await refreshMe();
          openAccount();
          sayFile(`Loaded ${r.count} cookies from the server's export.${r.warning ? ` ${esc(r.warning)}` : ' Verifying…'}`);
          if (r.hasSession) document.getElementById('verifyCookies')?.click();
        } catch (ex) {
          sayFile(ex.message, true);
          btn.disabled = false;
        }
      };
    })
    .catch(() => {});

  $('#saveCookies').onclick = async (e) => {
    const raw = $('#cookieBox').value.trim();
    if (!raw) return say('Paste your exported cookie JSON first.', true);
    e.target.disabled = true;
    try {
      const r = await api('/api/session/cookies', { method: 'POST', body: JSON.stringify({ cookies: raw }) });
      await refreshMe();
      openAccount();
      say(`Saved ${r.count} Workana cookies.${r.warning ? ` ${r.warning}` : ' Verifying…'}`);
      if (r.hasSession) document.getElementById('verifyCookies')?.click();
    } catch (ex) {
      say(ex.message, true);
      e.target.disabled = false;
    }
  };

  $('#verifyCookies').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Checking…';
    try {
      const r = await api('/api/session/verify', { method: 'POST' });
      // 202: the scraper's machine is still checking. Not a verdict either way.
      if (r.pending) {
        say(r.error, true);
        e.target.disabled = false;
        e.target.textContent = 'Verify';
        return;
      }
      await refreshMe();
      openAccount();
      say(r.loggedIn ? `Signed in to Workana as ${r.user || 'your account'}.` : 'Workana did not accept those cookies.', !r.loggedIn);
    } catch (ex) {
      say(ex.message, true);
      e.target.disabled = false;
      e.target.textContent = 'Verify';
    }
  };

  const remove = $('#removeCookies');
  if (remove) {
    remove.onclick = async () => {
      await api('/api/session/cookies', { method: 'DELETE' });
      await refreshMe();
      openAccount();
      say('Workana session removed.');
    };
  }

  const sayProxy = (msg, bad) => {
    const p = $('#proxyResult');
    p.innerHTML = bad ? `<span style="color:var(--red)">${esc(msg)}</span>` : esc(msg);
    p.hidden = false;
  };

  $('#saveProxy').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/api/session/proxy', {
        method: 'POST',
        body: JSON.stringify({ proxy: $('#proxyBox').value.trim() }),
      });
      await refreshMe();
      openAccount();
      sayProxy(r.proxy ? `Workana traffic will exit via ${r.proxy}. Verify to confirm.` : 'Using the server connection.');
    } catch (ex) {
      sayProxy(ex.message, true);
      e.target.disabled = false;
    }
  };

  const clearProxy = $('#clearProxy');
  if (clearProxy) {
    clearProxy.onclick = async () => {
      await api('/api/session/proxy', { method: 'POST', body: JSON.stringify({ proxy: '' }) });
      await refreshMe();
      openAccount();
      sayProxy('Using the server connection.');
    };
  }

  $('#signOut').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  };
}

$('#accountBtn').onclick = openAccount;
$('#accountBackdrop').onclick = (e) => {
  if (e.target.id === 'accountBackdrop') $('#accountBackdrop').hidden = true;
};

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

let statusTimer = null;

async function startApp() {
  $('#accountLabel').textContent = me.name || me.email.split('@')[0];
  // Neither needs the other, so the list does not wait behind the filters.
  await Promise.all([loadFacets(), load()]);
  alertsOn = readAlertPref();
  if (alertsOn) await resetAlertCursor();
  paintAlertsBtn();
  pollStatus();
  clearInterval(statusTimer);
  statusTimer = setInterval(pollStatus, 5000);
}

(async () => {
  try {
    await refreshMe();
  } catch {
    /* server not ready */
  }
  if (me) {
    showGate(false);
    await startApp();
    if (!me.hasCookies) openAccount();
  } else {
    renderGate();
    showGate(true);
  }
})();
