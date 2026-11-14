// Fetch a source's live rows by their permit numbers, rather than by a date
// window. Used by the rolling re-read (ingest/refresh.js), which catches edits
// and deletions on permits no window covers any more, and by the fidelity
// check (recon/fidelity_check.js).
//
// Socrata: `$where key IN (...)`. ArcGIS: `where key IN (...)` on every layer
// of the source (Raleigh has two; a key lives on one of them). The key
// column's type is read from the live service so numbers are not quoted.

const { fetchWithRetry } = require('./http.js');

const BATCH = 50;

/** SQL / SoQL `field IN (...)` over keys; strings are quoted with '' escaping. */
function keyWhere(field, keys, numeric) {
  const lit = keys.map((k) => (numeric ? String(Number(k)) : `'${String(k).replace(/'/g, "''")}'`));
  return `${field} IN (${lit.join(',')})`;
}

function socrataHeaders() {
  return process.env.SOCRATA_APP_TOKEN ? { 'X-App-Token': process.env.SOCRATA_APP_TOKEN } : undefined;
}

/**
 * @param {object} source entry from src/sources.js (socrata or arcgis)
 * @param {string[]} keys permit numbers as stored
 * @returns {Promise<{rows: object[], requests: number}>} unmapped live rows
 */
async function fetchByKeys(source, keys, { fetchImpl = fetch, log, batch = BATCH, retry } = {}) {
  const keyField = source.fieldMap && source.fieldMap.permitNumber;
  if (!keyField || Array.isArray(keyField)) throw new Error(`Source "${source.label}" has no single permitNumber field`);
  let requests = 0;
  const getJson = async (url, init) => {
    requests += 1;
    const res = await fetchWithRetry(fetchImpl, url, init, { log, ...retry });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 120)}`);
    const body = await res.json();
    if (body && body.error) throw new Error(`ArcGIS error ${body.error.code}: ${body.error.message}`);
    return body;
  };
  const rows = [];
  if (keys.length === 0) return { rows, requests };

  if (source.type === 'socrata') {
    const meta = await getJson(`https://${source.domain}/api/views/${source.datasetId}.json`, { headers: socrataHeaders() });
    const col = (meta.columns || []).find((c) => c.fieldName === keyField);
    const numeric = Boolean(col && col.dataTypeName === 'number');
    for (let i = 0; i < keys.length; i += batch) {
      const p = new URLSearchParams({ $where: keyWhere(keyField, keys.slice(i, i + batch), numeric), $limit: '5000' });
      const page = await getJson(`https://${source.domain}/resource/${source.datasetId}.json?${p}`, { headers: socrataHeaders() });
      if (!Array.isArray(page)) throw new Error('Socrata returned a non-array body');
      rows.push(...page);
    }
    return { rows, requests };
  }

  if (source.type === 'arcgis') {
    for (const layer of source.layerUrls || [source.layerUrl]) {
      const base = layer.replace(/\/+$/, '');
      const meta = await getJson(`${base}?f=json`);
      const f = (meta.fields || []).find((x) => x.name === keyField);
      if (!f) throw new Error(`Layer ${base} has no field ${keyField}`);
      const numeric = !/String|GUID/i.test(f.type);
      for (let i = 0; i < keys.length; i += batch) {
        const body = new URLSearchParams({
          f: 'json', where: keyWhere(keyField, keys.slice(i, i + batch), numeric), outFields: '*', returnGeometry: 'false',
        });
        const res = await getJson(`${base}/query`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
        });
        if (res.exceededTransferLimit) throw new Error(`Layer ${base} truncated a ${batch}-key query`);
        for (const feat of res.features || []) rows.push(feat.attributes || feat);
      }
    }
    return { rows, requests };
  }

  throw new Error(`fetchByKeys: unsupported source type ${source.type}`);
}

module.exports = { fetchByKeys, keyWhere, BATCH };
