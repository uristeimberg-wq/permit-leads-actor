// Lifecycle and pre-demolition source scan (thread "Add inspections, reviews
// and demolition notices", 2026-11-15). Read-only research, not a connector:
// it finds and measures candidate sources so a person can decide what to
// connect (CLAUDE.md rule 10). Nothing here is stored.
//
// Passes:
//   orgs:    list our three ArcGIS orgs' services whose names suggest
//            inspections, reviews, status history, demolition, asbestos,
//            right-of-way or utility cuts.
//   socrata: Socrata catalog search on the market and state domains.
//   search:  ArcGIS Online item search for state demolition/asbestos notices
//            and market inspection layers.
//   robots:  robots.txt and the landing status of permit portals and
//            Secretary of State sites (the PDF-attachment and owner-LLC probes:
//            what automation the sites allow, nothing downloaded).
//   specs:   measure only the given layers (--specs=url1,url2 or socrata:domain/id).
//   sample:  print N rows (names dropped) of --specs, for field mapping.
//   inspections: profile the two open inspection layers found by the scan
//            (Miami-Dade inspectionsData, Raleigh Inspection_Schedule_Public)
//            and measure how many of their permit numbers exist in the permit
//            layers we already sync. Names and contact fields are never read.
//   fixtures: write test/fixtures/sources/<slug>.json for both (names dropped).
//
//   node recon/lifecycle_scan.js [--only=orgs,socrata,search,robots] [--specs=...] [--sample=5] [--pad]
// CI: feasibility.yml input `lifecycle`. <= 2 requests a second.

const { get, measure } = require('./discovery_scan');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const ONLY = args.only ? String(args.only).split(',') : null;
const want = (k) => !ONLY || ONLY.includes(k);
const log = (...a) => console.log(...a);
const UA = 'permit-leads-lifecycle-scan/0.1 (research; read-only)';

const ORGS = {
  'Miami-Dade County': 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services',
  'City of Miami': 'https://services1.arcgis.com/CvuPhqcTQpZPT9qY/arcgis/rest/services',
  Raleigh: 'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services',
};
const TERMS = /inspect|insp_|review|status|history|activity|workflow|demol|asbest|abate|right.?of.?way|row_|_row|encroach|excavat|street.?cut|cut_|utility|driveway|sidewalk|curb|tap|meter|neshap|wreck/i;

const SOCRATA = ['data.austintexas.gov', 'datahub.austintexas.gov', 'data.texas.gov', 'data.raleighnc.gov', 'opendata.miamidade.gov', 'data.miamigov.com', 'data.ncdenr.gov'];
const SOCRATA_TERMS = ['inspection', 'inspections', 'plan review', 'review cycle', 'permit activity', 'status history', 'demolition', 'asbestos', 'abatement', 'right of way', 'street cut', 'excavation', 'utility', 'driveway', 'notification'];

const SEARCH = [
  'asbestos notification', 'demolition notification', 'asbestos NESHAP', 'FDEP asbestos', 'Florida asbestos demolition',
  'Miami-Dade asbestos', 'DERM asbestos', 'Texas asbestos DSHS', 'TCEQ asbestos', 'North Carolina asbestos', 'NC DHHS asbestos',
  'Miami-Dade building inspections', 'Miami inspections permits', 'Raleigh inspections', 'Raleigh right of way permits',
  'Miami-Dade right of way permit', 'Miami public works permit', 'Austin right of way permit', 'Austin inspections',
];

// Permit portals (attachments) and Secretary of State sites (owner LLCs).
const HOSTS = [
  ['Austin AMANDA public search', 'https://abc.austintexas.gov'],
  ['Austin development services', 'https://www.austintexas.gov'],
  ['Miami-Dade permits (www)', 'https://www.miamidade.gov'],
  ['Miami-Dade e-services', 'https://www8.miamidade.gov'],
  ['Miami-Dade apps', 'https://wwwx.miamidade.gov'],
  ['City of Miami iBuild', 'https://ibuild.miamigov.com'],
  ['City of Miami (www)', 'https://www.miami.gov'],
  ['Raleigh permit portal', 'https://permitportal.raleighnc.gov'],
  ['Raleigh (www)', 'https://raleighnc.gov'],
  ['Raleigh EnerGov', 'https://energovweb.raleighnc.gov'],
  ['TX SOSDirect', 'https://direct.sos.state.tx.us'],
  ['TX SOS (www)', 'https://www.sos.state.tx.us'],
  ['TX SOS (sos.texas.gov)', 'https://www.sos.texas.gov'],
  ['FL Sunbiz search', 'https://search.sunbiz.org'],
  ['FL DOS (dos.fl.gov)', 'https://dos.fl.gov'],
  ['NC SOS', 'https://www.sosnc.gov'],
  ['TX DSHS', 'https://www.dshs.texas.gov'],
  ['TCEQ', 'https://www.tceq.texas.gov'],
  ['FDEP', 'https://floridadep.gov'],
  ['NC DHHS epi', 'https://epi.dph.ncdhhs.gov'],
];

