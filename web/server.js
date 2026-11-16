// Search API + static frontend for the permit platform.
//
// All querying lives in db/queries.js; this layer only validates input and
// shapes responses, so the same query path can move behind Next.js API routes
// later without being rewritten.

const path = require('node:path');
const express = require('express');
const queries = require('../db/queries.js');
const db = require('../db/index.js');
const { router: pilotApi } = require('./pilot_api.js');
const { router: overviewApi, warmList } = require('./overview_api.js');
const { cache } = require('./cache.js');
const { demoGate } = require('./access.js');
const digestRoutes = require('./digest_routes.js');
const { imageryConfig } = require('./imagery.js');
const trust = require('./trust.js');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Liveness for the host's health check. Before the gate, and touches no data.
app.get('/healthz', (_req, res) => res.type('text').send('ok'));
// The applied migration number, so a deploy check can confirm the pre-deploy
// migrations ran (railway.json). A number only; no database detail.
// `code`: the newest migration this deployed code ships, and `commit` the
// commit Railway built (RAILWAY_GIT_COMMIT_SHA). code > schema means the
// deploy is live but its migrations did not run; an old commit means the new
// deploy never went live.
const CODE_MIGRATION = (() => {
  try {
    return Math.max(0, ...require('node:fs').readdirSync(require('node:path').join(__dirname, '../db/migrations'))
      .map((f) => Number((f.match(/^(\d+)_/) || [])[1]) || 0));
  } catch { return null; }
})();
const COMMIT = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 12) || null;
app.get('/healthz/schema', async (_req, res) => {
  try { res.json({ schema: await db.schemaVersion(), code: CODE_MIGRATION, commit: COMMIT }); } catch { res.status(503).json({ schema: null, code: CODE_MIGRATION, commit: COMMIT }); }
});

// Railway (and most hosts) put one proxy in front: trust it for req.ip (the
// sign-in rate limit) and req.secure (the Secure cookie flag).
app.set('trust proxy', 1);

// Signed links from digest emails (ADR-20): one job page per token, and the
// unsubscribe. Before the gate, because a customer opens them without the
// demo password; the token is the only key (web/digest_routes.js).
app.use(digestRoutes.publicRouter());

// A hosted demo sets DEMO_PASSWORD; see web/access.js. Sign-in is by email
// (web/users.js), which replaced the invite codes of ADR-27 (owner decision,
// 2026-11-15); DEMO_PASSWORD stays the owner's key. Unset, the app is open and
// the email is asked the first time someone saves a permit.
const users = require('./users.js');
const userStore = users.pgStore(db.query);
const userSessions = users.sessions();
// Open access (owner decision 2026-11-15): no login is asked; anyone with the
// link sees what the app shows. Redaction (rule 5) is unchanged. The digest
// previews stay behind the owner key: they render subscribers' real signed
// links, unsubscribe included. REQUIRE_LOGIN=1 puts the whole app behind the
// gate again. The email is asked only the first time someone saves a permit.
const OPEN_ACCESS = process.env.REQUIRE_LOGIN !== '1';
// Owner only, never an email user's session: the digest previews and the
// product analytics dashboard with its API (/admin, /api/admin; ADR-37).
const OWNER_ONLY = /^\/(digest\/(preview|sample)|admin|api\/admin)(\/|$)/;
const gate = demoGate(undefined, {
  users: { store: userStore, sessions: userSessions, normalEmail: users.normalEmail },
  isPublic: OPEN_ACCESS ? (req) => !OWNER_ONLY.test(req.path) : null,
  ownerOnly: (req) => OWNER_ONLY.test(req.path),
});
app.use(gate);
// Public pages carry contractor names and phones: keep them out of search engines.
if (OPEN_ACCESS) app.use((_req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });

// Digest email previews, behind the gate.
app.use(digestRoutes.previewRouter());

// Product analytics (docs/ANALYTICS.md, ADR-37): the browser tracker posts
// batches here; the owner reads them at /admin/analytics. A visit with the
// owner key is marked internal and left out of every metric.
app.use(require('./telemetry.js').router({
  store: require('./telemetry.js').pgStore(db.getPool),
  userIdOf: (req) => userSessions.userId(req),
  isOwner: gate.isOwner,
}));
app.use(require('./admin_analytics.js').router({
  query: db.query, isOwner: gate.isOwner, userIdOf: (req) => userSessions.userId(req),
}));
// What is collected, and the opt-out switch.
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));

