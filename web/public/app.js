/* Permit search — client.
 *
 * Talks to the same API the previous UI did; every filter maps 1:1 onto a query
 * parameter that db/queries.js already understands. Three things changed:
 *
 *   1. Every value interpolated into innerHTML now goes through esc(). The old
 *      card renderer put p.address, p.work_description and p.contractor_name in
 *      raw, which was a stored-XSS hole on government-supplied text.
 *   2. Filters apply on change (debounced) instead of on a Search click, and
 *      are mirrored into the URL so a search can be bookmarked or shared.
 *   3. Cards are keyboard-operable, and closing the drawer returns focus.
 *
 * The map is real Leaflet over real OpenStreetMap tiles, and every count on it
 * comes from the database under the current filters. What is NOT precise is pin
 * placement: the schema stores no lat/lng, so /api/map attaches a per-ZIP or
 * per-city centroid. A pin means "N permits in this area", never "a permit at
 * this address" — the UI is worded accordingly and never claims otherwise.
 */

'use strict';

const $ = (id) => document.getElementById(id);

const STAGES = [
  ['pending',   'Waiting for approval'],
  ['approved',  'Approved'],
  ['finished',  'Finished'],
  ['cancelled', 'Cancelled'],
  ['unknown',   'Unknown'],
];
// Matches DEFAULT_STAGES in src/status.js: work that might still happen.
const DEFAULT_STAGES = ['pending', 'approved'];

const PAGE_SIZE = 25;

// Text inputs debounce; selects and checkboxes fire immediately.
const TYPING_DELAY = 300;

const TEXT_FILTERS = ['contractor', 'minValuation', 'q'];
const PICK_FILTERS = ['where', 'jurisdiction', 'permitType', 'trade', 'from', 'to'];

/* `where` is one control standing in for two API params. Its value is an area
   key — `z:78704` or `c:MIAMI|FL`, the same vocabulary the map's pins use — and
   currentFilters() expands it to zip= or city=. The URL keeps the plain params,
   so links made by the old UI still work. */
const asWhere = (filters) =>
  (filters.zip ? `z:${filters.zip}` : (filters.city ? `c:${filters.city.toUpperCase()}|${(filters.state || '').toUpperCase()}` : ''));

let page = 1;
let lastFocused = null;   // card to restore focus to when the drawer closes
let reqId = 0;            // guards against a slow response overwriting a fast one

/* Map state. `areaSelection` is the one filter with no form control behind it:
   it is a set of map pins, produced by "Search this area". */
let map = null;
let pinLayer = null;
let pinMarkers = new Map();   // area key -> the marker drawing it (a cluster serves many)
let mapPins = [];             // last /api/map response, re-clustered on every zoom
let allAreas = [];            // every area we hold, unfiltered — backs geolocation
let areaSelection = null;     // array of area keys, or null
let userMovedMap = false;     // once true, stop auto-fitting the viewport
let pendingWhere = '';        // area key from the URL, applied once options load
let unmatchedLocation = null; // a URL location the picker cannot represent
let baseMapNote = '';         // the standing map note, restored after a transient one
let pointLayer = null;        // located job sites, drawn instead of area pins when zoomed in
let pointsReq = 0;            // guards against a slow viewport overwriting a newer one
let lastFilters = {};         // the filters the map was last drawn for
let areaNote = '';            // the area-pin note (unplaced permits), kept while zoomed in

/* ------------------------------------------------------------ formatting */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// Valuations are round and read better without cents ($278,000); fees are exact
// and $141.90 must not display as $142.
const money = (v) => {
  const n = Number(v);
  if (!(n > 0)) return null;
  const cents = Number.isInteger(n) ? 0 : 2;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: cents, maximumFractionDigits: cents });
};

// A date-only value is read as local midnight; a full timestamp as itself.
const fmtDate = (d) => (d
  ? new Date(String(d).length === 10 ? `${d}T00:00:00` : d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  : null);

// Stored as bare digits so they compare reliably; formatted only for display.
const phone = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (v || null);
};

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Whole days between a timestamp and now. */
const daysSince = (ts) => Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);

