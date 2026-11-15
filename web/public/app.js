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

// The Stage filter's groups and their labels: one vocabulary (stages.js).
const STAGES = window.Stages.GROUPS;
// Matches DEFAULT_STAGES in src/status.js: work that might still happen.
const DEFAULT_STAGES = ['pending', 'approved'];

const PAGE_SIZE = 25;

// Text inputs debounce; selects and checkboxes fire immediately.
const TYPING_DELAY = 300;

const TEXT_FILTERS = ['contractor', 'minValuation', 'q'];
// No trade filter: it read our keyword fit scores, an inference (ADR-26).
const PICK_FILTERS = ['from', 'to'];

// Permit types: a multi-select with search (location.js picker), sent as
// `permitType=a|b`. Some raw types contain commas; none contains a pipe.
const TYPE_SEP = '|';
let typeSelection = [];
let typePicker = null;

// The Saved view (/saved): the user's saved permits instead of the search.
const SAVED_MODE = location.pathname === '/saved';
// The Contractors tab (/contractors): companies on the filtered permits.
const CONTRACTORS_MODE = location.pathname === '/contractors';
let contractorIdsFilter = '';   // contractorIds=1,2: one company's permits (from the Contractors tab)
let contractorLabel = '';       // its name, for the chip

/* Location is one multi-select (location.js) whose value is `areaSelection`: a
   list of keys in the map's vocabulary — `a:TX` (a broad area, expanded by the
   server), `c:MIAMI|FL`, `z:78704` — sent as `areas=`. Links made by the old
   UI (`zip=`, `city=`, `jurisdiction=`) are still read: see applyUrl(). */
const asAreaKey = (filters) =>
  (filters.zip ? `z:${filters.zip}` : (filters.city ? `c:${filters.city.toUpperCase()}|${(filters.state || '').toUpperCase()}` : ''));

let page = 1;
let lastFocused = null;   // card to restore focus to when the drawer closes
let projectReturn = null;  // project to go back to from a permit opened in its timeline
// Group permits into projects (web/projects.js); `group=0` in the URL shows raw permits.
let grouping = true;
let lastInferences = false;  // whether the server shows inferred links and stages
// The lens (web/lens_config.js): `lens=sub.drywall,gc` in the URL, else the one
// saved by the welcome popup. `lens=off` keeps it but shows everything.
let lensParam = '';
let lensOff = false;
const savedLensParam = () => { try { return (JSON.parse(localStorage.getItem('contractos.lens.v1')) || {}).param || ''; } catch { return ''; } };
const lensActive = () => Boolean(lensParam) && !lensOff;
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
let pendingLegacyKey = '';    // an old `zip=`/`city=` link, resolved once places load
let unmatchedLocation = null; // a URL location the picker cannot represent
let jurisdictionFilter = '';  // an old `jurisdiction=` link; no control, shown as a chip
let areaIndex = null;         // every place we hold (LocationPicker.buildIndex)
let locPicker = null;         // the sidebar's location picker
let baseMapNote = '';         // the standing map note, restored after a transient one
let pointLayer = null;        // located job sites, drawn instead of area pins when zoomed in
let pointsReq = 0;            // guards against a slow viewport overwriting a newer one
let lastFilters = {};         // the filters the map was last drawn for
let lastRunKey = '';          // the filter set the list was last run for
let areaNote = '';            // the area-pin note (unplaced permits), kept while zoomed in

/* ------------------------------------------------------------ formatting */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// Valuations are round and read better without cents ($278,000); fees are exact
// and $141.90 must not display as $142.
/**
 * JSON from our API, or an Error a person can read. A failed response that is
 * a web page rather than JSON is what you get when another app answers on this
 * address (a dev server left on the port), so the message says so instead of
 * "Unexpected token '<'". The Error carries `status` and the JSON body as `data`.
 */
async function getJSON(url, opts) {
  let r;
  try {
    r = await fetch(url, opts);
  } catch {
    throw new Error("Couldn't reach the server. Check your connection, or that the Contractos server is running.");
  }
  const isJson = (r.headers.get('content-type') || '').includes('application/json');
  if (!isJson) {
    const err = new Error(`The server answered with a web page instead of data (HTTP ${r.status}). `
      + 'Another app may be running on this address; open Contractos on its own port.');
    err.status = r.status;
    throw err;
  }
  let data;
  try { data = await r.json(); } catch { throw new Error('The server sent data that could not be read.'); }
  if (!r.ok) {
    const err = new Error(data.error || `Request failed (HTTP ${r.status})`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

const money = (v) => {
  const n = Number(v);
  // $1 is a placeholder some portals file instead of a value (2,444 Austin
  // permits), so it reads as missing, like a null.
  if (!(n > 1)) return null;
  const cents = Number.isInteger(n) ? 0 : 2;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: cents, maximumFractionDigits: cents });
};

/**
 * A declared value, short ("$420K", "$1.3M", "$8.5K", "$950") for cards and
 * headers, as HTML; '' when missing or a $1 placeholder, so nothing shows.
 * $1 billion or more is shown as filed but flagged: those are filing errors
 * (five permits on one Austin lot at $8.1B each), not job values.
 */
const ODD_VALUE = 1e9;
function shortMoney(n) {
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K'], [1, '']];
  for (let i = 0; i < units.length; i += 1) {
    const [d, u] = units[i];
    if (n < d && i < units.length - 1) continue;
    const x = n / d;
    const r = x < 10 && d > 1 ? Math.round(x * 10) / 10 : Math.round(x);
    // $999,999 rounds to 1000K: say $1M instead.
    if (r >= 1000 && i > 0) return `$1${units[i - 1][1]}`;
    return `$${r}${u}`;
  }
  return '';
}
function valueTag(v, cls = 'card-value', repeats = 0) {
  const n = Number(v);
  if (!(n > 1)) return '';
  const full = `$${Math.round(n).toLocaleString('en-US')}`;
  // The same value on several permits: the project's figure, not this one's (values.js).
  if (Number(repeats) > 1) {
    return `<span class="${cls} is-odd" title="${esc(window.Values.repeatNote(n, repeats))}">${shortMoney(n)}<span class="sub"> ${esc(window.Values.repeatSuffix(repeats))}</span></span>`;
  }
  if (n >= ODD_VALUE) {
    return `<span class="${cls} is-odd" title="Declared as ${full} on the permit. Unusually high: likely a filing error, shown as filed.">${shortMoney(n)}<span aria-hidden="true"> ?</span><span class="visually-hidden"> (as filed, unusually high)</span></span>`;
  }
  return `<span class="${cls}" title="Declared value ${full}">${shortMoney(n)}</span>`;
}

// A date-only value is read as local midnight; a full timestamp as itself.
const fmtDate = (d) => (d
  ? new Date(String(d).length === 10 ? `${d}T00:00:00` : d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  : null);

// Stored as bare digits so they compare reliably; formatted only for display.
const phone = (v) => {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);   // +1 E.164 from contact records
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

  if (areaSelection && areaSelection.length) {
    f.areas = areaSelection.join(',');
  } else if (unmatchedLocation) {
    // Pass an old link's place through unchanged so the API can answer "we
    // don't cover this", the honest response the empty state is written for.
    Object.assign(f, unmatchedLocation);
  }
  if (jurisdictionFilter) f.jurisdiction = jurisdictionFilter;
  if (typeSelection.length) f.permitType = typeSelection.join(TYPE_SEP);
  if (!grouping) f.group = '0';
  if (lensParam) f.lens = lensOff ? 'off' : lensParam;
  if ($('hasContact').checked) f.hasContact = 'true';
  // The owner-builder filter is hidden (ADR-10, index.html); a hidden box never filters.
  if ($('ownerBuilder').checked && !$('ownerBuilder').closest('[hidden]')) f.ownerBuilder = 'true';

  const stages = checkedStages();
  // Three cases, so the URL stays as short as the query is plain:
  //   all five  -> `any`, the opt-out db/queries.js already understands
  //   default   -> omitted; the API applies DEFAULT_STAGES itself
  //   otherwise -> the explicit list
  if (stages.length === STAGES.length) f.stage = 'any';
  else if (stages.length && !isDefaultStages(stages)) f.stage = stages.join(',');

  const sort = $('sort').value;
  // The Contractors tab sorts companies (csort); the Leads list sorts permits.
  if (CONTRACTORS_MODE) { if (sort && sort !== 'active') f.csort = sort; } else if (sort && sort !== 'newest') f.sort = sort;
  if (contractorIdsFilter) { f.contractorIds = contractorIdsFilter; if (contractorLabel) f.contractorLabel = contractorLabel; }
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
    if (p.has(id)) $(id).value = p.get(id);
  }
  areaSelection = p.get('areas') ? p.get('areas').split(',').filter(Boolean) : null;
  jurisdictionFilter = p.get('jurisdiction') || '';
  grouping = p.get('group') !== '0';
  const lp = p.get('lens');
  lensOff = lp === 'off';
  lensParam = lp && !['off', '0', '1'].includes(lp) ? lp : savedLensParam();
  $('groupToggle').checked = grouping;
  typeSelection = p.get('permitType') ? p.get('permitType').split(TYPE_SEP).map((t) => t.trim()).filter(Boolean) : [];
  $('ownerBuilder').checked = p.get('ownerBuilder') === 'true' && !$('ownerBuilder').closest('[hidden]');
  // An old `zip=`/`city=` link is turned into a picker key once the places are
  // loaded (loadOptions). The raw params are kept meanwhile, because a URL can
  // name a place we hold nothing for, and answering that with the whole table
  // would be worse than answering nothing.
  pendingLegacyKey = areaSelection ? '' : asAreaKey({ zip: p.get('zip'), city: p.get('city'), state: p.get('state') });
  unmatchedLocation = null;
  if (pendingLegacyKey) {
    unmatchedLocation = {};
    for (const key of ['zip', 'city', 'state']) {
      if (p.get(key)) unmatchedLocation[key] = p.get(key);
    }
  }
  $('hasContact').checked = p.get('hasContact') === 'true';
  if (CONTRACTORS_MODE) { if (p.has('csort')) $('sort').value = p.get('csort'); } else if (p.has('sort')) $('sort').value = p.get('sort');
  contractorIdsFilter = p.get('contractorIds') || '';
  contractorLabel = p.get('contractorLabel') || '';
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
      <span class="stage-dot ${key}" aria-hidden="true"></span>
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
    getJSON('/api/areas'),
    getJSON('/api/filters'),
  ]);

  typePicker.setIndex(LocationPicker.buildListIndex(filters.permitTypes, { kind: 'type', key: 'permit_type', label: 'permit_type' }));
  typePicker.setValue(typeSelection);

  areaIndex = LocationPicker.buildIndex(areas);
  locPicker.setIndex(areaIndex);
  resolveLegacyKey();
  locPicker.setValue(areaSelection || []);
  areasReady(areaIndex);
}