// The signed-in user and their saved permits (/api/me...).
app.use(users.router({ store: userStore, sessions: userSessions, permitsByIds: queries.permitsByIds }));
app.disable('x-powered-by');

// Only these reach the query builder. Anything else a client sends is ignored
// rather than passed through to SQL.
const FILTER_PARAMS = [
  'zip', 'city', 'state', 'jurisdiction', 'sourceArea', 'from', 'to',
  'stage', 'statusRaw', 'status', 'permitType', 'minValuation',
  'trade', 'minScore', 'q', 'page', 'pageSize', 'sort',
  'hasContact', 'contractor', 'areas', 'ownerBuilder', 'contractorIds',
  'propertyClass',
];

const showOwnerBuilder = () => process.env.SHOW_OWNER_BUILDER === '1';
const { showUnmeasured } = require('../src/display_policy.js');

function pickFilters(query) {
  const filters = {};
  // The trade filter selects by keyword fit scores, an inference (ADR-26).
  let keys = trust.showInferences() ? FILTER_PARAMS : FILTER_PARAMS.filter((k) => k !== 'trade' && k !== 'minScore');
  // The owner-builder filter lists homeowner-pulled permits, which is the
  // homeowner track (ADR-10). Owner's decision 2026-11-15: keep it hidden until
  // that track's gate passes. SHOW_OWNER_BUILDER=1 turns it on.
  if (!showOwnerBuilder()) keys = keys.filter((k) => k !== 'ownerBuilder');
  for (const key of keys) {
    const value = query[key];
    if (value !== undefined && value !== '') filters[key] = value;
  }
  return filters;
}

/** pickFilters, with broad-area keys `a:XX` rewritten to state keys (web/areas.js). */
function pickFiltersExpanded(query) {
  const filters = pickFilters(query);
  if (filters.areas) Object.assign(filters, areaFilters(filters.areas));
  return filters;
}

const asyncRoute = (handler) => (req, res) => {
  Promise.resolve(handler(req, res)).catch((err) => {
    console.error(err);
    // No SQL, table names or stack to the client; the log has the detail.
    res.status(500).json({ error: 'Query failed' });
  });
};

app.get('/api/permits', asyncRoute(async (req, res) => {
  const filters = await pickFiltersExpanded(req.query);
  const result = await queries.searchPermits(filters);

  // An uncovered ZIP and a ZIP with no matches look identical in the results
  // list, but they mean completely different things to the user. Distinguish
  // them explicitly rather than letting an empty list imply "no permits here".
  if (result.total === 0 && filters.zip) {
    result.coverage = (await queries.isZipCovered(filters.zip)) ? 'covered' : 'not-covered';
  }
  res.json(result);
}));

// Everything we hold about one permit, so the UI never has to send a user off
// to the county portal to read the record.
// ── Projects: permits grouped into jobs (web/projects.js) ──────────────────
// The rows for one filter set are kept a minute, so paging through projects
// does not regroup from scratch. API_CACHE=off (the integration tests) skips it.
const projects = require('./projects.js');
const lens = require('./lens_config.js');

