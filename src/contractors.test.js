const assert = require('node:assert');
const C = require('./contractors.js');

function check(name, fn) {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

check('legal forms and punctuation do not split a firm', () => {
  assert.strictEqual(C.normalizeName('Acme Builders, LLC'), 'acme builders');
  assert.strictEqual(C.normalizeName('ACME BUILDERS INC.'), 'acme builders');
  assert.strictEqual(C.normalizeName('The Acme Builders Co'), 'acme builders');
  assert.strictEqual(C.normalizeName('Smith & Sons Plumbing of Texas, L.L.C.'), 'smith and sons plumbing');
});

check('trade words are kept, so different trades stay different firms', () => {
  assert.notStrictEqual(C.normalizeName('Acme Plumbing LLC'), C.normalizeName('Acme Electric LLC'));
});

check('near-miss spellings are NOT merged (conservative by design)', () => {
  assert.notStrictEqual(C.normalizeName('Radiant Plumbing & AC'), C.normalizeName('Radiant Plumbing and Air Conditioning'));
});

check('owner-builders are not contractors', () => {
  for (const n of ['OWNER', 'Owner/Builder', 'owner builder', 'HOMEOWNER', 'N/A', 'SELF', '', null]) assert.ok(C.isOwnerBuilder(n), String(n));
  assert.ok(!C.isOwnerBuilder('Owens Corning Roofing'));
});

check('party kind: businesses shown, person-like names hidden, unclear held for review', () => {
  assert.strictEqual(C.partyKind('Acme Builders LLC'), 'business');
  assert.strictEqual(C.partyKind('Radiant Plumbing & AC'), 'business');
  assert.strictEqual(C.partyKind('John Q Smith'), 'individual');
  assert.strictEqual(C.partyKind('Austin Smith'), 'individual');
  assert.strictEqual(C.partyKind('ZZQX'), 'unknown');
  assert.deepStrictEqual(['business', 'individual', 'unknown'].map(C.displayPolicy), ['show', 'hide', 'review']);
});

check('phones become E.164; impossible numbers are rejected', () => {
  assert.strictEqual(C.toE164('(512) 555-0100'), '+15125550100');
  assert.strictEqual(C.toE164('1-305-555-0100'), '+13055550100');
  for (const bad of ['5555555555', '0125550100', '5120550100', '555-0100', '', null]) assert.strictEqual(C.toE164(bad), null, String(bad));
});

check('identity: licence beats name; name needs a state', () => {
  assert.deepStrictEqual(C.identityFor({ name: 'Acme', licence: ' cgc 1234 ', state: 'FL' }), { key: 'lic:FL:CGC1234', rule: 'licence', confidence: 0.95 });
  assert.strictEqual(C.identityFor({ name: 'Acme Builders LLC', state: 'TX' }).key, 'name:TX:acme builders');
  assert.strictEqual(C.identityFor({ name: 'Acme Builders', licence: '0000', state: 'TX' }).rule, 'name_state');
  assert.strictEqual(C.identityFor({ name: 'Acme', state: null }), null);
});

check('Austin extraction groups BP and trade permits by permit-number base', () => {
  const bp = C.EXTRACTORS['austin-tx']({ permit_number: '2026-104544 BP', permittype: 'BP', issue_date: '2026-05-01T00:00:00.000', contractor_company_name: 'Acme Builders LLC' });
  const ep = C.EXTRACTORS['austin-tx']({ permit_number: '2026-104544 EP', permittype: 'EP', issue_date: '2026-06-01T00:00:00.000', contractor_company_name: 'Sparky Electric' });
  assert.strictEqual(bp.groupKey, '2026-104544'); assert.strictEqual(ep.groupKey, '2026-104544');
  assert.ok(bp.isBuilding); assert.strictEqual(ep.trade, 'electrical'); assert.strictEqual(ep.issuedOn, '2026-06-01');
});

check('Miami-Dade: the 0000000000 master means "none", so a permit is its own group', () => {
  const x = C.EXTRACTORS['miami-dade-fl']({ PermitNumber: '2025014493', MasterPermitNumber: '0000000000', PermitType: 'MECH', PermitIssuedDate: 1746057600000 });
  assert.strictEqual(x.groupKey, '2025014493'); assert.strictEqual(x.trade, 'mechanical'); assert.strictEqual(x.issuedOn, '2025-05-01');
  const y = C.EXTRACTORS['miami-dade-fl']({ PermitNumber: '2025044313', MasterPermitNumber: '2025038500', PermitType: 'ELEC', ContractorNumber: 'EC13001234' });
  assert.strictEqual(y.groupKey, '2025038500'); assert.strictEqual(y.licence, 'EC13001234');
});

const party = (o) => ({ sourceSlug: 'austin-tx', state: 'TX', ...o });

check('resolution merges spellings of one firm, keeps phones as evidence, skips owner-builders', () => {
  const { contractors, parties } = C.resolveParties([
    party({ permitNumber: 'A BP', name: 'Acme Builders LLC', phone: '5125550100', issuedOn: '2026-01-01' }),
    party({ permitNumber: 'B BP', name: 'ACME BUILDERS INC', phone: '512-555-0100', issuedOn: '2026-03-01' }),
    party({ permitNumber: 'C BP', name: 'Acme Builders', phone: '5125550199', issuedOn: '2026-02-01' }),
    party({ permitNumber: 'D BP', name: 'OWNER', phone: '5125550111' }),
  ]);
  assert.strictEqual(contractors.length, 1);
  const c = contractors[0];
  assert.strictEqual(c.permitCount, 3);
  assert.deepStrictEqual([c.firstPermitOn, c.lastPermitOn], ['2026-01-01', '2026-03-01']);
  assert.deepStrictEqual(c.contacts.map((p) => [p.value, p.seenOnPermits]).sort(), [['+15125550100', 2], ['+15125550199', 1]]);
  assert.ok(c.contacts.every((p) => p.displayPolicy === 'show'));
  assert.strictEqual(parties.find((p) => p.permitNumber === 'D BP').rule, 'owner_builder');
  assert.strictEqual(parties.find((p) => p.permitNumber === 'D BP').identityKey, null);
});

check('a phone shared by two firms does not merge them and is never "corroborated"', () => {
  const rows = [];
  for (let i = 0; i < 3; i += 1) rows.push(party({ permitNumber: `X${i}`, name: 'Alpha Plumbing', phone: '5125550100' }));
  rows.push(party({ permitNumber: 'Y', name: 'Beta Electric', phone: '5125550100' }));
  const { contractors } = C.resolveParties(rows);
  assert.strictEqual(contractors.length, 2);
  const alpha = contractors.find((c) => c.displayName === 'Alpha Plumbing');
  assert.strictEqual(alpha.contacts[0].sharedWithOtherContractors, 1);
  assert.strictEqual(alpha.contacts[0].verification, 'unverified');
});

check('three permits, unshared, makes a phone corroborated', () => {
  const rows = [0, 1, 2].map((i) => party({ permitNumber: `X${i}`, name: 'Alpha Plumbing', phone: '5125550100' }));
  assert.strictEqual(C.resolveParties(rows).contractors[0].contacts[0].verification, 'corroborated');
});

check('a person-like contractor name gets its phone hidden', () => {
  const { contractors } = C.resolveParties([party({ permitNumber: 'Z', name: 'John Smith', phone: '5125550100' })]);
  assert.strictEqual(contractors[0].partyKind, 'individual');
  assert.strictEqual(contractors[0].contacts[0].displayPolicy, 'hide');
});

check('relationships: the BP contractor is the GC, trade-permit contractors are subs', () => {
  const p = (o) => ({ sourceSlug: 'austin-tx', ...o });
  const rels = C.buildRelationships([
    p({ groupKey: 'G1', isBuilding: true, identityKey: 'gc', issuedOn: '2026-01-01' }),
    p({ groupKey: 'G1', trade: 'electrical', identityKey: 'sparky', issuedOn: '2026-02-01' }),
    p({ groupKey: 'G1', trade: 'electrical', identityKey: 'sparky', issuedOn: '2026-02-05' }), // same job, counted once
    p({ groupKey: 'G1', trade: 'plumbing', identityKey: 'gc' }),                            // GC self-performs: not a relationship
    p({ groupKey: 'G2', isBuilding: true, identityKey: 'gc' }),
    p({ groupKey: 'G2', trade: 'electrical', identityKey: 'sparky', issuedOn: '2026-04-01' }),
    p({ groupKey: 'G3', trade: 'electrical', identityKey: 'sparky' }),                      // no BP: no GC
    p({ groupKey: 'G4', isBuilding: true, identityKey: 'gc' }), p({ groupKey: 'G4', isBuilding: true, identityKey: 'gc2' }),
    p({ groupKey: 'G4', trade: 'plumbing', identityKey: 'drip' }),                          // two GCs: ambiguous, skipped
  ]);
  assert.deepStrictEqual(rels, [{ gcKey: 'gc', subKey: 'sparky', trade: 'electrical', jobs: 2, first: '2026-02-01', last: '2026-04-01' }]);
});

check('City of Miami: type from the permit-number pattern, job from ApplicationNumber', () => {
  const x = C.EXTRACTORS['miami-city-fl'];
  const b = x({ PermitNumber: 'BD26009606001B001', ApplicationNumber: 'BD26009606', IssuedDate: 1794455349183, CompanyName: 'Acme Builders Inc' });
  const e = x({ PermitNumber: 'BD26009606001E001', ApplicationNumber: 'BD26009606', IssuedDate: 1794455349183 });
  const z = x({ PermitNumber: 'BD26009606001ZS001', ApplicationNumber: 'BD26009606' });
  assert.deepStrictEqual([b.isBuilding, b.trade, e.isBuilding, e.trade, z.typeCode, z.trade], [true, null, false, 'electrical', 'ZS', null]);
  assert.strictEqual(b.groupKey, e.groupKey);
  assert.strictEqual(b.phone, null);
});

check('Raleigh: trade from the permit-type text, job from the parcel pin', () => {
  const x = C.EXTRACTORS['raleigh-nc'];
  const b = x({ permitnum: 'BLDR-1-2026', permittype: 'Building', pin: '0795592357', issueddate: 1794455349183 });
  const m = x({ permitnum: 'MECHR-2-2026', permittype: 'DSINSP - Online Only Mechanical (Residential)', pin: '0795592357' });
  const r = x({ permitnum: 'ROW-3-2026', permittype: 'DSENG - Right of Way', pin: '0795592357' });
  assert.deepStrictEqual([b.isBuilding, m.trade, r.trade, r.isBuilding], [true, 'mechanical', null, false]);
  assert.strictEqual(b.groupKey, m.groupKey);
});
