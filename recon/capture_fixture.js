// Records a small fixture of raw rows from a live source (CLAUDE.md rule 10),
// through the same adapter the sync uses, so the fixture has the exact shape
// ingest sees. Runs in GitHub Actions (fixture.yml): this container cannot
// reach government hosts.
//
// People's details are replaced before printing: owner, applicant and
// person-name fields become "REDACTED", emails become example.com addresses,
// and every phone becomes a 555 number. Business names and permit fields stay,
// because the fixture exists to test mapping and contractor resolution.
//
//   node recon/capture_fixture.js --source=austin-tx [--rows=20] [--days=14]
// Prints the fixture between BEGIN FIXTURE / END FIXTURE markers.
//
// Discovery, for a candidate ArcGIS layer that has no config yet (so no
// fieldMap, and the adapter rightly refuses it): reads the layer's declared
// fields and its newest rows directly, so the fieldMap can be written from
// real column names (hard rule 1).
//   node recon/capture_fixture.js --layer=<FeatureServer/N url> --date-field=IssuedDate --slug=miami-city-fl

const { SOURCES } = require('../src/sources.js');
const { getAdapter } = require('../src/adapters/index.js');

// Redaction lives in recon/redact.js (no dependencies, so recon scripts
// that run without npm ci can use it).
const { redactRow } = require('./redact.js');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

const LAYER_URL = /^https:\/\/services[0-9]*\.arcgis\.com\/[A-Za-z0-9]+\/arcgis\/rest\/services\/[A-Za-z0-9_]+\/FeatureServer\/[0-9]+$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function discover(layer, dateField, slug, rows) {
  if (!LAYER_URL.test(layer)) throw new Error('--layer must be an ArcGIS Online FeatureServer layer URL');
  if (!FIELD.test(dateField) || !/^[a-z0-9-]+$/.test(slug)) throw new Error('bad --date-field or --slug');
  const { fetchWithRetry } = require('../src/adapters/http.js');
  const get = async (url) => {
    const res = await fetchWithRetry(fetch, url, {}, { log: { warning: (m) => console.error(m) } });
    const body = await res.json();
    if (body.error) throw new Error(`${url}: ${JSON.stringify(body.error)}`);
    return body;
  };
  const meta = await get(`${layer}?f=json`);
  const q = new URLSearchParams({ where: '1=1', outFields: '*', orderByFields: `${dateField} DESC`, resultRecordCount: String(rows), f: 'json' });
  const data = await get(`${layer}/query?${q}`);
  const raw = (data.features || []).map((f) => f.attributes);
  if (!raw.length) throw new Error('layer returned no rows');
  return {
    source: slug, layer, capturedAt: new Date().toISOString(), discovery: true,
    layerName: meta.name, editedAt: meta.editingInfo && meta.editingInfo.lastEditDate ? new Date(meta.editingInfo.lastEditDate).toISOString() : null,
    licenseInfo: meta.copyrightText || null,
    declaredFields: (meta.fields || []).map((f) => ({ name: f.name, type: f.type, alias: f.alias })),
    rows: raw.map(redactRow),
    fields: [...new Set(raw.flatMap((r) => Object.keys(r)))].sort(),
  };
}

const SOCRATA_URL = /^https:\/\/[a-z0-9.-]+\.[a-z]+\/resource\/[a-z0-9]{4}-[a-z0-9]{4}\.json$/;

/** Discovery for a Socrata dataset with no config yet: its declared columns and newest rows. */
async function discoverSocrata(url, dateField, slug, rows) {
  if (!SOCRATA_URL.test(url)) throw new Error('--layer must be a Socrata /resource/<id>.json URL');
  if (!FIELD.test(dateField) || !/^[a-z0-9-]+$/.test(slug)) throw new Error('bad --date-field or --slug');
  const { fetchWithRetry } = require('../src/adapters/http.js');
  const headers = process.env.SOCRATA_APP_TOKEN ? { 'X-App-Token': process.env.SOCRATA_APP_TOKEN } : {};
  const get = async (u) => {
    const res = await fetchWithRetry(fetch, u, { headers }, { log: { warning: (m) => console.error(m) } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${u}`);
    return res.json();
  };
  const meta = await get(url.replace('/resource/', '/api/views/'));
  const q = new URLSearchParams({ $order: `${dateField} DESC`, $limit: String(rows) });
  const raw = await get(`${url}?${q}`);
  if (!raw.length) throw new Error('dataset returned no rows');
  return {
    source: slug, layer: url, capturedAt: new Date().toISOString(), discovery: true,
    layerName: meta.name, editedAt: meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString() : null,
    licenseInfo: (meta.license && meta.license.name) || meta.licenseId || null,
    declaredFields: (meta.columns || []).map((c) => ({ name: c.fieldName, type: c.dataTypeName, alias: c.name })),
    rows: raw.map(redactRow),
    fields: [...new Set(raw.flatMap((r) => Object.keys(r)))].sort(),
  };
}

async function main() {
  if (arg('layer') && SOCRATA_URL.test(arg('layer'))) {
    const fixture = await discoverSocrata(arg('layer'), arg('date-field', ''), arg('slug', ''), Math.min(Number(arg('rows', 20)), 200));
    console.log('BEGIN FIXTURE');
    console.log(JSON.stringify(fixture, null, 1));
    console.log('END FIXTURE');
    return;
  }
  if (arg('layer')) {
    const fixture = await discover(arg('layer'), arg('date-field', ''), arg('slug', ''), Math.min(Number(arg('rows', 20)), 200));
    console.log('BEGIN FIXTURE');
    // One value per line: Actions drops a log line over ~64 KB.
    console.log(JSON.stringify(fixture, null, 1));
    console.log('END FIXTURE');
    return;
  }
  const slug = arg('source');
  const source = SOURCES[slug];
  if (!source) throw new Error(`Unknown --source "${slug}". Known: ${Object.keys(SOURCES).join(', ')}`);
  const rows = Number(arg('rows', 20));
  const days = Number(arg('days', 14));
  let raw = [];
  const log = { info: () => {}, warning: (m) => console.error(`warning: ${m}`), error: (m) => console.error(m) };
  await getAdapter(source.type)(source, {
    includeIssued: true, daysBack: days, maxRecords: rows, log,
    onRaw: async (r) => { raw = r; },
  });
  if (!raw.length) throw new Error(`No rows from ${slug} in the last ${days} days`);
  const fixture = {
    source: slug, capturedAt: new Date().toISOString(), days, rows: raw.slice(0, rows).map(redactRow),
    fields: [...new Set(raw.flatMap((r) => Object.keys(r)))].sort(),
  };
  console.log('BEGIN FIXTURE');
  // One value per line: Actions drops a log line over ~64 KB.
    console.log(JSON.stringify(fixture, null, 1));
  console.log('END FIXTURE');
}

if (require.main === module) {
  main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
}

module.exports = { redactRow };
