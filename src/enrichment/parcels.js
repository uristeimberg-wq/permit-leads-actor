// Property enrichment (ADR-14 step 3): facts about the parcel a permit is on,
// joined on the official parcel id, never on a fuzzy address match.
//
// Providers:
//   - miami-dade-pa: the Miami-Dade Property Appraiser's public point layer,
//     keyed by 13-digit folio, joined to Miami-Dade county and City of Miami
//     permits (99% of recent county folios match, docs/DATA_SOURCES.md).
//   - wake-parcels: Wake County's parcel polygons, keyed by 10-digit PIN,
//     joined to Raleigh permits' `pin` (94.3% of recent pins found, probe run
//     43593964325). The point is the polygon's area centroid.
//
// Owner, mailing, deed, sale and exemption fields exist on these layers and
// are never requested (rule 5): outFields is an explicit list, not '*', and
// buildParcelQuery refuses a list that names one. Pure functions;
// ingest/enrich_parcels.js does the network and database work.

const PROVIDERS = {
  'miami-dade-pa': {
    label: 'Miami-Dade Property Appraiser',
    layerUrl: 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/PaGISView_gdb/FeatureServer/0',
    keyField: 'FOLIO',
    // Which raw permit field holds the parcel id, per permit source.
    permitKeyFields: { 'miami-dade-fl': 'FolioNumber', 'miami-city-fl': 'FolioNumber' },
    // The layer refreshes weekly (Saturdays), so a parcel older than this is re-read.
    refreshDays: 7,
    outFields: [
      'FOLIO', 'DOR_CODE_CUR', 'DOR_DESC', 'YEAR_BUILT', 'BUILDING_HEATED_AREA', 'BUILDING_ACTUAL_AREA', 'LOT_SIZE',
      'BEDROOM_COUNT', 'BATHROOM_COUNT', 'HALF_BATHROOM_COUNT', 'FLOOR_COUNT', 'UNIT_COUNT',
      'ASSESSED_VAL_CUR', 'ASSESSMENT_YEAR_CUR', 'TRUE_SITE_CITY', 'TRUE_SITE_ZIP_CODE', 'CONDO_FLAG',
    ],
    matchRule: 'folio',
    normalizeKey: (v) => normalizeFolio(v),
    map: (f) => mapMiamiDade(f),
  },
  'wake-parcels': {
    label: 'Wake County parcels',
    layerUrl: 'https://maps.wake.gov/arcgis/rest/services/Property/Parcels/MapServer/0',
    keyField: 'PIN_NUM',
    permitKeyFields: { 'raleigh-nc': 'pin' },
    refreshDays: 7,
    outFields: [
      'PIN_NUM', 'REID', 'CALC_AREA', 'DEED_ACRES', 'BLDG_VAL', 'LAND_VAL', 'TOTAL_VALUE_ASSD', 'HEATEDAREA',
      'YEAR_BUILT', 'TYPE_AND_USE', 'TYPE_USE_DECODE', 'DESIGN_STYLE_DECODE', 'UNITS', 'TOTUNITS', 'TOTSTRUCTS',
      'LAND_CLASS_DECODE', 'CITY_DECODE', 'PLANNING_JURISDICTION', 'ZIPNUM',
    ],
    // Polygons: generalised to about 2 m, enough for a centroid.
    polygon: true,
    matchRule: 'pin',
    normalizeKey: (v) => normalizePin(v),
    map: (f) => mapWake(f),
  },
};

// Never requested, never kept in a payload: owner and mailing names and
// addresses, ownership and billing class (they say whether the owner is a
// person), deed book/page/date, sales and exemptions (DATA_ENGINE_PLAN 6.4).
const OWNER_FIELD = /owner|mail|^addr\d|deed_(book|page|date)|sal(e|price)|exempt|bill/i;

/**
 * A folio as the appraiser writes it: 13 digits. City of Miami stores it as a
 * number, which drops the leading zero (141211320840 -> 0141211320840).
 * Anything else is not a folio and returns null rather than a guess.
 */
function normalizeFolio(value) {
  if (value == null) return null;
  const digits = (typeof value === 'number' ? value.toFixed(0) : String(value)).replace(/\D/g, '');
  if (digits.length === 13) return /^0+$/.test(digits) ? null : digits;
  if (digits.length === 12) return `0${digits}`;
  return null;
}

/** A Wake PIN: 10 digits. Anything else is not a PIN and returns null. */
function normalizePin(value) {
  if (value == null) return null;
  const digits = String(value).replace(/\D/g, '');
  return digits.length === 10 && !/^0+$/.test(digits) ? digits : null;
}

/**
 * The area centroid of an ArcGIS polygon (rings in lng/lat), holes
 * subtracted. Null for an empty or degenerate shape. It can fall outside an
 * L-shaped lot; it is a parcel point, not a building point.
 */
function polygonCentroid(geometry) {
  const rings = (geometry && geometry.rings) || [];
  let a = 0; let cx = 0; let cy = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [x0, y0] = ring[i]; const [x1, y1] = ring[i + 1];
      const cross = x0 * y1 - x1 * y0;
      a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
    }
  }
  if (!rings.length || Math.abs(a) < 1e-14) return null;
  return { lng: cx / (3 * a), lat: cy / (3 * a) };
}

