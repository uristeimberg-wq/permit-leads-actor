// A value the source repeats on several permits is never worded as one permit's cost (values.js).
const assert = require('assert');
const V = require('./values.js');

assert.strictEqual(V.valueText(580000000, 4), '$580,000,000 (same value on 4 permits)');
assert.strictEqual(V.valueText(250000, 1), '$250,000');
assert.strictEqual(V.valueText(250000, 0), '$250,000');
assert.strictEqual(V.valueText(250000, null), '$250,000');
assert.strictEqual(V.valueText(null, 3), 'not published');
assert.strictEqual(V.repeatSuffix(77), 'on 77 permits');
assert.strictEqual(V.repeatSuffix(1), '');
assert.ok(/not this permit's own cost/.test(V.repeatNote(830000000, 77)));
assert.ok(/\$830,000,000/.test(V.repeatNote(830000000, 77)));
assert.strictEqual(V.repeatNote(830000000, 1), '');
console.log('values.test.js: ok');
