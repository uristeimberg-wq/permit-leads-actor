// Discovery scan for early construction signals (lane B, data discovery).
// Read-only research, not a connector: it finds candidate layers and measures
// them, so a person can decide what to connect (CLAUDE.md rule 10).
//
// Passes:
//   orgs:   list every Feature/Map service an ArcGIS Online org publishes
//           (the services root, not a keyword search, so nothing hides behind
//           a bad title) and keep the ones whose names match the signal terms.
//   search: ArcGIS Online item search by place name for nearby jurisdictions.
//   socrata: Socrata catalog search on our Socrata domains.
//   layers: per matched layer, measure: rows, fields, last edit, and for each
//           date field its newest value and rows in the last 30 and 365 days.
//   specs:  measure only the given layers (--specs=url1,url2 or socrata:domain/id).
//
//   node recon/discovery_scan.js [--only=orgs,search,socrata,layers] [--specs=...] [--max=60] [--pad]
// CI: feasibility.yml input `discover`. <= 2 requests a second.

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const ONLY = args.only ? String(args.only).split(',') : null;
const want = (k) => !ONLY || ONLY.includes(k);
const MAX = Number(args.max || 60);
const UA = 'permit-leads-discovery-scan/0.1 (research; read-only)';
const DAY = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDay = (ms) => (ms == null || Number.isNaN(Number(ms)) ? null : new Date(Number(ms)).toISOString().slice(0, 10));
const log = (...a) => console.log(...a);

let last = 0;
async function get(url, { attempts = 2 } = {}) {
  for (let i = 1; ; i += 1) {
    const wait = 500 - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
      const body = JSON.parse(text);
      if (body && body.error) throw new Error(`API error: ${JSON.stringify(body.error).slice(0, 160)}`);
      return body;
    } catch (err) {
      if (i >= attempts) throw new Error(`${err.message} <- ${url.slice(0, 180)}`);
      await sleep(1500 * i);
    }
  }
}

// Our four markets' ArcGIS Online orgs (ids from the connected layers).
const ORGS = {
  'Miami-Dade County': 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services',
  'City of Miami': 'https://services1.arcgis.com/CvuPhqcTQpZPT9qY/arcgis/rest/services',
  Raleigh: 'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services',
};
// Words in a service name that suggest an application, case or early signal.
const TERMS = /applic|pending|plan(s|_|\b)|planning|zon|rezon|site|subdiv|plat|develop|variance|hearing|demol|right.?of.?way|row_|row\b|excavat|utility|water|sewer|allocat|tree|stormwater|grading|land.?use|case|review|certificate|occupan|construct|project|permit|board|notice|commence|impact|concurren|capacity|tap|meter|service.?request|lien|historic/i;
const SKIP = /parcel_?bound|basemap|imagery|elevation|contour|hydrant|street_?light|bus_?stop|trail|park(s)?\b|voting|census|school_?bound|police|fire_?station|flood_?zone/i;

const NEARBY = ['Wake County', 'Town of Cary', 'Durham', 'Apex', 'Wake Forest', 'Johnston County', 'Broward County', 'Fort Lauderdale', 'Miami Beach', 'Hialeah', 'Doral', 'Coral Gables', 'Homestead', 'Palm Beach County', 'Travis County', 'Williamson County', 'Round Rock', 'Georgetown TX', 'Cedar Park', 'Pflugerville', 'San Marcos', 'Hays County', 'Leander', 'Kyle'];
const SOCRATA = ['data.austintexas.gov', 'data.raleighnc.gov', 'data.miamigov.com', 'opendata.miamidade.gov', 'data.brla.gov', 'data.cityofgainesville.org'];
const SOCRATA_TERMS = ['zoning', 'rezoning', 'right of way', 'demolition', 'variance', 'board of adjustment', 'certificate of occupancy', 'utility', 'water service', 'tree permit', 'site plan', 'development', 'application', 'pending', 'hearing'];

async function orgs() {
  const found = [];
  for (const [name, root] of Object.entries(ORGS)) {
    let services = [];
    try {
      const b = await get(`${root}?f=json`);
      services = (b.services || []).concat((b.folders || []).map((f) => ({ name: f, type: 'folder' })));
    } catch (e) { log(`org ${name}: ${e.message}`); continue; }
    log(`\n## org ${name}: ${services.length} services`);
    for (const s of services) {
      const n = s.name || '';
      const hit = TERMS.test(n) && !SKIP.test(n);
      log(`${hit ? '*' : ' '} ${s.type} ${n}`);
      if (hit && s.type !== 'folder') found.push({ market: name, url: s.url || `${root}/${n}/${s.type}`, title: n });
    }
  }
  return found;
}

