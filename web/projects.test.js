// Projects (web/projects.js + web/project_stages.js): which permits link,
// the project's value, kinds and stage. Offline, on hand-made rows.
const assert = require('node:assert');
const { group, listProjects, projectFor, projectValue, addressKey } = require('./projects.js');
const { stageOf } = require('./project_stages.js');

const row = (id, o = {}) => ({
  id, source_area: 'austin-tx', permit_number: `2026-${100000 + id} BP`, address: `${id} MAIN ST, AUSTIN TX 78702`, zip: '78702', city: 'AUSTIN',
  permit_type: 'Building Permit', status_stage: 'approved', filed_date: '2026-10-01', valuation: null,
  contractor_name: null, contractor_phone: null, work_description: '', job: { jobKey: `2026-${100000 + id}`, isBuilding: true, trade: null }, ...o,
});
const sizes = (groups) => groups.map((g) => g.members.length).sort((a, b) => b - a);

// Address keys: the BLDG tail goes (with any UNIT after it); a bare UNIT stays.
assert.strictEqual(addressKey({ address: '2501 BRYAN ST BLDG 3, AUSTIN TX', zip: '78702' }), '2501 BRYAN ST|78702');
assert.strictEqual(addressKey({ address: '1706 RIVERVIEW ST BLDG 1 UNIT A, AUSTIN TX', zip: '78702' }), '1706 RIVERVIEW ST|78702');
assert.strictEqual(addressKey({ address: '1011 E 5TH ST UNIT 120, AUSTIN TX', zip: '78702' }), '1011 E 5TH ST UNIT 120|78702');

// 1. The same official job number links a building permit and its trade permits.
const job = [
  row(1),
  row(2, { permit_number: '2026-100001 EP', permit_type: 'Electrical Permit', job: { jobKey: '2026-100001', isBuilding: false, trade: 'electrical' } }),
  row(3, { permit_number: '2026-100001 PP', permit_type: 'Plumbing Permit', job: { jobKey: '2026-100001', isBuilding: false, trade: 'plumbing' } }),
];
assert.deepStrictEqual(sizes(group(job)), [3]);
assert.deepStrictEqual(group(job)[0].basis, ['permit number']);

// 2. "Ref: <number> BP" in a description links to that building permit.
const ref = [row(10), row(11, { permit_number: '2026-199999 EP', job: { jobKey: '2026-199999', isBuilding: false, trade: 'electrical' }, work_description: 'Home builders loop\nRef: 2026-100010 BP' })];
assert.deepStrictEqual(sizes(group(ref)), [2]);
assert.ok(group(ref)[0].basis.includes('ref in description'));

// 3. Same address (BLDG 1 / BLDG 3) only with inferences, and only within a year.
const bldgs = [
  row(20, { address: '2501 BRYAN ST BLDG 1, AUSTIN TX 78702' }),
  row(21, { address: '2501 BRYAN ST BLDG 3, AUSTIN TX 78702' }),
  row(22, { address: '2501 BRYAN ST, AUSTIN TX 78702', filed_date: '2023-01-01' }),   // years earlier: another job
];
assert.deepStrictEqual(sizes(group(bldgs)), [1, 1, 1], 'no address links without inferences');
assert.deepStrictEqual(sizes(group(bldgs, { inferences: true })), [2, 1]);
// A bare UNIT is a different tenant, never joined by address.
assert.deepStrictEqual(sizes(group([row(30, { address: '1011 E 5TH ST UNIT 120, AUSTIN TX' }), row(31, { address: '1011 E 5TH ST UNIT 130, AUSTIN TX' })], { inferences: true })), [1, 1]);
// Raleigh's job link is a parcel PIN: an address-like link, inferences only.
const pin = [row(40, { source_area: 'raleigh-nc', job: { jobKey: 'PIN1', isBuilding: true } }), row(41, { source_area: 'raleigh-nc', address: '9 OTHER ST', job: { jobKey: 'PIN1', isBuilding: false, trade: 'electrical' } })];
assert.deepStrictEqual(sizes(group(pin)), [1, 1]);
assert.deepStrictEqual(sizes(group(pin, { inferences: true })), [2]);

// Value: summed, a value repeated on several permits counted once, $1 and $1B+ left out.
assert.deepStrictEqual(projectValue([{ valuation: 100e6 }, { valuation: 100e6 }, { valuation: 100e6 }]), { total: 100e6, counted: 1, repeated: 2, odd: 0 });
assert.deepStrictEqual(projectValue([{ valuation: 300000 }, { valuation: 50000 }, { valuation: 1 }, { valuation: 8.1e9 }]), { total: 350000, counted: 2, repeated: 0, odd: 1 });
assert.deepStrictEqual(projectValue([{ valuation: null }]), { total: null, counted: 0, repeated: 0, odd: 0 });

// Stage, in rule order.
const p = (o) => row(0, o);
const ep = (o) => p({ job: { isBuilding: false, trade: 'electrical' }, permit_type: 'Electrical Permit', ...o });
assert.strictEqual(stageOf([p({ status_stage: 'pending' })]), 'In permitting');
assert.strictEqual(stageOf([p()]), 'Permitted – not started');
assert.strictEqual(stageOf([p(), ep({ work_description: 'Temporary power pole for construction' })]), 'Temp power / site work');
assert.strictEqual(stageOf([p(), ep()]), 'Rough-in (MEP)');
assert.strictEqual(stageOf([p({ status_stage: 'finished' }), ep({ status_stage: 'finished' })]), 'Finished');
assert.strictEqual(stageOf([p({ status_stage: 'cancelled' })]), 'Cancelled');
assert.strictEqual(stageOf([ep({ job: { isBuilding: false, trade: 'electrical' } })]), 'Rough-in (MEP)');

// Listing: one card per project, sorted, paged; phones once each; stage only with inferences.
const rows = [...job.map((r) => ({ ...r, contractor_phone: '5125550100', contractor_name: 'Acme LLC' })), ...bldgs];
const off = listProjects(rows, { pageSize: 10 });
assert.strictEqual(off.total, 4);
assert.ok(off.results.every((r) => r.stage === null));
const on = listProjects(rows, { pageSize: 10, inferences: true });
assert.strictEqual(on.total, 3);
const acme = on.results.find((r) => r.permitCount === 3);
assert.strictEqual(acme.phones.length, 1, 'one phone listed once');
assert.deepStrictEqual(acme.chips.map((c) => c.code), ['BP', 'EP', 'PP']);
assert.ok(acme.stage);
// A project page from candidate rows, found from any of its permits.
assert.strictEqual(projectFor(3, job).permitCount, 3);
assert.strictEqual(projectFor(999, job), null);

console.log('projects.test.js: all passed');
