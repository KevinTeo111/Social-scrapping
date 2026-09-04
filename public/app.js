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
  for (const k of ['verified', 'noBids', 'notBid', 'starred', 'hasContacts', 'noContacts', 'hasReply', 'hasHired'])
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
  const ageMin = (Date.now() - new Date(posted).getTime()) / 60000;

  /* # */
  const tdNo = el('td');
  tdNo.appendChild(el('span', 'j-no', String(job.no).padStart(6, '0')));
  tr.appendChild(tdNo);

  /* Posted */
  const tdPosted = el('td');
  const pt = el('span', `j-time${ageMin < 60 ? ' fresh' : ''}`, shortStamp(posted));
  pt.title = `Posted ${fullStamp(posted)} (${timeAgo(posted)})`;
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
      await fetch(`/api/insights/${slug}`, { method: 'POST' });
      data = await (await fetch(`/api/jobs/${slug}`)).json();
      drawer.innerHTML = drawerHtml(data);
      wireDrawer(drawer, data);
      load();
    } catch {
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Fetch contacts'; }
    }
  }
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#backdrop').hidden = true;
  document.querySelectorAll('tr.is-open').forEach((r) => r.classList.remove('is-open'));
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
      No. ${String(job.no).padStart(6, '0')} · posted ${esc(timeAgo(posted))} · collected ${esc(timeAgo(job.first_seen_at))}
      ${job.status_label ? ` · ${esc(job.status_label)}` : ''}
    </div>
    <div class="drawer-tools">
      <span class="pill">${job.is_hourly ? 'Hourly' : 'Fixed price'}</span>
      ${job.category ? `<span class="pill">${esc(job.category)}</span>` : ''}
      ${job.subcategory ? `<span class="pill">${esc(job.subcategory)}</span>` : ''}
      ${job.is_featured ? '<span class="pill gold">🏆 Workana\'s selection</span>' : ''}
      ${job.has_own_bid ? '<span class="pill mine">✓ You bid on this</span>' : ''}
      ${contacted.length ? `<span class="pill hot">${contacted.length} in contact</span>` : ''}
      <a class="btn btn-primary" href="${esc(job.url)}" target="_blank" rel="noopener">Open on Workana ↗</a>
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
        ${kv('Posted', `${esc(shortStamp(posted))}${job.published_text ? ` (${esc(job.published_text)})` : ''}`)}
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
        ${kv('Last login', esc(job.client_last_login))}
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

  const btn = drawer.querySelector('[data-insights]');
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    try {
      await fetch(`/api/insights/${job.slug}`, { method: 'POST' });
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
    </div>
    <div class="section"><h3>Jobs per day</h3>
      <div class="spark">${s.byDay.map((d) => `<div style="height:${(d.n / maxDay) * 100}%" title="${d.day}: ${d.n}"></div>`).join('')}</div>
      <div class="spark-labels">${s.byDay.map((d) => `<span>${(d.day || '').slice(5)}</span>`).join('')}</div>
    </div>
    <div class="section"><h3>By category</h3>${bars(s.byCategory, 'name', 'n')}</div>
    <div class="section"><h3>By client country</h3>${bars(s.byCountry, 'name', 'n')}</div>
    <div class="section"><h3>Most requested skills</h3>${bars(s.topSkills, 'name', 'n')}</div>
    <div style="text-align:right"><button class="btn" id="closeStats">Close</button></div>`;

  $('#statsBackdrop').hidden = false;
  $('#closeStats').onclick = () => ($('#statsBackdrop').hidden = true);
}

/* ------------------------------------------------------------------ */
/* Status polling                                                      */
/* ------------------------------------------------------------------ */

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    if (handleAuthLoss(res)) return;
    const s = await res.json();
    const dot = $('#statusDot');
    const text = $('#statusText');

    if (s.scraping) {
      dot.className = 'status-dot busy';
      text.textContent = s.scrapingMine
        ? 'Scraping Workana…'
        : `Another member is scraping${s.queued ? ` · ${s.queued} queued` : ''}`;
    } else if (s.lastError) {
      dot.className = 'status-dot error';
      text.textContent = s.lastError.slice(0, 60);
    } else {
      dot.className = 'status-dot';
      const loaded = s.lastRun?.finished_at ? new Date(s.lastRun.finished_at).toLocaleTimeString() : '—';
      text.textContent = `Loaded ${loaded}`;
    }
    $('#totalCount').textContent = `${s.total} total`;

    if (pollStatus.wasScraping && !s.scraping) { load(); loadFacets(); }
    pollStatus.wasScraping = s.scraping;
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
    repliedWithin: '', verified: false, noBids: false, notBid: false, starred: false,
    hasContacts: false, noContacts: false, hasReply: false, hasHired: false, offset: 0,
  });
  state.country.clear(); state.category.clear(); state.skill.clear();
  $('#search').value = '';
  for (const id of ['minBudget', 'maxBudget', 'maxBids', 'since', 'repliedWithin']) $(`#${id}`).value = '';
  for (const id of ['starred', 'verified', 'noBids', 'notBid', 'hasContacts', 'noContacts', 'hasReply', 'hasHired'])
    $(`#${id}`).checked = false;
  document.querySelectorAll('.seg-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  ['category', 'country', 'skill'].forEach((n) => { updateFacetCount(n); repaint(n); });
  load();
};

$('#refreshBtn').onclick = async () => {
  $('#refreshBtn').disabled = true;
  try {
    const r = await api('/api/scrape', { method: 'POST', body: JSON.stringify({}) });
    toast(r.queued ? `Queued behind ${r.queued} run(s)` : 'Scrape started');
  } catch (ex) {
    toast(ex.message);
    // Almost always "add your Workana session first" — take them there.
    if (/session/i.test(ex.message)) openAccount();
  } finally {
    setTimeout(() => ($('#refreshBtn').disabled = false), 4000);
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
      cookie-editor extension, open <code>workana.com</code> while signed in, export as JSON, and
      paste it below. Only <code>workana.com</code> cookies are kept — the rest of the export is
      discarded — and what is stored is encrypted.
      <strong>This is a live login to your Workana account; only add it to an instance you trust.</strong>
    </p>
    <textarea class="cookie-box" id="cookieBox" placeholder='[{"domain":".workana.com","name":"workana_session", ...}]'></textarea>
    <div class="acct-actions">
      <button class="btn btn-primary" id="saveCookies">Save session</button>
      <button class="btn" id="verifyCookies" ${me.hasCookies ? '' : 'disabled'}>Verify</button>
      ${me.hasCookies ? '<button class="btn" id="removeCookies">Remove</button>' : ''}
      <button class="btn" id="signOut" style="margin-left:auto">Sign out</button>
    </div>
    <p class="acct-help" id="cookieResult" hidden></p>

    <h3 style="margin:22px 0 8px;font-size:13px">Your region <span style="font-weight:400;color:var(--text-mute)">(optional)</span></h3>
    <p class="acct-help">
      Scraping runs on the server, so by default your Workana session is driven from
      <em>this machine's</em> IP rather than yours. If you are in another country, set an exit
      proxy in your own region — Workana ties its Cloudflare clearance to the IP that earned
      it, and a session that suddenly appears from elsewhere is what account-security checks
      look for. Leave blank to use the server's connection.
    </p>
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
  await loadFacets();
  await load();
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