async function text(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    return { status: res.status, url: res.url, body: await res.text() };
  } catch (e) { return { status: 0, url, body: '', error: e.message }; }
}

async function orgs() {
  for (const [name, root] of Object.entries(ORGS)) {
    let services = [];
    try {
      const b = await get(`${root}?f=json`);
      services = b.services || [];
    } catch (e) { log(`org ${name}: ${e.message}`); continue; }
    const hits = services.filter((s) => TERMS.test(s.name || ''));
    log(`\n## org ${name}: ${services.length} services, ${hits.length} match`);
    for (const s of hits) log(`  ${s.type} ${s.name} <${s.url || `${root}/${s.name}/${s.type}`}>`);
  }
}

async function socrata() {
  const seen = new Map();
  for (const d of SOCRATA) {
    for (const q of SOCRATA_TERMS) {
      try {
        const b = await get(`https://api.us.socrata.com/api/catalog/v1?domains=${d}&q=${encodeURIComponent(q)}&only=dataset&limit=20`);
        for (const r of b.results || []) {
          const key = `${r.metadata.domain}/${r.resource.id}`;
          if (seen.has(key)) { seen.get(key).terms.push(q); continue; }
          seen.set(key, { key, name: r.resource.name, updated: (r.resource.data_updated_at || '').slice(0, 10), terms: [q] });
        }
      } catch (e) { /* domain not on the US catalog */ }
    }
  }
  log(`\n## socrata: ${seen.size} datasets`);
  for (const s of [...seen.values()].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))) log(`  ${s.updated} | ${s.key} | ${s.name} | ${s.terms.join(',')}`);
}

async function search() {
  for (const q of SEARCH) {
    try {
      const b = await get(`https://www.arcgis.com/sharing/rest/search?f=json&num=25&sortField=modified&sortOrder=desc&q=${encodeURIComponent(`${q} (type:"Feature Service" OR type:"Map Service" OR type:"Table")`)}`);
      log(`\n## search "${q}": ${b.total} items`);
      for (const r of (b.results || [])) log(`  ${new Date(r.modified).toISOString().slice(0, 10)} | ${r.owner} | ${r.title} | ${r.type} | ${r.url || ''}`);
    } catch (e) { log(`search ${q}: ${e.message}`); }
  }
}

