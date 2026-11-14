// Offline tests for src/filers.js (ADR-19).
const assert = require('node:assert');
const F = require('./filers.js');

let failures = 0;
const t = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
};

t('account marks are removed from the display name', () => {
  assert.strictEqual(F.cleanOrgName('Waterloo Permits LLC *MAIN*'), 'Waterloo Permits LLC');
  assert.strictEqual(F.cleanOrgName('Cushing Terrell **MAIN'), 'Cushing Terrell');
  assert.strictEqual(F.cleanOrgName('Waterloo512 **MAIN'), 'Waterloo512');
  assert.strictEqual(F.cleanOrgName('  Taylor Morrison '), 'Taylor Morrison');
});

t('filers come from both organisation fields, once each', () => {
  const got = F.filersOf({ applicant_organization_name: 'Acme Homes LLC', other_organization_name: 'ACME HOMES' });
  assert.deepStrictEqual(got.map((f) => [f.field, f.key]), [['applicant_organization_name', 'acme homes']]);
  const two = F.filersOf({ applicant_organization_name: 'Acme Homes LLC', other_organization_name: 'Aqua Permits' });
  assert.deepStrictEqual(two.map((f) => f.name), ['Acme Homes LLC', 'Aqua Permits']);
});

t('placeholders, owner markers and the owner organisation are never filers', () => {
  assert.deepStrictEqual(F.filersOf({ other_organization_name: '*Main*' }), []);
  assert.deepStrictEqual(F.filersOf({ other_organization_name: 'Owner' }), []);
  assert.deepStrictEqual(F.filersOf({ applicant_organization_name: 'REDACTED' }), []);
  assert.deepStrictEqual(F.filersOf({ owner_organization_name: 'Loop 360 Land LP', other_organization_name: 'LOOP 360 LAND LP' }), []);
  assert.deepStrictEqual(F.filersOf({}), []);
  assert.deepStrictEqual(F.filersOf(null), []);
});

t('the owner and person-name fields are never read', () => {
  const got = F.filersOf({ owner_full_name: 'Jane Doe', applicant_full_name: 'John Roe', other_full_name: 'A B', owner_organization_name: 'Doe Family Trust' });
  assert.deepStrictEqual(got, []);
});

t('expediters by name', () => {
  for (const n of ['Aqua Permits', 'Permits Plus ATX', 'Waterloo Permits LLC', 'AUSTIN PLANS FOR PERMITS', 'Mercury Permits Inc.', 'Lone Star Permitting', 'ATX Expediting']) {
    assert.strictEqual(F.classify({ name: n, linked: 10, self: 10, distinct: 1 }).role, 'expediter', n);
  }
});

t('expediters by behaviour: many permits, pulled by others', () => {
  const r = F.classify({ name: 'Moore-Tate Projects & Design', linked: 8, self: 0, distinct: 5 });
  assert.strictEqual(r.role, 'expediter');
  assert.match(r.basis, /8 building permits pulled by 5 other contractors/);
  assert.strictEqual(F.classify({ name: 'X Design', linked: 4, self: 0, distinct: 4 }).role, 'unknown', 'below the minimum sample');
});

t('builders by behaviour: it pulled most of the permits its filings led to', () => {
  const r = F.classify({ name: 'Taylor Morrison', linked: 6, self: 5, distinct: 2 });
  assert.strictEqual(r.role, 'builder');
  assert.match(r.basis, /pulled 5 of the 6/);
  assert.strictEqual(F.classify({ name: 'Acme Homes', linked: 1, self: 1, distinct: 1 }).role, 'unknown', 'one permit is not enough');
});

t('builders by name match, unless the linked permits say otherwise', () => {
  assert.strictEqual(F.classify({ name: 'Acme Homes', knownBuilder: true }).role, 'builder');
  assert.strictEqual(F.classify({ name: 'Acme Homes', knownBuilder: true, linked: 4, self: 1, distinct: 3 }).role, 'unknown');
});

t('no evidence is unknown, never a guess', () => {
  const r = F.classify({ name: 'DMW Retreats' });
  assert.deepStrictEqual(r, { role: 'unknown', basis: 'no building permit linked yet' });
});

t('rule 5: a person-looking name is shown only when it is a business contractor', () => {
  assert.strictEqual(F.filerKind('Olshan Foundation Repair', null), 'business');
  assert.strictEqual(F.filerKind('Taylor Morrison', null), 'individual');
  assert.strictEqual(F.filerKind('Aqua Permits', null), 'business');
  assert.strictEqual(F.filerKind('Taylor Morrison', 'business'), 'business');
  assert.strictEqual(F.filerKind('Taylor Morrison', 'individual'), 'individual');
});

t('the filer shown is a business: builder first, then expediter', () => {
  const pick = F.pickFiler([
    { key: 'aqua permits', role: 'expediter', partyKind: 'business' },
    { key: 'jane roe', role: 'builder', partyKind: 'individual' },
    { key: 'acme homes', role: 'builder', partyKind: 'business' },
  ]);
  assert.strictEqual(pick.key, 'acme homes');
  assert.strictEqual(F.pickFiler([{ key: 'jane roe', role: 'builder', partyKind: 'individual' }]), null);
  assert.strictEqual(F.pickFiler([]), null);
});

t('segments follow the backtest building classes', () => {
  assert.strictEqual(F.segmentOf('R- 101 Single Family Houses'), 'homes');
  assert.strictEqual(F.segmentOf('R- 103 Two Family Bldgs'), 'homes');
  assert.strictEqual(F.segmentOf('R- 105 Five or More Family Bldgs'), 'apartments');
  assert.strictEqual(F.segmentOf('C- 324 Office Bank and Professional Bldgs'), 'commercial');
  assert.strictEqual(F.segmentOf('C- 213 Hotels and Motels'), 'commercial');
  assert.strictEqual(F.segmentOf('C- 329 Com Structures Other Than Bldg'), null);
  assert.strictEqual(F.segmentOf('R- 435 Renovations/Remodel'), null);
  assert.strictEqual(F.segmentOf('R- 1010 Something'), null);
  assert.strictEqual(F.segmentOf(null), null);
});

t('the fixture: expediters flagged, owner org and redactions dropped', () => {
  const fx = require('../test/fixtures/sources/austin-plan-review-tx.json');
  const all = fx.rows.flatMap((r) => F.filersOf(r));
  assert.ok(all.length >= 25, `filers found: ${all.length}`);
  assert.ok(!all.some((f) => /redacted|^main$/i.test(f.name)));
  const roles = Object.fromEntries(all.map((f) => [f.name, F.classify({ name: f.name }).role]));
  assert.strictEqual(roles['Aqua Permits'], 'expediter');
  assert.strictEqual(roles['Waterloo Permits LLC'], 'expediter');
  assert.strictEqual(roles['Taylor Morrison'], 'unknown');
});

if (failures) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nall filers tests passed');
