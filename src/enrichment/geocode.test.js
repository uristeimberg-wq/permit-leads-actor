const assert = require('node:assert');
const G = require('./geocode.js');
const { parseCsvLine } = require('./licences.js');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};

check('source points: strings parse, 0,0 and swapped pairs are rejected', () => {
  const src = { coordinates: { lat: 'latitude', lng: 'longitude' } };
  assert.deepStrictEqual(G.sourcePoint(src, { latitude: '30.2151', longitude: '-97.8069' }), { lat: 30.2151, lng: -97.8069 });
  assert.strictEqual(G.sourcePoint(src, { latitude: 0, longitude: 0 }), null);
  assert.strictEqual(G.sourcePoint(src, { latitude: '-97.8', longitude: '30.2' }), null);
  assert.strictEqual(G.sourcePoint(src, { latitude: '', longitude: '' }), null);
  assert.strictEqual(G.sourcePoint({}, { latitude: '30.2', longitude: '-97.8' }), null);
});

check('address keys: one per job site, none without a house number or a place', () => {
  assert.strictEqual(G.addressKey({ street: '1205 Ballyhask Pl.', city: 'Raleigh', state: 'NC', zip: '27607-1234' }), '1205 BALLYHASK PL|RALEIGH|NC|27607');
  assert.strictEqual(G.addressKey({ street: 'Ballyhask Pl', city: 'Raleigh', state: 'NC', zip: '27607' }), null);
  assert.strictEqual(G.addressKey({ street: '12 Main St', city: '', state: 'TX', zip: '' }), null);
  assert.strictEqual(G.addressKey({ street: 'Main St and 5th', city: 'Austin', state: 'TX', zip: '78701' }), null); // an intersection
});

check('Census input is quoted CSV and the batch limit is enforced', () => {
  assert.strictEqual(G.buildCensusCsv([{ id: '7', key: '12 MAIN ST|AUSTIN|TX|78701' }]), '"7","12 MAIN ST","AUSTIN","TX","78701"');
  assert.throws(() => G.buildCensusCsv(Array.from({ length: 10001 }, (_, i) => ({ id: String(i), key: '1 A|B|TX|1' }))), /limit/);
});

check('Census output: exact, non-exact, tie and no match', () => {
  const text = [
    '"1","12 MAIN ST, AUSTIN, TX, 78701","Match","Exact","12 MAIN ST, AUSTIN, TX, 78701","-97.74,30.27","123","L"',
    '"2","9 ELM, AUSTIN, TX, 78701","Match","Non_Exact","9 ELM ST, AUSTIN, TX, 78701","-97.75,30.28","124","R"',
    '"3","1 X ST, AUSTIN, TX, 78701","Tie"',
    '"4","2 Y ST, AUSTIN, TX, 78701","No_Match"',
  ].join('\n');
  const r = G.parseCensusResult(text, parseCsvLine);
  assert.deepStrictEqual(r.get('1'), { matched: true, quality: 'exact', matchedAddress: '12 MAIN ST, AUSTIN, TX, 78701', lat: 30.27, lng: -97.74 });
  assert.strictEqual(r.get('2').quality, 'non_exact');
  assert.deepStrictEqual([r.get('3'), r.get('4')], [{ matched: false, quality: 'tie' }, { matched: false, quality: 'no_match' }]);
});
