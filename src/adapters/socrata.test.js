const assert = require('node:assert');
const { mapRows, buildAddress, buildQueryUrl, buildWhere, fetchSocrataSource } = require('./socrata.js');
const { SOURCES } = require('../sources.js');

const pending = [];
function check(name, fn) {
  const done = (err) => { if (err) { console.error(`FAIL - ${name}`); console.error(err); process.exitCode = 1; } else console.log(`ok   - ${name}`); };
  try { const r = fn(); if (r instanceof Promise) { pending.push(r.then(() => done(), done)); return; } done(); }
  catch (err) { done(err); }
}
function fakeLog() {
  const warnings = [];
  return { warnings, info: () => {}, warning: (m) => warnings.push(m) };
}

const AUSTIN = SOURCES['austin-tx'];

// Verbatim shape of a real row from data.austintexas.gov/resource/3syk-w9eu.
const REAL_ROW = {
  permit_number: '2026-117073 MP',
  permit_type_desc: 'Mechanical Permit',
  description: 'Replacement of complete existing central heat and air system',
  status_current: 'Active',
  issue_date: '2026-09-09T00:00:00.000',
  original_address1: '4803 COUNTS CV',
  original_city: 'AUSTIN',
  original_state: 'TX',
  original_zip: '78749',
  jurisdiction: 'AUSTIN FULL PURPOSE',
  link: 'https://austin.gov/permit/2026-117073',
  contractor_company_name: 'SERVICE WIZARD LLC',
  contractor_trade: 'Mechanical Contractor',
  contractor_phone: '5128737333',
  contractor_city: 'Austin',
  mechanical_valuation_remodel: '8500',
};

check('maps a real Austin row into a permit with contractor contact', () => {
  const [permit] = mapRows([REAL_ROW], AUSTIN, { log: fakeLog() });

  assert.strictEqual(permit.permitNumber, '2026-117073 MP');
  assert.strictEqual(permit.permitType, 'Mechanical Permit');
  assert.strictEqual(permit.city, 'AUSTIN');
  assert.strictEqual(permit.state, 'TX');
  assert.strictEqual(permit.zip, '78749');
  assert.strictEqual(permit.filedDate, '2026-09-09');
  assert.strictEqual(permit.statusRaw, 'Active');
  assert.strictEqual(permit.statusStage, 'approved');

  // The reason this source matters: contact details the scraped portals lack.
  assert.strictEqual(permit.contractorName, 'SERVICE WIZARD LLC');
  assert.strictEqual(permit.contractorPhone, '5128737333');
  assert.strictEqual(permit.contractorTrade, 'Mechanical Contractor');
});

check('valuation is the job total only, never one trade\'s column (ADR-34)', () => {
  // total_job_valuation is absent here and only the mechanical remodel column
  // holds a value: that is one trade's share, so no declared value is shown.
  const [permit] = mapRows([REAL_ROW], AUSTIN, { log: fakeLog() });
  assert.strictEqual(permit.valuation, null);

  // The total wins when present; a zero total falls to the remodel total.
  const [withTotal] = mapRows([{ ...REAL_ROW, total_job_valuation: '250000' }], AUSTIN, { log: fakeLog() });
  assert.strictEqual(withTotal.valuation, 250000);
  const [remodel] = mapRows([{ ...REAL_ROW, total_job_valuation: '0', total_valuation_remodel: '40000' }], AUSTIN, { log: fakeLog() });
  assert.strictEqual(remodel.valuation, 40000);
});

check('buildAddress reassembles the split address columns', () => {
  assert.strictEqual(
    buildAddress(REAL_ROW, AUSTIN.fieldMap),
    '4803 COUNTS CV, AUSTIN TX 78749',
  );
});

check('a row with no street falls back rather than emitting a stray comma', () => {
  const addr = buildAddress({ original_city: 'AUSTIN' }, AUSTIN.fieldMap);
  assert.strictEqual(addr, null);
});

check('phone formatting variants all normalize to bare digits', () => {
  for (const raw of ['(512) 873-7333', '512-873-7333', '1-512-873-7333']) {
    const [p] = mapRows([{ ...REAL_ROW, contractor_phone: raw }], AUSTIN, { log: fakeLog() });
    assert.strictEqual(p.contractorPhone, '5128737333', `failed for ${raw}`);
  }
  // Junk is dropped rather than stored as an undiallable fragment.
  const [bad] = mapRows([{ ...REAL_ROW, contractor_phone: '000' }], AUSTIN, { log: fakeLog() });
  assert.strictEqual(bad.contractorPhone, null);
});

