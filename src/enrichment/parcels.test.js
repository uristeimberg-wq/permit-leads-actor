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
  const q = buildParcelQuery(PA, ['3020030240630', '0141211320840']);
  const params = new URLSearchParams(q.body);
  assert.ok(q.url.endsWith('/FeatureServer/0/query') && !q.url.includes('?'), 'parameters go in the POST body, not the URL');
  assert.strictEqual(params.get('where'), "FOLIO IN ('3020030240630','0141211320840')");
  assert.ok(!/owner|mail/i.test(params.get('outFields')));
  assert.strictEqual(params.get('outSR'), '4326');
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

const WAKE = PROVIDERS['wake-parcels'];
const wakeFx = require('../../test/fixtures/enrichment/wake-parcels.json');
const { normalizePin, polygonCentroid, OWNER_FIELD } = require('./parcels.js');

check('Wake PINs: 10 digits kept with the leading zero, anything else is null', () => {
  assert.deepStrictEqual(
    [normalizePin('0796972836'), normalizePin(1703290757), normalizePin('0796-97-2836'), normalizePin('0000000000'), normalizePin('123'), normalizePin(null)],
    ['0796972836', '1703290757', '0796972836', null, null, null],
  );
});

check('Wake: the allowlist names no owner, mailing, deed, sale, exemption or billing field', () => {
  for (const f of ['OWNER', 'ADDR1', 'ADDR3', 'DEED_BOOK', 'DEED_PAGE', 'DEED_DATE', 'TOTSALPRICE', 'SALE_DATE', 'EXEMPTDESC', 'EXEMPTSTAT', 'BILLCLASS', 'BILLING_CLASS_DECODE', 'OWNERSHIP']) {
    assert.ok(OWNER_FIELD.test(f), `${f} must be forbidden`);
  }
  for (const f of WAKE.outFields) assert.ok(!OWNER_FIELD.test(f), `${f} is allowlisted`);
  assert.ok(!OWNER_FIELD.test('DEED_ACRES'), 'the deeded lot size is a property fact');
  const params = new URLSearchParams(buildParcelQuery(WAKE, ['0796972836']).body);
  assert.strictEqual(params.get('where'), "PIN_NUM IN ('0796972836')");
  assert.ok(params.get('maxAllowableOffset'), 'polygons are generalised');
});

check('Wake fixture: an apartment parcel maps to facts, a point inside it, and zero units as missing', () => {
  const byPin = new Map(wakeFx.features.map((f) => [f.attributes.PIN_NUM, mapParcel(f, WAKE)]));
  const apt = byPin.get('1703290757');
  assert.deepStrictEqual(
    [apt.landUseCode, apt.landUse, apt.yearBuilt, apt.heatedSqft, apt.units, apt.lotSqft, apt.assessedValue, apt.landValue, apt.improvementValue, apt.assessmentYear, apt.siteZip],
    ['09', 'ELEV APT', 2013, 126760, 115, Math.round(1.77 * 43560), 27164937, 8448900, 18716037, null, '27603'],
  );
  const xs = wakeFx.features[1].geometry.rings[0].map((p) => p[0]);
  const ys = wakeFx.features[1].geometry.rings[0].map((p) => p[1]);
  assert.ok(apt.lng > Math.min(...xs) && apt.lng < Math.max(...xs) && apt.lat > Math.min(...ys) && apt.lat < Math.max(...ys));
  assert.strictEqual(byPin.get('1703734710').units, null, 'a church with UNITS 0 has no unit count, not zero units');
  for (const p of byPin.values()) assert.ok(!Object.keys(p.payload).some((k) => OWNER_FIELD.test(k)));
});

check('a polygon centroid: a unit square, with or without a hole, and nothing for no shape', () => {
  // ArcGIS rings: outer clockwise, hole counter-clockwise.
  const sq = { rings: [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]] };
  assert.deepStrictEqual(polygonCentroid(sq), { lng: 1, lat: 1 });
  const holed = { rings: [...sq.rings, [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  const c = polygonCentroid(holed);
  assert.ok(c.lng > 1 && c.lat > 1, 'a hole in one corner pulls the centroid away from it');
  assert.strictEqual(polygonCentroid(null), null);
  assert.strictEqual(polygonCentroid({ rings: [[[0, 0], [1, 1], [0, 0]]] }), null);
});