async function robots() {
  log('\n## robots.txt and landing pages');
  for (const [label, origin] of HOSTS) {
    const r = await text(`${origin}/robots.txt`);
    const land = await text(origin);
    const rules = r.status === 200 && !/<html/i.test(r.body)
      ? r.body.split('\n').map((l) => l.trim()).filter((l) => /^(user-agent|disallow|allow|crawl-delay)/i.test(l)).slice(0, 25).join(' ; ')
      : `(no robots.txt: HTTP ${r.status}${r.error ? ` ${r.error}` : ''})`;
    const captcha = /captcha|recaptcha|hcaptcha|cf-challenge|turnstile/i.test(land.body);
    const login = /type=["']?password/i.test(land.body);
    log(`\n### ${label} <${origin}>\n  landing HTTP ${land.status} -> ${land.url}${captcha ? ' [CAPTCHA marker]' : ''}${login ? ' [password field]' : ''}\n  robots: ${rules}`);
  }
}

async function sample(spec, n) {
  if (spec.startsWith('socrata:')) {
    const [domain, id] = spec.slice(8).split('/');
    const rows = await get(`https://${domain}/resource/${id}.json?$limit=${n}&$order=:updated_at DESC`).catch((e) => { log(`  ${e.message}`); return []; });
    log(`\n### sample ${spec}`);
    for (const r of rows) log(`  ${JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !/name|owner|applicant|phone|email|contact|agent/i.test(k)))).slice(0, 1200)}`);
    return;
  }
  const b = await get(`${spec}/query?where=1%3D1&outFields=*&resultRecordCount=${n}&returnGeometry=false&f=json`).catch((e) => { log(`  ${e.message}`); return {}; });
  log(`\n### sample ${spec}`);
  for (const f of (b.features || [])) log(`  ${JSON.stringify(Object.fromEntries(Object.entries(f.attributes).filter(([k]) => !/name|owner|applicant|phone|email|contact|agent/i.test(k)))).slice(0, 1200)}`);
}

const MD_INSP = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/inspectionsData/FeatureServer/0';
const MD_PERMITS = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0';
const RAL_INSP = 'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Inspection_Schedule_Public/FeatureServer/1';
const RAL_PERMITS = [
  'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Building_Permits/FeatureServer/0',
  'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Permits_Other_Than_Buildings/FeatureServer/0',
];
// Only these columns are read: no inspector, supervisor or contact names,
// emails or phones (government staff and private people; rule 5).
const MD_FIELDS = ['ObjectId', 'GlobalID', 'inspector_id', 'date', 'request_date', 'permit_number', 'sequence_number', 'input_order', 'permit_type', 'inspection_description', 'disp_description', 'job_site_address'];
const RAL_FIELDS = ['OBJECTID', 'GlobalID', 'IMInspectionID', 'Scheduled', 'created_date', 'last_edited_date', 'Address', 'InspectionStatus', 'InspectionType', 'IsCompleted', 'LinkNumber', 'LocationGUID'];

async function all(url, fields, idField) {
  const out = [];
  // Page by what the server returned: its maxRecordCount may be below ours.
  for (let offset = 0; offset < 50000;) {
    const b = await get(`${url}/query?where=1%3D1&outFields=${fields.join(',')}&orderByFields=${idField}&resultOffset=${offset}&resultRecordCount=2000&returnGeometry=false&f=json`);
    const rows = (b.features || []).map((f) => f.attributes);
    out.push(...rows);
    offset += rows.length;
    if (!rows.length || (!b.exceededTransferLimit && rows.length < 1000)) break;
  }
  const total = await get(`${url}/query?where=1%3D1&returnCountOnly=true&f=json`).then((b) => b.count).catch(() => null);
  log(`  paged ${out.length} rows; layer count ${total}`);
  return out;
}
const tally = (rows, f, top = 40) => {
  const m = new Map();
  for (const r of rows) { const k = r[f] == null || r[f] === '' ? '(blank)' : String(r[f]).replace(/\s+/g, ' ').trim(); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, n]) => `${n} ${k}`).join(' | ');
};
const day = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 10));
const pick = (xs, n) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(((i * 7919) % 104729) / 104729 * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };

// Precision of the number link: for matched numbers, does the permit's
// address agree with the inspection's (same house number and first street
// word)? Returns [agree, compared, examples of disagreement].
async function addressAgreement(urls, field, addrField, pairs) {
  const norm = (a) => String(a || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 2).join(' ');
  const byNum = new Map();
  for (const url of urls) {
    const nums = pairs.map(([n]) => n).filter((n) => !byNum.has(n));
    for (let i = 0; i < nums.length; i += 50) {
      const list = nums.slice(i, i + 50).map((v) => `'${String(v).replace(/'/g, "''")}'`).join(',');
      const b = await get(`${url}/query?where=${encodeURIComponent(`${field} IN (${list})`)}&outFields=${field},${addrField}&returnGeometry=false&f=json`).catch(() => ({}));
      for (const f of (b.features || [])) byNum.set(String(f.attributes[field]), f.attributes[addrField]);
    }
  }
  let agree = 0; let compared = 0; const bad = [];
  for (const [n, a] of pairs) {
    if (!byNum.has(n)) continue;
    compared += 1;
    if (norm(a) === norm(byNum.get(n))) agree += 1; else if (bad.length < 10) bad.push(`${n}: "${a}" vs "${byNum.get(n)}"`);
  }
  return [agree, compared, bad];
}

async function existIn(urls, field, values, quote) {
  const found = new Set();
  for (const url of urls) {
    for (let i = 0; i < values.length; i += 50) {
      const chunk = values.slice(i, i + 50).filter((v) => !found.has(v));
      if (!chunk.length) continue;
      const list = chunk.map((v) => (quote ? `'${String(v).replace(/'/g, "''")}'` : `'${v}'`)).join(',');
      const b = await get(`${url}/query?where=${encodeURIComponent(`${field} IN (${list})`)}&outFields=${field}&returnGeometry=false&f=json`).catch((e) => { log(`  ${e.message}`); return {}; });
      for (const f of (b.features || [])) found.add(String(f.attributes[field]));
    }
  }
  return found;
}

