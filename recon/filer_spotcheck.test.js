// Offline tests for recon/filer_spotcheck.js (ADR-19).
const assert = require('node:assert');
const { sameBusiness, verdict } = require('./filer_spotcheck.js');

assert.ok(sameBusiness('Acme Homes LLC', 'ACME HOMES'));
assert.ok(sameBusiness('Taylor Morrison', 'Taylor Morrison of Texas Inc'));
assert.ok(!sameBusiness('Acme', 'Acme Plumbing'), 'one-word names need an exact match');
assert.ok(!sameBusiness('Acme Homes', 'Acme Homesteads'));
assert.ok(!sameBusiness(null, 'Acme Homes'));

const review = [{ other_organization_name: 'Acme Homes LLC *MAIN*' }];
assert.strictEqual(verdict('Acme Homes LLC', review, [{ permit_number: '2026-1 BP', permittype: 'BP', contractor_company_name: 'ACME HOMES' }]).verdict, 'correct');
assert.strictEqual(verdict('Acme Homes LLC', review, [{ permit_number: '2026-1 BP', permittype: 'BP', contractor_company_name: 'Other Builders' }]).verdict, 'wrong');
assert.strictEqual(verdict('Acme Homes LLC', review, [{ permit_number: '2026-1 EP', permittype: 'EP', contractor_company_name: 'Sparky' }]).verdict, 'no_permit');
assert.strictEqual(verdict('Acme Homes LLC', [{ other_organization_name: 'Someone Else LLC' }], []).verdict, 'filer_missing');
console.log('all filer_spotcheck tests passed');
