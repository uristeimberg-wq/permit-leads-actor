const assert = require('node:assert');
const { mapFeatures, buildQueryUrl, buildWhere, fetchArcgisSource } = require('./arcgis.js');
const { SOURCES } = require('../sources.js');
const { scorePermit } = require('../scoring.js');

const pending = [];
function check(name, fn) {
  const done = (err) => { if (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; } else console.log(`ok   - ${name}`); };
  try {
    const r = fn();
    if (r instanceof Promise) { pending.push(r.then(() => done(), done)); return; }
    done();
  } catch (err) { done(err); }
}
function fakeLog() {
  const warnings = [];
  return { warnings, info: () => {}, warning: (m) => warnings.push(m) };
}

const SOURCE = {
  label: 'Test County',
  layerUrl: 'https://example.test/arcgis/rest/services/Permits/MapServer/9',
  dateField: 'ISSUE_DATE',
  fieldMap: {
    address: 'SITE_ADDR',
    workDescription: 'DESCRIPTION',
    valuation: 'JOB_VALUE',
    status: 'PERMIT_STATUS',
    permitNumber: 'PERMIT_NUM',
    filedDate: 'ISSUE_DATE',
  },
  statusMap: { 'in review': 'applied', issued: 'issued' },
};

check('buildWhere combines a date cutoff with an extra clause', () => {
  const where = buildWhere({ ...SOURCE, where: "PERMIT_TYPE='RES'" }, 30);
  assert.match(where, /ISSUE_DATE >= timestamp '\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}'/);
  assert.match(where, /AND \(PERMIT_TYPE='RES'\)/);
});

check('buildWhere falls back to 1=1 when nothing constrains the query', () => {
  assert.strictEqual(buildWhere({ label: 'x' }, 0), '1=1');
});

check('buildQueryUrl requests JSON attributes without geometry, and pages', () => {
  const url = buildQueryUrl(SOURCE, { daysBack: 7, offset: 500, pageSize: 500 });
  assert.match(url, /\/MapServer\/9\/query\?/);
  assert.match(url, /f=json/);
  assert.match(url, /outFields=\*/);
  assert.match(url, /returnGeometry=false/);
  assert.match(url, /resultOffset=500/);
  assert.match(url, /resultRecordCount=500/);
});

check('buildQueryUrl requests only the listed columns when a source names them', () => {
  const url = buildQueryUrl({ ...SOURCE, outFields: ['permit_number', 'disp_description'] }, { daysBack: 1, offset: 0, pageSize: 10 });
  assert.match(url, /outFields=permit_number%2Cdisp_description/);
  assert.ok(!/outFields=\*/.test(url));
});

check('buildQueryUrl tolerates a trailing slash on the layer URL', () => {
  const url = buildQueryUrl({ ...SOURCE, layerUrl: `${SOURCE.layerUrl}/` }, { daysBack: 1, offset: 0, pageSize: 10 });
  assert.ok(!url.includes('//query'), 'should not double the slash before /query');
});

check('mapFeatures converts ArcGIS attributes into scorable permits', () => {
  const features = [{
    attributes: {
      SITE_ADDR: '900 NE 1ST ST',
      DESCRIPTION: 'New SFR, two story',
      JOB_VALUE: 415000,
      PERMIT_STATUS: 'In Review',
      PERMIT_NUM: 'BLD-2026-001',
      ISSUE_DATE: Date.UTC(2026, 7, 20),
    },
  }];
  const [permit] = mapFeatures(features, SOURCE, { log: fakeLog() });

  assert.strictEqual(permit.address, '900 NE 1ST ST');
  assert.strictEqual(permit.valuation, 415000);
  assert.strictEqual(permit.status, 'applied');
  assert.strictEqual(permit.permitNumber, 'BLD-2026-001');
  assert.strictEqual(permit.filedDate, '2026-08-20'); // epoch ms -> ISO date
  assert.strictEqual(scorePermit(permit, 'flooring').score, 102);
});

check('mapFeatures builds a permit URL from a template', () => {
  const src = { ...SOURCE, permitUrlTemplate: 'https://example.test/p?id={permitNumber}' };
  const [permit] = mapFeatures([{ attributes: { PERMIT_NUM: 'BLD 2026/9' } }], src, { log: fakeLog() });
  assert.strictEqual(permit.permitUrl, 'https://example.test/p?id=BLD%202026%2F9');
});

