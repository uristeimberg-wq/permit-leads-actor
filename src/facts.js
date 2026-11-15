// Building facts the sources publish and the permits table never mapped
// (data audit 2026-11-14, docs/research/2026-11-14-data-engine/audit.md):
// units, floors, square feet, residential/commercial class, proposed use,
// zoning, plan-review days, completion and inspection dates, the source's own
// planning and property keys, and a link to the official record.
//
// Pure functions; ingest/facts.js reads the latest raw record of each permit
// and writes one permit_facts row (migration 020) with that raw record's id,
// so every value traces to what the source published (rule 6).
//
// Rules, the same as everywhere (CLAUDE.md):
//   - No invented data. A field a source does not publish stays NULL. Values
//     are parsed, never estimated.
//   - Placeholders are not facts: 0 and 1 square feet, 0 floors and 0 units
//     are NULL. (Miami-Dade and City of Miami type 0 or 1 where nothing is
//     known; a real job is never 1 sq ft.)
//   - A class word no vocabulary below maps stays NULL and is counted in the
//     run report (rule 3).
//   - Names are not extracted here. Miami-Dade's ArchitectName needs its live
//     values checked first (the fixture is redacted).

const FACTS_VERSION = 'facts-v1';

const COLUMNS = ['units', 'floors', 'building_sqft', 'new_sqft', 'remodel_sqft', 'use_class', 'proposed_use',
  'construction_type', 'zoning', 'plan_review_days', 'completed_on', 'last_inspection_on',
  'planning_ref', 'property_ref', 'project_ref', 'record_url'];

// Field names read off each source's fixture and the live audit sample.
const SPECS = {
  'austin-tx': {
    units: 'housing_units', floors: 'number_of_floors',
    building_sqft: 'total_existing_bldg_sqft', new_sqft: 'total_new_add_sqft', remodel_sqft: 'remodel_repair_sqft',
    completed_on: 'completed_date',
    // AMANDA keys (DATA_STRATEGY section 6): project_id groups a project's folders.
    project_ref: 'project_id',
  },
  'austin-plan-review-tx': {
    units: 'number_of_units', floors: 'number_of_floors',
    building_sqft: 'total_existing_bldg_footage', new_sqft: 'total_new_add_footage',
    // AMANDA's own property id, on 100% of cases (DATA_STRATEGY section 1).
    property_ref: 'propertyrsn',
  },
  'miami-dade-fl': {
    units: 'StructureUnits', floors: 'StructureFloors', building_sqft: 'SquareFootage',
    use_class: { field: 'ResidentialCommercial', map: { r: 'residential', c: 'commercial' } },
    proposed_use: 'ProposedUseDescription',
    completed_on: 'CoCcDate', last_inspection_on: 'LastInspectionDate',
    record: { layer: 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0', id: 'ObjectId' },
  },
  'miami-city-fl': {
    building_sqft: 'TotalSQFT',
    use_class: { field: 'PropertyType', map: { residential: 'residential', commercial: 'commercial' } },
    zoning: 'Miami21Zone',
    plan_review_days: 'TotalDaysInPlanReviewNumeric',
    record: { layer: 'https://services1.arcgis.com/CvuPhqcTQpZPT9qY/arcgis/rest/services/Building_Permits_Since_2014/FeatureServer/0', id: 'ObjectId' },
  },
  'raleigh-nc': {
    units: 'housingunitstotal', floors: 'numberstories', building_sqft: 'totalsqft',
    proposed_use: 'proposeduse', construction_type: 'const_type',
    completed_on: ['cocissueddate', 'perm_final_date'],
    // The building layer's link to Raleigh Development_Plans (sprint 2).
    planning_ref: 'devplanid',
    // Two layers share a fieldMap; a row from the building layer carries its
    // declared latitude_perm column (fixture declaredFields), a trade row does not.
    record: {
      layer: (p) => ('latitude_perm' in p
        ? 'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Building_Permits/FeatureServer/0'
        : 'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Permits_Other_Than_Buildings/FeatureServer/0'),
      id: 'OBJECTID',
    },
  },
};

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');

function first(payload, spec) {
  const names = Array.isArray(spec) ? spec : [spec];
  for (const n of names) if (!blank(payload[n])) return payload[n];
  return null;
}

/** A positive number, or null. `min` drops placeholders (0, 1 sq ft). */
function num(v, { min = 0, integer = false } = {}) {
  if (blank(v)) return null;
  const n = Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= min) return null;
  return integer ? (Number.isInteger(n) ? n : null) : n;
}

/** Epoch milliseconds (ArcGIS) or a leading ISO date (Socrata) -> 'YYYY-MM-DD'. */
function day(v) {
  if (blank(v)) return null;
  if (typeof v === 'number') { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); }
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  return Number.isNaN(Date.parse(m[1])) ? null : m[1];
}

const text = (v) => (blank(v) ? null : String(v).trim().replace(/\s+/g, ' '));

/**
 * The facts for one raw payload. Returns null for a source with no spec.
 * `unmapped` lists class words no vocabulary maps, for the run report.
 */
function extractFacts(slug, payload) {
  const spec = SPECS[slug];
  if (!spec || !payload) return null;
  const p = payload;
  const get = (k) => (spec[k] ? first(p, spec[k]) : null);
  const out = {
    units: num(get('units'), { integer: true }),
    floors: num(get('floors')),
    building_sqft: num(get('building_sqft'), { min: 1 }),
    new_sqft: num(get('new_sqft'), { min: 1 }),
    remodel_sqft: num(get('remodel_sqft'), { min: 1 }),
    use_class: null,
    proposed_use: text(get('proposed_use')),
    construction_type: text(get('construction_type')),
    zoning: text(get('zoning')),
    // 0 days is a real value here (same-day approval), so only negatives drop.
    plan_review_days: (() => { const v = get('plan_review_days'); const n = blank(v) ? NaN : Number(v); return Number.isInteger(n) && n >= 0 ? n : null; })(),
    completed_on: day(get('completed_on')),
    last_inspection_on: day(get('last_inspection_on')),
    planning_ref: text(get('planning_ref')),
    property_ref: text(get('property_ref')),
    project_ref: text(get('project_ref')),
    record_url: null,
  };
  const unmapped = [];
  if (spec.use_class) {
    const raw = text(p[spec.use_class.field]);
    if (raw) {
      out.use_class = spec.use_class.map[raw.toLowerCase()] || null;
      if (!out.use_class) unmapped.push(`${spec.use_class.field}=${raw}`);
    }
  }
  if (spec.record) {
    const id = p[spec.record.id];
    const layer = typeof spec.record.layer === 'function' ? spec.record.layer(p) : spec.record.layer;
    // The source's own query page for this one record (ArcGIS REST, HTML view):
    // an official link where the portal has no stable public permit page.
    if (Number.isInteger(Number(id)) && !blank(id)) {
      out.record_url = `${layer}/query?where=${encodeURIComponent(`${spec.record.id}=${Number(id)}`)}&outFields=*&f=html`;
    }
  }
  return { facts: out, unmapped };
}

module.exports = { FACTS_VERSION, COLUMNS, SPECS, extractFacts, num, day };