async function search() {
  const found = [];
  for (const place of NEARBY) {
    const q = `"${place}" AND (application OR applications OR "site plan" OR zoning OR rezoning OR "development review" OR "plan review" OR permits OR "land use" OR demolition OR "right of way" OR "development case" OR subdivision) AND (type:"Feature Service" OR type:"Map Service")`;
    try {
      const b = await get(`https://www.arcgis.com/sharing/rest/search?f=json&num=40&sortField=modified&sortOrder=desc&q=${encodeURIComponent(q)}`);
      const rows = (b.results || []).filter((r) => r.url && TERMS.test(r.title || '') && !SKIP.test(r.title || ''));
      log(`\n## search ${place}: ${b.total} items, ${rows.length} kept`);
      for (const r of rows.slice(0, 25)) {
        log(`  ${isoDay(r.modified)} | ${r.owner} | ${r.title} | ${r.url} | licence: ${String(r.licenseInfo || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 80) || '(blank)'}`);
        found.push({ market: place, url: r.url, title: r.title });
      }
    } catch (e) { log(`search ${place}: ${e.message}`); }
  }
  return found;
}

async function socrata() {
  const seen = new Map();
  for (const d of SOCRATA) {
    for (const q of SOCRATA_TERMS) {
      try {
        const b = await get(`https://api.us.socrata.com/api/catalog/v1?domains=${d}&q=${encodeURIComponent(q)}&only=dataset&limit=15`);
        for (const r of b.results || []) {
          const key = `${r.metadata.domain}/${r.resource.id}`;
          if (seen.has(key)) { seen.get(key).terms.push(q); continue; }
          seen.set(key, { key, name: r.resource.name, updated: (r.resource.data_updated_at || '').slice(0, 10), terms: [q] });
        }
      } catch (e) { /* not on Socrata */ }
    }
  }
  log(`\n## socrata: ${seen.size} datasets`);
  for (const s of [...seen.values()].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))) log(`  ${s.updated} | ${s.key} | ${s.name} | ${s.terms.join(',')}`);
  return [...seen.values()];
}

// Resolve a service URL to its layers (a FeatureServer root lists them).
async function layersOf(url) {
  if (/\/\d+$/.test(url)) return [url];
  const b = await get(`${url}?f=json`);
  return (b.layers || []).concat(b.tables || []).map((l) => `${url}/${l.id}`);
}

async function measureArcgis(url) {
  const meta = await get(`${url}?f=json`);
  const fields = meta.fields || [];
  const dates = fields.filter((f) => f.type === 'esriFieldTypeDate');
  const count = await get(`${url}/query?where=1%3D1&returnCountOnly=true&f=json`).then((b) => b.count).catch(() => null);
  log(`\n### ${meta.name} <${url}>`);
  log(`  rows ${count}; last edit ${isoDay(meta.editingInfo && meta.editingInfo.lastEditDate)}; geometry ${meta.geometryType || 'none'}; copyright ${(meta.copyrightText || '').slice(0, 80) || '(blank)'}`);
  log(`  fields: ${fields.map((f) => f.name).join(', ').slice(0, 900)}`);
  if (meta.serviceItemId) {
    const item = await get(`https://www.arcgis.com/sharing/rest/content/items/${meta.serviceItemId}?f=json`).catch(() => null);
    if (item) log(`  item ${meta.serviceItemId}: owner ${item.owner}; licence: ${String(item.licenseInfo || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) || '(blank)'}; access ${item.access}; description: ${String(item.description || item.snippet || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400)}`);
  }
  for (const f of dates.slice(0, 6)) {
    const stats = encodeURIComponent(JSON.stringify([{ statisticType: 'max', onStatisticField: f.name, outStatisticFieldName: 'mx' }]));
    const mx = await get(`${url}/query?where=1%3D1&outStatistics=${stats}&f=json`).then((b) => b.features && b.features[0] && b.features[0].attributes.mx).catch(() => null);
    const since = (days) => encodeURIComponent(`${f.name} >= TIMESTAMP '${new Date(Date.now() - days * DAY).toISOString().slice(0, 19).replace('T', ' ')}'`);
    const n30 = await get(`${url}/query?where=${since(30)}&returnCountOnly=true&f=json`).then((b) => b.count).catch(() => null);
    const n365 = await get(`${url}/query?where=${since(365)}&returnCountOnly=true&f=json`).then((b) => b.count).catch(() => null);
    log(`  date ${f.name}: newest ${isoDay(mx)}, last 30d ${n30}, last 365d ${n365}`);
  }
  // One sample row, without names, phones or emails.
  const s = await get(`${url}/query?where=1%3D1&outFields=*&resultRecordCount=1&returnGeometry=false&f=json`).catch(() => null);
  const row = s && s.features && s.features[0] && s.features[0].attributes;
  if (row) {
    const safe = Object.fromEntries(Object.entries(row).filter(([k]) => !/name|owner|applicant|phone|email|contact|agent/i.test(k))
      .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 60) : v]));
    log(`  sample (names dropped): ${JSON.stringify(safe).slice(0, 900)}`);
  }
}

