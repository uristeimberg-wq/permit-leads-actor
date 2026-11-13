const assert = require('node:assert');
const { parseAddress } = require('./address.js');

function check(name, fn) {
  try { fn(); console.log(`ok   - ${name}`); }
  catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

// Every address below was captured from a live run — Clackamas County and
// Oregon statewide ePermitting.
const REAL = [
  ['6491 SE VERNELDA ST, MILWAUKIE OR 97267', '6491 SE VERNELDA ST', 'MILWAUKIE', 'OR', '97267'],
  ['14682 HUCKLEBERRY AVE, SANDY OR 97055', '14682 HUCKLEBERRY AVE', 'SANDY', 'OR', '97055'],
  ['3429 CASCADE TER, WEST LINN OR 97068', '3429 CASCADE TER', 'WEST LINN', 'OR', '97068'],
  ['957 NE 15TH AVE, CANBY OR 97013', '957 NE 15TH AVE', 'CANBY', 'OR', '97013'],
  ['22801 SW WILLAMINA CREEK RD, WILLAMINA OR 97396', '22801 SW WILLAMINA CREEK RD', 'WILLAMINA', 'OR', '97396'],
  ['31339 NE CORRAL CREEK RD, NEWBERG OR 97132', '31339 NE CORRAL CREEK RD', 'NEWBERG', 'OR', '97132'],
];

check('parses every real captured address', () => {
  for (const [raw, street, city, state, zip] of REAL) {
    assert.deepStrictEqual(parseAddress(raw), { street, city, state, zip }, `failed on: ${raw}`);
  }
});

check('handles multi-word city names', () => {
  // "GOVERNMENT CAMP" and "EAGLE CREEK" both appear in live Clackamas data and
  // would break any parser that assumes the city is a single token.
  assert.deepStrictEqual(parseAddress('30580 E UNION ST, GOVERNMENT CAMP OR 97028'),
    { street: '30580 E UNION ST', city: 'GOVERNMENT CAMP', state: 'OR', zip: '97028' });
  assert.deepStrictEqual(parseAddress('30033 SE FOLSOM RD, EAGLE CREEK OR 97022'),
    { street: '30033 SE FOLSOM RD', city: 'EAGLE CREEK', state: 'OR', zip: '97022' });
});

check('keeps a middle segment (LOT n) with the street instead of dropping it', () => {
  // Oregon statewide inserts a lot number: "..., LOT 7, MCMINNVILLE OR 97128".
  assert.deepStrictEqual(parseAddress('2123 NW FENDLE WAY, LOT 7, MCMINNVILLE OR 97128'),
    { street: '2123 NW FENDLE WAY, LOT 7', city: 'MCMINNVILLE', state: 'OR', zip: '97128' });
});

check('accepts ZIP+4 but stores only the 5-digit ZIP users search by', () => {
  assert.deepStrictEqual(parseAddress('1 MAIN ST, SANDY OR 97055-1234'),
    { street: '1 MAIN ST', city: 'SANDY', state: 'OR', zip: '97055' });
});

check('normalizes whitespace and case', () => {
  assert.deepStrictEqual(parseAddress('  1 Main   St ,  sandy  or   97055 '),
    { street: '1 Main St', city: 'SANDY', state: 'OR', zip: '97055' });
});

check('recovers state and ZIP without a comma, but refuses to guess the city', () => {
  // No comma means no reliable city boundary. Location filtering still works
  // off ZIP; inventing a city from trailing street words would be worse.
  assert.deepStrictEqual(parseAddress('123 MAIN ST PORTLAND OR 97201'),
    { street: '123 MAIN ST PORTLAND', city: null, state: 'OR', zip: '97201' });
});

check('returns nulls rather than guesses when there is no state/ZIP tail', () => {
  assert.deepStrictEqual(parseAddress('ADDRESS NOT AVAILABLE'),
    { street: 'ADDRESS NOT AVAILABLE', city: null, state: null, zip: null });
});

check('handles missing and non-string input', () => {
  const empty = { street: null, city: null, state: null, zip: null };
  assert.deepStrictEqual(parseAddress(null), empty);
  assert.deepStrictEqual(parseAddress(undefined), empty);
  assert.deepStrictEqual(parseAddress(''), empty);
  assert.deepStrictEqual(parseAddress('   '), empty);
  assert.deepStrictEqual(parseAddress(12345), empty);
});

check('does not mistake a street number for a ZIP', () => {
  const parsed = parseAddress('97267 SE MAIN ST');
  assert.strictEqual(parsed.zip, null);
  assert.strictEqual(parsed.state, null);
});

check('handles a spelled-out state name (real: THE DALLES OREGON)', () => {
  // Oregon statewide writes some addresses with the state spelled out, which a
  // strict two-letter state pattern silently dropped — 3 live records had no ZIP
  // purely because of this.
  assert.deepStrictEqual(parseAddress('1103 LINCOLN ST, THE DALLES OREGON 97058'),
    { street: '1103 LINCOLN ST', city: 'THE DALLES', state: 'OR', zip: '97058' });
  assert.deepStrictEqual(parseAddress('1 A ST, VANCOUVER WASHINGTON 98660'),
    { street: '1 A ST', city: 'VANCOUVER', state: 'WA', zip: '98660' });
});

check('keeps city and state when the address has no ZIP (real: TILLAMOOK COUNTY OR)', () => {
  // No ZIP to find, but losing the city would also drop it from the city and
  // jurisdiction pickers for no reason.
  assert.deepStrictEqual(parseAddress('35435 TOHL AVE, TILLAMOOK COUNTY OR'),
    { street: '35435 TOHL AVE', city: 'TILLAMOOK COUNTY', state: 'OR', zip: null });
});

check('falls back to a trailing ZIP when no state is present', () => {
  assert.deepStrictEqual(parseAddress('123 MAIN ST 97201'),
    { street: '123 MAIN ST', city: null, state: null, zip: '97201' });
});

check('does not treat an unknown word as a state', () => {
  const parsed = parseAddress('1 MAIN ST, SOMETOWN NOTASTATE 97201');
  // The ZIP is still recoverable, but nothing is invented for the state.
  assert.strictEqual(parsed.zip, '97201');
  assert.strictEqual(parsed.state, null);
});

console.log('\nDone.');
