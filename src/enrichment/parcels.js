// Property enrichment (ADR-14 step 3): facts about the parcel a permit is on,
// joined on the official parcel id, never on a fuzzy address match.
//
// One provider today: the Miami-Dade Property Appraiser's public point layer,
// keyed by 13-digit folio, joined to Miami-Dade county and City of Miami
// permits (99% of recent county folios match, docs/DATA_SOURCES.md).
//
// Owner fields exist on the layer and are never requested (rule 5): outFields
// below is an explicit list, not '*'. Pure functions; ingest/enrich_parcels.js
// does the network and database work.

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
  },
};

const OWNER_FIELD = /owner|mail/i;

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
  });
  return { url: `${provider.layerUrl}/query`, body: params.toString() };
}

// The layer writes 0 for "not recorded" (a 0 sq ft house, built in year 0).
// That is missing data, so it becomes NULL (rule 1).
const positive = (v) => (v == null || v === '' || Number(v) <= 0 || Number.isNaN(Number(v)) ? null : Number(v));
const text = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

/** One layer feature -> a parcels row (without ids or timestamps). */
function mapParcel(feature) {
  const a = feature.attributes || {};
  const g = feature.geometry || {};
  const baths = positive(a.BATHROOM_COUNT);
  const halves = positive(a.HALF_BATHROOM_COUNT);
  const year = positive(a.YEAR_BUILT);
  const payload = {};
  for (const [k, v] of Object.entries(a)) if (!OWNER_FIELD.test(k)) payload[k] = v;
  return {
    parcelKey: normalizeFolio(a.FOLIO),
    landUseCode: text(a.DOR_CODE_CUR),
    landUse: text(a.DOR_DESC),
    yearBuilt: year && year >= 1800 && year <= new Date().getUTCFullYear() + 1 ? year : null,
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

module.exports = { PROVIDERS, normalizeFolio, buildParcelQuery, mapParcel };