async function measureSocrata(key) {
  const [domain, id] = key.split('/');
  const meta = await get(`https://${domain}/api/views/${id}.json`);
  const cols = (meta.columns || []).filter((c) => !c.fieldName.startsWith(':'));
  const count = await get(`https://${domain}/resource/${id}.json?$select=count(*)`).then((b) => b[0] && Object.values(b[0])[0]).catch(() => null);
  log(`\n### ${meta.name} <socrata:${key}>`);
  log(`  rows ${count}; data updated ${isoDay((meta.rowsUpdatedAt || 0) * 1000)}; licence ${meta.license ? meta.license.name : '(none)'}; category ${meta.category}`);
  log(`  fields: ${cols.map((c) => c.fieldName).join(', ').slice(0, 900)}`);
  for (const c of cols.filter((x) => x.dataTypeName === 'calendar_date').slice(0, 6)) {
    const mx = await get(`https://${domain}/resource/${id}.json?$select=max(${c.fieldName})`).then((b) => b[0] && Object.values(b[0])[0]).catch(() => null);
    const since = (days) => `https://${domain}/resource/${id}.json?$select=count(*)&$where=${encodeURIComponent(`${c.fieldName} >= '${new Date(Date.now() - days * DAY).toISOString().slice(0, 19)}'`)}`;
    const n30 = await get(since(30)).then((b) => b[0] && Object.values(b[0])[0]).catch(() => null);
    const n365 = await get(since(365)).then((b) => b[0] && Object.values(b[0])[0]).catch(() => null);
    log(`  date ${c.fieldName}: newest ${String(mx || '').slice(0, 10)}, last 30d ${n30}, last 365d ${n365}`);
  }
  const s = await get(`https://${domain}/resource/${id}.json?$limit=1`).catch(() => null);
  if (s && s[0]) {
    const safe = Object.fromEntries(Object.entries(s[0]).filter(([k]) => !/name|owner|applicant|phone|email|contact|agent/i.test(k))
      .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 60) : v]));
    log(`  sample (names dropped): ${JSON.stringify(safe).slice(0, 900)}`);
  }
}

async function measure(spec) {
  try {
    if (spec.startsWith('socrata:')) return await measureSocrata(spec.slice(8));
    for (const l of (await layersOf(spec)).slice(0, 4)) await measureArcgis(l).catch((e) => log(`  ${l}: ${e.message}`));
  } catch (e) { log(`  ${spec}: ${e.message}`); }
}

async function main() {
  if (args.specs) {
    for (const s of String(args.specs).split(',').map((x) => x.trim()).filter(Boolean)) await measure(s);
  } else {
    const found = [];
    if (want('orgs')) found.push(...await orgs());
    if (want('search')) found.push(...await search());
    if (want('socrata')) await socrata();
    if (want('layers')) {
      log(`\n## measuring ${Math.min(found.length, MAX)} of ${found.length} matched services (org matches first)`);
      for (const f of found.slice(0, MAX)) { log(`\n[${f.market}] ${f.title}`); await measure(f.url); }
    }
  }
  // Pad so the job log is saved to a file by the log reader instead of flooding context.
  if (args.pad) for (let i = 0; i < 400; i += 1) log(`PAD ${'.'.repeat(200)}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });

module.exports = { get, measure, measureArcgis, measureSocrata, layersOf };