const relativeDays = (n) => (n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`);

/* ------------------------------------------------------------ filter state */

/** Reads every control into the flat object the API expects. */
function currentFilters() {
  const f = {};
  for (const id of [...TEXT_FILTERS, ...PICK_FILTERS]) {
    const v = $(id).value.trim();
    if (v) f[id] = v;
  }

  // Expand the single picker back into the params the API takes.
  const where = f.where;
  delete f.where;
  if (!where && unmatchedLocation) {
    // Pass it through unchanged so the API can answer "we don't cover this",
    // which is the honest response and the one the empty state is written for.
    Object.assign(f, unmatchedLocation);
  } else if (where && where.startsWith('z:')) {
    f.zip = where.slice(2);
  } else if (where && where.startsWith('c:')) {
    const [city, state] = where.slice(2).split('|');
    f.city = city;
    if (state) f.state = state;
  }
  if ($('hasContact').checked) f.hasContact = 'true';
  if (areaSelection && areaSelection.length) f.areas = areaSelection.join(',');

  const stages = checkedStages();
  // Three cases, so the URL stays as short as the query is plain:
  //   all five  -> `any`, the opt-out db/queries.js already understands
  //   default   -> omitted; the API applies DEFAULT_STAGES itself
  //   otherwise -> the explicit list
  if (stages.length === STAGES.length) f.stage = 'any';
  else if (stages.length && !isDefaultStages(stages)) f.stage = stages.join(',');

  const sort = $('sort').value;
  if (sort && sort !== 'newest') f.sort = sort;
  return f;
}

const checkedStages = () =>
  STAGES.map(([key]) => key).filter((key) => $('stage-' + key).checked);

/** True when the selection is exactly the API's own default (pending + approved). */
const isDefaultStages = (stages) =>
  stages.length === DEFAULT_STAGES.length && DEFAULT_STAGES.every((s) => stages.includes(s));

/** Mirrors the current query into the address bar so it can be shared. */
function syncUrl(filters) {
  const params = new URLSearchParams(filters);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

/** Restores controls from the URL on load. */
function applyUrl() {
  const p = new URLSearchParams(location.search);

  for (const id of [...TEXT_FILTERS, ...PICK_FILTERS]) {
    if (id !== 'where' && p.has(id)) $(id).value = p.get(id);
  }
  // Applied once the options exist; see loadOptions(). The raw params are kept
  // alongside, because a URL can name a place we hold nothing for — and
  // answering that with the whole table would be worse than answering nothing.
  pendingWhere = asWhere({ zip: p.get('zip'), city: p.get('city'), state: p.get('state') });
  unmatchedLocation = null;
  if (p.has('zip') || p.has('city')) {
    unmatchedLocation = {};
    for (const key of ['zip', 'city', 'state']) {
      if (p.get(key)) unmatchedLocation[key] = p.get(key);
    }
  }
  $('hasContact').checked = p.get('hasContact') === 'true';
  areaSelection = p.get('areas') ? p.get('areas').split(',').filter(Boolean) : null;
  if (p.has('sort')) $('sort').value = p.get('sort');
  page = Math.max(1, Number.parseInt(p.get('page'), 10) || 1);

  const raw = p.get('stage');
  const on = raw === 'any'
    ? STAGES.map(([k]) => k)
    : (raw ? raw.split(',').map((s) => s.trim()) : DEFAULT_STAGES);
  for (const [key] of STAGES) $('stage-' + key).checked = on.includes(key);
}

/* ------------------------------------------------------------ sidebar init */

function buildStageCheckboxes() {
  $('stageGroup').innerHTML = STAGES.map(([key, label]) => `
    <label class="check" for="stage-${key}">
      <input type="checkbox" id="stage-${key}" value="${key}">
      <span class="check-label">${esc(label)}</span>
      <span class="check-count" id="stage-count-${key}"></span>
    </label>`).join('');
}

/**
 * Counts beside each stage come from the search response, not from the
 * table-wide totals in /api/filters — showing "Finished 330" while viewing one
 * ZIP would imply 330 finished permits in that ZIP.
 */
function paintStageCounts(facets) {
  const counts = (facets && facets.stages) || {};
  for (const [key] of STAGES) {
    const n = counts[key] || 0;
    $('stage-count-' + key).textContent = n ? n.toLocaleString('en-US') : '—';
  }
}

async function loadOptions() {
  const [areas, filters] = await Promise.all([
    fetch('/api/areas').then((r) => r.json()),
    fetch('/api/filters').then((r) => r.json()),
  ]);

  const fill = (el, rows, valueKey, label) => {
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const o = document.createElement('option');
      o.value = row[valueKey];
      o.textContent = label(row);
      frag.appendChild(o);
    }
    el.appendChild(frag);
  };

  fill($('jurisdiction'), areas.jurisdictions, 'jurisdiction', (r) => `${r.jurisdiction} (${r.permits})`);
  fill($('permitType'), filters.permitTypes, 'permit_type', (r) => `${r.permit_type} (${r.permits})`);

  buildWhereOptions(areas);

  // Quick-pick the ZIPs we actually hold data for — the busiest first, so the
  // chips are useful rather than merely numeric order.
  const top = [...areas.zips].sort((a, b) => b.permits - a.permits).slice(0, 8);
  $('zipChips').innerHTML = top
    .map((z) => `<button type="button" class="chip" data-where="z:${esc(z.zip)}"
                   aria-pressed="false">${esc(z.zip)} · ${z.permits}</button>`)
    .join('');

  $('zipChips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-where]');
    if (!btn) return;
    // Clicking the active chip clears it, so the chips work as a toggle.
    setWhere($('where').value === btn.dataset.where ? '' : btn.dataset.where);
    run({ resetPage: true });
  });
}

/**
 * Every place we hold permits for, and nothing else. ZIPs are grouped by state
 * and labelled with their city; a city gets its own entry only when it has
 * permits carrying no ZIP — Miami-Dade publishes none, so "Miami" is the only
 * way to reach its ~2,900 records.
 */
function buildWhereOptions(areas) {
  const STATE_NAMES = { TX: 'Texas', FL: 'Florida', OR: 'Oregon' };
  const groups = new Map();
  const push = (state, entry) => {
    if (!groups.has(state)) groups.set(state, []);
    groups.get(state).push(entry);
  };

  // Every city gets a roll-up entry, and every trusted ZIP its own. Selecting a
  // city returns its ZIP-bearing permits too, so the two overlap by design —
  // which is why the group headings carry no total. Summing the options would
  // count Austin's permits twice.
  for (const c of areas.cities) {
    push(c.state || '—', {
      key: `c:${c.city.toUpperCase()}|${(c.state || '').toUpperCase()}`,
      label: `${titleCase(c.city)} — all`,
      permits: c.permits,
    });
  }
  for (const z of areas.zips) {
    push(z.state || '—', {
      key: `z:${z.zip}`,
      label: `${z.zip}${z.city ? ` · ${titleCase(z.city)}` : ''}`,
      permits: z.permits,
    });
  }

  // Busiest state first, and busiest area within it, so the list opens on the
  // places most likely to be wanted rather than on alphabetical accident.
  const ordered = [...groups.entries()]
    .map(([state, entries]) => [state, entries.sort((a, b) => b.permits - a.permits)])
    .sort((a, b) => b[1][0].permits - a[1][0].permits);

  const frag = document.createDocumentFragment();
  for (const [state, entries] of ordered) {
    const group = document.createElement('optgroup');
    group.label = STATE_NAMES[state] || state;
    for (const entry of entries) {
      const opt = document.createElement('option');
      opt.value = entry.key;
      opt.textContent = `${entry.label} · ${entry.permits.toLocaleString('en-US')}`;
      group.appendChild(opt);
    }
    frag.appendChild(group);
  }
  $('where').appendChild(frag);

  // A key from the URL can only be applied now that the options exist. If it
  // matched, the picker is the source of truth and the raw fallback is dropped.
  if (pendingWhere && setWhere(pendingWhere)) unmatchedLocation = null;
  pendingWhere = '';
}

const titleCase = (v) => String(v || '').toLowerCase()
  .replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Selects an area key, ignoring one we hold no permits for. */
function setWhere(key) {
  const select = $('where');
  if (!key) { select.value = ''; return true; }

  const has = (v) => Boolean(select.querySelector(`option[value="${CSS.escape(v)}"]`));
  if (has(key)) { select.value = key; return true; }

  // A link written before the picker existed can carry `?city=MIAMI` with no
  // state, which builds the key `c:MIAMI|`. Match on the city alone rather than
  // silently resetting to "Anywhere".
  if (key.startsWith('c:') && key.endsWith('|')) {
    const city = key.slice(2, -1);
    const match = [...select.options]
      .find((o) => o.value.startsWith(`c:${city}|`));
    if (match) { select.value = match.value; return true; }
  }

  select.value = '';
  return false;
}

function paintZipChips(activeWhere) {
  for (const chip of $('zipChips').querySelectorAll('[data-where]')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.where === activeWhere));
  }
}

/* --------------------------------------------------------------- freshness */

/**
 * "Latest permits" is a claim about recency. If the newest ingest is two weeks
 * old, that belongs in the header, not in grey 12px text below the form.
 */
async function loadFreshness() {
  let sources = [];
  try {
    ({ sources = [] } = await fetch('/api/freshness').then((r) => r.json()));
  } catch {
    sources = [];
  }

  const badge = $('fresh');
  const done = sources.filter((s) => s.finished_at && !s.error);
  const failed = sources.filter((s) => s.error);

  if (!done.length) {
    badge.dataset.level = 'stale';
    $('freshLabel').textContent = 'Never updated';
  } else {
    const age = Math.min(...done.map((s) => daysSince(s.finished_at)));
    badge.dataset.level = age < 1 ? 'ok' : age < 7 ? 'warn' : 'stale';
    $('freshLabel').textContent = `Updated ${relativeDays(age)}`;
  }
  if (failed.length) badge.dataset.level = 'stale';

  // Under 620px the label is hidden and only the dot shows, which would leave
  // the button with no accessible name. Mirror the text onto the element.
  badge.setAttribute('aria-label', `Data freshness: ${$('freshLabel').textContent}`);
  badge.title = $('freshLabel').textContent;

  const level = (d) => (d < 1 ? 'ok' : d < 7 ? 'warn' : 'stale');
  $('freshSources').innerHTML = sources
    .slice()
    .sort((a, b) => new Date(b.finished_at || 0) - new Date(a.finished_at || 0))
    .map((s) => {
      const d = s.finished_at ? daysSince(s.finished_at) : null;
      const note = s.error ? 'failed' : d === null ? 'never run' : relativeDays(d);
      return `<div class="src-row" data-level="${s.error ? 'stale' : level(d ?? 99)}">
          <span class="name">${esc(s.label || s.source_area)}</span>
          <span>${s.permits_seen ? plural(s.permits_seen, 'permit', 'permits') : ''}</span>
          <span class="age">${esc(note)}</span>
          ${s.publicationLag ? `<span class="lag">${esc(s.publicationLag)}, on top of our sync.</span>` : ''}
        </div>`;
    })
    .join('');

  paintCredits(sources);

  // Popover toggle.
  badge.addEventListener('click', () => {
    const pop = $('freshPop');
    const open = pop.hidden;
    pop.hidden = !open;
    badge.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.fresh-wrap')) {
      $('freshPop').hidden = true;
      badge.setAttribute('aria-expanded', 'false');
    }
  });
}

/** Every source's credit line under the results (CC BY needs it wherever City of Miami data shows). */
async function paintCredits(sources) {
  let enrichment = [];
  try { ({ enrichment = [] } = await fetch('/api/credits').then((r) => r.json())); } catch { enrichment = []; }
  const permitCredits = sources.filter((s) => s.attribution).map((s) => `${s.label || s.source_area}: ${s.attribution}`);
  const lines = [...permitCredits, ...enrichment.map((e) => e.attribution)];
  $('credits').innerHTML = `
    <p><b>Sources.</b> ${lines.map(esc).join(' · ') || 'Public permit records.'}</p>
    <p>Contacts come from the public permit record; individuals are withheld. Not affiliated with or endorsed by these agencies. Data as published, may be incomplete.</p>`;
}

/** The Screens menu in the topbar: links to the other pilot screens. */
function initScreensMenu() {
  const btn = $('screensBtn');
  const pop = $('screensPop');
  if (!btn || !pop) return;
  btn.addEventListener('click', () => {
    const open = pop.hidden;
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) { $('freshPop').hidden = true; $('fresh').setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.screens-wrap')) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
  });
}

/* ------------------------------------------------------------ active chips */

const CHIP_LABELS = {
  zip: 'ZIP', city: 'City', jurisdiction: 'Jurisdiction', permitType: 'Type',
  trade: 'Trade', minValuation: 'Min value', contractor: 'Contractor',
  from: 'From', to: 'To', q: 'Search', hasContact: 'Contact', stage: 'Stage',
  areas: 'Map area',
};

function paintActiveFilters(filters) {
  const stages = checkedStages();
  const chips = [];

  // zip/city/state come from one control, so they get one chip — otherwise
  // picking Miami would produce a "City MIAMI" and a "State FL" chip.
  const where = $('where');
  if (where.value) {
    chips.push(['zip', 'Where', where.options[where.selectedIndex].textContent.split(' · ')[0]]);
  } else if (unmatchedLocation) {
    chips.push(['zip', 'Where',
      unmatchedLocation.zip || [unmatchedLocation.city, unmatchedLocation.state].filter(Boolean).join(', ')]);
  }

  for (const [key, value] of Object.entries(filters)) {
    if (key === 'sort') continue;
    if (key === 'zip' || key === 'city' || key === 'state') continue;
    if (key === 'stage') {
      // The default view needs no chip; anything else is worth stating.
      if (isDefaultStages(stages)) continue;
      const label = value === 'any'
        ? 'any'
        : stages.map((s) => STAGES.find(([k]) => k === s)[1].toLowerCase()).join(', ');
      chips.push([key, 'Stage', label]);
      continue;
    }
    const shown = key === 'hasContact' ? 'has a phone number'
      : key === 'minValuation' ? (money(value) || value)
      : key === 'areas' ? plural(areaSelection.length, 'place', 'places')
      : value;
    chips.push([key, CHIP_LABELS[key] || key, shown]);
  }

  $('activeFilters').innerHTML = chips.map(([key, label, value]) => `
    <span class="fchip">
      <span class="k">${esc(label)}</span> ${esc(value)}
      <button type="button" data-clear="${esc(key)}"
              aria-label="Remove ${esc(label)} filter">&times;</button>
    </span>`).join('');
}

function clearFilter(key) {
  // zip/city/state are all shown by the one picker, so any of them clears it.
  if (key === 'zip' || key === 'city' || key === 'state') {
    unmatchedLocation = null;
    setWhere('');
    run({ resetPage: true });
    return;
  }
  if (key === 'stage') {
    for (const [k] of STAGES) $('stage-' + k).checked = DEFAULT_STAGES.includes(k);
  } else if (key === 'hasContact') {
    $('hasContact').checked = false;
  } else if (key === 'areas') {
    areaSelection = null;
    userMovedMap = false;
  } else {
    $(key).value = '';
  }
  run({ resetPage: true });
}

/* ----------------------------------------------------------------- results */

function stageBadge(p) {
  // The portal's own wording, coloured by lifecycle stage — the user reads
  // "Ready to Issue", not our bucket for it.
  const label = p.status_raw || p.status || p.status_stage;
  if (!label) return '';
  return `<span class="stage ${esc(p.status_stage || 'unknown')}">${esc(label)}</span>`;
}

function renderCard(p) {
  const el = document.createElement('article');
  el.className = 'card';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.dataset.id = p.id;
  // Which pin this card belongs to, for the hover link in both directions.
  const areaKey = areaKeyOf(p);
  if (areaKey) el.dataset.area = areaKey;

  const val = money(p.valuation);
  const contact = phoneLink(p.contractor_phone, ' data-tel');

  const foot = [
    stageBadge(p),
    val ? `<span class="money">${esc(val)}</span>` : '',
    p.jurisdiction ? `<span class="pill">${esc(p.jurisdiction)}</span>` : '',
    p.contractor_name
      ? (isRealContractor(p.contractor_name)
          ? `<button type="button" class="link-btn" data-open-contractor="${esc(p.contractor_name)}"
                >${esc(p.contractor_name)}</button>`
          : `<span>${esc(p.contractor_name)}</span>`)
      : (p.contractor_withheld ? '<span title="Looks like an individual; name and contact withheld">Individual (withheld)</span>' : ''),
    contact,
    p.permit_number ? `<span>#${esc(p.permit_number)}</span>` : '',
  ].filter(Boolean).join('<span class="sep" aria-hidden="true"></span>');

  el.innerHTML = `
    <div class="card-top">
      <h3 class="card-addr">${esc(p.address || 'Address not listed')}</h3>
      <span class="card-date">${esc(fmtDate(p.filed_date) || 'No date')}</span>
    </div>
    ${p.permit_type ? `<div class="card-type">${esc(p.permit_type)}</div>` : ''}
    ${p.work_description ? `<p class="card-desc">${esc(p.work_description)}</p>` : ''}
    <div class="card-foot">${foot}</div>`;

  const open = (e) => {
    // The phone link dials and the contractor name opens a history; neither
    // should also open this permit.
    if (e.target.closest('[data-tel], [data-open-contractor]')) return;
    flyToPermit(p);
    openDetail(p.id, el);
  };
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      flyToPermit(p);
      openDetail(p.id, el);
    }
  });
  if (areaKey) {
    el.addEventListener('mouseenter', () => highlightPin(areaKey, true));
    el.addEventListener('mouseleave', () => highlightPin(areaKey, false));
    el.addEventListener('focus', () => highlightPin(areaKey, true));
    el.addEventListener('blur',  () => highlightPin(areaKey, false));
  }
  return el;
}

