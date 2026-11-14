// Travis Central Appraisal District (TCAD) export: property facts for Austin
// permits, joined on Austin's own `tcad_id` (ADR-15 step 3b).
//
// Use rules (docs/COMPLIANCE.md, "Travis CAD use rules"):
//   1. Only these facts are read: parcel ids, roll year, year built, living
//      area, land and improvement value, state codes, improvement type, and
//      lot size (LAND_DET square feet).
//   2. Never read: owner name or id, owner or mailing address, deed fields,
//      any exemption flag or amount, sale price, renditions, sketches. The
//      positions below are an allowlist; nothing else is sliced from a line.
//      Homestead and non-homestead values are summed at once, because the
//      split itself would say whether a homestead exemption applies.
//   3. A parcel with any confidential or address-suppression flag set is
//      skipped whole (Tax Code §25.025 protected people).
//   4. Credit "Travis Central Appraisal District", show the roll year, and
//      label values as appraisal estimates.
//
// Positions are 1-based inclusive, from the export layout "Legacy 8.0.33"
// (recon/enrichment_sources.js tcadLayout, read 2026-11-13). Pure functions;
// ingest/enrich_tcad.js does the I/O.

const PROVIDER = {
  slug: 'travis-cad',
  label: 'Travis Central Appraisal District',
  page: 'https://traviscad.org/publicinformation',
  // The supplemental export is re-posted under a new name as the roll changes
  // ("SUPP 336"), so the run finds the newest link on the page and falls back
  // to this one.
  knownFile: 'https://traviscad.org/wp-content/largefiles/travis_SUPP%20336_2026_WEBSITE%20EXPORT_Renamed.zip',
  permitKeyFields: { 'austin-tx': 'tcad_id', 'austin-plan-review-tx': 'appraisal_id' },
};

const PROP = {
  minLength: 4860, // the last field read ends here; a shorter line is a layout change
  propId: [1, 12],
  propType: [13, 17],
  rollYear: [18, 22],
  geoId: [547, 596],
  situsCity: [1110, 1139],
  situsZip: [1140, 1149],
  landHstd: [1796, 1810],
  landNonHstd: [1811, 1825],
  imprvHstd: [1826, 1840],
  imprvNonHstd: [1841, 1855],
  imprvStateCd: [2732, 2741],
  landStateCd: [2742, 2751],
  // Confidential and address-suppression flags for the three owner records
  // the file carries (property year, January 1, current appraisal).
  flags: [[990, 990], [991, 991], [2569, 2569], [2570, 2570], [4859, 4859], [4860, 4860]],
};

const IMP_INFO = { minLength: 83, propId: [1, 12], imprvId: [17, 28], typeCd: [29, 38], typeDesc: [39, 63], value: [70, 83] };

// imprv_det_type_cd and its description sit at 41-50 and 51-75 (read from the
// file by the recon run: "1ST=1st Floor", "2ND=2nd Floor").
const IMP_DET = { minLength: 108, propId: [1, 12], imprvId: [17, 28], typeCd: [41, 50], yearBuilt: [86, 89], area: [94, 108] };
// Living area is the sum of the floor rows (1ST, 2ND, ...); porches, garages
// and decks have their own codes and are left out.
const FLOOR = /^\d(?:ST|ND|RD|TH)$/;

// LAND_DET.TXT (layout "LandDetail", run 43622711795): one row per land
// segment. size_square_feet is whole square feet (run 43622800074: 99.9%
// filled, and sqft / size_acres = 4.356 because acres carry 4 implied
// decimals). A lot is the sum of its segments.
const LAND_DET = { minLength: 97, propId: [1, 12], sqft: [84, 97] };

const cut = (line, [a, b]) => line.slice(a - 1, b).trim();
const num = (v) => (v === '' || !/^-?\d+(\.\d+)?$/.test(v) ? null : Number(v));
const text = (v) => (v === '' ? null : v);

/** Austin's tcad_id in the forms the export uses: geo_id as is, or a prop_id for "letter + digits". */
function permitKey(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (/^\d{4,}$/.test(s)) return { geoId: s };
  const m = s.match(/^[A-Z](\d+)$/);
  return m ? { propId: m[1].replace(/^0+/, '') } : null;
}

/**
 * One PROP.TXT line -> the allowed facts, or { skip } with a reason. Only
 * allowlisted positions are read.
 */
