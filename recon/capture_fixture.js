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

const PERSON_FIELD = /owner|applicant|full_?name|first_?name|last_?name|contact_?name|agent|architect|engineer|designer|surveyor/i;
const PHONE_FIELD = /phone|tel|fax|mobile/i;
const EMAIL_FIELD = /e_?mail/i;

/** A copy of one raw row with people's details replaced. Pure; tested. */
function redactRow(row) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(row)) {
    if (v == null || v === '') { out[k] = v; continue; }
    if (EMAIL_FIELD.test(k)) out[k] = 'redacted@example.com';
    else if (PHONE_FIELD.test(k)) { n += 1; out[k] = `512555${String(100 + n).padStart(4, '0')}`; }
    else if (PERSON_FIELD.test(k)) out[k] = 'REDACTED';
    else out[k] = v;
  }
  return out;
}

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

async function main() {
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