const skeletons = (n) =>
  `<div class="cards">${'<div class="skel"><span></span><span></span><span></span><span></span></div>'.repeat(n)}</div>`;

function emptyState(data, filters) {
  // The distinction that keeps this honest: we don't cover the area, versus we
  // cover it and nothing matched.
  if (data.coverage === 'not-covered') {
    return `<div class="empty">
      ${emptyIcon()}
      <strong>We don't cover ${esc(filters.zip)} yet</strong>
      <p>This search only includes the jurisdictions we currently ingest. Try one
         of the postal codes listed in the sidebar.</p></div>`;
  }
  return `<div class="empty">
    ${emptyIcon()}
    <strong>No permits match these filters</strong>
    <p>There is data for this area — try widening the date range, lowering the
       minimum valuation, or clearing a filter.</p></div>`;
}

const emptyIcon = () => `<span class="empty-icon" aria-hidden="true">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/>
  <path d="m20 20-3.5-3.5"/></svg></span>`;

async function run({ resetPage = false } = {}) {
  if (resetPage) page = 1;

  const filters = currentFilters();
  syncUrl(filters);
  paintActiveFilters(filters);
  paintZipChips($('where').value);
  updateFilterCount(filters);
  // The map is refreshed independently of the list: it must not delay results,
  // and a map failure must not blank the feed.
  loadMap(filters);

  // Unchecking every stage is a query for nothing. Say so, rather than letting
  // the API fall back to its default and silently ignore the user.
  if (!checkedStages().length) {
    $('results').innerHTML = `<div class="empty">${emptyIcon()}
      <strong>No stage selected</strong>
      <p>Tick at least one stage in the sidebar to see permits.</p></div>`;
    $('count').textContent = 'No results';
    $('pager').innerHTML = '';
    paintStageCounts(null);
    setSheetCount(0);
    return;
  }

  const mine = ++reqId;
  $('results').innerHTML = skeletons(6);
  $('count').textContent = 'Searching…';

  let data;
  try {
    const params = new URLSearchParams({ ...filters, page: String(page), pageSize: String(PAGE_SIZE) });
    data = await fetch('/api/permits?' + params).then((r) => r.json());
  } catch (err) {
    if (mine !== reqId) return;
    $('results').innerHTML = `<div class="empty">${emptyIcon()}
      <strong>Couldn't reach the server</strong><p>${esc(err.message)}</p></div>`;
    $('count').textContent = '';
    return;
  }
  if (mine !== reqId) return;  // a newer search already landed

  paintStageCounts(data.facets);

  if (!data.results || !data.results.length) {
    $('results').innerHTML = emptyState(data, filters);
    $('count').textContent = 'No permits';
    $('pager').innerHTML = '';
    setSheetCount(0);
    return;
  }

  const list = document.createElement('div');
  list.className = 'cards';
  for (const p of data.results) list.appendChild(renderCard(p));
  $('results').replaceChildren(list);
  paintPinState();

  setSheetCount(data.total);

  const first = (data.page - 1) * data.pageSize + 1;
  const last = Math.min(data.page * data.pageSize, data.total);
  $('count').innerHTML = `${plural(data.total, 'permit', 'permits')}
    <span class="sub">· showing ${first}–${last}</span>`;

  const pages = Math.ceil(data.total / data.pageSize);
  $('pager').innerHTML = pages > 1
    ? `<button type="button" class="btn btn-ghost" data-page="prev" ${data.page <= 1 ? 'disabled' : ''}>← Previous</button>
       <span class="pos">Page ${data.page} of ${pages.toLocaleString('en-US')}</span>
       <button type="button" class="btn btn-ghost" data-page="next" ${data.page >= pages ? 'disabled' : ''}>Next →</button>`
    : '';
}