/**
 * An old `zip=`/`city=` link becomes a picker key when we hold that place.
 * `?city=MIAMI` with no state builds `c:MIAMI|`, so match on the city alone
 * rather than dropping it. A place we don't hold stays in unmatchedLocation,
 * so the API can say it isn't covered.
 */
function resolveLegacyKey() {
  const key = pendingLegacyKey;
  pendingLegacyKey = '';
  if (!key) return;
  let match = areaIndex.byKey.has(key) ? key : null;
  if (!match && key.startsWith('c:') && key.endsWith('|')) {
    const it = areaIndex.items.find((x) => x.key.startsWith(key));
    match = it ? it.key : null;
  }
  if (match) { areaSelection = [match]; unmatchedLocation = null; }
}

/** Replaces the location selection (picker, map pins and popup all land here). */
function setAreas(keys, { rerun = true } = {}) {
  // From the Saved view (the lens popup), a location means "show me leads there".
  if (SAVED_MODE) {
    const q = new URLSearchParams();
    if (keys && keys.length) q.set('areas', keys.join(','));
    if (lensParam) q.set('lens', lensParam);
    location.href = `/${q.toString() ? `?${q}` : ''}`;
    return;
  }
  areaSelection = keys && keys.length ? [...new Set(keys)] : null;
  unmatchedLocation = null;
  userMovedMap = false;
  if (locPicker) locPicker.setValue(areaSelection || []);
  if (rerun) run({ resetPage: true });
}

/** Adds or removes one place, keeping the rest. */
function toggleArea(key) {
  const now = areaSelection || [];
  setAreas(now.includes(key) ? now.filter((k) => k !== key) : [...now, key]);
}

// The welcome popup (lens.js) needs the places and a way to set the location.
let areasReady;
window.Leads = {
  areas: new Promise((resolve) => { areasReady = resolve; }),
  getAreas: () => [...(areaSelection || [])],
  setAreas: (keys) => setAreas(keys),
  // The popup: a location and a lens together, one search.
  apply: ({ areas = [], lens = '' } = {}) => {
    lensParam = lens || '';
    lensOff = false;
    setAreas(areas);
  },
};

const titleCase = (v) => String(v || '').toLowerCase()
  .replace(/\b[a-z]/g, (c) => c.toUpperCase());

/* --------------------------------------------------------------- freshness */

/**
 * "Latest permits" is a claim about recency. If the newest ingest is two weeks
 * old, that belongs in the header, not in grey 12px text below the form.
 */
