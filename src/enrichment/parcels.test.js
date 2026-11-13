const assert = require('node:assert');
const { PROVIDERS, normalizeFolio, buildParcelQuery, mapParcel } = require('./parcels.js');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};
const PA = PROVIDERS['miami-dade-pa'];

check('folios: 13 digits kept, a numeric 12-digit City of Miami folio regains its zero, junk is null', () => {
  assert.deepStrictEqual(
    [normalizeFolio('3020030240630'), normalizeFolio(141211320840), normalizeFolio('30-2003-024-0630'), normalizeFolio('0000000000000'), normalizeFolio('123'), normalizeFolio(null)],
    ['3020030240630', '0141211320840', '3020030240630', null, null, null],
  );
});

check('the query names its fields, never owners, and asks for WGS84 points', () => {
  const url = new URL(buildParcelQuery(PA, ['3020030240630', '0141211320840']));
  assert.strictEqual(url.searchParams.get('where'), "FOLIO IN ('3020030240630','0141211320840')");
  assert.ok(!/owner|mail/i.test(url.searchParams.get('outFields')));
  assert.strictEqual(url.searchParams.get('outSR'), '4326');
  assert.throws(() => buildParcelQuery(PA, ["1' OR 1=1"]), /digits/);
  assert.throws(() => buildParcelQuery({ ...PA, outFields: ['FOLIO', 'TRUE_OWNER1'] }, ['1']), /owner/);
});

check('a parcel maps with zeros as missing and owner fields dropped from the payload', () => {
  const p = mapParcel({
    attributes: { FOLIO: '3020030240630', DOR_CODE_CUR: '0101', DOR_DESC: 'RESIDENTIAL - SINGLE FAMILY', YEAR_BUILT: 1957,
      BUILDING_HEATED_AREA: 1820, BUILDING_ACTUAL_AREA: 0, LOT_SIZE: 7500, BEDROOM_COUNT: 3, BATHROOM_COUNT: 2, HALF_BATHROOM_COUNT: 1,
      FLOOR_COUNT: 0, UNIT_COUNT: 1, ASSESSED_VAL_CUR: 412000, ASSESSMENT_YEAR_CUR: 2026, TRUE_SITE_ZIP_CODE: '33155-1234', TRUE_OWNER1: 'J DOE' },
    geometry: { x: -80.31, y: 25.73 },
  });
  assert.deepStrictEqual(
    [p.parcelKey, p.yearBuilt, p.heatedSqft, p.buildingSqft, p.floors, p.bathrooms, p.siteZip, p.lat, p.lng],
    ['3020030240630', 1957, 1820, null, null, 2.5, '33155', 25.73, -80.31],
  );
  assert.ok(!('TRUE_OWNER1' in p.payload));
});

check('an impossible year built is missing, not a fact', () => {
  assert.strictEqual(mapParcel({ attributes: { FOLIO: '3020030240630', YEAR_BUILT: 9999 } }).yearBuilt, null);
  assert.strictEqual(mapParcel({ attributes: { FOLIO: '3020030240630', YEAR_BUILT: 0 } }).yearBuilt, null);
});

check('every provider maps at least one permit source', () => {
  for (const p of Object.values(PROVIDERS)) assert.ok(Object.keys(p.permitKeyFields).length);
});