// What the welcome popup offers, and whether trade matching is on here.
// `jobLinks`: whether project grouping may run (ADR-33); the page hides the
// switch and lists permits when it is off.
app.get('/api/lens', (_req, res) => res.json({ ...lens.publicConfig(), enabled: trust.showInferences() && showUnmeasured(), jobLinks: showUnmeasured() }));
const ROWS_TTL_MS = 60 * 1000;
const rowsMemo = new Map();
async function projectRowsFor(filters) {
  const { page: _p, pageSize: _s, sort: _o, ...where } = filters;
  if (process.env.API_CACHE === 'off') return queries.projectRows(where);
  const key = JSON.stringify(where);
  const hit = rowsMemo.get(key);
  if (hit && Date.now() - hit.at < ROWS_TTL_MS) return hit.value;
  const value = await queries.projectRows(where);
  rowsMemo.set(key, { at: Date.now(), value });
  if (rowsMemo.size > 30) rowsMemo.delete(rowsMemo.keys().next().value);
  return value;
}
const clampInt = (v, lo, hi, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

app.get('/api/projects', asyncRoute(async (req, res) => {
  const filters = pickFiltersExpanded(req.query);
  const page = clampInt(req.query.page, 1, 10000, 1);
  const pageSize = clampInt(req.query.pageSize, 1, 100, 25);
  const data = await projectRowsFor(filters);
  const inferences = trust.showInferences();
  // The lens (web/lens_config.js) filters and ranks by trade signals: an
  // inference, so it applies only with SHOW_INFERENCES=1.
  const parsed = req.query.lens ? lens.selector(req.query.lens) : null;
  // Its "no electrical permit filed yet" signal reads the project's permits, so
  // it also needs the job links that ADR-33 hides: off unless SHOW_UNMEASURED=1.
  const select = inferences && showUnmeasured() ? parsed : null;
  const out = projects.listProjects(data.rows, {
    page, pageSize, sort: req.query.sort, inferences, select, grouped: req.query.group !== '0',
  });
  res.json({
    ...out, page, pageSize, inferences,
    lens: req.query.lens
      ? (select ? { applied: true, label: select.label, param: select.param }
        : { applied: false, reason: !parsed ? 'unknown' : 'off', label: parsed ? parsed.label : null })
      : null,
    permitsTotal: data.total, capped: data.capped, cap: queries.PROJECT_ROW_CAP, facets: data.facets,
  });
}));

// ── The Contractors tab (web/contractors.js) ──────────────────────────────────
// /api/companies, not /api/contractors/..., which already means a name lookup.
const contractors = require('./contractors.js');
const pilotQueries = require('../db/pilot_queries.js');
app.get('/api/companies', asyncRoute(async (req, res) => {
  const filters = pickFiltersExpanded(req.query);
  const { page: _p, pageSize: _s, sort: _o, ...where } = filters;
  const page = clampInt(req.query.page, 1, 10000, 1);
  const pageSize = clampInt(req.query.pageSize, 1, 100, 25);
  const rows = await queries.contractorsInFilters(where);
  const inferences = trust.showInferences();
  const out = await contractors.listContractors(
    { rows, phonesById: (ids) => pilotQueries.contractorsById(ids), recordsFor: (ids) => queries.contractorRecords(ids) },
    { sort: req.query.csort, page, pageSize, inferences },
  );
  res.json({ ...out, inferences });
}));

/** The whole project a permit belongs to, every permit in date order (unfiltered). */
app.get('/api/projects/by-permit/:id', asyncRoute(async (req, res) => {
  if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'Bad permit id' });
  const project = await projects.expandProject(req.params.id, (id) => queries.projectCandidates(id), { inferences: trust.showInferences() });
  if (!project) return res.status(404).json({ error: 'Permit not found' });
  return res.json({ ...project, inferences: trust.showInferences() });
}));

app.get('/api/permits/:id', asyncRoute(async (req, res) => {
  const permit = await queries.getPermit(req.params.id);
  if (!permit) return res.status(404).json({ error: 'Permit not found' });
  // Trade fit scores are our keyword rules, an inference (docs/DATA_TRUST_AUDIT.md).
  if (!trust.showInferences()) delete permit.trade_scores;
  return res.json(permit);
}));

// Map and picker placement (web/areas.js): an area sits at the median of its
// permits' located job sites, falling back to the committed prototype
// centroids. No geocoding happens at request time.
const { placeArea, zipIsTrusted, regionsFrom, areaFilters } = require('./areas.js');
// Past this, a cold centroid cache answers from the area file for one request.
const CENTROID_WAIT_MS = 2000;

/**
 * Map pins for the current filter set. Counts come from the database and are
 * as real as the list. A pin means "N permits in this ZIP/city", never "a
 * permit at this point"; `placed`/`unplaced` in the response lets the UI say
 * so. Street-level job sites come from /api/map/points instead.
 */
app.get('/api/map', asyncRoute(async (req, res) => {
  const [rows, located] = await Promise.all([queries.mapClusters(await pickFiltersExpanded(req.query)), queries.areaCentroids({ maxWaitMs: CENTROID_WAIT_MS })]);

  const pins = new Map();
  let unplaced = 0;

  for (const row of rows) {
    // ZIP where the record has a believable one, else the city: Miami-Dade
    // publishes no property ZIP, and a few of its rows carry out-of-state ones.
    const place = placeArea(row, located);
    if (!place) { unplaced += row.permits; continue; }

    const pin = pins.get(place.key) || { ...place, permits: 0, pending: 0 };
    pin.permits += row.permits;
    pin.pending += row.pending;
    pins.set(place.key, pin);
  }

  const list = [...pins.values()].sort((a, b) => b.permits - a.permits);
  res.json({
    pins: list,
    placed: list.reduce((n, p) => n + p.permits, 0),
    unplaced,
  });
}));

/**
 * Located job sites in a viewport (`bbox=south,west,north,east`), for the
 * current filters. The map asks only when zoomed in to neighbourhood level.
 */