async function loadFreshness() {
  let sources = [];
  try {
    ({ sources = [] } = await getJSON('/api/freshness'));
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
  try { ({ enrichment = [] } = await getJSON('/api/credits')); } catch { enrichment = []; }
  const permitCredits = sources.filter((s) => s.attribution).map((s) => `${s.label || s.source_area}: ${s.attribution}`);
  const lines = [...permitCredits, ...enrichment.map((e) => e.attribution)];
  $('credits').innerHTML = `
    <p><b>Sources.</b> ${lines.map(esc).join(' · ') || 'Public permit records.'}</p>
    <p>Contacts come from the public permit record; individuals are withheld. Not affiliated with or endorsed by these agencies. Data as published, may be incomplete.</p>`;
}

/* ------------------------------------------------------------ active chips */

const CHIP_LABELS = {
  zip: 'ZIP', city: 'City', jurisdiction: 'Jurisdiction', permitType: 'Type',
  trade: 'Trade', minValuation: 'Min value', contractor: 'Contractor',
  from: 'From', to: 'To', q: 'Search', hasContact: 'Contact', stage: 'Stage',
  areas: 'Map area', ownerBuilder: 'Owner',
};

function paintActiveFilters(filters) {
  const stages = checkedStages();
  const chips = [];

  // Every chosen place is one chip, named after the first: "Austin area +2".
  if (areaSelection && areaSelection.length) {
    const first = LocationPicker.labelFor(areaSelection[0], areaIndex);
    chips.push(['areas', 'Location', areaSelection.length > 1 ? `${first} +${areaSelection.length - 1}` : first]);
  } else if (unmatchedLocation) {
    chips.push(['zip', 'Location',
      unmatchedLocation.zip || [unmatchedLocation.city, unmatchedLocation.state].filter(Boolean).join(', ')]);
  }

  if (typeSelection.length) {
    chips.push(['permitType', 'Type', typeSelection.length > 1 ? `${typeSelection[0]} +${typeSelection.length - 1}` : typeSelection[0]]);
  }

  for (const [key, value] of Object.entries(filters)) {
    if (['sort', 'csort', 'areas', 'permitType', 'lens', 'group', 'contractorLabel'].includes(key)) continue;
    if (key === 'contractorIds') { chips.push(['contractorIds', 'Contractor', contractorLabel || 'one company']); continue; }
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
      : key === 'ownerBuilder' ? 'filed by the homeowner'
      : key === 'minValuation' ? (money(value) || value)
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
  // The location chip (picked places, or an old link's zip/city) clears it all.
  if (key === 'areas' || key === 'zip' || key === 'city' || key === 'state') {
    setAreas(null);
    return;
  }
  if (key === 'stage') {
    for (const [k] of STAGES) $('stage-' + k).checked = DEFAULT_STAGES.includes(k);
  } else if (key === 'hasContact') {
    $('hasContact').checked = false;
  } else if (key === 'ownerBuilder') {
    $('ownerBuilder').checked = false;
  } else if (key === 'permitType') {
    typeSelection = [];
    typePicker.setValue([]);
  } else if (key === 'contractorIds') {
    contractorIdsFilter = '';
    contractorLabel = '';
  } else if (key === 'jurisdiction') {
    jurisdictionFilter = '';
  } else {
    $(key).value = '';
  }
  run({ resetPage: true });
}

/* ----------------------------------------------------------------- results */

function stageBadge(p) {
  // The colour is the Stage filter's group; the text is the finer stage the
  // source's wording maps to (stages.js), so a plan-review "Approved and
  // Released" reads "Approved, not issued", never "waiting for approval". The
  // portal's wording follows in small type, because it is the record's own
  // status.
  const { group: stage, label } = window.Stages.badge(p);
  const raw = p.status_raw || p.status || '';
  const showRaw = raw && raw.toLowerCase() !== label.toLowerCase();
  return `<span class="stage ${stage}">${esc(label)}</span>${showRaw
    ? `<span class="stage-raw" title="Status as written on the city's portal">${esc(raw)}</span>` : ''}`;
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

  const who = p.contractor_name
    ? (isRealContractor(p.contractor_name)
        ? `<button type="button" class="link-btn" data-open-contractor="${esc(p.contractor_name)}"
              >${esc(p.contractor_name)}</button>`
        : `<span>${esc(p.contractor_name)}</span>`)
    : (p.contractor_withheld ? '<span title="Looks like an individual; name and contact withheld">Individual (withheld)</span>' : '');
  // With a phone, the call is the card's main action: its own row, with the
  // company it reaches. Without one, the card is laid out as before.
  const pill = phonePill(p.contractor_phone);

  const foot = [
    stageBadge(p),
    p.jurisdiction ? `<span class="pill">${esc(p.jurisdiction)}</span>` : '',
    pill ? '' : who,
    p.permit_number ? `<span>#${esc(p.permit_number)}</span>` : '',
  ].filter(Boolean).join('<span class="sep" aria-hidden="true"></span>');

  el.innerHTML = `
    <div class="card-top">
      <h3 class="card-addr">${esc(p.address || 'Address not listed')}</h3>
      <span class="card-meta">${valueTag(p.valuation, 'card-value', p.valuation_repeats)}<span class="card-date">${esc(fmtDate(p.filed_date) || 'No date')}</span></span>
      ${window.Saved ? Saved.heartHtml(p.id) : ''}
    </div>
    ${p.permit_type ? `<div class="card-type">${esc(p.permit_type)}</div>` : ''}
    ${p.work_description ? `<p class="card-desc">${esc(p.work_description)}</p>` : ''}
    ${pill ? `<div class="card-call">${pill}${who ? `<span class="card-call-who">${who}</span>` : ''}</div>` : ''}
    <div class="card-foot">${foot}</div>`;

  const open = (e) => {
    // The phone link dials, the contractor name opens a history, the heart
    // saves, and the Saved view's controls edit; none should also open it.
    if (e.target.closest('[data-tel], [data-open-contractor], [data-heart], .saved-ctl')) return;
    flyToPermit(p);
    openDetail(p.id, el);
  };
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    // Only the card itself: Enter on a button or field inside it is theirs.
    if (e.target !== el) return;
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
  // A new filter set re-frames the map on its results; paging does not, and
  // neither does "Search this area" (it marks the map as moved afterwards).
  const filterKey = JSON.stringify(filters);
  if (filterKey !== lastRunKey) { userMovedMap = false; lastRunKey = filterKey; }
  syncUrl(filters);
  paintActiveFilters(filters);
  window.dispatchEvent(new Event('leads:areas'));   // the lens button shows the location
  updateFilterCount(filters);
  updateTabLinks(filters);
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

  // Projects, or any list under a lens (the lens ranks on the server).
  if (CONTRACTORS_MODE) { runCompanies(filters, mine); return; }
  if (grouping || lensActive()) { runProjects(filters, mine); return; }

  let data;
  try {
    const params = new URLSearchParams({ ...filters, page: String(page), pageSize: String(PAGE_SIZE) });
    data = await getJSON('/api/permits?' + params);
  } catch (err) {
    if (mine !== reqId) return;
    $('results').innerHTML = `<div class="empty">${emptyIcon()}
      <strong>Couldn't load permits</strong><p>${esc(err.message)}</p></div>`;
    $('count').textContent = '';
    return;
  }
  if (mine !== reqId) return;  // a newer search already landed

  paintLensBar(null);
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

/* ============================================================ projects ===
 *
 * Grouped view (default): one card per project (web/projects.js), with its
 * total declared value, latest activity, a chip per permit kind coloured by
 * status, and the contractors' phones. The drawer shows the timeline.
 */

const KIND_LABEL = { BP: 'Building', EP: 'Electrical', MP: 'Mechanical', PP: 'Plumbing', DM: 'Demolition', OT: 'Other' };
const BASIS_LABEL = {
  'permit number': 'linked by permit number',
  'ref in description': 'linked by a “Ref:” in a description',
  'same address': 'same address (our grouping)',
  'single permit': 'one permit',
};

/* ========================================================= contractors ===
 *
 * /contractors: one row per company on the permits in the current filters
 * (web/contractors.js), with its phone, licence and activity. A row opens the
 * company's projects on the Leads tab.
 */

const CONTRACTOR_SORTS = [['active', 'Most active permits'], ['value', 'Highest active value'], ['recent', 'Most recent permit']];

/** Leads and Contractors keep the same place and filters when you switch. */
function updateTabLinks(filters) {
  const keep = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (!['sort', 'csort', 'group', 'contractorIds', 'contractorLabel', 'lens'].includes(k)) keep.set(k, v);
  }
  const q = keep.toString();
  $('navLeads').href = `/${q ? `?${q}` : ''}`;
  const c = document.getElementById('navContractors');
  if (c) c.href = `/contractors${q ? `?${q}` : ''}`;
}

async function runCompanies(filters, mine) {
  let data;
  try {
    const params = new URLSearchParams({ ...filters, page: String(page), pageSize: String(PAGE_SIZE) });
    data = await getJSON('/api/companies?' + params);
  } catch (err) {
    if (mine !== reqId) return;
    $('results').innerHTML = `<div class="empty">${emptyIcon()}<strong>Couldn't load contractors</strong><p>${esc(err.message)}</p></div>`;
    $('count').textContent = '';
    return;
  }
  if (mine !== reqId) return;
  paintStageCounts(null);
  if (!data.results.length) {
    $('results').innerHTML = `<div class="empty">${emptyIcon()}<strong>No contractors on these permits</strong>
      <p>Widen the location or clear a filter. Individuals are never listed.</p></div>`;
    $('count').textContent = 'No contractors';
    $('pager').innerHTML = '';
    setSheetCount(0);
    return;
  }
  const list = document.createElement('div');
  list.className = 'cards';
  for (const c of data.results) list.appendChild(renderCompanyRow(c, filters));
  $('results').replaceChildren(list);
  setSheetCount(data.total);
  const first = (data.page - 1) * data.pageSize + 1;
  const last = Math.min(data.page * data.pageSize, data.total);
  $('count').innerHTML = `${plural(data.total, 'contractor', 'contractors')}
    <span class="sub">· businesses only · showing ${first}–${last}</span>`;
  const pages = Math.ceil(data.total / data.pageSize);
  $('pager').innerHTML = pages > 1
    ? `<button type="button" class="btn btn-ghost" data-page="prev" ${data.page <= 1 ? 'disabled' : ''}>← Previous</button>
       <span class="pos">Page ${data.page} of ${pages.toLocaleString('en-US')}</span>
       <button type="button" class="btn btn-ghost" data-page="next" ${data.page >= pages ? 'disabled' : ''}>Next →</button>`
    : '';
}

function renderCompanyRow(c, filters) {
  const el = document.createElement('article');
  el.className = 'card company-card';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (!['csort', 'sort', 'contractorIds', 'contractorLabel'].includes(k)) q.set(k, v);
  q.set('contractorIds', c.ids.join(','));
  q.set('contractorLabel', c.name);
  const href = `/?${q}`;
  const lic = [
    ...c.registry.map((r) => `<span class="lic${r.official ? '' : ' is-inferred'}" title="Matched by ${esc(r.matchedBy)}${r.fileDate ? `; licence file dated ${esc(fmtDate(String(r.fileDate).slice(0, 10)))}` : ''}">
      ${esc(r.provider)} #${esc(r.number)}${r.type ? ` · ${esc(r.type)}` : ''}${r.status ? ` · ${esc(r.status)}` : r.expires ? ` · in force to ${esc(fmtDate(String(r.expires).slice(0, 10)))}` : ''}${r.official ? '' : ' <small>(matched by name/phone)</small>'}</span>`),
    ...c.licences.filter((l) => !c.registry.some((r) => l.endsWith(` ${r.number}`))).map((l) => `<span class="lic" title="Licence number written on their permits">Licence on permits: ${esc(l)}</span>`),
  ];
  const reg = c.registrations.map((r) => `<span class="lic is-inferred" title="Matched by ${esc(r.matchedBy)}">${esc(r.provider)}: ${esc(r.status || 'on file')}${r.asOf ? ` (as of ${esc(fmtDate(String(r.asOf).slice(0, 10)))})` : ''}</span>`);
  el.innerHTML = `
    <div class="card-top">
      <h3 class="card-addr"><a class="company-link" href="${esc(href)}">${esc(c.name)}</a></h3>
      <span class="card-meta">${valueTag(c.activeValue)}<span class="card-date" title="Most recent permit filed">${esc(fmtDate(c.latest) || '')}</span></span>
    </div>
    ${c.aliases.length ? `<div class="card-type">Also listed as ${esc(c.aliases.slice(0, 3).join(', '))}${c.aliases.length > 3 ? ` +${c.aliases.length - 3}` : ''}</div>` : ''}
    <div class="company-stats">
      <span><b>${c.active.toLocaleString('en-US')}</b> active permit${c.active === 1 ? '' : 's'}</span>
      <span><b>${c.permits.toLocaleString('en-US')}</b> in these filters</span>
      ${c.activeValue ? `<span><b>${shortMoney(c.activeValue)}</b> active value</span>` : ''}
      ${c.trade ? `<span>${esc(c.trade)}</span>` : ''}
    </div>
    ${c.phone ? `<div class="card-call">${phonePill(c.phone.value)}</div>` : ''}
    <div class="company-lic">${lic.length ? lic.join('') : '<span class="sub">No state licence on file for this company</span>'}${reg.join('')}
      ${!c.registrations.length ? '<span class="sub">Business registration: not checked</span>' : ''}</div>
    <div class="card-foot"><a class="link-btn" href="${esc(href)}">See their projects →</a></div>`;
  return el;
}

/** The lens in force, above the list, with a one-click way out (or back). */
function paintLensBar(data) {
  const bar = $('lensBar');
  const label = (data && data.lens && data.lens.label) || (window.LensUI ? LensUI.label() : '');
  const where = areaSelection && areaSelection.length
    ? `${LocationPicker.labelFor(areaSelection[0], areaIndex).replace(/, [A-Z]{2}$/, '')}${areaSelection.length > 1 ? ` +${areaSelection.length - 1}` : ''}`
    : 'All areas';
  const ico = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>';
  let html = '';
  if (data && data.lens && data.lens.applied) {
    html = `${ico}<span class="lens-bar-text"><b>${esc(label)}</b> · ${esc(where)} · ${plural(data.total, 'match', 'matches')}</span>
      <button type="button" class="btn-quiet" data-lens="off">Show everything</button>
      <button type="button" class="btn-quiet" data-lens="edit">Change</button>`;
  } else if (lensParam && lensOff) {
    html = `${ico}<span class="lens-bar-text">Showing everything.</span>
      <button type="button" class="btn-quiet" data-lens="on">Apply your lens${label ? `: ${esc(label)}` : ''}</button>`;
  } else if (data && data.lens && !data.lens.applied && data.lens.reason === 'off') {
    html = `${ico}<span class="lens-bar-text">Your lens${label ? ` (${esc(label)})` : ''} can't filter here yet: trade matching is off on this site.</span>`;
  }
  bar.innerHTML = html;
  bar.hidden = !html;
}

async function runProjects(filters, mine) {
  let data;
  try {
    const params = new URLSearchParams({ ...filters, page: String(page), pageSize: String(PAGE_SIZE) });
    if (!lensActive()) params.delete('lens');
    data = await getJSON('/api/projects?' + params);
  } catch (err) {
    if (mine !== reqId) return;
    $('results').innerHTML = `<div class="empty">${emptyIcon()}
      <strong>Couldn't load projects</strong><p>${esc(err.message)}</p></div>`;
    $('count').textContent = '';
    return;
  }
  if (mine !== reqId) return;
  lastInferences = Boolean(data.inferences);
  paintStageCounts(data.facets);
  paintLensBar(data);

  if (!data.results.length) {
    $('results').innerHTML = emptyState(data, filters);
    $('count').textContent = 'No projects';
    $('pager').innerHTML = '';
    setSheetCount(0);
    return;
  }
  const list = document.createElement('div');
  list.className = 'cards';
  for (const pr of data.results) list.appendChild(renderProjectCard(pr));
  $('results').replaceChildren(list);
  paintPinState();
  setSheetCount(data.total);

  const first = (data.page - 1) * data.pageSize + 1;
  const last = Math.min(data.page * data.pageSize, data.total);
  // Ungrouped under a lens, each row is one permit.
  $('count').innerHTML = grouping
    ? `${plural(data.total, 'project', 'projects')}
       <span class="sub">· ${plural(data.permitsMatched, 'permit', 'permits')} · showing ${first}–${last}</span>`
    : `${plural(data.total, 'permit', 'permits')}
       <span class="sub">· of ${data.permitsMatched.toLocaleString('en-US')} · showing ${first}–${last}</span>`;
  if (data.capped) {
    $('results').insertAdjacentHTML('afterbegin', `<p class="callout">Grouping covers the newest
      ${data.cap.toLocaleString('en-US')} of ${data.permitsTotal.toLocaleString('en-US')} matching permits. Narrow the location to see every project.</p>`);
  }
  const pages = Math.ceil(data.total / data.pageSize);
  $('pager').innerHTML = pages > 1
    ? `<button type="button" class="btn btn-ghost" data-page="prev" ${data.page <= 1 ? 'disabled' : ''}>← Previous</button>
       <span class="pos">Page ${data.page} of ${pages.toLocaleString('en-US')}</span>
       <button type="button" class="btn btn-ghost" data-page="next" ${data.page >= pages ? 'disabled' : ''}>Next →</button>`
    : '';
}

/** "BP ×3" chips, coloured by the most advanced status of that kind. */
const kindChips = (chips) => `<div class="kind-chips">${chips.map((c) => `
  <span class="kind-chip" title="${esc(`${c.label}: ${c.count} permit${c.count === 1 ? '' : 's'}, ${(STAGES.find(([k]) => k === c.stage) || [, 'Unknown'])[1].toLowerCase()}`)}">
    <span class="stage-dot ${esc(c.stage)}" aria-hidden="true"></span>${esc(c.code)}${c.count > 1 ? `<span class="kind-n">×${c.count}</span>` : ''}</span>`).join('')}</div>`;

/** A project's value with how it was summed, or ''. */
function projectValueTag(v, cls = 'card-value') {
  if (!v || v.total == null) return '';
  const tag = valueTag(v.total, cls);
  const notes = [];
  if (v.counted > 1) notes.push(`sum of ${v.counted} declared values`);
  if (v.repeated) notes.push(`${plural(v.repeated, 'repeated value', 'repeated values')} counted once`);
  if (v.odd) notes.push(`${plural(v.odd, 'value', 'values')} of $1B+ left out as filing errors`);
  return notes.length ? tag.replace(/title="([^"]*)"/, (_, t) => `title="${t}: ${esc(notes.join('; '))}"`) : tag;
}

function renderProjectCard(pr) {
  const el = document.createElement('article');
  el.className = 'card project-card';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.dataset.id = pr.primaryId;
  const areaKey = areaKeyOf(pr);
  if (areaKey) el.dataset.area = areaKey;

  const phones = pr.phones.slice(0, 2).map((x) => `<span class="proj-phone">${phonePill(x.phone)}${x.name
    ? `<span class="card-call-who">${isRealContractor(x.name)
      ? `<button type="button" class="link-btn" data-open-contractor="${esc(x.name)}">${esc(x.name)}</button>` : esc(x.name)}</span>` : ''}</span>`).join('');
  const morePhones = pr.phones.length > 2 ? `<span class="sub">+${pr.phones.length - 2} more in the timeline</span>` : '';
  const sub = [
    plural(pr.permitCount, 'permit', 'permits'),
    pr.buildings.length ? pr.buildings.slice(0, 3).join(' · ') + (pr.buildings.length > 3 ? ` +${pr.buildings.length - 3}` : '') : '',
  ].filter(Boolean).join(' · ');

  el.innerHTML = `
    <div class="card-top">
      <h3 class="card-addr">${esc(pr.address || 'Address not listed')}</h3>
      <span class="card-meta">${projectValueTag(pr.value)}<span class="card-date" title="Latest permit filed">${esc(fmtDate(pr.latest) || 'No date')}</span></span>
      ${window.Saved ? Saved.heartHtml(pr.primaryId) : ''}
    </div>
    <div class="card-type">${esc(sub)}${pr.stage ? ` <span class="proj-stage" title="Our reading of the permits on file, not a site inspection">${esc(pr.stage)}</span>` : ''}</div>
    ${pr.lens ? `<p class="lens-why"><b>Why it fits:</b> ${esc(pr.lens.why.join(' · '))}</p>` : ''}
    ${pr.description ? `<p class="card-desc">${esc(pr.description)}</p>` : ''}
    ${kindChips(pr.chips)}
    ${phones ? `<div class="card-call proj-phones">${phones}${morePhones}</div>` : ''}
    <div class="card-foot">
      <span class="sub">${esc(pr.basis.map((b) => BASIS_LABEL[b] || b).join(' · '))}</span>
      ${pr.jurisdiction ? `<span class="sep" aria-hidden="true"></span><span class="pill">${esc(pr.jurisdiction)}</span>` : ''}
    </div>`;

  const open = (e) => {
    if (e.target.closest('[data-tel], [data-open-contractor], [data-heart]')) return;
    openProject(pr.id, el);
  };
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProject(pr.id, el); }
  });
  if (areaKey) {
    el.addEventListener('mouseenter', () => highlightPin(areaKey, true));
    el.addEventListener('mouseleave', () => highlightPin(areaKey, false));
  }
  return el;
}