check('mapFeatures leaves filedDate null when the date field is absent', () => {
  const [permit] = mapFeatures([{ attributes: {} }], SOURCE, { log: fakeLog() });
  assert.strictEqual(permit.filedDate, null);
  assert.strictEqual(permit.valuation, null);
});

check('a source without a fieldMap refuses to run rather than guessing', async () => {
  await assert.rejects(
    () => fetchArcgisSource({ label: 'Unverified', layerUrl: 'https://x.test/0' }, { log: fakeLog() }),
    /no fieldMap/i,
  );
});

check('an ArcGIS error returned inside a 200 body is surfaced, not ignored', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ error: { code: 400, message: 'Invalid field: BOGUS', details: ['bad where'] } }) });
  await assert.rejects(
    () => fetchArcgisSource(SOURCE, { log: fakeLog(), fetchImpl }),
    /ArcGIS error 400: Invalid field: BOGUS \(bad where\)/,
  );
});

check('paging stops once the server stops reporting a transfer limit', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({
      features: Array.from({ length: calls === 1 ? 500 : 3 }, () => ({ attributes: { PERMIT_STATUS: 'Issued' } })),
      exceededTransferLimit: calls === 1,
    }) };
  };
  const permits = await fetchArcgisSource(SOURCE, { log: fakeLog(), fetchImpl, maxRecords: 2000 });
  assert.strictEqual(calls, 2);
  assert.strictEqual(permits.length, 503);
});

check('a layer capped below our page size keeps paging while it reports a transfer limit', async () => {
  // maxRecordCount 200: every page is "short", but more rows remain.
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({
      features: Array.from({ length: calls < 3 ? 200 : 50 }, () => ({ attributes: { PERMIT_STATUS: 'Issued' } })),
      exceededTransferLimit: calls < 3,
    }) };
  };
  const permits = await fetchArcgisSource(SOURCE, { log: fakeLog(), fetchImpl, maxRecords: 2000 });
  assert.strictEqual(calls, 3);
  assert.strictEqual(permits.length, 450);
});

check('an empty page ends paging even if the server still claims a transfer limit', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ features: calls === 1 ? [{ attributes: { PERMIT_STATUS: 'Issued' } }] : [], exceededTransferLimit: true }) };
  };
  const permits = await fetchArcgisSource(SOURCE, { log: fakeLog(), fetchImpl, maxRecords: 2000 });
  assert.strictEqual(calls, 2);
  assert.strictEqual(permits.length, 1);
});

check('onRaw receives the unmapped attributes and the request count', async () => {
  let got;
  const attrs = { PERMIT_STATUS: 'Issued', X: 1 };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ features: [{ attributes: attrs }], exceededTransferLimit: false }) });
  await fetchArcgisSource(SOURCE, { log: fakeLog(), fetchImpl, onRaw: (rows, meta) => { got = { rows, meta }; } });
  assert.deepStrictEqual(got.rows, [attrs]);
  assert.deepStrictEqual(got.meta, { requests: 1, truncated: false });
});

check('windows: per-layer fields, each ordered by its own field, a row found twice kept once', async () => {
  const urls = [];
  const src = { ...SOURCE, layerUrl: undefined, dateField: 'issued', orderByFields: 'issued DESC, OBJECTID',
    layerUrls: ['https://x.test/A/FeatureServer/0', 'https://x.test/B/FeatureServer/0'], fieldMap: { ...SOURCE.fieldMap, permitNumber: 'num' } };
  const rows = { A: [{ num: '1' }, { num: '2' }], B: [{ num: '3' }] };
  const fetchImpl = async (url) => {
    urls.push(decodeURIComponent(url).replace(/\+/g, ' '));
    const layer = url.includes('/A/') ? 'A' : 'B';
    return { ok: true, json: async () => ({ features: rows[layer].map((attributes) => ({ attributes })), exceededTransferLimit: false }) };
  };
  let meta;
  await fetchArcgisSource(src, {
    log: fakeLog(), fetchImpl, onRaw: (r, m) => { meta = { n: r.map((x) => x.num), ...m }; },
    windows: [{ field: 'applied', days: 30, layer: 0 }, { field: 'created', days: 30, layer: 1 }, { field: 'updated', days: 14 }],
  });
  assert.deepStrictEqual(meta, { n: ['1', '2', '3'], requests: 4, truncated: false });
  assert.ok(/A\/.*where=applied >= timestamp/.test(urls[0]) && /orderByFields=applied DESC, OBJECTID/.test(urls[0]), urls[0]);
  assert.ok(/A\/.*where=updated >= /.test(urls[1]));
  assert.ok(/B\/.*where=created >= /.test(urls[2]) && /B\/.*where=updated >= /.test(urls[3]));
});

