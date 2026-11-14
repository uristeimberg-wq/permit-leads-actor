// Offline checks for web/invites.js.
const assert = require('node:assert');
const I = require('./invites.js');

const codes = new Set(Array.from({ length: 200 }, () => I.newCode()));
assert.strictEqual(codes.size, 200, 'codes do not repeat');
for (const c of codes) assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
assert.deepStrictEqual(I.hashCode(' abcd-efgh-jk23 '), I.hashCode('ABCD-EFGH-JK23'), 'case and spaces do not matter');
assert.deepStrictEqual(I.cleanIndustry({ industry: 'insurance', industryOther: 'x' }), { industry: 'insurance', industryOther: null });
assert.deepStrictEqual(I.cleanIndustry({ industry: 'other', industryOther: ' a  b ' }), { industry: 'other', industryOther: 'a b' });
assert.deepStrictEqual(I.cleanIndustry({ industry: 'other', industryOther: 'x'.repeat(200) }).industryOther.length, 80);
assert.deepStrictEqual(I.cleanIndustry({ industry: 'constructor' }), { industry: null, industryOther: null });
assert.deepStrictEqual(I.cleanIndustry({}), { industry: null, industryOther: null });
assert.ok(!Object.keys(I.INDUSTRIES).some((k) => /lead/.test(k)));

// pgStore: a malformed code never reaches the database.
let calls = 0;
const st = I.pgStore(async () => { calls += 1; return { rows: [] }; });
(async () => {
  assert.strictEqual(await st.find("x' OR 1=1"), null);
  assert.strictEqual(calls, 0);
  assert.strictEqual(await st.find('ABCD-EFGH-JK23'), null);
  assert.strictEqual(calls, 1);
  console.log('invites.test.js: all passed');
})();