/** The project drawer: header facts, then every permit in date order. */
async function openProject(id, cardEl, { keepFocus = false } = {}) {
  const dlg = $('detail');
  if (!keepFocus) lastFocused = cardEl || null;
  projectReturn = null;
  for (const c of document.querySelectorAll('.card[aria-current]')) c.removeAttribute('aria-current');
  if (cardEl) cardEl.setAttribute('aria-current', 'true');

  $('dAddr').textContent = 'Loading…';
  for (const k of ['dType']) $(k).textContent = '';
  for (const k of ['dMeta', 'dStage', 'dSave', 'dFoot']) $(k).innerHTML = '';
  $('dBody').innerHTML = skeletons(3);
  if (!dlg.open) dlg.showModal();

  let pr;
  try {
    pr = await getJSON(`/api/projects/by-permit/${encodeURIComponent(id)}`);
  } catch (err) {
    $('dAddr').textContent = 'Could not load project';
    $('dBody').innerHTML = `<p class="callout">${esc(err.message)}</p>`;
    return;
  }

  $('dAddr').textContent = pr.address || 'Address not listed';
  $('dType').textContent = [plural(pr.permitCount, 'permit', 'permits'), pr.buildings.join(' · ')].filter(Boolean).join(' · ');
  const val = projectValueTag(pr.value, 'd-value');
  $('dMeta').innerHTML = [pr.latest ? `<span>Latest ${esc(fmtDate(pr.latest))}</span>` : '', val ? `<span>${val} declared in total</span>` : '']
    .filter(Boolean).join('<span class="sep" aria-hidden="true"></span>');
  $('dStage').innerHTML = pr.stage ? `<span class="proj-stage" title="Our reading of the permits on file, not a site inspection">${esc(pr.stage)}</span>` : '';
  $('dSave').innerHTML = window.Saved ? Saved.heartHtml(pr.primaryId, { label: true }) : '';

  $('dBody').innerHTML = `
    ${kindChips(pr.chips)}
    <div class="sect">Timeline</div>
    <ol class="timeline">${pr.permits.map((p) => `
      <li class="tl-item">
        <div class="tl-when">${esc(fmtDate(p.filed_date) || 'No date')}</div>
        <div class="tl-main">
          <div class="tl-head"><span class="kind-chip"><span class="stage-dot ${esc(p.status_stage || 'unknown')}" aria-hidden="true"></span>${esc(p.kind)}</span>
            <span class="tl-type">${esc(p.permit_type || KIND_LABEL[p.kind] || 'Permit')}</span>
            ${valueTag(p.valuation, 'card-value', p.valuation_repeats)}</div>
          <div class="tl-status">${stageBadge(p)}${p.permit_number ? `<span class="sub">#${esc(p.permit_number)}</span>` : ''}</div>
          ${p.work_description ? `<p class="tl-desc">${esc(p.work_description)}</p>` : ''}
          ${p.contractor_name || p.contractor_phone || p.contractor_withheld ? `<div class="tl-who">
            ${p.contractor_phone ? phonePill(p.contractor_phone) : ''}
            <span>${p.contractor_name ? (isRealContractor(p.contractor_name)
              ? `<button type="button" class="link-btn" data-open-contractor="${esc(p.contractor_name)}">${esc(p.contractor_name)}</button>`
              : esc(p.contractor_name)) : (p.contractor_withheld ? 'Individual (withheld)' : '')}</span></div>` : ''}
          <button type="button" class="link-btn tl-open" data-open-permit="${esc(p.id)}">Permit details →</button>
        </div>
      </li>`).join('')}</ol>
    <p class="check-count">Grouped by ${esc(pr.basis.map((b) => BASIS_LABEL[b] || b).join(', '))}.${pr.inferences ? '' : ' Same-address grouping and stages are off on this site.'}</p>`;

  for (const b of $('dBody').querySelectorAll('[data-open-permit]')) {
    b.addEventListener('click', () => openDetail(b.dataset.openPermit, null, { fromProject: pr.id }));
  }
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
  // The lens and the grouping switch are not filters: the lens has its own bar.
  const n = Object.keys(filters).filter((k) => !['sort', 'csort', 'stage', 'lens', 'group', 'contractorLabel'].includes(k)).length;
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
    c = await getJSON('/api/contractors/' + encodeURIComponent(name));
  } catch (err) {
    // A JSON 404 is a real answer ("no such company"); anything else is an error.
    if (err.status !== 404 || !err.data) {
      $('cBody').innerHTML = `<p class="callout">${esc(err.message)}</p>`;
      return;
    }
    const body = err.data;
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
      ${c.phone ? `<dt>Phone</dt><dd>${phonePill(c.phone)}</dd>` : ''}
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
    const { contractors } = await getJSON('/api/contractors?limit=12&q=' + encodeURIComponent(term));
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
  pointsFramed = false;

  let data;
  try {
    data = await getJSON('/api/map?' + new URLSearchParams(filters));
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
  // A small selection (a ZIP, a few neighbourhoods) is framed on its job sites
  // rather than on one area pin, so the map opens at street level.
  if (!(await framePoints(filters))) loadPoints();
}

/**
 * Fits the map to the current results' located job sites when the area pins
 * span less than about a city (the points API takes at most 1 degree). The
 * bounds ignore the outer 5% on each axis, so one mis-geocoded address cannot
 * zoom the map back out to the whole state. Returns true when it framed.
 */
const FRAME_MAX_DEG = 0.9;
async function framePoints(filters) {
  if (!map || userMovedMap || !mapPins.length) return false;
  const lats = mapPins.map((p) => p.lat);
  const lngs = mapPins.map((p) => p.lng);
  const pad = 0.06;
  const box = [Math.min(...lats) - pad, Math.min(...lngs) - pad, Math.max(...lats) + pad, Math.max(...lngs) + pad];
  if (box[2] - box[0] > FRAME_MAX_DEG || box[3] - box[1] > FRAME_MAX_DEG) return false;
  let data;
  try {
    data = await getJSON(`/api/map/points?${new URLSearchParams({ ...filters, bbox: box.map((v) => v.toFixed(5)).join(',') })}`);
  } catch { return false; }
  if (filters !== lastFilters || userMovedMap || !data.points || data.points.length < 2) return false;
  const q = (arr, f) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))]; };
  const pl = data.points.map((p) => p.lat);
  const pg = data.points.map((p) => p.lng);
  pointsFramed = true;
  map.fitBounds([[q(pl, 0.05), q(pg, 0.05)], [q(pl, 0.95), q(pg, 0.95)]], { padding: [40, 40], maxZoom: 16, animate: false });
  renderPins();
  loadPoints();
  return true;
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