check('a finished Austin permit is staged finished, not approved', () => {
  const [permit] = mapRows([{ ...REAL_ROW, status_current: 'Final' }], AUSTIN, { log: fakeLog() });
  assert.strictEqual(permit.statusStage, 'finished');
});

check('buildQueryUrl pages and orders newest-first', () => {
  const url = buildQueryUrl(AUSTIN, { daysBack: 7, offset: 1000, pageSize: 1000 });
  assert.match(url, /data\.austintexas\.gov\/resource\/3syk-w9eu\.json/);
  assert.match(url, /%24limit=1000/);
  assert.match(url, /%24offset=1000/);
  assert.match(url, /%24order=issue_date\+DESC/);
});

check('buildWhere constrains by the date field', () => {
  const where = buildWhere(AUSTIN, 30);
  assert.match(where, /issue_date >= '\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(buildWhere({ label: 'x' }, 0), '');
});

check('a source without a fieldMap refuses to run rather than guessing', async () => {
  await assert.rejects(
    () => fetchSocrataSource({ label: 'Unverified', domain: 'x.test', datasetId: 'abcd-1234' }, { log: fakeLog() }),
    /no fieldMap/i,
  );
});

check('a non-array Socrata response is surfaced as an error', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ error: true, message: 'Invalid SoQL' }) });
  await assert.rejects(
    () => fetchSocrataSource(AUSTIN, { log: fakeLog(), fetchImpl }),
    /Invalid SoQL/,
  );
});

check('paging stops on a short page', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => Array.from({ length: calls === 1 ? 1000 : 5 }, () => REAL_ROW) };
  };
  const permits = await fetchSocrataSource(AUSTIN, { log: fakeLog(), fetchImpl, maxRecords: 5000 });
  assert.strictEqual(calls, 2);
  assert.strictEqual(permits.length, 1005);
});

check('onRaw receives the unmapped rows and the request count', async () => {
  let calls = 0; let got;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => Array.from({ length: calls === 1 ? 1000 : 2 }, () => REAL_ROW) }; };
  await fetchSocrataSource(AUSTIN, { log: fakeLog(), fetchImpl, maxRecords: 5000, onRaw: (rows, meta) => { got = { rows, meta }; } });
  assert.strictEqual(got.rows.length, 1002);
  assert.strictEqual(got.rows[0], REAL_ROW);
  assert.deepStrictEqual({ ...got.meta, recordUrls: got.meta.recordUrls.length }, { requests: 2, truncated: false, recordUrls: 1002 });
  assert.strictEqual(got.meta.recordUrls[0], 'https://data.austintexas.gov/resource/3syk-w9eu.json?permit_number=2026-117073+MP');
});

check('two windows: rows found by both come back once, with :id as the paging tiebreak', async () => {
  const urls = []; let got;
  const rowA = { ...REAL_ROW, permit_number: 'A' }; const rowB = { ...REAL_ROW, permit_number: 'B' };
  const fetchImpl = async (url) => {
    urls.push(decodeURIComponent(url).replace(/\+/g, ' '));
    const page = urls.length === 1 ? [rowA] : [rowA, rowB];
    return { ok: true, json: async () => page };
  };
  const permits = await fetchSocrataSource(AUSTIN, {
    log: fakeLog(), fetchImpl, maxRecords: 100,
    windows: [{ field: 'issue_date', days: 30 }, { field: 'statusdate', days: 14 }],
    onRaw: (rows, meta) => { got = { rows, meta }; },
  });
  assert.match(urls[0], /issue_date >= /); assert.match(urls[0], /\$order=issue_date DESC, :id/);
  assert.match(urls[1], /statusdate >= /); assert.match(urls[1], /\$order=statusdate DESC, :id/);
  assert.deepStrictEqual(got.rows.map((r) => r.permit_number), ['A', 'B']);
  assert.deepStrictEqual({ ...got.meta, recordUrls: undefined }, { requests: 2, truncated: false, recordUrls: undefined });
  assert.strictEqual(permits.length, 2);
});

check('the cap is total across windows and truncation is reported', async () => {
  let got; let n = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => Array.from({ length: 3 }, () => ({ ...REAL_ROW, permit_number: `P${n++}` })) });
  await fetchSocrataSource(AUSTIN, {
    log: fakeLog(), fetchImpl, maxRecords: 3,
    windows: [{ field: 'issue_date', days: 30 }, { field: 'statusdate', days: 14 }],
    onRaw: (rows, meta) => { got = { rows, meta }; },
  });
  assert.strictEqual(got.rows.length, 3);
  assert.strictEqual(got.meta.truncated, true);
});

Promise.all(pending).then(() => console.log('\nDone.'));
