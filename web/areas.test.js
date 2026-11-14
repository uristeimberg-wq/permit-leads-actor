// Offline: placing ZIPs and cities on the search map (web/areas.js).
const assert = require('node:assert');
const { placeArea, zipIsTrusted } = require('./areas.js');

const coords = {
  zips: { 78704: { lat: 30.24, lng: -97.77 }, 10028: { lat: 40.776, lng: -73.953 } },
  cities: { 'MIAMI|FL': { lat: 25.77, lng: -80.19 } },
};
const none = { zips: new Map(), cities: new Map() };
const located = {
  zips: new Map([
    ['27603', { lat: 35.75, lng: -78.65, located: 120 }],    // Raleigh: not in the area file at all
    ['78704', { lat: 30.245, lng: -97.765, located: 900 }],
    ['10028', { lat: 25.78, lng: -80.2, located: 3 }],        // a NY code on Miami job sites
  ]),
  cities: new Map([['RALEIGH|NC', { lat: 35.78, lng: -78.64, located: 4000 }], ['HIALEAH|FL', { lat: 25.86, lng: -80.29, located: 50 }]]),
};

// The file alone keeps the prototype's behaviour.
let p = placeArea({ zip: '78704', city: 'AUSTIN', state: 'TX' }, none, coords);
assert.deepStrictEqual([p.key, p.basis], ['z:78704', 'area_file']);

// Located job sites win over the file.
p = placeArea({ zip: '78704', city: 'AUSTIN', state: 'TX' }, located, coords);
assert.deepStrictEqual([p.key, p.basis, p.lat], ['z:78704', 'job_sites', 30.245]);

// Raleigh had no centroid anywhere before; now it places, as a ZIP and as a city.
p = placeArea({ zip: '27603', city: 'RALEIGH', state: 'NC' }, located, coords);
assert.deepStrictEqual([p.key, p.basis], ['z:27603', 'job_sites']);
assert.ok(zipIsTrusted({ zip: '27603', city: 'RALEIGH', state: 'NC' }, located, coords));
assert.ok(!zipIsTrusted({ zip: '27603', city: 'RALEIGH', state: 'NC' }, none, coords), 'without locations it stays hidden, as before');
p = placeArea({ zip: null, city: 'Hialeah', state: 'fl' }, located, coords);
assert.deepStrictEqual([p.key, p.kind, p.basis], ['c:Hialeah|fl', 'city', 'job_sites']);

// A ZIP that contradicts its own city is placed by city, never under the code.
p = placeArea({ zip: '10028', city: 'MIAMI', state: 'FL' }, located, coords);
assert.deepStrictEqual([p.key, p.kind], ['c:MIAMI|FL', 'city']);
assert.ok(!zipIsTrusted({ zip: '10028', city: 'MIAMI', state: 'FL' }, located, coords));
p = placeArea({ zip: '10028', city: 'MIAMI', state: 'FL' }, none, coords);
assert.strictEqual(p.kind, 'city', 'the old rule still holds with the file alone');

// Nothing to go on: unplaced, and the API counts it rather than dropping it.
assert.strictEqual(placeArea({ zip: '99999', city: 'NOWHERE', state: 'ZZ' }, located, coords), null);

console.log('areas.test.js: all passed');