// A small selection framed on its job sites (framePoints) shows them at that
// zoom too, down to city level; otherwise job sites start at POINT_ZOOM.
const FRAMED_MIN_ZOOM = 11;
let pointsFramed = false;
const showingPoints = () => map && (map.getZoom() >= POINT_ZOOM || (pointsFramed && map.getZoom() >= FRAMED_MIN_ZOOM));

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
    data = await getJSON(`/api/map/points?${new URLSearchParams({ ...lastFilters, bbox })}`);
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
// The merge cell shrinks as you zoom in, so groups split apart at city zoom
// instead of holding together until the street level.
const clusterPx = (zoom) => (zoom >= 12 ? 36 : zoom >= 9 ? 52 : 68);

function renderPins() {
  if (!map) return;
  pinLayer.clearLayers();
  pinMarkers.clear();

  const zoom = map.getZoom();
  const cells = new Map();

  for (const pin of mapPins) {
    const pt = map.project([pin.lat, pin.lng], zoom);
    const px = clusterPx(zoom);
    const cell = `${Math.floor(pt.x / px)}:${Math.floor(pt.y / px)}`;
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
    (pin.pending ? `, ${pin.pending} not issued yet` : '');

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
    (group.pending ? `, ${group.pending} not issued yet` : '') +
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

/** Clicking a pin adds that place to the location (or removes it, if chosen). */
function selectArea(pin) {
  // Pins and the picker speak the same key vocabulary, so this is a direct toggle.
  toggleArea(pin.key);
  userMovedMap = true;
}

/** The chosen places get the accent treatment, matching the picker's chips. */
function paintPinState() {
  for (const [key, marker] of pinMarkers) {
    const el = marker.getElement() && marker.getElement().querySelector('.pin');
    if (!el) continue;
    el.classList.toggle('is-active', Boolean(areaSelection && areaSelection.includes(key)));
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
  $('searchArea').hidden = true;
  setAreas(keys);
  userMovedMap = true;
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
    const data = await getJSON('/api/map?stage=any');
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
        // Add, never toggle: asking "near me" twice must not remove the place.
        if (!(areaSelection || []).includes(best.area.key)) toggleArea(best.area.key);
        userMovedMap = true;
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

/**
 * The contractor's phone as the card's main action: a pill with a handset
 * icon. On a phone it is a tel: link that dials; on a desktop a click copies
 * the number (see the copy handler below), since most desktops cannot dial.
 * Only the business contact ever gets here (rule 5, src/privacy.js).
 */
const PHONE_ICON = `<svg class="phone-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h3.5l1.8 4.6-2.3 1.4a11 11 0 0 0 6 6l1.4-2.3L20 15.5V19a2 2 0 0 1-2.2 2A17 17 0 0 1 3 6.2 2 2 0 0 1 5 4Z"/></svg>`;
function phonePill(v) {
  if (!v) return '';
  const shown = phone(v);
  const href = telHref(v);
  if (!href) return `<span class="phone-pill is-plain">${PHONE_ICON}<span class="phone-num">${esc(shown)}</span></span>`;
  return `<a class="phone-pill" href="${esc(href)}" data-tel data-phone="${esc(shown)}"
    title="Call ${esc(shown)} (on a computer, click to copy)">${PHONE_ICON}<span class="phone-num">${esc(shown)}</span></a>`;
}

// Desktop: a phone pill copies its number instead of opening a dialer that
// usually isn't there. Touch screens keep the tel: link and dial.
const dialsNatively = matchMedia('(hover: none), (pointer: coarse)');
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => false);
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return Promise.resolve(ok);
}
document.addEventListener('click', async (e) => {
  const pill = e.target.closest('a.phone-pill');
  if (!pill || dialsNatively.matches) return;
  e.preventDefault();
  const number = pill.dataset.phone;
  const ok = await copyText(number);
  const label = pill.querySelector('.phone-num');
  pill.dataset.state = ok ? 'copied' : 'failed';
  label.textContent = ok ? 'Copied ✓' : number;
  $('liveNote').textContent = ok ? `Copied ${number}` : `Couldn't copy. The number is ${number}.`;
  clearTimeout(pill._t);
  pill._t = setTimeout(() => { delete pill.dataset.state; label.textContent = number; }, 1600);
});


/* ------------------------------------------------------------------ drawer */

const row = (label, value, cls = '') =>
  (value === null || value === undefined || value === '' || value === 0)
    ? '' : `<dt>${esc(label)}</dt><dd class="${cls}">${esc(value)}</dd>`;

/**
 * Everything we hold about one permit, shown in-app. The source link at the
 * bottom is provenance only — nothing here requires leaving to read it.
 */
async function openDetail(id, cardEl, { fromProject = null } = {}) {
  const dlg = $('detail');
  if (!fromProject) lastFocused = cardEl || null;
  projectReturn = fromProject;

  for (const c of document.querySelectorAll('.card[aria-current]')) c.removeAttribute('aria-current');
  if (cardEl) cardEl.setAttribute('aria-current', 'true');

  $('dAddr').textContent = 'Loading…';
  $('dType').textContent = '';
  $('dMeta').innerHTML = '';
  $('dStage').innerHTML = '';
  $('dSave').innerHTML = '';
  $('dBody').innerHTML = skeletons(3);
  $('dFoot').innerHTML = '';
  if (!dlg.open) dlg.showModal();

  let p;
  try {
    p = await getJSON('/api/permits/' + encodeURIComponent(id));
  } catch (err) {
    $('dAddr').textContent = 'Could not load permit';
    $('dBody').innerHTML = `<p class="callout">${esc(err.message)}</p>`;
    return;
  }

  $('dAddr').textContent = p.address || 'Address not listed';
  $('dType').textContent = p.permit_type || '';
  // The filing date and the declared value, side by side (nothing when missing).
  const dVal = valueTag(p.valuation, 'd-value', p.valuation_repeats);
  $('dMeta').innerHTML = [p.filed_date ? `<span>Filed ${esc(fmtDate(p.filed_date))}</span>` : '', dVal ? `<span>${dVal} declared</span>` : '']
    .filter(Boolean).join('<span class="sep" aria-hidden="true"></span>');
  $('dStage').innerHTML = stageBadge(p);
  $('dSave').innerHTML = window.Saved ? Saved.heartHtml(p.id, { label: true }) : '';

  const scores = Object.entries(p.trade_scores || {})
    .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([t, v]) => `${t} ${v}`).join(', ');

  const fees = p.fees || [];
  const inspections = p.inspections || [];

  $('dBody').innerHTML = `
    <div class="sect">Permit</div>
    <dl class="kv">
      ${row('Status', p.status_raw)}
      ${row('Stage', window.Stages.badge(p).label)}
      ${row(p.filing_kind === 'building_application' ? 'Applied' : 'Issued', fmtDate(p.filed_date))}
      ${row('Permit no.', p.permit_number)}
      ${row('Type', p.permit_type)}
      ${row('Valuation', money(p.valuation) && (Number(p.valuation) >= ODD_VALUE ? `${money(p.valuation)} (as filed; unusually high, likely a filing error)` : money(p.valuation)), 'money')}
      ${row('', window.Values.repeatNote(p.valuation, p.valuation_repeats))}
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
        ${p.contractor_phone ? `<dt>Phone</dt><dd>${phonePill(p.contractor_phone)}</dd>` : ''}
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

    <div id="dMore" aria-live="polite"><div class="sect">Lifecycle</div><p class="check-count">Loading…</p></div>

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
  // Opened from a project's timeline: offer the way back to it.
  if (projectReturn) {
    $('dFoot').insertAdjacentHTML('afterbegin', '<button type="button" class="btn btn-ghost" id="dBackProject">← Back to project</button>');
    const back = projectReturn;
    $('dBackProject').addEventListener('click', () => openProject(back, null, { keepFocus: true }));
  }

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
const LIFECYCLE = window.Stages.LIFECYCLE_LABEL;
const LICENCE_BOARD = { 'fl-dbpr': 'Florida DBPR', 'tx-tdlr': 'Texas TDLR' };
const num = (v, unit = '') => (v == null ? '' : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 })}${unit}`);
let extrasFor = null;

async function loadJobExtras(id) {
  extrasFor = id;
  const box = $('dMore');
  let j;
  try {
    j = await getJSON(`/api/pilot/jobs/${encodeURIComponent(id)}`);
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
      ${row('Status date', lc.stageSince ? `${fmtDate(lc.stageSince)} (the source’s date for its current status)` : '')}
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
      ${row('Assessed value', pr.assessedValueBand ? pr.assessedValueBand.label : '')}
    </dl>
    <p class="check-count">Source: ${esc(v.attribution || v.source || 'appraiser')}${pr.valueNote ? ` · ${esc(pr.valueNote)}` : ''}. Owner, sale and exemption fields are not collected.</p>`
    : (j.unmeasuredHidden ? '' : '<div class="sect">Property</div><p class="check-count">No appraiser record joined to this permit.</p>');

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
    ${licences || j.unmeasuredHidden ? '' : '<p class="check-count">No state licence record matched yet.</p>'}` : '';

  const hidden = j.unmeasuredHidden ? `<p class="check-count">${esc(j.unmeasuredHidden)}</p>` : '';
  box.innerHTML = `${lifecycle}${property}${located}${company}${hidden}
    <p class="check-count"><a href="/pilot/live/job.html?id=${encodeURIComponent(id)}">Open the full job page →</a></p>`;
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
$('ownerBuilder').addEventListener('change', runNow);
$('groupToggle').addEventListener('change', (e) => { grouping = e.target.checked; runNow(); });
$('lensBar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lens]');
  if (!b) return;
  if (b.dataset.lens === 'edit') { if (window.LensUI) LensUI.open(); return; }
  lensOff = b.dataset.lens === 'off';
  runNow();
});
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
  jurisdictionFilter = '';
  contractorIdsFilter = '';
  contractorLabel = '';
  userMovedMap = false;
  locPicker.setValue([]);
  for (const id of [...TEXT_FILTERS, ...PICK_FILTERS]) $(id).value = '';
  $('hasContact').checked = false;
  $('ownerBuilder').checked = false;
  typeSelection = [];
  typePicker.setValue([]);
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

// The sidebar's location picker: one search, several places (location.js).
locPicker = LocationPicker.create($('locPicker'), {
  label: 'Where',
  placeholder: 'Search an area, city or ZIP',
  onChange: (keys) => setAreas(keys),
});

// Permit types: several at once, searchable, busiest first.
typePicker = LocationPicker.create($('typePicker'), {
  label: 'Permit type',
  placeholder: 'Search permit types',
  listLabel: 'Permit types',
  noun: 'permit type',
  groups: [{ kind: 'type', title: 'Permit types', idleTitle: 'Most common types', idle: 12, max: 40 }],
  onChange: (keys) => { typeSelection = keys; runNow(); },
});

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

/* ============================================================ saved view ===
 *
 * /saved: the signed-in user's saved permits (web/users.js), as the same cards
 * plus a status, a note and Remove. Filter chips by status; "Not relevant"
 * sinks to the bottom, dimmed. No sidebar, no map.
 */

const SAVED_ORDER = ['saved', 'called', 'no_answer', 'quoted', 'won', 'lost', 'not_relevant'];
let savedItems = [];
let savedFilter = 'all';
let savedLoadedFor = null;     // the email the list was loaded for

async function loadSaved() {
  savedLoadedFor = Saved.email();
  $('count').textContent = 'Saved permits';
  $('pager').innerHTML = '';
  if (!savedLoadedFor) {
    $('activeFilters').innerHTML = '';
    $('results').innerHTML = `<div class="empty">${emptyIcon()}
      <strong>Sign in to see your saved permits</strong>
      <p>Tap ♥ on any permit to save it. Your email keeps the list; there's no password.</p>
      <p><button type="button" class="btn btn-primary" data-signin>Sign in with email</button></p></div>`;
    return;
  }
  $('results').innerHTML = skeletons(3);
  try {
    savedItems = (await Saved.api('GET', '/api/me/saved')).items || [];
  } catch (err) {
    $('results').innerHTML = `<div class="empty">${emptyIcon()}<strong>Couldn't load your saved permits</strong><p>${esc(err.message)}</p></div>`;
    return;
  }
  paintSaved();
}

function paintSaved() {
  const counts = {};
  for (const it of savedItems) counts[it.status] = (counts[it.status] || 0) + 1;
  $('count').textContent = plural(savedItems.length, 'saved permit', 'saved permits');
  $('activeFilters').innerHTML = savedItems.length ? `<div class="chips saved-filter" role="group" aria-label="Show by status">
    ${[['all', 'All', savedItems.length], ...SAVED_ORDER.filter((s) => counts[s]).map((s) => [s, Saved.STATUS_LABELS[s], counts[s]])]
      .map(([k, label, n]) => `<button type="button" class="chip" data-sfilter="${k}" aria-pressed="${savedFilter === k}">${esc(label)} · ${n}</button>`).join('')}
    </div>` : '';

  if (!savedItems.length) {
    $('results').innerHTML = `<div class="empty">${emptyIcon()}
      <strong>No saved permits yet</strong>
      <p>Tap ♥ on any permit to save it here, then mark who you called and add notes.</p>
      <p><a class="btn btn-ghost" href="/">Browse leads</a></p></div>`;
    return;
  }
  if (savedFilter !== 'all' && !counts[savedFilter]) savedFilter = 'all';
  const shown = savedItems
    .filter((it) => savedFilter === 'all' || it.status === savedFilter)
    .sort((a, b) => (a.status === 'not_relevant') - (b.status === 'not_relevant')
      || String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const list = document.createElement('div');
  list.className = 'cards';
  for (const it of shown) {
    const card = renderCard(it.permit);
    card.dataset.status = it.status;
    card.appendChild(savedControls(it));
    list.appendChild(card);
  }
  $('results').replaceChildren(list);
}

function savedControls(it) {
  const id = String(it.permit.id);
  const div = document.createElement('div');
  div.className = 'saved-ctl';
  div.innerHTML = `
    <label class="saved-status"><span class="visually-hidden">Status</span>
      <select class="select">${SAVED_ORDER.map((s) => `<option value="${s}"${s === it.status ? ' selected' : ''}>${esc(Saved.STATUS_LABELS[s])}</option>`).join('')}</select></label>
    <input class="input saved-note" type="text" maxlength="500" value="${esc(it.note || '')}"
           placeholder="Add a note: who you spoke to, next step…" aria-label="Note for this permit">
    <button type="button" class="btn btn-ghost saved-remove">Remove</button>`;
  const fail = (err) => alert(err.message);
  div.querySelector('select').addEventListener('change', (e) => {
    Saved.update(id, { status: e.target.value }).then((r) => { it.status = r.status; it.updatedAt = r.updatedAt; paintSaved(); }, fail);
  });
  div.querySelector('.saved-note').addEventListener('change', (e) => {
    Saved.update(id, { note: e.target.value }).then((r) => { it.note = r.note; it.updatedAt = r.updatedAt; }, fail);
  });
  div.querySelector('.saved-remove').addEventListener('click', () => {
    Saved.remove(id).then(() => { savedItems = savedItems.filter((x) => x !== it); paintSaved(); }, fail);
  });
  return div;
}

$('activeFilters').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-sfilter]');
  if (!chip) return;
  savedFilter = chip.dataset.sfilter;
  paintSaved();
});

