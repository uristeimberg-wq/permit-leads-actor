// Unit tests for src/facts.js (offline, no DB).
const assert = require('node:assert');
const F = require('./facts.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
};

check('every spec column is a permit_facts column', () => {
  for (const [slug, spec] of Object.entries(F.SPECS)) {
    for (const k of Object.keys(spec)) if (k !== 'record') assert.ok(F.COLUMNS.includes(k), `${slug}.${k}`);
  }
});

check('Austin: units, floors, square feet, completion date and AMANDA project id', () => {
  const { facts } = F.extractFacts('austin-tx', {
    housing_units: '1', number_of_floors: '2', total_new_add_sqft: '2,440', remodel_repair_sqft: '0',
    completed_date: '2026-03-04T00:00:00.000', project_id: '13204411',
  });
  assert.deepStrictEqual([facts.units, facts.floors, facts.new_sqft, facts.remodel_sqft, facts.completed_on, facts.project_ref],
    [1, 2, 2440, null, '2026-03-04', '13204411']);
  assert.strictEqual(facts.record_url, null);
});

check('placeholders are not facts: 0/1 sq ft, 0 floors, fractional units', () => {
  const { facts } = F.extractFacts('miami-dade-fl', { SquareFootage: '1', StructureFloors: '0', StructureUnits: '1.5', ObjectId: 5 });
  assert.deepStrictEqual([facts.building_sqft, facts.floors, facts.units], [null, null, null]);
});

check('Miami-Dade: class R/C, proposed use, epoch dates, official record link', () => {
  const { facts, unmapped } = F.extractFacts('miami-dade-fl', {
    ResidentialCommercial: 'C', ProposedUseDescription: ' WAREHOUSE ', StructureUnits: '5', SquareFootage: '4984',
    LastInspectionDate: Date.UTC(2026, 9, 2), CoCcDate: null, ObjectId: 489601,
  });
  assert.deepStrictEqual([facts.use_class, facts.proposed_use, facts.units, facts.building_sqft, facts.last_inspection_on, facts.completed_on],
    ['commercial', 'WAREHOUSE', 5, 4984, '2026-10-02', null]);
  assert.ok(facts.record_url.startsWith('https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/'));
  assert.ok(facts.record_url.includes('where=ObjectId%3D489601'));
  assert.deepStrictEqual(unmapped, []);
});

check('an unknown class word stays NULL and is reported', () => {
  const { facts, unmapped } = F.extractFacts('miami-city-fl', { PropertyType: 'Mixed Use', ObjectId: 1 });
  assert.strictEqual(facts.use_class, null);
  assert.deepStrictEqual(unmapped, ['PropertyType=Mixed Use']);
});

check('City of Miami: zoning, plan-review days (0 is real), square feet', () => {
  const { facts } = F.extractFacts('miami-city-fl', { Miami21Zone: 'T3-R', TotalDaysInPlanReviewNumeric: 0, TotalSQFT: 0, PropertyType: 'Residential', ObjectId: 230946 });
  assert.deepStrictEqual([facts.zoning, facts.plan_review_days, facts.building_sqft, facts.use_class], ['T3-R', 0, null, 'residential']);
});

check('Raleigh: the record link follows the layer the row came from', () => {
  const b = F.extractFacts('raleigh-nc', { OBJECTID: 283316, latitude_perm: null, devplanid: 'SR-12-2025', proposeduse: '\t RESIDENTIAL TOWNHOUSE' }).facts;
  const t = F.extractFacts('raleigh-nc', { OBJECTID: 9, perm_final_date: Date.UTC(2026, 0, 5) }).facts;
  assert.ok(b.record_url.includes('/Building_Permits/FeatureServer/0/'));
  assert.ok(t.record_url.includes('/Permits_Other_Than_Buildings/FeatureServer/0/'));
  assert.deepStrictEqual([b.planning_ref, b.proposed_use, t.completed_on], ['SR-12-2025', 'RESIDENTIAL TOWNHOUSE', '2026-01-05']);
});

check('a source without a spec, or no payload, gives null', () => {
  assert.strictEqual(F.extractFacts('portland-or', { a: 1 }), null);
  assert.strictEqual(F.extractFacts('austin-tx', null), null);
});

check('dates: junk is NULL, never a guessed day', () => {
  assert.deepStrictEqual([F.day('soon'), F.day(''), F.day('2026-13-40'), F.day('2026-02-03T05:00:00')], [null, null, null, '2026-02-03']);
});

if (failures) { console.error(`${failures} failed`); process.exit(1); }
