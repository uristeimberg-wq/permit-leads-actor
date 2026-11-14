const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mapCase, validatePlanning, toInt } = require('./planning.js');
const { SOURCES } = require('./sources.js');
const { caseHash } = require('../ingest/planning.js');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};
const fixture = (slug) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'sources', `${slug}.json`), 'utf8')).rows;

check('Austin site plan: key, stage, address from parts, parcel and property refs, business owner', () => {
  const src = SOURCES['austin-site-plans-tx'];
  const c = mapCase(src, fixture('austin-site-plans-tx')[0]);
  assert.strictEqual(c.caseNumber, '13804835');
  assert.strictEqual(c.caseRef, null, 'no human case number yet at intake: NULL, not invented');
  assert.strictEqual(c.caseKind, 'site_plan');
  assert.strictEqual(c.lifecycleStage, 'submitted');
  assert.strictEqual(c.filedOn, '2026-11-13');
  assert.strictEqual(c.address, '830 ESTANCIA PKWY');
  assert.strictEqual(c.parcel, '0447130103');
  assert.strictEqual(c.propertyRef, '6226634');
  // The fixture redacts a non-business applicant organisation as REDACTED.
  assert.deepStrictEqual(c.parties.filter((p) => p.name !== 'REDACTED'), [{ role: 'owner', name: 'KB HOME LONE STAR INC', partyKind: 'business' }]);
  assert.match(c.recordUrl, /folderrsn=13804835$/);
});

check('Austin subdivision: lots proposed, two businesses, completeness-check status in review', () => {
  const src = SOURCES['austin-subdivisions-tx'];
  const c = mapCase(src, fixture('austin-subdivisions-tx')[1]);
  assert.strictEqual(c.caseKind, 'subdivision');
  assert.strictEqual(c.caseRef, '2026-149676 C');
  assert.strictEqual(c.lotsProposed, 212);
  assert.deepStrictEqual(c.parties.map((p) => [p.role, p.partyKind]), [['applicant', 'business'], ['owner', 'business']]);
  assert.strictEqual(mapCase(src, { projectid: '1', status: 'CC Pending' }).lifecycleStage, 'in_review');
});

check('an unmapped status is unknown, never guessed (rule 3)', () => {
  const src = SOURCES['austin-site-plans-tx'];
  assert.strictEqual(mapCase(src, { folderrsn: '1', status: 'Closed' }).lifecycleStage, 'unknown');
  assert.strictEqual(mapCase(SOURCES['raleigh-devplans-nc'], { plan_number: 'X', status: 'Active' }).lifecycleStage, 'unknown');
});

check('placeholders are NULL: "0" property id, 0 square feet, blank developer', () => {
  const sub = mapCase(SOURCES['austin-subdivisions-tx'], { projectid: '9', propertyrsn: '0', proposed_no_of_lots: '0' });
  assert.strictEqual(sub.propertyRef, null);
  assert.strictEqual(sub.lotsProposed, null);
  const areas = mapCase(SOURCES['raleigh-plan-areas-nc'], fixture('raleigh-plan-areas-nc')[0]);
  assert.strictEqual(areas.floorAreaSqft, null, 'square_feet 0 on every row is a placeholder');
  const dp = mapCase(SOURCES['raleigh-devplans-nc'], { plan_number: 'SUB-1', developer: ' ' });
  assert.deepStrictEqual(dp.parties, []);
  assert.strictEqual(toInt('1,250'), 1250);
});

check('Raleigh plan areas: type word -> kind, PIN as parcel, epoch dates', () => {
  const rows = fixture('raleigh-plan-areas-nc');
  const src = SOURCES['raleigh-plan-areas-nc'];
  const spr = mapCase(src, rows[0]);
  assert.strictEqual(spr.caseKind, 'site_plan');
  assert.strictEqual(spr.parcel, '1705002247');
  assert.match(spr.filedOn, /^2026-11-1\d$/);
  assert.strictEqual(spr.lifecycleStage, 'submitted');
  const sub = mapCase(src, rows.find((r) => /^SUB-/.test(r.plan_number)));
  assert.strictEqual(sub.caseKind, 'subdivision');
  assert.strictEqual(mapCase(src, { plan_number: 'X', plan_type: 'Something New' }).caseKind, 'other');
});

check('Raleigh plan details: developer stored with its kind; a person-shaped name is marked individual', () => {
  const src = SOURCES['raleigh-devplans-nc'];
  const c = mapCase(src, fixture('raleigh-devplans-nc').find((r) => r.developer === 'SAYF DEEN HOLDINGS LLC'));
  assert.deepStrictEqual(c.parties, [{ role: 'developer', name: 'SAYF DEEN HOLDINGS LLC', partyKind: 'business' }]);
  const p = mapCase(src, { plan_number: 'X', developer: 'Jane Smith' });
  assert.strictEqual(p.parties[0].partyKind, 'individual');
});

