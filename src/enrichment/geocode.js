// Permit locations (ADR-15 item 4). A permit's point comes from, in order:
//   1. the source's own coordinates (sources.js `coordinates`)        'source'
//   2. the appraiser parcel it is joined to (permit_parcels)           'parcel'
//   3. the US Census batch geocoder, on the JOB-SITE address only       'census'
// Contractor business addresses are never geocoded: the Census terms forbid
// using its data to identify a business (compliance review, PR #28).
// Pure functions; ingest/geocode.js does the I/O.

const CENSUS = {
  url: 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch',
  benchmark: 'Public_AR_Current',
  batch: 10000, // the service's stated per-file limit
};

// Roughly the continental US plus Alaska and Hawaii; a point outside it is a
// data error (0,0 or a swapped pair), not a place.
const inUS = (lat, lng) => lat >= 18 && lat <= 72 && lng >= -180 && lng <= -64;

function point(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (lat == null || lng == null || lat === '' || lng === '' || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return inUS(a, b) ? { lat: a, lng: b } : null;
}

/** The source's own point from a raw payload, or null. */
function sourcePoint(source, payload) {
  const c = source && source.coordinates;
  if (!c || !payload) return null;
  return point(payload[c.lat], payload[c.lng]);
}

/** A stable key for one job-site address, so it is geocoded once. */
function addressKey({ street, city, state, zip }) {
  const norm = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const st = norm(street);
  const z = String(zip ?? '').replace(/\D/g, '').slice(0, 5);
  if (!st || !/^\d/.test(st) || (!z && !norm(city))) return null; // nothing a geocoder can place
  return [st, norm(city), norm(state), z].join('|');
}

const csvField = (v) => `"${String(v ?? '').replace(/"/g, '')}"`;

/** Census batch input: "id","street","city","state","zip" per line, no header. */
function buildCensusCsv(items) {
  if (items.length > CENSUS.batch) throw new Error(`Census batch limit is ${CENSUS.batch}`);
  return items.map(({ id, key }) => {
    const [street, city, state, zip] = key.split('|');
    return [id, street, city, state, zip].map(csvField).join(',');
  }).join('\n');
}

/**
 * Census batch output -> Map(id -> result). Rows are
 * id, input, Match|No_Match|Tie, Exact|Non_Exact, matched address, "lon,lat", ...
 * A tie is ambiguous, so it is no match.
 */
function parseCensusResult(text, parseCsvLine) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    const id = f[0];
    if (f[2] === 'Match') {
      const [lng, lat] = String(f[5] || '').split(',');
      const p = point(lat, lng);
      out.set(id, p ? { matched: true, quality: f[3] === 'Exact' ? 'exact' : 'non_exact', matchedAddress: f[4] || null, ...p }
        : { matched: false, quality: 'bad_point' });
    } else {
      out.set(id, { matched: false, quality: f[2] === 'Tie' ? 'tie' : 'no_match' });
    }
  }
  return out;
}

module.exports = { CENSUS, point, sourcePoint, addressKey, buildCensusCsv, parseCensusResult };
