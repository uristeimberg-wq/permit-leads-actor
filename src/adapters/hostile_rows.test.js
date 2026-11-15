// Every configured Socrata and ArcGIS source must map a row of odd values
// (wrong types, empty strings, out-of-range numbers) without throwing. One bad
// cell from a portal would otherwise fail the whole market's sync run.
// Offline: mapping only, no network.

const assert = require('node:assert');
const { SOURCES } = require('../sources.js');
const { mapRows } = require('./socrata.js');
const { mapFeatures } = require('./arcgis.js');

const log = { info() {}, warning() {}, error() {} };
const ODD = [null, 42, -1, 0, 1e20, -1e20, NaN, true, '', '   ', 'not a date', '9999-99-99', { url: 5 }, [1, 2], {}];

let failures = 0; let runs = 0;
for (const [area, s] of Object.entries(SOURCES)) {
  if (!s.fieldMap || !['socrata', 'arcgis'].includes(s.type)) continue;
  const fields = new Set();
  for (const v of Object.values(s.fieldMap)) for (const f of [].concat(v)) if (typeof f === 'string') fields.add(f);
  for (const v of ODD) {
    const row = {};
    for (const f of fields) row[f] = v;
    row[s.fieldMap.permitNumber] = 'K-1';
    runs += 1;
    try {
      if (s.type === 'socrata') mapRows([row], s, { log });
      else mapFeatures([{ attributes: row }], s, { log });
    } catch (err) {
      failures += 1;
      console.error(`  FAIL ${area} with ${JSON.stringify(v)}: ${err.message}`);
    }
  }
}
assert.ok(runs > 50, `expected to exercise the sources, ran ${runs}`);
assert.strictEqual(failures, 0, `${failures} of ${runs} odd rows threw`);
console.log(`  ok - ${runs} odd rows mapped across every Socrata/ArcGIS source without throwing`);
console.log('\nDone.');