app.get('/api/map/points', asyncRoute(async (req, res) => {
  const parts = String(req.query.bbox || '').split(',').map(Number);
  const [south, west, north, east] = parts;
  const valid = parts.length === 4 && parts.every(Number.isFinite)
    && south < north && west < east && north - south <= 1 && east - west <= 1;
  // A box wider than about a city would scan most of the table: refuse it.
  if (!valid) return res.status(400).json({ error: 'bbox must be south,west,north,east and at most 1 degree across' });
  return res.json(await queries.mapPoints(await pickFiltersExpanded(req.query), { south, west, north, east }));
}));

/**
 * The places the UI is allowed to offer. A ZIP is only offered when we can
 * place it AND it agrees with its own city: Miami-Dade carries a handful of
 * rows reading 10028, 18225 and 24037, which are New York, Pennsylvania and
 * Virginia postal codes on Miami addresses.
 *
 * Nothing becomes unreachable: filtering by city returns those permits too, so
 * they sit under "Miami — all" rather than under a postal code that is wrong.
 */
app.get('/api/areas', asyncRoute(async (_req, res) => {
  const [areas, located] = await Promise.all([queries.listAreas(), queries.areaCentroids({ maxWaitMs: CENTROID_WAIT_MS })]);
  const trusted = areas.zips.filter((z) => zipIsTrusted(z, located));

  res.json({
    ...areas,
    // Broad areas for the Leads location picker (web/areas.js regionsFrom).
    regions: regionsFrom(areas),
    zips: trusted,
    // Stated rather than silently dropped, so the difference is auditable.
    zipsHidden: areas.zips.length - trusted.length,
    permitsUnderCityOnly: areas.zips
      .filter((z) => !trusted.includes(z))
      .reduce((n, z) => n + z.permits, 0),
  });
}));
// Contractor name lookup, for the picker in the sidebar.
app.get('/api/contractors', asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  res.json({ contractors: await queries.searchContractors(req.query.q, limit) });
}));

// One contractor's full record across every area we hold. 404 rather than an
// empty shell, so the UI can say "no permits under that exact name" instead of
// rendering a company with zero jobs.
app.get('/api/contractors/:name', asyncRoute(async (req, res) => {
  if (!queries.isRealContractor(req.params.name)) {
    return res.status(404).json({ error: 'Not a contractor', reason: 'owner-builder' });
  }
  const history = await queries.getContractorHistory(req.params.name);
  if (!history) return res.status(404).json({ error: 'No permits under that name' });
  return res.json(history);
}));

// Credit lines for every source on the search screen: the permit feeds (from
// /api/freshness) plus the enrichment sources behind the permit panel. City of
// Miami data is CC BY 4.0, so its credit must appear wherever its data does.
app.get('/api/credits', cache.route(async () => ({ enrichment: await queries.enrichmentCredits() })));

app.get('/api/filters', cache.route(() => queries.listFilterOptions()));

app.get('/api/freshness', cache.route(async () => ({ sources: await queries.getFreshness() })));

// Photo sources for the job page (web/public/pilot/live/photos.js, ADR-24).
// The Google key is a browser key: it reaches every viewer by design, so it
// must be restricted to this site's referrer and the Street View Static API,
// with a daily quota cap (docs/IMAGERY.md). Unset, the Street View photo is
// hidden. Behind the demo gate, like every /api route.
app.get('/api/pilot/imagery', (_req, res) => {
  res.set('Cache-Control', 'private, max-age=300');
  // Street View matching is an inference (docs/DATA_TRUST_AUDIT.md): off unless SHOW_INFERENCES=1.
  res.json(trust.filter('imagery', imageryConfig(process.env)));
});

app.use('/api/pilot', overviewApi);
app.use('/api/pilot', pilotApi);

// The Leads screen (the search tool) is the front door. /search and
// /search.html stay as aliases so old links keep working. The pilot screens
// (/pilot/live/*) are no longer linked from it but still load by URL.
// /saved is the same page in its Saved view (app.js reads the path).
app.get(['/', '/search', '/search.html', '/saved', '/contractors'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Permit search running at http://localhost:${PORT}`);
    // Compute every market's overview before the first visitor asks, so the
    // first screen after a deploy is served from memory (web/cache.js).
    const t0 = Date.now();
    cache.warm(warmList()).then(() => console.log(`cache: overviews warmed in ${Date.now() - t0} ms`));
  });
  const shutdown = async () => { server.close(); await db.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { app };
