// Offline tests for src/inspections.js and the pure part of ingest/inspections.js.
const assert = require('node:assert');
const { SOURCES } = require('./sources.js');
const { mapInspection, validateInspections, resultClass } = require('./inspections.js');
const { toInspections } = require('../ingest/inspections.js');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};

const MD = SOURCES['miami-dade-inspections-fl'];
const RAL = SOURCES['raleigh-inspections-nc'];
// 2026-11-16T05:00Z = midnight in Miami, as the layer stores request dates.
const MD_ROW = { ObjectId: 1, permit_number: 2026043726, sequence_number: 37, input_order: 231, inspector_id: 'E402100',
  date: 1794805200000, request_date: 1794805200000, permit_type: 'BLDG', inspection_description: 'FINAL',
  disp_description: 'NOT  INSPECTED', job_site_address: '4456  SW  11  ST' };
const RAL_ROW = { OBJECTID: 1, IMInspectionID: '57a6c4d9-6af5-4ba1-b61b-61c90f842d1b', Scheduled: 1794459600000,
  InspectionStatus: 'Re-inspection Required', InspectionType: 'Framing [Residential]', IsCompleted: 'True',
  LinkNumber: 'BLDR-028857-2026', Address: '410 Kinsey St, Raleigh, NC 27603' };

check('both inspection sources validate', () => {
  assert.deepStrictEqual(validateInspections('miami-dade-inspections-fl', MD), []);
  assert.deepStrictEqual(validateInspections('raleigh-inspections-nc', RAL), []);
});

check('a Miami-Dade row maps with its composite key, local date and result class', () => {
  const x = mapInspection(MD, MD_ROW);
  assert.strictEqual(x.inspectionKey, '2026043726 | 37 | 2026-11-16 | 231 | E402100');
  assert.strictEqual(x.permitNumber, '2026043726');
  assert.strictEqual(x.scheduledOn, '2026-11-16');
  assert.strictEqual(x.result, 'NOT INSPECTED');
  assert.strictEqual(x.resultClass, 'not_inspected');
  assert.strictEqual(x.completed, null, 'Miami-Dade publishes no completed flag: NULL, not false');
  assert.strictEqual(x.address, '4456 SW 11 ST');
});

check('a Raleigh row maps by EnerGov id; IsCompleted becomes a boolean', () => {
  const x = mapInspection(RAL, RAL_ROW);
  assert.strictEqual(x.inspectionKey, '57a6c4d9-6af5-4ba1-b61b-61c90f842d1b');
  assert.strictEqual(x.permitNumber, 'BLDR-028857-2026');
  assert.strictEqual(x.resultClass, 'rejected');
  assert.strictEqual(x.completed, true);
  assert.strictEqual(mapInspection(RAL, { ...RAL_ROW, IsCompleted: 'False' }).completed, false);
});

check('an unknown wording is unknown, never guessed (rule 3)', () => {
  assert.strictEqual(resultClass(RAL, 'Approved by magic'), 'unknown');
  assert.strictEqual(resultClass(RAL, null), 'unknown');
  assert.strictEqual(resultClass(MD, '  rejected   work concealed '), 'rejected');
});

check('a row without a key part or a permit number is skipped, not stored under a made-up key', () => {
  assert.strictEqual(mapInspection(MD, { ...MD_ROW, inspector_id: null }), null);
  assert.strictEqual(mapInspection(RAL, { ...RAL_ROW, LinkNumber: ' ' }), null);
});

check('duplicate layer rows collapse to one inspection per key', () => {
  const recs = [MD_ROW, { ...MD_ROW }, { ...MD_ROW, input_order: 232 }].map((p, i) => ({ payload: p, sourceKey: String(p.permit_number), payloadHash: `h${i}` }));
  const { inspections, skipped } = toInspections('miami-dade-inspections-fl', recs);
  assert.strictEqual(inspections.length, 2);
  assert.strictEqual(skipped, 0);
});

check('the content hash changes with the result, so history is written', () => {
  const a = toInspections('raleigh-inspections-nc', [{ payload: RAL_ROW, sourceKey: 'k', payloadHash: 'a' }]).inspections[0];
  const b = toInspections('raleigh-inspections-nc', [{ payload: { ...RAL_ROW, InspectionStatus: 'Passed' }, sourceKey: 'k', payloadHash: 'b' }]).inspections[0];
  assert.notStrictEqual(a.contentHash, b.contentHash);
  assert.strictEqual(b.resultClass, 'approved');
});

check('validation catches a name column, an unlisted mapped column and a bad class', () => {
  const bad = { ...RAL, outFields: [...RAL.outFields.filter((f) => f !== 'Address'), 'ContactLastName'],
    inspections: { ...RAL.inspections, results: { ...RAL.inspections.results, 'Odd Case': 'great' } } };
  const problems = validateInspections('x', bad).join('\n');
  assert.match(problems, /ContactLastName/);
  assert.match(problems, /"Address" is mapped but not in outFields/);
  assert.match(problems, /unknown class "great"/);
  assert.match(problems, /must be lower case/);
});