check('DERM sewer certification: utility allocation, flow, folio, process number as the official ref', () => {
  const src = SOURCES['miami-derm-sewer-fl'];
  const c = mapCase(src, fixture('miami-derm-sewer-fl')[0]);
  assert.strictEqual(c.caseNumber, '2026-ALLOCATION-03641 | 3050160190080 | 8846 SW 129 TER');
  assert.strictEqual(c.caseRef, '2026-ALLOCATION-03641');
  assert.strictEqual(c.caseKind, 'utility_allocation');
  assert.strictEqual(c.parcel, '3050160190080');
  assert.strictEqual(c.officialRef, 'U2026004290');
  assert.strictEqual(c.flowGpd, 30);
  assert.match(c.filedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(c.lifecycleStage, 'unknown', 'COALLOC is not mapped');
  assert.strictEqual(mapCase(src, { EEOSALLCNO: 'A', SWRAPVCODE: 'APP' }).lifecycleStage, 'approved');
  assert.strictEqual(mapCase(src, { EEOSALLCNO: 'A', SWRAPVCODE: 'BPEXP' }).lifecycleStage, 'expired');
  assert.strictEqual(mapCase(src, { EEOSALLCNO: 'A', BLDPROCNO: 'N/A' }).officialRef, null);
});

check('one DERM allocation over several lots is one case per lot, each with its own process number', () => {
  const src = SOURCES['miami-derm-sewer-fl'];
  const lot = (address, proc) => ({ EEOSALLCNO: '2025-ALLOCATION-04612', FOLIO: '3069350000080', ADDRESS: address, BLDPROCNO: proc, SWRAPVCODE: 'APP' });
  const a = mapCase(src, lot('13339 SW 265 TER', 'C2025154944'));
  const b = mapCase(src, lot('13374 SW 265 TER', 'C2025154949'));
  assert.notStrictEqual(a.caseNumber, b.caseNumber);
  assert.deepStrictEqual([a.caseRef, a.officialRef, b.officialRef], ['2025-ALLOCATION-04612', 'C2025154944', 'C2025154949']);
  assert.strictEqual(mapCase(src, lot('13339 SW 265 TER', 'C2025154944')).caseNumber, a.caseNumber, 'stable on re-runs');
  assert.strictEqual(mapCase(src, { FOLIO: '1', ADDRESS: 'x' }), null, 'no allocation number: no case');
});

check('links: a parcel rule needs a hand check to be on, and a rule that failed one is off with its reason', () => {
  for (const [slug, s] of Object.entries(SOURCES).filter(([, x]) => x.kind === 'planning')) {
    for (const l of s.planning.links || []) {
      if (l.kind !== 'parcel_window') continue;
      assert.ok(l.measured && l.measured.read > 0, `${slug}: no hand check`);
      if (l.enabled !== false) assert.ok(l.measured.same / l.measured.read >= 0.6, `${slug}: on below the 60% bar`);
    }
  }
  assert.strictEqual(SOURCES['austin-subdivisions-tx'].planning.links[0].enabled, false);
  const ral = SOURCES['raleigh-plan-areas-nc'].planning.links[0];
  assert.notStrictEqual(ral.enabled, false, 'Raleigh is on for new construction only');
  assert.deepStrictEqual(ral.permitFilter, { field: 'workclassmapped', equals: 'New' });
  const base = { planning: { fields: { caseNumber: 'a' } } };
  assert.deepStrictEqual(validatePlanning('x', { planning: { ...base.planning, links: [{ kind: 'parcel_window' }] } }),
    ['x: a parcel_window link needs a measured hand check before it is enabled']);
  assert.deepStrictEqual(validatePlanning('x', { planning: { ...base.planning, links: [{ kind: 'parcel_window', enabled: false }] } }),
    ['x: a disabled link needs offReason']);
});

check('a row without a case number is skipped, not stored under a made-up key', () => {
  assert.strictEqual(mapCase(SOURCES['austin-site-plans-tx'], { status: 'Pending' }), null);
});

check('every fixture row maps; case hash is stable and changes with the status', () => {
  for (const slug of ['austin-site-plans-tx', 'austin-subdivisions-tx', 'raleigh-plan-areas-nc', 'raleigh-devplans-nc', 'miami-derm-sewer-fl']) {
    const cases = fixture(slug).map((r) => mapCase(SOURCES[slug], r));
    assert.ok(cases.every(Boolean), slug);
  }
  const row = fixture('austin-site-plans-tx')[0];
  const a = mapCase(SOURCES['austin-site-plans-tx'], row);
  assert.strictEqual(caseHash(a), caseHash(mapCase(SOURCES['austin-site-plans-tx'], { ...row })));
  assert.notStrictEqual(caseHash(a), caseHash(mapCase(SOURCES['austin-site-plans-tx'], { ...row, status: 'In Review' })));
});

check('validatePlanning catches typos', () => {
  assert.deepStrictEqual(validatePlanning('x', { planning: { fields: { caseNumber: 'a', unitz: 'b' }, caseKind: 'plat' } }),
    ['x: unknown planning field "unitz"', 'x: unknown caseKind "plat"']);
});
