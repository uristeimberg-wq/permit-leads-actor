// Offline test for recon/early_backtest.js (no network).
const assert = require('node:assert');
const B = require('./early_backtest');

const ok = (name, fn) => { fn(); console.log(`ok   - ${name}`); };

ok('main-building segments; accessory structures (329) and demolitions are not outcomes', () => {
  assert.strictEqual(B.segmentOf(101), 'single-family');
  assert.strictEqual(B.segmentOf(105), 'multifamily (5+)');
  assert.strictEqual(B.segmentOf(327), 'commercial');
  assert.strictEqual(B.segmentOf(329), null);
  assert.strictEqual(B.segmentOf(645), null);
});

ok('case numbers cited in BP descriptions are found and normalized', () => {
  assert.deepStrictEqual(B.citedCases('Concurrent Review: SP-2023-0202C'), ['SP-2023-0202C']);
  assert.deepStrictEqual(B.citedCases('SP-2023- 0227D and C14-2022-0007'), ['SP-2023-0227D', 'C14-2022-0007']);
  assert.deepStrictEqual(B.citedCases('new house, no case'), []);
  assert.strictEqual(B.normCase('SP-2018-0466C(XT)'), 'SP-2018-0466C');
});

ok('site plans: building vs ROW/utility vs extension', () => {
  assert.strictEqual(B.signalKind({ dataset: 'site_plan', caseNumber: 'SP-2023-0075C', subType: 'Consolidated', landUse: 'Restaurant' }), 'site plan: building');
  assert.strictEqual(B.signalKind({ dataset: 'site_plan', caseNumber: 'SP-2023-0001D', subType: 'Utility Line', landUse: '' }), 'site plan: non-building (ROW, utility, drainage)');
  assert.strictEqual(B.signalKind({ dataset: 'site_plan', caseNumber: 'SP-2018-0466C(XT)', subType: '' }), 'site plan: extension or revision');
  assert.strictEqual(B.signalKind({ dataset: 'zoning', subType: 'Zoning/Rezoning', approved: '2022-06-01' }), 'rezoning: approved');
});

ok('wilson interval brackets the point estimate', () => {
  const [lo, hi] = B.wilson(6, 11);
  assert.ok(lo < 54.5 && hi > 54.5 && lo >= 0 && hi <= 100);
});

const sp = (n, filed, parcel, prsn, extra = {}) => ({ dataset: 'site_plan', caseNumber: n, filed, approved: null, status: '', subType: 'Consolidated', work: '', landUse: 'Retail', name: n, parcel, prsn, lat: NaN, lon: NaN, ...extra });
const bp = (n, applied, code, parcel, extra = {}) => ({ number: n, applied, issued: null, code, isNew: true, isDemo: false, master: null, desc: '', parcel, lat: NaN, lon: NaN, ...extra });

ok('a site plan followed by a commercial BP on the same parcel converts, with the lead; the placebo window does not', () => {
  const r = B.analyze({
    cases: [sp('SP-2021-0001C', '2021-03-01', 'P1', null), sp('SP-2021-0002C', '2021-03-01', 'P2', null)],
    bps: [bp('2021-1 BP', '2021-12-01', 327, 'P1'), bp('2022-9 BP', '2022-01-01', 329, 'P2')],   // P2 only gets a dumpster
    reviews: [],
  });
  const c = r.conversion['site plan: building'].byBasis.parcel;
  assert.strictEqual(c.eligible, 2);
  assert.strictEqual(c.within730, 1);
  assert.strictEqual(c.within183, 0);
  assert.strictEqual(c.placebo730, 0);
  assert.strictEqual(c.leadDays.p50, 275);
  const cap = r.preApplicationCapture.commercial;
  assert.strictEqual(cap.newMainBps, 1);
  assert.strictEqual(cap.pctWithEarlierPlanningSignal, 100);
  assert.strictEqual(cap.leadOverApplicationDaysPlanning.p50, 275);
});

ok('official links: cited case number and propertyrsn via masterpermitnum work without a parcel', () => {
  const r = B.analyze({
    cases: [sp('SP-2022-0100C', '2022-01-10', null, null), sp('SP-2022-0200C', '2022-01-10', null, '777')],
    bps: [bp('2022-5 BP', '2022-06-01', 105, null, { desc: 'Concurrent Review: SP-2022-0100C' }),
      bp('2022-6 BP', '2022-07-01', 105, null, { master: '9001' })],
    reviews: [{ folderrsn: '9001', prsn: '777', parcel: null }],
  });
  const k = r.conversion['site plan: building'].byBasis;
  assert.strictEqual(k.cited.within730, 1);
  assert.strictEqual(k.prsn.within730, 1);
  assert.strictEqual(k['official (cited, prsn or parcel)'].within730, 2);
  assert.strictEqual(r.linkQuality.pctMasterResolvesToPlanReview, 100);
  assert.strictEqual(r.preApplicationCapture['multifamily (5+)'].pctWithEarlierPlanningSignal, 100);
});

ok('a BP applied before the signal is not counted as conversion or capture', () => {
  const r = B.analyze({ cases: [sp('SP-2022-0300C', '2022-05-01', 'P3', null)], bps: [bp('2022-1 BP', '2022-04-01', 101, 'P3')], reviews: [] });
  assert.strictEqual(r.conversion['site plan: building'].byBasis.parcel.within730, 0);
  assert.strictEqual(r.preApplicationCapture['single-family'].pctWithEarlierPlanningSignal, 0);
});

ok('demolition: residential demo then a new house, and the new house applied before the demo was issued', () => {
  const r = B.analyze({ cases: [], bps: [
    bp('2023-1 BP', '2023-01-05', 645, 'P4', { isNew: false, isDemo: true, issued: '2023-04-01' }),
    bp('2023-2 BP', '2023-03-01', 101, 'P4'),
  ], reviews: [] });
  const d = r.conversion['demolition: residential'];
  assert.strictEqual(d.byBasis.parcel.within365, 1);
  assert.strictEqual(d.newBuildAppliedBeforeDemoIssued.pct, 100);
  const cap = r.preApplicationCapture['single-family'];
  assert.strictEqual(cap.pctWithEarlierPlanningSignal, 0);
  assert.strictEqual(cap.pctWithAnyEarlierSignal, 100);
});

ok('campus parcels over the cap are excluded from parcel links', () => {
  const cases = Array.from({ length: 6 }, (_, i) => sp(`SP-2021-00${10 + i}C`, '2021-01-01', 'BIG', null));
  const r = B.analyze({ cases, bps: [bp('2021-1 BP', '2021-06-01', 320, 'BIG')], reviews: [] });
  assert.strictEqual(r.capExcludedParcels, 1);
  assert.strictEqual(r.conversion['site plan: building'].byBasis.parcel.within730, 0);
});

ok('the markdown report renders', () => {
  const r = B.analyze({ cases: [sp('SP-2021-0001C', '2021-03-01', 'P1', null)], bps: [bp('2021-1 BP', '2021-12-01', 327, 'P1')], reviews: [] });
  const md = B.markdown({ ...r, generatedAt: 'x', rows: {} });
  assert.ok(md.includes('Pre-application capture'));
});