/* --------------------------------------------------------------- bootstrap */

buildStageCheckboxes();
// The Contractors tab sorts companies; its options must exist before the URL is read.
if (CONTRACTORS_MODE) $('sort').innerHTML = CONTRACTOR_SORTS.map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join('');
applyUrl();

if (SAVED_MODE) {
  $('app').dataset.mode = 'saved';
  $('navLeads').removeAttribute('aria-current');
  $('navSaved').setAttribute('aria-current', 'page');
  document.title = 'Saved permits · Contractos';
  setView('list', { remember: false });
  loadFreshness();
  Saved.ready.then(loadSaved);
  // Signing in (or out) from this page reloads the list for that email; the
  // heart in a card removing a permit drops it from the list.
  window.addEventListener('saved:change', () => {
    if (Saved.email() !== savedLoadedFor) { loadSaved(); return; }
    const before = savedItems.length;
    savedItems = savedItems.filter((it) => Saved.isSaved(it.permit.id));
    if (savedItems.length !== before) paintSaved();
  });
} else if (CONTRACTORS_MODE) {
  $('app').dataset.mode = 'contractors';
  $('navLeads').removeAttribute('aria-current');
  $('navContractors').setAttribute('aria-current', 'page');
  document.title = 'Contractors · Contractos';
  const savedLayout = readStore();
  setView('list', { remember: false });
  setFilters(savedLayout.filters !== 'closed', { remember: false });
  syncSidebar();
  loadFreshness();
  loadAllAreas();
  loadOptions().finally(run);
} else {
  const savedLayout = readStore();
  setView(savedLayout.view || 'split', { remember: false });
  setFilters(savedLayout.filters !== 'closed', { remember: false });

  syncSidebar();
  initMap();
  loadFreshness();
  loadAllAreas();
  loadOptions().finally(run);
}