/** The sheet's action doubles as the result count, so a phone shows the effect
 *  of a filter without closing the sheet to look. */
function setSheetCount(total) {
  $('sheetApply').textContent = total
    ? `Show ${plural(total, 'permit', 'permits')}`
    : 'No matches — adjust filters';
  $('sheetApply').disabled = !total;
}

function updateFilterCount(filters) {
  const n = Object.keys(filters).filter((k) => k !== 'sort' && k !== 'stage').length;
  $('filtersToggleLabel').textContent = n ? `Filters (${n})` : 'Filters';
}

/* ==================================================== contractor history ===
 *
 * A permit is one job; this is a track record. The same firm often appears
 * under several spellings (portals do not issue stable contractor IDs), so
 * near-matches are offered rather than silently merged — merging would
 * eventually fuse two genuinely different companies.
 */

// Portal placeholders meaning "the owner did the work", not a company.
const NON_CONTRACTORS = new Set(['OWNER', 'OWNER/BUILDER', 'OWNER BUILDER', 'SELF', 'HOMEOWNER', 'N/A', 'NONE', 'TBD']);
const isRealContractor = (name) =>
  Boolean(name) && !NON_CONTRACTORS.has(String(name).trim().toUpperCase());

let contractorReturnsTo = null;   // the permit drawer to reopen on close, if any

async function openContractor(name, { from = null } = {}) {
  const dlg = $('contractorPanel');
  contractorReturnsTo = from;

  $('cName').textContent = name;
  $('cMeta').textContent = 'Loading history…';
  $('cBody').innerHTML = skeletons(3);
  $('cFoot').innerHTML = '';
  if (!dlg.open) dlg.showModal();

  let c;
  try {
    const res = await fetch('/api/contractors/' + encodeURIComponent(name));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      $('cMeta').textContent = '';
      $('cBody').innerHTML = `<div class="empty">${emptyIcon()}
        <strong>${body.reason === 'owner-builder'
          ? 'That is an owner-builder, not a company'
          : 'No permits under that exact name'}</strong>
        <p>${body.reason === 'owner-builder'
          ? 'Portals write “OWNER” in the contractor column when the property owner pulled the permit themselves, so there is no firm to show a history for.'
          : 'The name may be spelled differently on other permits.'}</p></div>`;
      return;
    }
    c = await res.json();
  } catch (err) {
    $('cBody').innerHTML = `<p class="callout">${esc(err.message)}</p>`;
    return;
  }

  const span = (c.first_filed && c.last_filed)
    ? `${fmtDate(c.first_filed)} – ${fmtDate(c.last_filed)}`
    : '—';
  const daysQuiet = c.last_filed ? daysSince(c.last_filed + 'T00:00:00') : null;

  $('cMeta').textContent = [c.trade, c.city, c.licence && `Licence ${c.licence}`]
    .filter(Boolean).join(' · ');

  const stat = (label, value, cls = '') =>
    `<div class="stat"><span class="stat-v ${cls}">${esc(value)}</span>
       <span class="stat-k">${esc(label)}</span></div>`;

  // Valuation is only summed over permits that carry one; saying "$107,026
  // total" while 40% of the rows report $0 would understate it silently.
  const valuationNote = c.valued < c.permits
    ? `from ${c.valued} of ${c.permits} permits that report a value`
    : 'across all permits';

  $('cBody').innerHTML = `
    <div class="stats">
      ${stat('permits', c.permits.toLocaleString('en-US'))}
      ${stat('waiting', c.pending.toLocaleString('en-US'), c.pending ? 'is-pending' : '')}
      ${stat('approved', c.approved.toLocaleString('en-US'))}
      ${stat('finished', c.finished.toLocaleString('en-US'))}
    </div>

    <div class="sect">Track record</div>
    <dl class="kv">
      ${row('Active', span)}
      ${daysQuiet !== null ? row('Last permit', relativeDays(daysQuiet)) : ''}
      ${row('Declared value', money(c.total_valuation) || '—')}
      ${row('', valuationNote)}
      ${c.phone ? `<dt>Phone</dt><dd>${phoneLink(c.phone)}</dd>` : ''}
      ${row('Licence', c.licence)}
      ${row('Based in', c.city)}
    </dl>

    ${c.permitTypes.length ? `
      <div class="sect">What they pull</div>
      <div class="chips">${c.permitTypes.map((t) =>
        `<span class="chip as-tag">${esc(t.permit_type)} · ${t.permits}</span>`).join('')}</div>` : ''}

    ${c.areas.length ? `
      <div class="sect">Where they work</div>
      <div class="chips">${c.areas.map((a) =>
        `<span class="chip as-tag">${esc(a.area)} · ${a.permits}</span>`).join('')}</div>` : ''}

    ${c.similar.length ? `
      <div class="sect">Possibly the same firm</div>
      <p class="hint">Portals record company names free-form, so one firm can appear
         under several spellings. These are not merged automatically — open one to
         check.</p>
      <div class="chips">${c.similar.map((sfirm) =>
        `<button type="button" class="chip" data-contractor="${esc(sfirm.name)}">
           ${esc(sfirm.name)} · ${sfirm.permits}</button>`).join('')}</div>` : ''}

    <div class="sect">Recent permits</div>
    <div class="mini-list">${c.recent.map((p) => `
      <button type="button" class="mini-row" data-permit="${esc(p.id)}">
        <span class="mini-addr">${esc(p.address || 'Address not listed')}</span>
        <span class="mini-meta">${esc(fmtDate(p.filed_date) || '')}${
          p.permit_type ? ` · ${esc(p.permit_type)}` : ''}${
          money(p.valuation) ? ` · ${esc(money(p.valuation))}` : ''}</span>
        ${stageBadge(p)}
      </button>`).join('')}</div>`;

  $('cFoot').innerHTML = `
    <button type="button" class="btn btn-primary" id="cFilter">
      Show all ${plural(c.permits, 'permit', 'permits')} in the results
    </button>`;

  $('cFilter').addEventListener('click', () => {
    $('contractor').value = c.name;
    dlg.close();
    $('detail').close();
    run({ resetPage: true });
  });

  $('cBody').addEventListener('click', (e) => {
    const firm = e.target.closest('[data-contractor]');
    if (firm) { openContractor(firm.dataset.contractor, { from: contractorReturnsTo }); return; }
    const permit = e.target.closest('[data-permit]');
    if (permit) { dlg.close(); openDetail(permit.dataset.permit, null); }
  });
}

/** Name suggestions from the real data, as you type. */
const loadContractorSuggestions = debounce(async (term) => {
  if (!term || term.length < 2) { $('contractorList').innerHTML = ''; $('contractorHint').textContent = ''; return; }
  try {
    const { contractors } = await fetch('/api/contractors?limit=12&q=' + encodeURIComponent(term))
      .then((r) => r.json());
    $('contractorList').innerHTML = contractors
      .map((c) => `<option value="${esc(c.name)}">${esc(c.name)} · ${c.permits}</option>`).join('');
    $('contractorHint').innerHTML = contractors.length
      ? `<button type="button" class="link-btn" data-open-contractor="${esc(contractors[0].name)}">
           See ${esc(contractors[0].name)}'s history →</button>`
      : 'No company matches that name.';
  } catch { /* suggestions are optional */ }
}, TYPING_DELAY);

/* ================================================================== map ===
 *
 * Real Leaflet, real OpenStreetMap tiles, real counts. Pin POSITIONS are area
 * centroids rather than addresses (see the file header), so the vocabulary here
 * is deliberately "area" and "place" — never "location of this permit".
 */

