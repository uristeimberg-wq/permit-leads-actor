const assert = require('node:assert');
const F = require('./fields.js');

const check = (name, fn) => {
  try { fn(); console.log(`ok   - ${name}`); } catch (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; }
};

const parcel = { provider: 'wake-parcels', parcel_key: '1703290757', found: true, year_built: 2013, heated_sqft: '126760', lot_sqft: '77101',
  units: '115', floors: null, land_use: 'ELEV APT', assessed_value: '27164937', land_value: '8448900', improvement_value: '18716037',
  assessment_year: null, source_edited_at: null, fetched_at: '2026-11-14T17:30:00Z' };

check('a parcel gives one high-confidence observation per field its appraiser publishes, NULL as unknown', () => {
  const obs = F.parcelObservations(parcel);
  assert.deepStrictEqual(obs.map((o) => o.field), F.PUBLISHES['wake-parcels']);
  assert.ok(!obs.some((o) => o.field === 'floors'), 'Wake publishes no floors: silent, not unknown');
  const units = obs.find((o) => o.field === 'units');
  assert.deepStrictEqual([units.value, units.confidence, units.method, units.sourceRef], [115, 'high', 'as_published', '1703290757']);
  const p2 = F.parcelObservations({ ...parcel, year_built: null });
  assert.strictEqual(p2.find((o) => o.field === 'year_built').value, null);
  assert.deepStrictEqual(F.parcelObservations({ ...parcel, found: false }), []);
  assert.deepStrictEqual(F.parcelObservations({ ...parcel, provider: 'unknown' }), []);
});

check('the roll year is the source date when published', () => {
  const o = F.parcelObservations({ ...parcel, provider: 'miami-dade-pa', assessment_year: 2026 })[0];
  assert.strictEqual(o.sourceAsOf, '2026-01-01');
});

check('a permit gives only the units and floors it carries, at medium confidence', () => {
  const obs = F.permitObservations({ permit_number: 'BLDR-1', source_slug: 'raleigh-nc', units: 4, floors: null, raw_record_id: 9, extracted_at: 'x', filed_date: '2026-10-01' });
  assert.deepStrictEqual(obs.map((o) => [o.field, o.value, o.confidence, o.method, o.rawRecordId]), [['units', 4, 'medium', 'matched', 9]]);
});

const ob = (id, role, value, extra = {}) => ({ id, role, value, confidence: role === 'appraiser' ? 'high' : 'medium', sourceSlug: role === 'appraiser' ? 'miami-dade-pa' : 'miami-dade-fl', sourceRef: `r${id}`, ...extra });

check('agreement: one value, no conflict; sq ft within 10% agrees, floors must match exactly', () => {
  assert.deepStrictEqual(F.resolve('floors', [ob(1, 'appraiser', 2), ob(2, 'permit', 2)]), { value: 2, winnerId: 1, conflict: null });
  assert.strictEqual(F.resolve('heated_sqft', [ob(1, 'appraiser', 2000), ob(2, 'appraiser', 2150)]).conflict, null);
  assert.ok(F.resolve('floors', [ob(1, 'appraiser', 2), ob(2, 'permit', 3)]).conflict);
});

check('appraiser beats permit: auto-resolved, the permit value kept visible', () => {
  const r = F.resolve('floors', [ob(1, 'appraiser', 1), ob(2, 'permit', 3)]);
  assert.strictEqual(r.value, 1);
  assert.strictEqual(r.conflict.status, 'auto_resolved');
  assert.deepStrictEqual(r.conflict.observationIds, [1, 2]);
  assert.ok(/miami-dade-fl r2 says 3/.test(r.conflict.resolution));
});

check('two permits that disagree, with no appraiser value: unresolved, open, nothing picked', () => {
  const r = F.resolve('units', [ob(5, 'permit', 1), ob(6, 'permit', 115)]);
  assert.deepStrictEqual([r.value, r.winnerId, r.conflict.status], [null, null, 'open']);
});

check('low confidence and unknown values never vote', () => {
  const r = F.resolve('units', [ob(1, 'appraiser', null), ob(2, 'permit', 4), ob(3, 'permit', 9, { confidence: 'low' })]);
  assert.deepStrictEqual([r.value, r.conflict], [4, null]);
  assert.deepStrictEqual(F.resolve('units', []), { value: null, winnerId: null, conflict: null });
});

check('value hashes are stable and distinguish null from 0', () => {
  assert.strictEqual(F.valueHash(2), F.valueHash(2));
  assert.notStrictEqual(F.valueHash(null), F.valueHash(0));
  assert.strictEqual(F.normalize('units', '115.0'), 115);
  assert.strictEqual(F.normalize('land_use', '  '), null);
});

check('every published field is in the vocabulary, and every appraiser has a county', () => {
  for (const [p, list] of Object.entries(F.PUBLISHES)) {
    assert.ok(F.APPRAISERS[p], p);
    for (const f of list) assert.ok(F.FIELDS[f], `${p}.${f}`);
  }
});