/**
 * One batch query as { url, body }: sent as a form POST, because 100 folios
 * plus the field list make a GET URL that services.arcgis.com rejects with
 * 404 (first production run, 2026-11-13). Keys are digits only, so quoting is
 * safe.
 */
function buildParcelQuery(provider, keys) {
  if (!keys.every((k) => /^\d+$/.test(k))) throw new Error('parcel keys must be digits');
  if (provider.outFields.some((f) => OWNER_FIELD.test(f))) throw new Error('owner fields must never be requested');
  const params = new URLSearchParams({
    f: 'json',
    where: `${provider.keyField} IN (${keys.map((k) => `'${k}'`).join(',')})`,
    outFields: provider.outFields.join(','),
    returnGeometry: 'true',
    outSR: '4326',
    ...(provider.polygon ? { maxAllowableOffset: '0.00002', geometryPrecision: '6' } : {}),
  });
  return { url: `${provider.layerUrl}/query`, body: params.toString() };
}

// The layer writes 0 for "not recorded" (a 0 sq ft house, built in year 0).
// That is missing data, so it becomes NULL (rule 1).
const positive = (v) => (v == null || v === '' || Number(v) <= 0 || Number.isNaN(Number(v)) ? null : Number(v));
const text = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

const cleanPayload = (a) => {
  const payload = {};
  for (const [k, v] of Object.entries(a)) if (!OWNER_FIELD.test(k)) payload[k] = v;
  return payload;
};
const validYear = (y) => (y && y >= 1800 && y <= new Date().getUTCFullYear() + 1 ? y : null);

/** One layer feature -> a parcels row (without ids or timestamps). */
function mapParcel(feature, provider = PROVIDERS['miami-dade-pa']) {
  return provider.map(feature);
}

function mapMiamiDade(feature) {
  const a = feature.attributes || {};
  const g = feature.geometry || {};
  const baths = positive(a.BATHROOM_COUNT);
  const halves = positive(a.HALF_BATHROOM_COUNT);
  const year = positive(a.YEAR_BUILT);
  const payload = cleanPayload(a);
  return {
    parcelKey: normalizeFolio(a.FOLIO),
    landUseCode: text(a.DOR_CODE_CUR),
    landUse: text(a.DOR_DESC),
    yearBuilt: validYear(year),
    heatedSqft: positive(a.BUILDING_HEATED_AREA),
    buildingSqft: positive(a.BUILDING_ACTUAL_AREA),
    lotSqft: positive(a.LOT_SIZE),
    bedrooms: positive(a.BEDROOM_COUNT),
    bathrooms: baths == null && halves == null ? null : (baths || 0) + (halves || 0) / 2,
    units: positive(a.UNIT_COUNT),
    floors: positive(a.FLOOR_COUNT),
    assessedValue: positive(a.ASSESSED_VAL_CUR),
    assessmentYear: positive(a.ASSESSMENT_YEAR_CUR),
    siteCity: text(a.TRUE_SITE_CITY),
    siteZip: text(a.TRUE_SITE_ZIP_CODE) ? String(a.TRUE_SITE_ZIP_CODE).trim().slice(0, 5) : null,
    lat: Number.isFinite(g.y) ? g.y : null,
    lng: Number.isFinite(g.x) ? g.x : null,
    payload,
  };
}

/**
 * Wake County. Values are the county's tax-roll figures for the current year
 * (Wake does not publish the roll year on the layer, so assessmentYear stays
 * NULL). DEED_ACRES is the deeded lot size; 1 acre = 43,560 sq ft exactly.
 * BLDG_VAL / LAND_VAL map to improvement / land value like Travis CAD's.
 */
function mapWake(feature) {
  const a = feature.attributes || {};
  const c = polygonCentroid(feature.geometry);
  const acres = positive(a.DEED_ACRES);
  const units = positive(a.TOTUNITS) ?? positive(a.UNITS);
  return {
    parcelKey: normalizePin(a.PIN_NUM),
    landUseCode: text(a.TYPE_AND_USE),
    landUse: text(a.TYPE_USE_DECODE) || text(a.LAND_CLASS_DECODE),
    yearBuilt: validYear(positive(a.YEAR_BUILT)),
    heatedSqft: positive(a.HEATEDAREA),
    buildingSqft: null,
    lotSqft: acres == null ? null : Math.round(acres * 43560),
    bedrooms: null,
    bathrooms: null,
    units,
    floors: null,
    assessedValue: positive(a.TOTAL_VALUE_ASSD),
    assessmentYear: null,
    landValue: positive(a.LAND_VAL),
    improvementValue: positive(a.BLDG_VAL),
    // DESIGN_STYLE_DECODE (Ranch, Conventional...) is not Travis CAD's
    // improvement type, so it stays in the payload only.
    improvementType: null,
    siteCity: text(a.CITY_DECODE),
    siteZip: text(a.ZIPNUM) ? String(a.ZIPNUM).trim().slice(0, 5) : null,
    lat: c ? c.lat : null,
    lng: c ? c.lng : null,
    payload: cleanPayload(a),
  };
}

module.exports = { PROVIDERS, OWNER_FIELD, normalizeFolio, normalizePin, polygonCentroid, buildParcelQuery, mapParcel };