const OSM_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** The area key a permit belongs to; mirrors the grouping in /api/map. */
const areaKeyOf = (p) => (p.zip ? `z:${p.zip}` : (p.city && p.state ? `c:${p.city}|${p.state}` : null));

function initMap() {
  if (map || typeof L === 'undefined') return;

  map = L.map('map', { zoomControl: true, attributionControl: true })
    .setView([31.5, -98.5], 4);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: OSM_ATTR,
  }).addTo(map);

  pinLayer = L.layerGroup().addTo(map);
  pointLayer = L.layerGroup().addTo(map);

  // Panning is how you ask "what about over here?", so offer the re-search
  // rather than silently refetching and yanking the list out from under them.
  //
  // This keys off real input rather than Leaflet's own move events, because
  // fitBounds() fires movestart/moveend exactly like a drag does — using those
  // would pop "Search this area" open on first paint, before anyone touched it.
  for (const evt of ['mousedown', 'wheel', 'touchstart', 'keydown']) {
    map.getContainer().addEventListener(evt, () => { userMovedMap = true; }, { passive: true });
  }

  // Pins are clustered in screen space, so the grouping only changes with zoom.
  map.on('zoomend', renderPins);
  map.on('moveend', () => {
    if (userMovedMap && map._loadedOnce) $('searchArea').hidden = false;
    loadPointsSoon();
  });
}

/** Renders the pin set for the current filters. */
async function loadMap(filters) {
  if (!map) return;
  lastFilters = filters;

  let data;
  try {
    data = await fetch('/api/map?' + new URLSearchParams(filters)).then((r) => r.json());
  } catch {
    return;   // the map is an aid; a failure here must not break the results
  }

  mapPins = data.pins || [];
  renderPins();

  // Say plainly when rows exist that no pin can represent.
  areaNote = data.unplaced
    ? `${plural(data.unplaced, 'permit', 'permits')} not shown — no mappable area on the record`
    : '';
  baseMapNote = areaNote;
  clearTimeout(noteTimer);
  $('mapNote').textContent = baseMapNote;

  fitPins();
  map._loadedOnce = true;
  loadPoints();
}

/* ------------------------------------------------------------ job sites ===
 *
 * Zoomed in to neighbourhood level, the map stops drawing "N permits in this
 * ZIP" and draws the job sites themselves, one dot per located permit. Each dot
 * says how it was located (the source's own point, the appraiser's parcel, or a
 * Census match on the address), because those differ in precision. Permits we
 * could not locate are not drawn at this zoom, and the note says so.
 */
const POINT_ZOOM = 14;
const METHOD_LABEL = {
  source: 'point published by the permit source',
  parcel: 'centre of the appraiser’s parcel',
  census: 'Census match on the job-site address',
};
const methodText = (m, quality) =>
  `${METHOD_LABEL[m] || 'located point'}${m === 'census' && quality === 'non_exact' ? ' (approximate match)' : ''}`;

let pointsTimer = null;
function loadPointsSoon() {
  clearTimeout(pointsTimer);
  pointsTimer = setTimeout(loadPoints, 250);
}

const showingPoints = () => map && map.getZoom() >= POINT_ZOOM;

async function loadPoints() {
  if (!map || !pointLayer) return;
  const mine = ++pointsReq;
  if (!showingPoints()) {
    pointLayer.clearLayers();
    $('map').classList.remove('is-points');
    baseMapNote = areaNote;
    if (!noteTimer) $('mapNote').textContent = baseMapNote;
    return;
  }
  const b = map.getBounds();
  const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(5)).join(',');
  let data;
  try {
    const r = await fetch(`/api/map/points?${new URLSearchParams({ ...lastFilters, bbox })}`);
    if (!r.ok) throw new Error(String(r.status));
    data = await r.json();
  } catch {
    return;   // the area pins stay; the map is an aid, not the results
  }
  if (mine !== pointsReq || !showingPoints()) return;

  pointLayer.clearLayers();
  $('map').classList.add('is-points');
  for (const pt of data.points) {
    const title = `${pt.address || 'Address not listed'} · ${methodText(pt.method, pt.quality)}`;
    const marker = L.marker([pt.lat, pt.lng], {
      icon: L.divIcon({
        className: 'pin-wrap',
        html: `<span class="site${pt.stage === 'pending' ? ' is-pending' : ''}${pt.method === 'census' && pt.quality === 'non_exact' ? ' is-approx' : ''}" title="${esc(title)}"></span>`,
        iconSize: [0, 0],
      }),
      keyboard: false, riseOnHover: true,
    });
    marker.on('click', () => openDetail(pt.id, null));
    marker.addTo(pointLayer);
  }
  const shown = data.points.length;
  baseMapNote = shown < data.inView
    ? `Showing the newest ${plural(shown, 'job site', 'job sites')} of ${data.inView.toLocaleString('en-US')} here. Zoom in for the rest.`
    : `${plural(shown, 'located job site', 'located job sites')} here. Permits we couldn’t locate aren’t drawn at this zoom.`;
  if (!noteTimer) $('mapNote').textContent = baseMapNote;
}

/** Frame the current pins, until the user takes the viewport over themselves. */
function fitPins() {
  if (!map || !mapPins.length || userMovedMap) return;
  map.fitBounds(L.latLngBounds(mapPins.map((p) => [p.lat, p.lng])),
    { padding: [56, 56], maxZoom: 12, animate: false });
  renderPins();   // fitBounds may not change the zoom, in which case no zoomend fires
}

/* Pins are merged in SCREEN space rather than by geography: at continental zoom
 * fifty Portland-area ZIPs land on the same few pixels and become an unreadable
 * pile. Bucketing by a fixed pixel grid means the map is legible at every zoom
 * and splits apart as you go in — and because the grid is in projected
 * coordinates, only zoom changes the grouping, never panning. */
const CLUSTER_PX = 68;

function renderPins() {
  if (!map) return;
  pinLayer.clearLayers();
  pinMarkers.clear();

  const zoom = map.getZoom();
  const cells = new Map();

  for (const pin of mapPins) {
    const pt = map.project([pin.lat, pin.lng], zoom);
    const cell = `${Math.floor(pt.x / CLUSTER_PX)}:${Math.floor(pt.y / CLUSTER_PX)}`;
    const group = cells.get(cell) ||
      { members: [], permits: 0, pending: 0, x: 0, y: 0 };
    group.members.push(pin);
    group.permits += pin.permits;
    group.pending += pin.pending;
    // Weight the centre by permit count so a cluster sits on its mass.
    group.x += pt.x * pin.permits;
    group.y += pt.y * pin.permits;
    cells.set(cell, group);
  }

  for (const group of cells.values()) {
    if (group.members.length === 1) addPin(group.members[0]);
    else addCluster(group, zoom);
  }
  paintPinState();
}

function pinHtml(count, pending, title, extra = '') {
  return `<span class="pin${extra}" title="${esc(title)}">${
    pending > 0 ? '<i class="wait" aria-hidden="true"></i>' : ''
  }${count.toLocaleString('en-US')}</span>`;
}

function addPin(pin) {
  const title = `${pin.label}${pin.sublabel ? ` · ${pin.sublabel}` : ''} — ` +
    `${plural(pin.permits, 'permit', 'permits')}` +
    (pin.pending ? `, ${pin.pending} waiting for approval` : '');

  const marker = L.marker([pin.lat, pin.lng], {
    icon: L.divIcon({ className: 'pin-wrap', html: pinHtml(pin.permits, pin.pending, title), iconSize: [0, 0] }),
    keyboard: false, riseOnHover: true,
  });
  marker.on('click', () => selectArea(pin));
  marker.on('mouseover', () => highlightCards(pin.key, true));
  marker.on('mouseout',  () => highlightCards(pin.key, false));
  marker.addTo(pinLayer);
  pinMarkers.set(pin.key, marker);
}

