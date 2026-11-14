// Offline checks for the Street View photo rules (photos.js, docs/IMAGERY.md).
const assert = require('node:assert');
const P = require('./photos.js');

let n = 0;
const check = (name, fn) => { try { fn(); n += 1; } catch (e) { console.error(`FAIL ${name}`); throw e; } };

// A house in Austin, and points due north/east of it.
const site = { lat: 30.2672, lng: -97.7431, method: 'source', approximate: false };
const north = (m) => ({ lat: site.lat + m / 111195, lng: site.lng });
const east = (m) => ({ lat: site.lat, lng: site.lng + m / (111195 * Math.cos((site.lat * Math.PI) / 180)) });
const TODAY = '2026-11-14';

check('distance and bearing', () => {
  assert.ok(Math.abs(P.distanceM(site, north(30)) - 30) < 0.5);
  assert.ok(Math.abs(P.bearingDeg(north(30), site) - 180) < 0.5, 'camera north of the site looks south');
  assert.ok(Math.abs(P.bearingDeg(east(20), site) - 270) < 0.5, 'camera east of the site looks west');
});

check('capture dates keep only the precision given', () => {
  assert.deepStrictEqual(P.captureDate('2024-05'), { label: '2024-05', y: 2024, m: 5 });
  assert.deepStrictEqual(P.captureDate('2019'), { label: '2019', y: 2019, m: null });
  assert.strictEqual(P.captureDate(undefined), null);
  assert.strictEqual(P.captureDate('n/a'), null);
});

const meta = (at, date = '2025-06', extra = {}) => ({ status: 'OK', pano_id: 'pano1', location: at, date, copyright: '© 2025 Google', ...extra });

check('a close, recent panorama at a published point is high', () => {
  const r = P.streetViewPlan(meta(north(12)), site, '2025-01-10', TODAY);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tier, 'high');
  assert.strictEqual(r.distanceM, 12);
  assert.deepStrictEqual(r.notes, []);
  assert.strictEqual(r.copyright, '© 2025 Google');
});

check('distance tiers: 25-40 m medium, 40-60 m low with a warning, beyond 60 m nothing', () => {
  assert.strictEqual(P.streetViewPlan(meta(north(33)), site, null, TODAY).tier, 'medium');
  const low = P.streetViewPlan(meta(north(50)), site, null, TODAY);
  assert.strictEqual(low.tier, 'low');
  assert.ok(low.notes.some((x) => /neighbouring building/.test(x)));
  const far = P.streetViewPlan(meta(north(75)), site, null, TODAY);
  assert.strictEqual(far.ok, false);
  assert.match(far.reason, /75 m/);
});

check('no panorama, or an error status, shows nothing', () => {
  assert.strictEqual(P.streetViewPlan({ status: 'ZERO_RESULTS' }, site).ok, false);
  assert.match(P.streetViewPlan({ status: 'ZERO_RESULTS' }, site).reason, /within 60 m/);
  assert.strictEqual(P.streetViewPlan({ status: 'REQUEST_DENIED' }, site).ok, false);
  assert.strictEqual(P.streetViewPlan(null, site).ok, false);
  assert.strictEqual(P.streetViewPlan(meta(north(5)), null).ok, false);
});

check('a Census point caps the tier: exact at medium, approximate at low', () => {
  const exact = P.streetViewPlan(meta(north(5)), { ...site, method: 'census', approximate: false }, null, TODAY);
  assert.strictEqual(exact.tier, 'medium');
  assert.ok(exact.notes.some((x) => /estimated from the address/.test(x)));
  const approx = P.streetViewPlan(meta(north(5)), { ...site, method: 'census', approximate: true }, null, TODAY);
  assert.strictEqual(approx.tier, 'low');
});

check('old, undated and pre-permit images are labelled', () => {
  const old = P.streetViewPlan(meta(north(5), '2019-04'), site, null, TODAY);
  assert.strictEqual(old.tier, 'medium');
  assert.ok(old.notes.some((x) => /Older image \(2019-04\)/.test(x)));
  const undated = P.streetViewPlan(meta(north(5), null), site, null, TODAY);
  assert.strictEqual(undated.tier, 'medium');
  assert.ok(undated.notes.some((x) => /date not published/.test(x)));
  const before = P.streetViewPlan(meta(north(5), '2024-03'), site, '2025-02-01', TODAY);
  assert.ok(before.notes.some((x) => /before this permit/.test(x)));
  // Same month as the permit is not called "before": the month's last day is used.
  const same = P.streetViewPlan(meta(north(5), '2025-02'), site, '2025-02-20', TODAY);
  assert.ok(!same.notes.some((x) => /before this permit/.test(x)));
});

check('request URLs: metadata outdoor within 60 m; image by pano, turned toward the site', () => {
  const key = `AIza${'k'.repeat(35)}`;
  const m = new URL(P.streetViewMetaUrl(key, site));
  assert.strictEqual(m.pathname, '/maps/api/streetview/metadata');
  assert.strictEqual(m.searchParams.get('source'), 'outdoor');
  assert.strictEqual(m.searchParams.get('radius'), '60');
  assert.strictEqual(m.searchParams.get('location'), `${site.lat},${site.lng}`);
  const i = new URL(P.streetViewImageUrl(key, meta(north(20)), site, 20));
  assert.strictEqual(i.pathname, '/maps/api/streetview');
  assert.strictEqual(i.searchParams.get('pano'), 'pano1');
  assert.strictEqual(Math.round(Number(i.searchParams.get('heading'))), 180);
  assert.strictEqual(i.searchParams.get('return_error_code'), 'true');
  assert.strictEqual(i.searchParams.get('size'), '640x400');
});

console.log(`photos: ${n} checks passed`);
