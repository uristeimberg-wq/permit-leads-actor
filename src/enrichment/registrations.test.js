const assert = require('node:assert');
const R = require('./registrations.js');
const fx = require('../../test/fixtures/enrichment/tx-comptroller.json');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};

check('search text: the name up to its first "and", upper case, at most 50 characters', () => {
  assert.strictEqual(R.searchText('protex plumbing and mechanical'), 'PROTEX PLUMBING');
  assert.strictEqual(R.searchText('ies residential'), 'IES RESIDENTIAL');
  assert.strictEqual(R.searchText('a and b roofing'), 'A AND B ROOFING', 'a head shorter than 4 characters sends the whole name');
  assert.ok(R.searchText('x'.repeat(80)).length === 50);
  assert.strictEqual(R.searchText(''), null);
});

check('one taxpayer with exactly our name is a match', () => {
  const m = R.pickMatch('ies residential', fx.search['IES Residential, Inc.']);
  assert.deepStrictEqual([m.outcome, m.taxpayerId], ['matched', '32012778745']);
  const amp = R.pickMatch('protex plumbing and mechanical', { data: [{ name: 'PROTEX PLUMBING & MECHANICAL, LP', taxpayerId: '32074066401' }] });
  assert.strictEqual(amp.outcome, 'matched', '"&" and "and" compare equal');
});

check('two taxpayers with the same name are ambiguous: no match', () => {
  const m = R.pickMatch('ies residential', { data: [
    { name: 'IES RESIDENTIAL, INC.', taxpayerId: '32012778745' }, { name: 'IES RESIDENTIAL INC', taxpayerId: '32033609358' }] });
  assert.deepStrictEqual([m.outcome, m.taxpayerId], ['ambiguous', null]);
  const same = R.pickMatch('ies residential', { data: [
    { name: 'IES RESIDENTIAL, INC.', taxpayerId: '32012778745' }, { name: 'IES Residential Inc', taxpayerId: '32012778745' }] });
  assert.strictEqual(same.outcome, 'matched', 'the same taxpayer listed twice is one');
});

check('a longer legal name that starts with ours is a candidate, never a match', () => {
  const m = R.pickMatch('christianson plumbing', fx.search['Christianson Plumbing']);
  assert.deepStrictEqual([m.outcome, m.taxpayerId], ['prefix', '32020647130']);
  assert.strictEqual(R.pickMatch('victory plumbing', fx.search['Victory Plumbing Company']).outcome, 'none');
  assert.strictEqual(R.pickMatch('acme', null).outcome, 'none');
});

check('the detail keeps business facts only: no officers, agent, street or FEIN', () => {
  const g = R.mapDetail(fx.detail);
  assert.deepStrictEqual(g, {
    registryId: '32012778745', legalName: 'IES RESIDENTIAL, INC.', dbaName: null, sosFileNumber: '0800862442', stateOfFormation: 'DE',
    sosStatus: 'ACTIVE', rightToTransact: 'ACTIVE', sosRegisteredOn: '2007-08-24', reportYear: 2026,
    mailingCity: 'SUGAR LAND', mailingState: 'TX', mailingZip: '77478',
  });
  assert.ok(!JSON.stringify(g).match(/officer|agent|DAIRY|BRYAN|741774028/i));
  assert.strictEqual(R.mapDetail({ data: {} }), null);
  assert.strictEqual(R.usDate('2007-08-24'), null);
});