async function inspections() {
  const md = await all(MD_INSP, MD_FIELDS, 'ObjectId');
  log(`\n## Miami-Dade inspectionsData: ${md.length} rows`);
  const dates = md.map((r) => r.request_date).filter(Boolean).sort();
  log(`  request_date ${day(dates[0])} .. ${day(dates[dates.length - 1])}; date ${day(Math.min(...md.map((r) => r.date || Infinity)))} .. ${day(Math.max(...md.map((r) => r.date || 0)))}`);
  log(`  rows per request_date: ${tally(md.map((r) => ({ d: day(r.request_date) })), 'd', 40)}`);
  log(`  disp_description: ${tally(md, 'disp_description', 60)}`);
  log(`  inspection_description: ${tally(md, 'inspection_description', 60)}`);
  log(`  permit_type: ${tally(md, 'permit_type')}`);
  const keyDup = new Map();
  for (const r of md) { const k = `${r.permit_number}|${r.sequence_number}|${r.request_date}`; keyDup.set(k, (keyDup.get(k) || 0) + 1); }
  for (const cols of [['permit_number', 'sequence_number', 'request_date'], ['permit_number', 'sequence_number', 'request_date', 'inspection_description'],
    ['permit_number', 'sequence_number', 'request_date', 'input_order'], ['permit_number', 'sequence_number', 'request_date', 'inspection_description', 'input_order'],
    ['permit_number', 'sequence_number', 'request_date', 'inspection_description', 'input_order', 'inspector_id'],
    ['permit_number', 'sequence_number', 'request_date', 'input_order', 'inspector_id'],
    ['permit_number', 'sequence_number', 'date', 'request_date', 'inspection_description', 'input_order', 'inspector_id', 'disp_description', 'permit_type', 'job_site_address'], ['GlobalID']]) {
    const seen = new Map();
    for (const r of md) { const k = cols.map((c) => r[c]).join('|'); seen.set(k, (seen.get(k) || 0) + 1); }
    const dups = [...seen.entries()].filter(([, n]) => n > 1);
    log(`  key ${cols.join('+')}: ${seen.size} distinct of ${md.length}; e.g. ${dups.slice(0, 3).map(([k, n]) => `${k} x${n}`).join(' ; ')}`);
  }
  const ex = md.filter((r) => r.permit_number === md[0].permit_number);
  log(`  all rows of one permit (${md[0].permit_number}): ${JSON.stringify(ex.map((r) => [r.sequence_number, r.input_order, day(r.request_date), day(r.date), r.inspection_description, r.disp_description])).slice(0, 1500)}`);
  log(`  permit_number blank ${md.filter((r) => r.permit_number == null).length}; ObjectId range ${Math.min(...md.map((r) => r.ObjectId))}..${Math.max(...md.map((r) => r.ObjectId))}`);
  const mdNums = [...new Set(md.map((r) => r.permit_number).filter((v) => v != null).map(String))];
  const mdSample = pick(mdNums, 300);
  const mdFound = await existIn([MD_PERMITS], 'PermitNumber', mdSample, true);
  log(`  link: ${mdFound.size} of ${mdSample.length} sampled permit numbers (of ${mdNums.length} distinct) exist as PermitNumber in miamidade_permit_data`);
  const byType = new Map();
  for (const n of mdSample) { const t = (md.find((r) => String(r.permit_number) === n) || {}).permit_type; const e = byType.get(t) || [0, 0]; e[0] += 1; if (mdFound.has(n)) e[1] += 1; byType.set(t, e); }
  log(`  link by permit_type (sampled, found): ${[...byType.entries()].map(([t, [a, b]]) => `${t} ${b}/${a}`).join(' | ')}`);
  log(`  unmatched examples: ${mdSample.filter((n) => !mdFound.has(n)).slice(0, 15).join(', ')}`);
  const mdPairs = [...mdFound].slice(0, 150).map((n) => [n, (md.find((r) => String(r.permit_number) === n) || {}).job_site_address]);
  const [mdA, mdC, mdBad] = await addressAgreement([MD_PERMITS], 'PermitNumber', 'PropertyAddress', mdPairs);
  log(`  address agreement (house number + first street word): ${mdA} of ${mdC}; disagreements: ${mdBad.join(' ; ')}`);

  const ral = await all(RAL_INSP, RAL_FIELDS, 'OBJECTID');
  log(`\n## Raleigh Inspection_Schedule_Public/1: ${ral.length} rows`);
  log(`  Scheduled per day: ${tally(ral.map((r) => ({ d: day(r.Scheduled) })), 'd', 20)}`);
  log(`  created_date ${day(Math.min(...ral.map((r) => r.created_date)))} .. ${day(Math.max(...ral.map((r) => r.created_date)))}`);
  log(`  InspectionStatus: ${tally(ral, 'InspectionStatus', 60)}`);
  log(`  IsCompleted: ${tally(ral, 'IsCompleted')}`);
  log(`  InspectionType: ${tally(ral, 'InspectionType', 60)}`);
  log(`  LinkNumber prefix: ${tally(ral.map((r) => ({ p: String(r.LinkNumber || '').replace(/-\d.*$/, '') })), 'p', 40)}`);
  log(`  IMInspectionID distinct ${new Set(ral.map((r) => r.IMInspectionID)).size} of ${ral.length}`);
  const ralNums = [...new Set(ral.map((r) => r.LinkNumber).filter(Boolean))];
  const ralSample = pick(ralNums, 300);
  const ralFound = await existIn(RAL_PERMITS, 'permitnum', ralSample, true);
  log(`  link: ${ralFound.size} of ${ralSample.length} sampled LinkNumbers (of ${ralNums.length} distinct) exist as permitnum in the two Raleigh permit layers`);
  const byPre = new Map();
  for (const n of ralSample) { const p = n.replace(/-\d.*$/, ''); const e = byPre.get(p) || [0, 0]; e[0] += 1; if (ralFound.has(n)) e[1] += 1; byPre.set(p, e); }
  log(`  link by prefix (sampled, found): ${[...byPre.entries()].sort((a, b) => b[1][0] - a[1][0]).map(([t, [a, b]]) => `${t} ${b}/${a}`).join(' | ')}`);
  log(`  unmatched examples: ${ralSample.filter((n) => !ralFound.has(n)).slice(0, 15).join(', ')}`);
  const ralPairs = [...ralFound].slice(0, 150).map((n) => [n, (ral.find((r) => r.LinkNumber === n) || {}).Address]);
  const [rA, rC, rBad] = await addressAgreement(RAL_PERMITS, 'permitnum', 'originaladdress1', ralPairs);
  log(`  address agreement (house number + first street word): ${rA} of ${rC}; disagreements: ${rBad.join(' ; ')}`);
  return { md, ral };
}