function addCluster(group, zoom) {
  const centre = map.unproject([group.x / group.permits, group.y / group.permits], zoom);
  const title = `${plural(group.permits, 'permit', 'permits')} across ` +
    `${plural(group.members.length, 'area', 'areas')}` +
    (group.pending ? `, ${group.pending} waiting for approval` : '') +
    ' — click to zoom in';

  const marker = L.marker(centre, {
    icon: L.divIcon({
      className: 'pin-wrap',
      html: pinHtml(group.permits, group.pending, title, ' is-cluster'),
      iconSize: [0, 0],
    }),
    keyboard: false, riseOnHover: true,
  });

  // Zoom to the cluster's own extent rather than filtering by it: a screen-space
  // cluster is an artefact of the current zoom, not a place anyone chose.
  marker.on('click', () => {
    userMovedMap = true;
    map.fitBounds(L.latLngBounds(group.members.map((m) => [m.lat, m.lng])),
      { padding: [60, 60], maxZoom: 13 });
  });
  marker.on('mouseover', () => group.members.forEach((m) => highlightCards(m.key, true)));
  marker.on('mouseout',  () => group.members.forEach((m) => highlightCards(m.key, false)));
  marker.addTo(pinLayer);

  // Registered under every member key, so hovering a card still finds the pin
  // that currently represents it.
  for (const m of group.members) pinMarkers.set(m.key, marker);
}

/** Clicking a pin drills into that one place. */
function selectArea(pin) {
  areaSelection = null;
  // Pins and the picker speak the same key vocabulary, so this is a direct set.
  // Clicking the place already selected clears it, matching the chips.
  setWhere($('where').value === pin.key ? '' : pin.key);
  userMovedMap = true;
  run({ resetPage: true });
}

/** The active place gets the accent treatment, matching the sidebar chips. */
function paintPinState() {
  const where = $('where').value;
  for (const [key, marker] of pinMarkers) {
    const el = marker.getElement() && marker.getElement().querySelector('.pin');
    if (!el) continue;
    const active = (where && key === where) ||
                   (areaSelection ? areaSelection.includes(key) : false);
    el.classList.toggle('is-active', Boolean(active));
  }
}

/** Hover in either direction links a card to the pin for its area. */
function highlightCards(key, on) {
  for (const card of document.querySelectorAll('.card')) {
    if (card.dataset.area === key) card.classList.toggle('is-linked', on);
  }
}
function highlightPin(key, on) {
  const marker = key && pinMarkers.get(key);
  const el = marker && marker.getElement() && marker.getElement().querySelector('.pin');
  if (el) el.classList.toggle('is-hot', on);
}

/** "Search this area" — every pin whose centroid is in the viewport. */
function searchVisibleArea() {
  const bounds = map.getBounds();
  // Test the real area centroids, not the markers — a cluster's marker sits at
  // a weighted average that may fall outside the viewport its members are in.
  const keys = mapPins.filter((p) => bounds.contains([p.lat, p.lng])).map((p) => p.key);
  // Panning somewhere we hold nothing is a real answer, so send the empty set
  // rather than quietly leaving the previous results on screen.
  areaSelection = keys;
  setWhere('');
  $('searchArea').hidden = true;
  run({ resetPage: true });
}

/* ------------------------------------------------------------ geolocation */

/** Great-circle distance in kilometres. */
function distanceKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Every area we hold, ignoring filters — so "near me" can find coverage the
 *  current filters happen to exclude. */
async function loadAllAreas() {
  try {
    const data = await fetch('/api/map?stage=any').then((r) => r.json());
    allAreas = data.pins || [];
  } catch { allAreas = []; }
}

const NEAR_KM = 60;   // roughly "this metro", not "this street"

function useMyLocation() {
  const status = $('geoStatus');
  const btn = $('useLocation');

  if (!navigator.geolocation) {
    status.textContent = 'This browser has no location support — enter a postal code instead.';
    return;
  }
  if (!window.isSecureContext) {
    status.textContent = 'Location needs HTTPS (or localhost). Enter a postal code instead.';
    return;
  }

  btn.disabled = true;
  $('useLocationLabel').textContent = 'Locating…';
  status.textContent = '';

  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      btn.disabled = false;
      $('useLocationLabel').textContent = 'Use my location';

      const me = { lat: coords.latitude, lng: coords.longitude };
      if (!allAreas.length) {
        status.textContent = 'Coverage list unavailable — try again in a moment.';
        return;
      }

      let best = null;
      for (const area of allAreas) {
        const km = distanceKm(me, area);
        if (!best || km < best.km) best = { area, km };
      }

      const miles = Math.round(best.km * 0.621371);
      if (map) { map.setView([me.lat, me.lng], best.km < NEAR_KM ? 11 : 9); userMovedMap = true; }

      if (best.km <= NEAR_KM) {
        selectArea(best.area);
        status.textContent = `Nearest area we cover: ${best.area.label} (${miles} mi away).`;
      } else {
        // Being outside coverage is the honest answer, and a more useful one
        // than dropping them into a city 1,200 miles away without saying so.
        status.textContent =
          `You're about ${miles.toLocaleString('en-US')} mi from the nearest area we cover ` +
          `(${best.area.label}). Filters left unchanged.`;
      }
      paintPinState();
    },
    (err) => {
      btn.disabled = false;
      $('useLocationLabel').textContent = 'Use my location';
      status.textContent = err.code === err.PERMISSION_DENIED
        ? 'Location permission denied — enter a postal code instead.'
        : `Couldn't get your location (${esc(err.message)}).`;
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

// A phone as a tel: link when it normalizes to a dialable number (links.js),
// else as plain text. Owner and applicant phones are never rendered
// (CLAUDE.md hard rule 5); only the contractor's business contact is.
const phoneLink = (v, attrs = '') => {
  if (!v) return '';
  const href = telHref(v);
  return href
    ? `<a href="${esc(href)}"${attrs}>${esc(phone(v))}</a>`
    : `<span>${esc(phone(v))}</span>`;
};

/* ------------------------------------------------------------------ drawer */

const row = (label, value, cls = '') =>
  (value === null || value === undefined || value === '' || value === 0)
    ? '' : `<dt>${esc(label)}</dt><dd class="${cls}">${esc(value)}</dd>`;

/**
 * Everything we hold about one permit, shown in-app. The source link at the
 * bottom is provenance only — nothing here requires leaving to read it.
 */
async function openDetail(id, cardEl) {
  const dlg = $('detail');
  lastFocused = cardEl || null;

  for (const c of document.querySelectorAll('.card[aria-current]')) c.removeAttribute('aria-current');
  if (cardEl) cardEl.setAttribute('aria-current', 'true');

  $('dAddr').textContent = 'Loading…';
  $('dType').textContent = '';
  $('dStage').innerHTML = '';
  $('dBody').innerHTML = skeletons(3);
  $('dFoot').innerHTML = '';
  if (!dlg.open) dlg.showModal();

  let p;
  try {
    p = await fetch('/api/permits/' + encodeURIComponent(id)).then((r) => r.json());
  } catch (err) {
    $('dAddr').textContent = 'Could not load permit';
    $('dBody').innerHTML = `<p class="callout">${esc(err.message)}</p>`;
    return;
  }

  $('dAddr').textContent = p.address || 'Address not listed';
  $('dType').textContent = p.permit_type || '';
  $('dStage').innerHTML = stageBadge(p);

  const scores = Object.entries(p.trade_scores || {})
    .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([t, v]) => `${t} ${v}`).join(', ');

  const fees = p.fees || [];
  const inspections = p.inspections || [];

  $('dBody').innerHTML = `
    <div class="sect">Permit</div>
    <dl class="kv">
      ${row('Status', p.status_raw)}
      ${row('Stage', p.status_stage)}
      ${row('Filed', fmtDate(p.filed_date))}
      ${row('Permit no.', p.permit_number)}
      ${row('Type', p.permit_type)}
      ${row('Valuation', money(p.valuation), 'money')}
      ${row('Description', p.work_description)}
    </dl>

    <div class="sect">Location</div>
    <dl class="kv">
      ${row('Address', p.address)}
      ${row('City', p.city)}
      ${row('Postal code', p.zip, 'num')}
      ${row('Jurisdiction', p.jurisdiction)}
    </dl>

    ${(p.contractor_name || p.contractor_phone || p.contractor_withheld) ? `
      <div class="sect">Contractor</div>
      <dl class="kv">
        ${p.contractor_withheld ? '<dt>Company</dt><dd>Individual (name and contact withheld)</dd>' : ''}
        ${p.contractor_name ? `<dt>Company</dt><dd>${
          isRealContractor(p.contractor_name)
            ? `<button type="button" class="link-btn" data-open-contractor="${esc(p.contractor_name)}"
                  >${esc(p.contractor_name)}</button>`
            : esc(p.contractor_name)}</dd>` : ''}
        ${p.contractor_phone ? `<dt>Phone</dt><dd>${phoneLink(p.contractor_phone)}</dd>` : ''}
        ${row('Trade', p.contractor_trade)}
        ${row('Licence', p.contractor_licence)}
        ${row('City', p.contractor_city)}
      </dl>` : ''}

    ${[p.parcel_number, p.parcel_lot, p.construction_type].some(Boolean) ? `
      <div class="sect">Property</div>
      <dl class="kv">
        ${row('Parcel no.', p.parcel_number, 'num')}
        ${row('Block', p.parcel_block)}
        ${row('Lot', p.parcel_lot)}
        ${row('Subdivision', p.parcel_subdivision)}
        ${row('Construction', p.construction_type)}
        ${row('Construction (other)', p.other_construction_type)}
      </dl>` : ''}

    ${(p.fees_paid !== null || fees.length) ? `
      <div class="sect">Fees</div>
      <dl class="kv">
        ${row('Paid', money(p.fees_paid), 'money')}
        ${row('Outstanding', money(p.fees_balance), 'money')}
      </dl>
      ${fees.length ? `<table class="mini">
        <thead><tr><th>Date</th><th>Invoice</th><th class="r">Amount</th></tr></thead>
        <tbody>${fees.map((f) => `<tr>
          <td>${esc(f.date || '')}</td>
          <td>${esc(f.invoice || '—')}</td>
          <td class="r">${esc(f.amount || '')}</td></tr>`).join('')}</tbody></table>` : ''}` : ''}

    ${inspections.length ? `
      <div class="sect">Inspections</div>
      <table class="mini">
        <thead><tr><th>Type</th><th>Date</th><th>Result</th></tr></thead>
        <tbody>${inspections.map((i) => `<tr>
          <td>${esc(i.type || '—')}${i.inspector ? `<br><span class="check-count">${esc(i.inspector)}</span>` : ''}</td>
          <td>${esc(i.date || '—')}</td>
          <td class="res">${esc(i.result || i.status || '—')}</td></tr>`).join('')}</tbody></table>` : ''}

    <div id="dMore" aria-live="polite"><div class="sect">Lifecycle, property and licences</div><p class="check-count">Loading…</p></div>

    <div class="sect">Record</div>
    <dl class="kv">
      ${row('Source', p.source_area)}
      ${row('First seen', p.first_seen_at ? new Date(p.first_seen_at).toLocaleString() : '')}
      ${row('Last checked', p.last_seen_at ? new Date(p.last_seen_at).toLocaleString() : '')}
      ${row('Trade scores', scores)}
    </dl>`;

  // On a phone the list and the map are never on screen together, so tapping a
  // card cannot move a map you cannot see. This is how you get there.
  const mapAction = (p.location || areaKeyOf(p))
    ? `<button type="button" class="btn" id="dShowMap">
         <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2-6-2ZM9 4v14M15 6v14"/>
         </svg>
         <span>${p.location ? 'Show job site on map' : 'Show area on map'}</span>
       </button>` : '';

  const sourceUrl = safeHttpUrl(p.permit_url);
  $('dFoot').innerHTML = `${mapAction}${sourceUrl
    ? `<span>Source record, for verification:</span>
       <a href="${esc(sourceUrl)}" target="_blank" rel="noopener">open the county portal →</a>`
    : '<span>No source link recorded for this permit.</span>'}`;

  if (mapAction) {
    $('dShowMap').addEventListener('click', () => {
      // Below the split breakpoint the map needs to be the visible pane first.
      if ($('app').dataset.view === 'list') setView(splitFits() ? 'split' : 'map');
      $('detail').close();
      flyToPermit(p);
    });
  }
  loadJobExtras(p.id);
}

