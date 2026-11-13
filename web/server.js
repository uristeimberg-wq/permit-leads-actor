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
const { router: overviewApi } = require('./overview_api.js');
const { demoGate } = require('./access.js');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Liveness for the host's health check. Before the gate, and touches no data.
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// Railway (and most hosts) put one proxy in front: trust it for req.ip (the
// sign-in rate limit) and req.secure (the Secure cookie flag).
app.set('trust proxy', 1);

// A hosted demo sets DEMO_PASSWORD; see web/access.js.
app.use(demoGate());
app.disable('x-powered-by');

// Only these reach the query builder. Anything else a client sends is ignored
// rather than passed through to SQL.
const FILTER_PARAMS = [
  'zip', 'city', 'state', 'jurisdiction', 'sourceArea', 'from', 'to',
  'stage', 'statusRaw', 'status', 'permitType', 'minValuation',
  'trade', 'minScore', 'q', 'page', 'pageSize', 'sort',
  'hasContact', 'contractor', 'areas',
];

function pickFilters(query) {
  const filters = {};
  for (const key of FILTER_PARAMS) {
    const value = query[key];
    if (value !== undefined && value !== '') filters[key] = value;
  }
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
  const filters = pickFilters(req.query);
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
app.get('/api/permits/:id', asyncRoute(async (req, res) => {
  const permit = await queries.getPermit(req.params.id);
  if (!permit) return res.status(404).json({ error: 'Permit not found' });
  return res.json(permit);
}));

// Centroids for the map. Geocoded once against OpenStreetMap and committed, so
// no geocoding happens at request time and nothing is re-fetched per user.
// eslint-disable-next-line global-require
const AREA_COORDS = require('../data/area-coords.json');

/** True when two centroids are further apart than any one metro area. */
function farApart(a, b, maxKm = 150) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) > maxKm;
}

/**
 * Map pins for the current filter set. Counts come from the database and are
 * as real as the list; the COORDINATES are per-area centroids, because permits
 * carry no lat/lng. A pin means "N permits in this ZIP/city", never "a permit
 * at this point" — `placed`/`unplaced` in the response lets the UI say so.
 */
app.get('/api/map', asyncRoute(async (req, res) => {
  const rows = await queries.mapClusters(pickFilters(req.query));

  const pins = new Map();
  let unplaced = 0;

  for (const row of rows) {
    // Prefer the ZIP centroid; fall back to the city when the source gives no
    // ZIP, which is every Miami-Dade record.
    const cityKey = row.city && row.state ? `${row.city}|${row.state}` : null;
    const zipCoord = row.zip ? AREA_COORDS.zips[row.zip] : null;
    const cityCoord = cityKey ? AREA_COORDS.cities[cityKey] : null;

    // Some rows carry a ZIP that contradicts their own city — Miami-Dade has a
    // handful reading 10028 and 18225, which would drop Miami permits into
    // Manhattan and Pennsylvania. The city name is the far more reliable field,
    // so when the two disagree by more than a metro's width, the city wins.
    const useZip = zipCoord && !(cityCoord && farApart(zipCoord, cityCoord));
    const coord = useZip ? zipCoord : cityCoord;

    if (!coord) { unplaced += row.permits; continue; }

    const key = useZip ? `z:${row.zip}` : `c:${cityKey}`;
    const pin = pins.get(key) || {
      key,
      kind: useZip ? 'zip' : 'city',
      label: useZip ? row.zip : row.city,
      sublabel: useZip ? (row.city || '') : (row.state || ''),
      lat: coord.lat, lng: coord.lng,
      permits: 0, pending: 0,
    };
    pin.permits += row.permits;
    pin.pending += row.pending;
    pins.set(key, pin);
  }

  const list = [...pins.values()].sort((a, b) => b.permits - a.permits);
  res.json({
    pins: list,
    placed: list.reduce((n, p) => n + p.permits, 0),
    unplaced,
  });
}));

/**
 * The places the UI is allowed to offer. A ZIP is only offered when we can
 * place it AND its centroid agrees with its own city — Miami-Dade carries a
 * handful of rows reading 10028, 18225 and 24037, which are New York,
 * Pennsylvania and Virginia postal codes on Miami addresses.
 *
 * Nothing becomes unreachable: filtering by city returns those permits too, so
 * they sit under "Miami — all" rather than under a postal code that is wrong.
 */
app.get('/api/areas', asyncRoute(async (_req, res) => {
  const areas = await queries.listAreas();
  const trusted = areas.zips.filter((z) => {
    const zipCoord = AREA_COORDS.zips[z.zip];
    if (!zipCoord) return false;
    const cityCoord = z.city && z.state ? AREA_COORDS.cities[`${z.city}|${z.state}`] : null;
    return !(cityCoord && farApart(zipCoord, cityCoord));
  });

  res.json({
    ...areas,
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

app.get('/api/filters', asyncRoute(async (_req, res) => res.json(await queries.listFilterOptions())));

app.get('/api/freshness', asyncRoute(async (_req, res) => {
  res.json({ sources: await queries.getFreshness() });
}));

app.use('/api/pilot', overviewApi);
app.use('/api/pilot', pilotApi);

// The overview is the front door; the original search tool stays reachable at
// /search.html (and /index.html, so old links keep working).
app.get('/', (_req, res) => res.redirect(302, '/pilot/live/'));
app.get(['/search', '/search.html'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Permit search running at http://localhost:${PORT}`);
  });
  const shutdown = async () => { server.close(); await db.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { app };
