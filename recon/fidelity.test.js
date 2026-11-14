const assert = require('node:assert');
const { SOURCES } = require('../src/sources.js');
const { canon, compareFields, diffRaw, mapOne, windowCatches, keyWhere, judge, wilson } = require('./fidelity.js');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};

const austin = SOURCES['austin-tx'];
const raleigh = SOURCES['raleigh-nc'];
const austinRow = require('../test/fixtures/sources/austin-tx.json').rows[0];
const raleighRow = require('../test/fixtures/sources/raleigh-nc.json').rows[0];

// A stored permit row exactly as today's code would write it from a raw row.
const storedFrom = (source, row) => {
  const m = mapOne(source, row);
  return {
    permit_type: m.permitType, work_description: m.workDescription, valuation: m.valuation,
    status_raw: m.statusRaw, lifecycle_stage: m.lifecycleStage, filed_date: m.filedDate ? new Date(`${m.filedDate}T00:00:00Z`) : null,
    submitted_on: m.submittedOn, stage_since: m.stageSince, address: m.address, zip: m.zip,
    contractor_name: m.contractorName, contractor_phone: m.contractorPhone, contractor_licence: m.contractorLicence,
    permit_url: m.permitUrl,
  };
};

check('canon treats blanks as null, numeric strings as numbers, dates as days', () => {
  assert.strictEqual(canon('  '), null);
  assert.strictEqual(canon('1200.00'), 1200);
  assert.strictEqual(canon(new Date('2026-11-12T00:00:00Z')), '2026-11-12');
  assert.strictEqual(canon(' A  B '), 'A B');
});

check('an unchanged Austin row matches on every field, pipeline and live', () => {
  const v = judge({ source: austin, stored: storedFrom(austin, austinRow), storedRaw: austinRow, liveRows: [austinRow] });
  assert.strictEqual(v.found, true);
  assert.deepStrictEqual(v.rawChanged, []);
  assert.deepStrictEqual(v.shown, []);
  assert.deepStrictEqual(v.pipeline, []);
});

check('an unchanged Raleigh (ArcGIS) row matches too', () => {
  const v = judge({ source: raleigh, stored: storedFrom(raleigh, raleighRow), storedRaw: raleighRow, liveRows: [raleighRow] });
  assert.deepStrictEqual(v.shown, []);
  assert.deepStrictEqual(v.pipeline, []);
});

check('a source edit shows as raw change and a shown mismatch, not a pipeline one', () => {
  const edited = { ...austinRow, description: 'Something else entirely' };
  const v = judge({ source: austin, stored: storedFrom(austin, austinRow), storedRaw: austinRow, liveRows: [edited] });
  assert.deepStrictEqual(v.rawChanged, ['description']);
  assert.deepStrictEqual(v.substantive, ['description']);
  assert.deepStrictEqual(v.shown.map(({ field, kind }) => ({ field, kind })), [{ field: 'work_description', kind: 'differs' }]);
  assert.deepStrictEqual(v.pipeline, []);
});

check('a value the source removed but we still show is "kept_ours"', () => {
  const stored = { ...storedFrom(austin, austinRow), contractor_name: 'ACME ELECTRIC LLC' };
  const blank = { ...austinRow, contractor_company_name: undefined, contractor_full_name: undefined };
  const v = judge({ source: austin, stored, storedRaw: austinRow, liveRows: [blank] });
  assert.ok(v.shown.some((d) => d.field === 'contractor_name'));
});

check('a record missing from the source is not found', () => {
  assert.deepStrictEqual(judge({ source: austin, stored: {}, storedRaw: austinRow, liveRows: [] }), { found: false });
});

check('diffRaw lists keys present on one side only', () => {
  assert.deepStrictEqual(diffRaw({ a: 1, b: 2 }, { a: 1, c: 3 }), ['b', 'c']);
});

check('windowCatches reads the sync windows, ISO and epoch dates', () => {
  const now = new Date('2026-11-14T00:00:00Z');
  assert.strictEqual(windowCatches(austin, { issue_date: '2026-11-01T00:00:00.000' }, now), true);
  assert.strictEqual(windowCatches(austin, { issue_date: '2025-01-01T00:00:00.000', statusdate: '2026-11-10T00:00:00.000' }, now), true);
  assert.strictEqual(windowCatches(austin, { issue_date: '2025-01-01T00:00:00.000', statusdate: '2025-02-01T00:00:00.000' }, now), false);
  assert.strictEqual(windowCatches(raleigh, { issueddate: Date.parse('2026-11-05T00:00:00Z') }, now), true);
});

check('keyWhere quotes strings and escapes quotes', () => {
  assert.strictEqual(keyWhere('k', ["a'b", 'c'], false), "k IN ('a''b','c')");
  assert.strictEqual(keyWhere('k', ['12', '7'], true), 'k IN (12,7)');
});

check('wilson bound: 0 of 300 is under about 1.3%', () => {
  const [lo, hi] = wilson(0, 300);
  assert.strictEqual(lo, 0);
  assert.ok(hi > 0.01 && hi < 0.014, String(hi));
});

check('bookkeeping-only changes are not substantive edits', () => {
  const touched = { ...raleighRow, EditDate: 1 };
  const v = judge({ source: raleigh, stored: storedFrom(raleigh, raleighRow), storedRaw: raleighRow, liveRows: [touched] });
  assert.deepStrictEqual(v.rawChanged, ['EditDate']);
  assert.deepStrictEqual(v.substantive, []);
});