/* ---------------------------------------------------- job page panels ===
 *
 * What the job page (/pilot/live/job.html) knows beyond the permit row: the
 * lifecycle and the application behind it, the appraiser's property facts, the
 * matched company profile and its state licences. Fetched only when a panel
 * opens, so the search itself loads nothing extra. Missing reads as missing.
 */
const LIFECYCLE = {
  pre_application: 'Pre-application', submitted: 'Submitted', in_review: 'In review', corrections: 'Corrections',
  approved: 'Approved, not issued', issued: 'Issued', inspections: 'Inspections', completed: 'Completed',
  expired: 'Expired', withdrawn: 'Withdrawn', cancelled: 'Cancelled', denied: 'Denied', unknown: 'Stage not mapped',
};
const LICENCE_BOARD = { 'fl-dbpr': 'Florida DBPR', 'tx-tdlr': 'Texas TDLR' };
const num = (v, unit = '') => (v == null ? '' : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 })}${unit}`);
let extrasFor = null;

async function loadJobExtras(id) {
  extrasFor = id;
  const box = $('dMore');
  let j;
  try {
    const r = await fetch(`/api/pilot/jobs/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(`Request failed (${r.status})`);
    j = await r.json();
  } catch (err) {
    if (extrasFor === id && box.isConnected) box.innerHTML = `<div class="sect">Lifecycle, property and licences</div><p class="check-count">Could not load: ${esc(err.message)}</p>`;
    return;
  }
  if (extrasFor !== id || !box.isConnected) return;   // another permit was opened meanwhile

  const lc = j.lifecycle;
  const apps = (lc && lc.applications) || [];
  const lifecycle = lc ? `
    <div class="sect">Lifecycle</div>
    <dl class="kv">
      ${row('Stage', LIFECYCLE[lc.stage] || lc.stage)}
      ${row('Applied', lc.submittedOn ? `${fmtDate(lc.submittedOn)} (the source’s date)` : '')}
      ${row('Stage since', lc.stageSince ? fmtDate(lc.stageSince) : '')}
      ${row('First seen by us', lc.firstSeenAt ? `${fmtDate(lc.firstSeenAt)}${lc.firstSeenStage ? `, while ${(LIFECYCLE[lc.firstSeenStage] || lc.firstSeenStage).toLowerCase()}` : ''}` : '')}
      ${apps.map((a) => `<dt>Application</dt><dd>${esc(a.permitNumber)} · ${esc(LIFECYCLE[a.stage] || a.stage)} · submitted ${esc(a.submittedOn ? fmtDate(a.submittedOn) : 'date not published')}<br><span class="check-count">Linked by ${esc(a.link.detail)}</span></dd>`).join('')}
    </dl>` : '';

  const pr = j.property;
  const v = (pr && pr.provenance) || {};
  const property = pr ? `
    <div class="sect">Property</div>
    <dl class="kv">
      ${row('Land use', pr.landUse || pr.landUseCode)}
      ${row('Year built', pr.yearBuilt)}
      ${row(pr.heatedSqft != null ? 'Heated area' : 'Building area', num(pr.heatedSqft ?? pr.buildingSqft, ' sq ft'))}
      ${row('Lot', num(pr.lotSqft, ' sq ft'))}
      ${row('Assessed value', pr.assessedValue != null ? money(pr.assessedValue) : '')}
    </dl>
    <p class="check-count">Source: ${esc(v.attribution || v.source || 'appraiser')}${pr.valueNote ? ` · ${esc(pr.valueNote)}` : ''}. Owner, sale and exemption fields are not collected.</p>`
    : '<div class="sect">Property</div><p class="check-count">No appraiser record joined to this permit.</p>';

  const loc = j.location;
  const located = loc ? `<p class="check-count">Job site located by ${esc(METHOD_LABEL[loc.method] || loc.method)}${loc.quality === 'non_exact' ? ' (approximate)' : ''}.</p>` : '';

  const gc = j.gc;
  const licences = (j.gcRegistry || []).map((r) => `<dt>Licence</dt><dd>${esc(LICENCE_BOARD[r.provider] || r.provider)} ${esc(r.number)} · ${
    r.expiresOn ? (r.expired ? `expired ${esc(fmtDate(r.expiresOn))}` : `valid to ${esc(fmtDate(r.expiresOn))}`) : 'no expiry published'}</dd>`).join('');
  const company = gc && gc.id ? `
    <div class="sect">Company record</div>
    <dl class="kv">
      <dt>Profile</dt><dd><a href="/pilot/live/contractor.html?id=${encodeURIComponent(gc.id)}">${esc(gc.name)} →</a></dd>
      ${j.gcHiring ? row('Building jobs', j.gcHiring.buildingJobs) : ''}
      ${licences}
    </dl>
    ${licences ? '' : '<p class="check-count">No state licence record matched yet.</p>'}` : '';

  box.innerHTML = `${lifecycle}${property}${located}${company}
    <p class="check-count"><a href="/pilot/live/job.html?id=${encodeURIComponent(id)}">Open the full job page →</a> trade permits on this job and who the GC hires.</p>`;
}

