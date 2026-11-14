const assert = require('node:assert');
const T = require('./tcad.js');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};

/** A fixed-width line with the given 1-based fields set and filler elsewhere. */
function line(length, fields, filler = ' ') {
  const a = Array(length).fill(filler);
  for (const [[start, end], v] of fields) {
    const s = String(v).padEnd(end - start + 1).slice(0, end - start + 1);
    for (let i = 0; i < s.length; i += 1) a[start - 1 + i] = s[i];
  }
  return a.join('');
}
const P = T.PROP;
// Owner name, deed and exemption positions hold text the parser must never return.
const SECRET = 'SECRET OWNER';
const prop = (o = {}) => line(9922, [
  [P.propId, '000000123456'], [P.propType, 'R'], [P.rollYear, '2026'], [P.geoId, '0414181801'],
  [[609, 678], SECRET], [[2609, 2610], 'TT'], [[1994, 2013], 'DEED 1'],
  [P.situsCity, 'AUSTIN'], [P.situsZip, '78745-1234'],
  [P.landHstd, '000000000100000'], [P.landNonHstd, '000000000000000'],
  [P.imprvHstd, '000000000250000'], [P.imprvNonHstd, '000000000005000'],
  [P.imprvStateCd, 'A1'], ...Object.entries(o).map(([k, v]) => [JSON.parse(k), v]),
], ' ');

check('a property line gives only the allowed facts, with homestead splits summed', () => {
  const p = T.mapProp(prop());
  assert.deepStrictEqual(p, { propId: '123456', geoId: '0414181801', propType: 'R', rollYear: 2026, siteCity: 'AUSTIN',
    siteZip: '78745', landValue: 100000, improvementValue: 255000, stateCode: 'A1' });
  assert.ok(!JSON.stringify(p).includes(SECRET));
});

check('any confidential or address-suppression flag skips the parcel', () => {
  for (const f of P.flags) assert.deepStrictEqual(T.mapProp(prop({ [JSON.stringify(f)]: 'T' })), { skip: 'confidential' }, String(f));
  assert.ok(T.mapProp(prop({ [JSON.stringify(P.flags[0])]: 'F' })).propId);
  assert.deepStrictEqual(T.mapProp('x'.repeat(4000)), { skip: 'short_line' });
});

check('Austin tcad_id: geo_id as is, letter + digits as a prop_id', () => {
  assert.deepStrictEqual(['0414181801', 'R123456', 'r000789', '', 'N/A', null].map(T.permitKey),
    [{ geoId: '0414181801' }, { propId: '123456' }, { propId: '789' }, null, null, null]);
});

check('only floor rows count; the main building is the most valuable improvement', () => {
  const det = (imp, code, yr, area) => line(622, [[T.IMP_DET.propId, '000000123456'], [T.IMP_DET.imprvId, imp], [T.IMP_DET.typeCd, code], [T.IMP_DET.yearBuilt, yr], [T.IMP_DET.area, String(area).padStart(15, '0')]]);
  const rows = [det('1', '1ST', '1998', 1500), det('1', '2ND', '2004', 600), det('1', '011', '1998', 300), det('1', '041', '1998', 400),
    det('2', '1ST', '2021', 500), det('1', '1ST', '0000', 0)].map(T.mapFloor).filter(Boolean);
  assert.strictEqual(rows.length, 4);
  const imp = (id, desc, v) => T.mapImprovement(line(114, [[T.IMP_INFO.propId, '000000123456'], [T.IMP_INFO.imprvId, id], [T.IMP_INFO.typeDesc, desc], [T.IMP_INFO.value, String(v).padStart(14, '0')]]));
  assert.deepStrictEqual(T.summarize([imp('2', 'GARAGE APARTMENT', 80000), imp('1', '1 FAM DWELLING', 250000)], rows),
    { improvementType: '1 FAM DWELLING', yearBuilt: 1998, livingSqft: 2100 });
  assert.deepStrictEqual(T.summarize([], rows), { improvementType: null, yearBuilt: null, livingSqft: null });
});

check('a land segment gives whole square feet; empty or short lines give nothing', () => {
  const L = T.LAND_DET;
  const land = (id, sqft) => line(199, [[L.propId, id.padStart(12, '0')], [[70, 83], '00000000005423'], [L.sqft, sqft]], ' ');
  assert.deepStrictEqual(T.mapLand(land('123456', '00000000023623')), { propId: '123456', sqft: 23623 });
  assert.strictEqual(T.mapLand(land('123456', '00000000000000')), null);
  assert.strictEqual(T.mapLand('short'), null);
});

check('the newest supplemental export link is found; JSON and layout files are not', () => {
  const html = `<a href="/wp-content/largefiles/travis_SUPP%20336_2026_WEBSITE%20EXPORT_Renamed.zip">x</a>
    <a href='https://traviscad.org/wp-content/largefiles/travis_SUPP%20341_2026_WEBSITE%20EXPORT.zip'>y</a>
    <a href="/wp-content/largefiles/2026%20Special%20export%20Supp%204%2011062026.zip">z</a>
    <a href="/wp-content/largefiles/Website_Legacy8.0.33-AppraisalExportLayout_06182026.zip">l</a>`;
  assert.strictEqual(T.findExportLink(html), 'https://traviscad.org/wp-content/largefiles/travis_SUPP%20341_2026_WEBSITE%20EXPORT.zip');
  assert.strictEqual(T.findExportLink('<p>nothing</p>'), null);
});