// Fixtures in the contract test's shape, read with the connector's own
// columns and filter (src/sources.js), so names are never fetched.
async function fixtures() {
  const fs = require('node:fs');
  const { SOURCES } = require('../src/sources.js');
  fs.mkdirSync('fixture-out', { recursive: true });
  for (const slug of ['miami-dade-inspections-fl', 'raleigh-inspections-nc']) {
    const src = SOURCES[slug];
    const where = encodeURIComponent(src.where || '1=1');
    const b = await get(`${src.layerUrl}/query?where=${where}&outFields=${src.outFields.join(',')}&orderByFields=${src.orderByFields}&resultRecordCount=25&returnGeometry=false&f=json`);
    const rows = b.features.map((f) => f.attributes);
    const fields = (await get(`${src.layerUrl}?f=json`)).fields.map((f) => f.name);
    const body = JSON.stringify({ source: slug, endpoint: src.layerUrl, capturedAt: new Date().toISOString(),
      note: 'Read with the connector outFields and where (src/sources.js); staff and contact names are never requested.',
      declaredFields: fields, rows }, null, 1);
    fs.writeFileSync(`fixture-out/${slug}.json`, body);
    log(`\n## FIXTURE ${slug} (${rows.length} rows)\n${body}\n## END FIXTURE`);
  }
}

async function main() {
  if (want('inspections') && ONLY) await inspections();
  if (want('fixtures') && ONLY) await fixtures();
  if (ONLY && ONLY.every((k) => ['inspections', 'fixtures'].includes(k))) { if (args.pad) for (let i = 0; i < 400; i += 1) log(`PAD ${'.'.repeat(200)}`); return; }

  if (args.specs) {
    const specs = String(args.specs).split(',').map((x) => x.trim()).filter(Boolean);
    for (const s of specs) {
      if (args.sample) await sample(s, Number(args.sample) || 5);
      else await measure(s);
    }
  } else {
    if (want('orgs')) await orgs();
    if (want('socrata')) await socrata();
    if (want('search')) await search();
    if (want('robots')) await robots();
  }
  if (args.pad) for (let i = 0; i < 400; i += 1) log(`PAD ${'.'.repeat(200)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