/* ============================================================== layout ===
 *
 * Two independent switches, both held as data attributes on .app so the CSS
 * owns the arithmetic: data-view (list | split | map) and data-filters
 * (open | closed). Hiding a pane collapses its grid column, so whatever is
 * left grows to fill the width.
 *
 * The preference is per-viewer convenience, so it lives in localStorage rather
 * than the URL — a shared link should carry the search, not someone else's
 * pane arrangement. Storage can throw in a private window, so every access is
 * guarded and the app works without it.
 */

const VIEWS = ['list', 'split', 'map'];
const STORE_KEY = 'permits.layout';

const readStore = () => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
};
const writeStore = (patch) => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...readStore(), ...patch })); } catch { /* ignore */ }
};

/** Split needs two panes' worth of width; below that it degrades to the list. */
const splitFits = () => matchMedia('(min-width: 1181px)').matches;

function setView(view, { remember = true } = {}) {
  const wanted = VIEWS.includes(view) ? view : 'split';
  const applied = (wanted === 'split' && !splitFits()) ? 'list' : wanted;

  $('app').dataset.view = applied;
  for (const btn of $('viewToggle').querySelectorAll('[data-view]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === applied));
  }
  if (remember) writeStore({ view: wanted });   // remember the wish, not the clamp
  afterLayoutChange();
}

function setFilters(open, { remember = true } = {}) {
  $('app').dataset.filters = open ? 'open' : 'closed';
  $('filtersToggle').setAttribute('aria-expanded', String(open));
  if (remember) writeStore({ filters: open ? 'open' : 'closed' });
  afterLayoutChange();
}

/** Leaflet measures its container once; any column resize invalidates that. */
function afterLayoutChange() {
  if (!map) return;
  // Wait for the grid to settle before re-measuring, or Leaflet reads the old
  // width and renders a band of grey tiles where the pane just grew.
  requestAnimationFrame(() => {
    map.invalidateSize();
    fitPins();
    renderPins();
  });
}

/**
 * Centres the map on a permit: on its job site when we hold a located point
 * for it, and the note says how that point was found; otherwise on its ZIP or
 * city centre, and the note says it is the area, not the address. A map that
 * silently centres on a neighbourhood after you clicked one house would be
 * claiming a precision it does not have.
 */
function flyToPermit(p) {
  if (!map || $('app').dataset.view === 'list') return;

  if (p.location) {
    userMovedMap = true;
    map.setView([p.location.lat, p.location.lng], Math.max(map.getZoom(), 16), { animate: true });
    showTransientMapNote(`Centred on this job site: ${methodText(p.location.method, p.location.quality)}`);
    return;
  }

  const key = areaKeyOf(p);
  if (!key) return;
  const area = mapPins.find((a) => a.key === key) || allAreas.find((a) => a.key === key);
  if (!area) return;

  userMovedMap = true;   // an explicit destination outranks auto-fitting
  map.setView([area.lat, area.lng], Math.min(Math.max(map.getZoom(), 12), POINT_ZOOM - 1), { animate: true });

  for (const [k, marker] of pinMarkers) {
    const el = marker.getElement() && marker.getElement().querySelector('.pin');
    if (el) el.classList.toggle('is-hot', k === key);
  }
  showTransientMapNote(`Centred on ${area.label}: area centre, we hold no point for this address`);
}

let noteTimer = null;
function showTransientMapNote(text) {
  clearTimeout(noteTimer);
  $('mapNote').textContent = text;
  noteTimer = setTimeout(() => { noteTimer = null; $('mapNote').textContent = baseMapNote; }, 7000);
}

/* -------------------------------------------------------------- responsive */

// Above the breakpoint the sidebar is a static column; below it, a modal sheet.
// Same markup either way — only how the dialog is opened changes.
const wide = matchMedia('(min-width: 981px)');

function syncSidebar() {
  const sidebar = $('sidebar');
  if (wide.matches) {
    $('freshPop').hidden = true;
    if (!sidebar.open) sidebar.setAttribute('open', '');   // static, not modal
  } else if (sidebar.open) {
    sidebar.close();
  }
  // Re-apply the stored view: crossing 1181px changes whether split is possible.
  setView(readStore().view || 'split', { remember: false });
}

/* ------------------------------------------------------------------- wiring */

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

const runNow = () => run({ resetPage: true });
const runSoon = debounce(runNow, TYPING_DELAY);

for (const id of TEXT_FILTERS) $(id).addEventListener('input', runSoon);
for (const id of PICK_FILTERS) $(id).addEventListener('change', runNow);
$('hasContact').addEventListener('change', runNow);
$('sort').addEventListener('change', runNow);
$('stageGroup').addEventListener('change', runNow);

// Enter in a text field should search immediately rather than wait out the debounce.
$('filters').addEventListener('submit', (e) => { e.preventDefault(); runNow(); });
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runNow(); } });

// One delegated handler: contractor names appear in cards, in the permit
// drawer and under the sidebar field.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-open-contractor]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  openContractor(btn.dataset.openContractor, { from: $('detail').open ? $('detail') : null });
});

$('contractor').addEventListener('input', (e) => loadContractorSuggestions(e.target.value.trim()));

$('cClose').addEventListener('click', () => $('contractorPanel').close());
$('contractorPanel').addEventListener('click', (e) => {
  if (e.target === $('contractorPanel')) $('contractorPanel').close();
});
$('contractorPanel').addEventListener('close', () => {
  // Coming from a permit, go back to it rather than dumping the user in the list.
  if (contractorReturnsTo && !contractorReturnsTo.open) contractorReturnsTo.showModal();
  contractorReturnsTo = null;
});

$('activeFilters').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-clear]');
  if (btn) clearFilter(btn.dataset.clear);
});

$('clearAll').addEventListener('click', () => {
  areaSelection = null;
  unmatchedLocation = null;
  userMovedMap = false;
  for (const id of [...TEXT_FILTERS, ...PICK_FILTERS]) $(id).value = '';
  $('hasContact').checked = false;
  $('sort').value = 'newest';
  for (const [k] of STAGES) $('stage-' + k).checked = DEFAULT_STAGES.includes(k);
  runNow();
});

$('pager').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-page]');
  if (!btn) return;
  page += btn.dataset.page === 'next' ? 1 : -1;
  run();
  $('feed').scrollTo({ top: 0, behavior: 'smooth' });
});

// Picking a place by hand supersedes a map-drawn area; keeping both would AND
// them together and quietly return nothing.
$('where').addEventListener('change', () => { areaSelection = null; unmatchedLocation = null; });

$('searchArea').addEventListener('click', searchVisibleArea);
$('useLocation').addEventListener('click', useMyLocation);

$('viewToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (btn) setView(btn.dataset.view);
});

// The map's own Close button is just "show me the list".
$('mapClose').addEventListener('click', () => setView('list'));

$('filtersToggle').addEventListener('click', () => {
  const sidebar = $('sidebar');
  if (wide.matches) {
    // A column, so this collapses it and the remaining panes take the width.
    setFilters($('app').dataset.filters === 'closed');
  } else if (sidebar.open) {
    sidebar.close();
  } else {
    sidebar.showModal();
  }
});

$('sheetApply').addEventListener('click', () => $('sidebar').close());

$('sidebarClose').addEventListener('click', () => {
  if (wide.matches) setFilters(false); else $('sidebar').close();
});

$('dClose').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('close', () => {
  for (const c of document.querySelectorAll('.card[aria-current]')) c.removeAttribute('aria-current');
  // Return focus to the card the drawer was opened from.
  if (lastFocused && lastFocused.isConnected) lastFocused.focus();
  lastFocused = null;
});
// Clicking the backdrop closes the drawer.
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) $('detail').close(); });

wide.addEventListener('change', syncSidebar);

/* --------------------------------------------------------------- bootstrap */

buildStageCheckboxes();
applyUrl();

const savedLayout = readStore();
setView(savedLayout.view || 'split', { remember: false });
setFilters(savedLayout.filters !== 'closed', { remember: false });

syncSidebar();
initMap();
loadFreshness();
initScreensMenu();
loadAllAreas();
loadOptions().finally(run);
