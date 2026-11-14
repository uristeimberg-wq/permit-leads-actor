// GET /api/pilot/overview: the data behind the pilot overview screen
// (web/public/pilot/live/index.html). Read-only; queries in db/overview_queries.js.
//
// Map pins are per-ZIP (or per-city) centroids from data/area-coords.json,
// the same file the search map uses, because permits carry no coordinates. A
// pin means "N permits in this ZIP", never "a permit at this point", and the
// count we could not place is returned so the screen can say so.

const express = require('express');
const oq = require('../db/overview_queries.js');
const { SOURCES } = require('../db/pilot_queries.js');
const AREA_COORDS = require('../data/area-coords.json');
const { cache } = require('./cache.js');
const trust = require('./trust.js');

const router = express.Router();

/** True when two centroids are further apart than any one metro area (as in server.js). */
function farApart(a, b, maxKm = 150) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) > maxKm;
}

/** Groups place rows into pins; a ZIP that contradicts its own city falls back to the city. */
function toPins(rows, coords = AREA_COORDS) {
  const pins = new Map();
  let unplaced = 0;
  let unplacedBuilding = 0;
  for (const row of rows) {
    const cityKey = row.city && row.state ? `${String(row.city).toUpperCase()}|${String(row.state).toUpperCase()}` : null;
    const zipCoord = row.zip ? coords.zips[row.zip] : null;
    const cityCoord = cityKey ? coords.cities[cityKey] || coords.cities[`${row.city}|${row.state}`] : null;
    const useZip = zipCoord && !(cityCoord && farApart(zipCoord, cityCoord));
    const coord = useZip ? zipCoord : cityCoord;
    if (!coord) { unplaced += row.permits; unplacedBuilding += row.building; continue; }
    const key = useZip ? `z:${row.zip}` : `c:${cityKey}`;
    const pin = pins.get(key) || {
      key, kind: useZip ? 'zip' : 'city', label: useZip ? row.zip : row.city, zip: useZip ? row.zip : null,
      lat: coord.lat, lng: coord.lng, permits: 0, building: 0,
    };
    pin.permits += row.permits;
    pin.building += row.building;
    pins.set(key, pin);
  }
  const list = [...pins.values()].sort((a, b) => b.building - a.building || b.permits - a.permits);
  return { pins: list, placed: list.reduce((n, p) => n + p.permits, 0), unplaced, unplacedBuilding };
}

const sourceOf = (q) => (SOURCES.includes(q) ? q : 'austin-tx');

async function overviewPayload(source) {
  const { placeRows, ...d } = await oq.overview(source);
  return trust.filter('overview', { source, ...d, map: { days: oq.ACTIVE_DAYS, ...toPins(placeRows) } });
}

// One cache entry per market, whatever else is in the query string.
router.get('/overview', cache.route(
  (req) => overviewPayload(sourceOf(req.query.source)),
  (req) => `overview:${sourceOf(req.query.source)}`,
));

/** Cache entries for every market's overview, for warming on boot. */
const warmList = () => SOURCES.map((s) => [`overview:${s}`, () => overviewPayload(s)]);

module.exports = { router, toPins, farApart, warmList };