check('maxRecords caps how much is pulled', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({
    features: Array.from({ length: 10 }, () => ({ attributes: { PERMIT_STATUS: 'Issued' } })),
    exceededTransferLimit: true,
  }) });
  const permits = await fetchArcgisSource(SOURCE, { log: fakeLog(), fetchImpl, maxRecords: 10 });
  assert.strictEqual(permits.length, 10);
});

// --- Miami-Dade: a layer with contractor contact but no status column -------

const MIAMI = SOURCES['miami-dade-fl'];

// Verbatim shape of a real record from the live Miami-Dade layer.
const MIAMI_ROW = {
  attributes: {
    PermitNumber: '2026061402',
    ApplicationTypeDescription: 'ALTER - INTERIOR',
    DetailDescriptionComments: 'WALK-IN COOLER',
    EstimatedValue: '150000',
    PermitIssuedDate: '2026-09-10',
    PropertyAddress: '12200 NW 25 ST               109',
    City: 'MIAMI',
    State: 'FL',
    OwnerName: 'AMB INSTIT ALLIANCE FD III LP',
    ContractorName: 'TURN CONSTRUCTION LLC',
    ContractorPhone: '(305)333-5153',
    ContractorNumber: 'CGC061097',
    ContractorCity: 'MIAMI',
    CoCcDate: null,
  },
};

check('maps a real Miami-Dade feature, including contractor contact', () => {
  const [permit] = mapFeatures([MIAMI_ROW], MIAMI, { log: fakeLog() });
  assert.strictEqual(permit.permitNumber, '2026061402');
  assert.strictEqual(permit.city, 'MIAMI');
  assert.strictEqual(permit.state, 'FL');
  assert.strictEqual(permit.valuation, 150000);
  assert.strictEqual(permit.owner, 'AMB INSTIT ALLIANCE FD III LP');
  assert.strictEqual(permit.contractorName, 'TURN CONSTRUCTION LLC');
  assert.strictEqual(permit.contractorPhone, '3053335153'); // punctuation stripped
  assert.strictEqual(permit.contractorLicence, 'CGC061097');
});

check('Miami stage is derived from dates, since the layer has no status column', () => {
  // Issued, not yet completed.
  const [issued] = mapFeatures([MIAMI_ROW], MIAMI, { log: fakeLog() });
  assert.strictEqual(issued.statusStage, 'approved');
  assert.strictEqual(issued.statusRaw, 'Issued');

  // A Certificate of Completion means the job is done — it must NOT read as
  // approved, which is the whole point of the stage column.
  const done = { attributes: { ...MIAMI_ROW.attributes, CoCcDate: 1724385600000 } };
  const [finished] = mapFeatures([done], MIAMI, { log: fakeLog() });
  assert.strictEqual(finished.statusStage, 'finished');
  assert.notStrictEqual(finished.statusStage, 'approved');
});

check('Miami has no property postal code, and none is invented', () => {
  // The layer publishes a street address plus City/State but no ZIP. Miami is
  // searchable by city; fabricating a ZIP would be worse than leaving it null.
  const [permit] = mapFeatures([MIAMI_ROW], MIAMI, { log: fakeLog() });
  assert.strictEqual(permit.zip, null);
  assert.strictEqual(permit.city, 'MIAMI');
});

check('a multi-layer source reads every layer and hands one raw batch over', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const n = url.includes('/A/') ? 'A-1' : 'B-1';
    return { ok: true, status: 200, json: async () => ({ features: [{ attributes: { num: n, d: 1794455349183 } }] }) };
  };
  let raw = null;
  const src = { label: 'Two', layerUrls: ['https://x.test/A/FeatureServer/0', 'https://x.test/B/FeatureServer/0'], dateField: 'd',
    fieldMap: { permitNumber: 'num', filedDate: 'd' } };
  const permits = await fetchArcgisSource(src, { log: fakeLog(), fetchImpl, onRaw: async (r, meta) => { raw = { r, meta }; } });
  assert.deepStrictEqual(permits.map((p) => p.permitNumber), ['A-1', 'B-1']);
  assert.deepStrictEqual([raw.r.length, raw.meta.requests], [2, 2]);
  assert.ok(urls[0].startsWith('https://x.test/A/') && urls[1].startsWith('https://x.test/B/'));
});

Promise.all(pending).then(() => console.log('\nDone.'));