function mapProp(line) {
  if (line.length < PROP.minLength) return { skip: 'short_line' };
  if (PROP.flags.some((r) => cut(line, r) === 'T')) return { skip: 'confidential' };
  const propId = cut(line, PROP.propId).replace(/^0+/, '');
  if (!/^\d+$/.test(propId)) return { skip: 'bad_id' };
  const sum = (a, b) => {
    const x = num(cut(line, a));
    const y = num(cut(line, b));
    return x == null && y == null ? null : (x || 0) + (y || 0);
  };
  return {
    propId,
    geoId: text(cut(line, PROP.geoId)),
    propType: text(cut(line, PROP.propType)),
    rollYear: num(cut(line, PROP.rollYear)),
    siteCity: text(cut(line, PROP.situsCity)),
    siteZip: text(cut(line, PROP.situsZip).slice(0, 5)),
    landValue: sum(PROP.landHstd, PROP.landNonHstd),
    improvementValue: sum(PROP.imprvHstd, PROP.imprvNonHstd),
    stateCode: text(cut(line, PROP.imprvStateCd)) || text(cut(line, PROP.landStateCd)),
  };
}

/** One IMP_INFO.TXT line -> { propId, imprvId, typeCd, typeDesc, value } or null. */
function mapImprovement(line) {
  if (line.length < IMP_INFO.minLength) return null;
  return {
    propId: cut(line, IMP_INFO.propId).replace(/^0+/, ''),
    imprvId: cut(line, IMP_INFO.imprvId).replace(/^0+/, ''),
    typeCd: text(cut(line, IMP_INFO.typeCd)),
    typeDesc: text(cut(line, IMP_INFO.typeDesc)),
    value: num(cut(line, IMP_INFO.value)),
  };
}

/** One IMP_DET.TXT line -> a floor row { propId, imprvId, yearBuilt, area }, or null for anything else. */
function mapFloor(line) {
  if (line.length < IMP_DET.minLength) return null;
  const typeCd = cut(line, IMP_DET.typeCd).toUpperCase();
  if (!FLOOR.test(typeCd)) return null;
  const year = num(cut(line, IMP_DET.yearBuilt));
  const area = num(cut(line, IMP_DET.area));
  return {
    propId: cut(line, IMP_DET.propId).replace(/^0+/, ''),
    imprvId: cut(line, IMP_DET.imprvId).replace(/^0+/, ''),
    yearBuilt: year && year > 1800 && year <= new Date().getUTCFullYear() + 1 ? year : null,
    area: area && area > 0 ? area : null,
  };
}

/** One LAND_DET.TXT line -> { propId, sqft } (a land segment), or null. */
function mapLand(line) {
  if (line.length < LAND_DET.minLength) return null;
  const sqft = num(cut(line, LAND_DET.sqft));
  if (!sqft || sqft <= 0) return null;
  return { propId: cut(line, LAND_DET.propId).replace(/^0+/, ''), sqft };
}

/**
 * Folds one property's improvements and floor rows into its facts. The main
 * building is the improvement with the highest value; year built is its
 * earliest floor year, and living area the sum of its floors.
 */
function summarize(improvements, floors) {
  const main = [...improvements].sort((a, b) => (b.value || 0) - (a.value || 0) || a.imprvId.localeCompare(b.imprvId))[0] || null;
  const mine = main ? floors.filter((f) => f.imprvId === main.imprvId) : [];
  const years = mine.map((f) => f.yearBuilt).filter(Boolean);
  const areas = mine.map((f) => f.area).filter(Boolean);
  return {
    improvementType: main ? (main.typeDesc || main.typeCd) : null,
    yearBuilt: years.length ? Math.min(...years) : null,
    livingSqft: areas.length ? areas.reduce((a, b) => a + b, 0) : null,
  };
}

/** The newest supplemental export link on the public-information page, or null. */
function findExportLink(html, base = PROVIDER.page) {
  const links = [...String(html).matchAll(/href\s*=\s*["']([^"']+\.zip)["']/gi)].map((m) => new URL(m[1], base).toString());
  const supp = links
    .map((u) => ({ u, name: decodeURIComponent(u.split('/').pop()) }))
    .filter(({ name }) => /SUPP\s*\d+/i.test(name) && /EXPORT/i.test(name) && !/JSON|SPECIAL|LAYOUT/i.test(name))
    .map((x) => ({ ...x, n: Number(x.name.match(/SUPP\s*(\d+)/i)[1]) }))
    .sort((a, b) => b.n - a.n);
  return supp.length ? supp[0].u : null;
}

module.exports = { PROVIDER, PROP, IMP_INFO, IMP_DET, LAND_DET, FLOOR, permitKey, mapProp, mapImprovement, mapFloor, mapLand, summarize, findExportLink };
