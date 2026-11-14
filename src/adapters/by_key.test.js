// Offline: fetching live rows by permit number (src/adapters/by_key.js).
const assert = require('node:assert');
const { fetchByKeys, keyWhere } = require('./by_key.js');

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   - ${name}`); } catch (err) { failures += 1; console.error(`FAIL - ${name}`); console.error(err); }
};
const json = (body) => ({ ok: true, status: 200, json: async () => body });

(async () => {
  await check('keys are quoted unless the column is numeric, with quotes escaped', () => {
    assert.strictEqual(keyWhere('k', ["O'NEIL", 'B2'], false), "k IN ('O''NEIL','B2')");
    assert.strictEqual(keyWhere('k', ['007', '12'], true), 'k IN (7,12)');
  });

  await check('ArcGIS: every layer is asked, by POST, in batches; rows are attributes', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('?f=json')) return json({ fields: [{ name: 'permitnum', type: 'esriFieldTypeString' }] });
      const where = new URLSearchParams(init.body).get('where');
      const keys = [...where.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      return json({ features: keys.filter((k) => url.includes('/0/') === k.startsWith('B')).map((k) => ({ attributes: { permitnum: k } })) });
    };
    const source = { type: 'arcgis', label: 'R', fieldMap: { permitNumber: 'permitnum' }, layerUrls: ['https://x/FeatureServer/0', 'https://x/FeatureServer/1'] };
    const { rows, requests } = await fetchByKeys(source, ['B1', 'T1', 'B2'], { fetchImpl, batch: 2 });
    assert.deepStrictEqual(rows.map((r) => r.permitnum).sort(), ['B1', 'B2', 'T1']);
    assert.strictEqual(requests, 6, 'one metadata read and two batches per layer');
    assert.ok(calls.filter((c) => c.url.endsWith('/query')).every((c) => c.init.method === 'POST'));
  });

  await check('ArcGIS: a truncated batch is an error, never a short answer', async () => {
    const fetchImpl = async (url) => (url.endsWith('?f=json')
      ? json({ fields: [{ name: 'k', type: 'esriFieldTypeString' }] })
      : json({ features: [], exceededTransferLimit: true }));
    await assert.rejects(fetchByKeys({ type: 'arcgis', label: 'L', fieldMap: { permitNumber: 'k' }, layerUrl: 'https://x/0' }, ['a'], { fetchImpl }), /truncated/);
  });

  await check('Socrata: numeric key columns are not quoted', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      if (url.includes('/api/views/')) return json({ columns: [{ fieldName: 'n', dataTypeName: 'number' }] });
      seen.push(new URL(url).searchParams.get('$where'));
      return json([{ n: 5 }]);
    };
    const { rows } = await fetchByKeys({ type: 'socrata', label: 'S', domain: 'd', datasetId: 'x', fieldMap: { permitNumber: 'n' } }, ['5'], { fetchImpl });
    assert.deepStrictEqual(seen, ['n IN (5)']);
    assert.strictEqual(rows.length, 1);
  });

  await check('no keys, no requests', async () => {
    const r = await fetchByKeys({ type: 'socrata', label: 'S', fieldMap: { permitNumber: 'n' } }, [], { fetchImpl: async () => { throw new Error('no'); } });
    assert.deepStrictEqual(r, { rows: [], requests: 0 });
  });

  if (failures) process.exit(1);
})();
