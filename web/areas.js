// Where to put an area (a ZIP or a city) on the search map and in the picker.
//
// Two sources of a centre, best first:
//   1. Where that area's permits actually are: the median of their located job
//      sites (permit_locations: the source's own point, the appraiser parcel,
//      or a Census match on the job-site address). Covers every market we sync,
//      Raleigh and every Miami-Dade municipality included.
//   2. data/area-coords.json, geocoded once against OpenStreetMap for the
//      prototype. It has no North Carolina entries and two Miami-Dade cities,
//      so on its own it left Raleigh off the map and out of the ZIP picker.
//
// A ZIP that contradicts its own city is still caught: Miami-Dade carries rows
// reading 10028, 18225 and 24037 (New York, Pennsylvania and Virginia codes on
// Miami addresses). Those rows' job sites geocode to Miami while the code's own
// centre is a thousand miles away, so they are placed by city, never under a
// postal code that is wrong.

const AREA_COORDS = require('../data/area-coords.json');

/** True when two centres are further apart than any one metro area. */
function farApart(a, b, maxKm = 150) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) > maxKm;
}

const cityKeyOf = (city, state) => (city && state ? `${String(city).toUpperCase()}|${String(state).toUpperCase()}` : null);

/**
 * @param {{zip?: string|null, city?: string|null, state?: string|null}} row
 * @param {{zips: Map, cities: Map}} located  medians from queries.areaCentroids()
 * @returns {{key, kind, label, sublabel, lat, lng, basis}|null}  null = cannot place
 *   basis: 'job_sites' (median of N located permits) or 'area_file' (prototype centroid)
 */
function placeArea(row, located, coords = AREA_COORDS) {
  const cityKey = cityKeyOf(row.city, row.state);
  const zipLoc = row.zip ? located.zips.get(row.zip) : null;
  const zipFile = row.zip ? coords.zips[row.zip] : null;
  const cityLoc = cityKey ? located.cities.get(cityKey) : null;
  const cityFile = cityKey ? coords.cities[cityKey] : null;
  const cityCoord = cityLoc || cityFile;

  let zipCoord = zipLoc || zipFile;
  if (zipCoord) {
    // The postal code's own centre disagrees with where its permits are, or
    // with its city: the code is wrong on the record, so the city wins.
    const contradicts = (zipFile && zipLoc && farApart(zipFile, zipLoc))
      || (cityCoord && farApart(zipCoord, cityCoord));
    if (contradicts) zipCoord = null;
  }

  if (zipCoord) {
    return { key: `z:${row.zip}`, kind: 'zip', label: row.zip, sublabel: row.city || '',
      lat: zipCoord.lat, lng: zipCoord.lng, basis: zipLoc && zipCoord === zipLoc ? 'job_sites' : 'area_file' };
  }
  if (cityCoord) {
    return { key: `c:${row.city}|${row.state}`, kind: 'city', label: row.city, sublabel: row.state || '',
      lat: cityCoord.lat, lng: cityCoord.lng, basis: cityLoc ? 'job_sites' : 'area_file' };
  }
  return null;
}

/** True when the picker may offer this ZIP: it places as a ZIP, not by city. */
function zipIsTrusted(z, located, coords = AREA_COORDS) {
  const placed = placeArea(z, located, coords);
  return Boolean(placed && placed.kind === 'zip');
}

// ── Broad areas (the "general location" in the Leads picker) ────────────────
//
// One per state we hold, because each state we sync is one market: Texas is
// Austin and its ETJ, Florida is Miami-Dade and the City of Miami, North
// Carolina is Raleigh. A state with only a handful of rows (a typo'd "CT" on
// a Raleigh record) is not offered as an area; those rows stay reachable by
// city. Keys are `a:<STATE>`, alongside the picker's `z:` and `c:` keys.
const REGION_LABELS = { TX: 'Austin area, TX', FL: 'Miami area, FL', NC: 'Raleigh area, NC', OR: 'Oregon (older data)' };
const MIN_REGION_PERMITS = 50;

/** The broad areas to offer, busiest first, from listAreas() rows. */
function regionsFrom(areas) {
  const byState = new Map();
  for (const c of areas.cities || []) {
    const st = String(c.state || '').toUpperCase();
    if (!st) continue;
    byState.set(st, (byState.get(st) || 0) + c.permits);
  }
  return [...byState.entries()]
    .filter(([, permits]) => permits >= MIN_REGION_PERMITS)
    .map(([state, permits]) => ({ key: `a:${state}`, state, label: REGION_LABELS[state] || state, permits }))
    .sort((a, b) => b.permits - a.permits);
}

/**
 * Rewrites `a:<STATE>` keys in an `areas` filter into the `c:` and `z:` keys
 * db/queries.js understands (every city and ZIP we hold in that state), so a
 * shared link stays short and the query layer is unchanged. Other keys pass
 * through untouched, and duplicates are dropped.
 */
function expandAreaKeys(areasParam, areas) {
  const keys = String(areasParam || '').split(',').map((k) => k.trim()).filter(Boolean);
  if (!keys.some((k) => k.startsWith('a:'))) return keys.join(',');
  const out = new Set();
  for (const key of keys) {
    if (!key.startsWith('a:')) { out.add(key); continue; }
    const st = key.slice(2).toUpperCase();
    for (const c of areas.cities || []) if (String(c.state || '').toUpperCase() === st) out.add(`c:${String(c.city).toUpperCase()}|${st}`);
    for (const z of areas.zips || []) if (String(z.state || '').toUpperCase() === st) out.add(`z:${z.zip}`);
  }
  // An area we hold nothing for must still filter to nothing, not to everything.
  return out.size ? [...out].join(',') : 'none:';
}

/**
 * The query filters for an `areas` value. One broad area on its own becomes
 * `state=`, which is exact: some sources publish no city or ZIP at all (City
 * of Miami, Austin's plan-review feed), so only the state reaches them. Mixed
 * with other places, an area expands to its cities and ZIPs (expandAreaKeys),
 * because db/queries.js cannot OR a state with them; those city-less rows are
 * then left out. Returns the fields to merge over the request's filters.
 */
function areaFilters(areasParam, areas) {
  const keys = String(areasParam || '').split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 1 && keys[0].startsWith('a:')) return { areas: undefined, state: keys[0].slice(2).toUpperCase() };
  return { areas: expandAreaKeys(keys.join(','), areas) };
}

module.exports = { placeArea, zipIsTrusted, farApart, cityKeyOf, regionsFrom, expandAreaKeys, areaFilters, REGION_LABELS };
