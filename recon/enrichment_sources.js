// Enrichment-source recon (docs/DATA_SOURCES.md, "Enrichment sources").
//
// Verifies, live, the sources we plan to join to permits: Texas TDLR licences,
// Texas TSBPE plumbing licences, Florida DBPR construction and electrical
// licences, the Travis Central Appraisal District (TCAD) export, the
// Miami-Dade Property Appraiser layer, the US Census batch geocoder, and
// whether the Austin and Miami-Dade permit sources already carry coordinates.
//
// Read-only and polite (<= 2 requests/second). No dependencies beyond Node 20
// built-ins; the TCAD section shells out to `unzip` (present on GitHub
// runners). It prints field names, counts, fill rates, code values and ID
// *shapes* (letters -> A, digits -> 9) only: never a name, phone or address.
//   node recon/enrichment_sources.js [--only=tdlr,tsbpe,dbpr,tcad,mdpa,wake,census,coords]
// CI runs it via .github/workflows/feasibility.yml with only=enrichment.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const UA = 'permit-leads-recon/0.1 (research; read-only)';
const AUSTIN = 'https://data.austintexas.gov/resource/3syk-w9eu.json';
const AUSTIN_META = 'https://data.austintexas.gov/api/views/3syk-w9eu.json';
const TDLR = 'https://data.texas.gov/resource/7358-krk7.json';
const TDLR_META = 'https://data.texas.gov/api/views/7358-krk7.json';
const MIAMI = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0';
const MDPA = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/PaGISView_gdb/FeatureServer';
const DBPR = {
  construction: 'https://www2.myfloridalicense.com/sto/file_download/extracts//CONSTRUCTIONLICENSE_1.csv',
  electrical: 'https://www2.myfloridalicense.com/sto/file_download/extracts/lic08el.csv',
};
const TSBPE = {
  RMP: 'https://tsbpe.texas.gov/download-csv/RMP/',
  MP: 'https://tsbpe.texas.gov/download-csv/MP/',
};
const TCAD = {
  layout: 'https://traviscad.org/wp-content/largefiles/Website_Legacy8.0.33-AppraisalExportLayout_06182026.zip',
  certified: 'https://traviscad.org/wp-content/largefiles/2026%20Certified%20Appraisal%20Export%20Supp%200_07182026.zip',
  certifiedJson: 'https://traviscad.org/wp-content/largefiles/2026%20Certified%20JSON%20SUPP%200%2007182026.zip',
  supplemental: 'https://traviscad.org/wp-content/largefiles/travis_SUPP%20336_2026_WEBSITE%20EXPORT_Renamed.zip',
  supplementalJson: 'https://traviscad.org/wp-content/largefiles/2026%20Special%20export%20Supp%204%2011062026.zip',
};
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';

// ---------- pure helpers (tested in enrichment_sources.test.js) ----------

// Shape of an identifier: letters -> A, digits -> 9. Safe to print for IDs.
const shape = (v) => String(v ?? '').trim().replace(/[A-Za-z]/g, 'A').replace(/[0-9]/g, '9');
const digits = (p) => String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const normCo = (s) => String(s || '').toLowerCase().replace(/\b(llc|inc|co|corp|ltd|lp|company|the)\b/g, '').replace(/[^a-z0-9]/g, '');
const filled = (v) => v !== null && v !== undefined && String(v).trim() !== '';

// One line of quote/comma-delimited CSV (DBPR, TSBPE). No embedded newlines.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// Column profile: fill rate, distinct count, and (only for code-like columns
// with few distinct values, or when asked) top values; shapes for ID columns.
function profile() {
  const cols = [];
  return {
    add(row) {
      row.forEach((v, i) => {
        const c = cols[i] || (cols[i] = { filled: 0, values: new Map(), shapes: new Map() });
        if (!filled(v)) return;
        c.filled += 1;
        const t = String(v).trim();
        if (c.values.size < 200 || c.values.has(t)) c.values.set(t, (c.values.get(t) || 0) + 1);
        else c.overflow = true;
        const s = shape(t);
        c.shapes.set(s, (c.shapes.get(s) || 0) + 1);
      });
    },
    report(n, { names = [], show = [], shapes = [] } = {}) {
      return cols.map((c, i) => {
        const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(' ');
        const r = { col: i, name: names[i] || `#${i + 1}`, fillPct: pct(c.filled, n), distinct: c.overflow ? '200+' : c.values.size };
        if (show.includes(i)) r.top = top(c.values);
        if (shapes.includes(i)) r.shapes = top(c.shapes);
        return r;
      });
    },
  };
}

// Licence key: uppercase letter prefix + the number without leading zeros, so
// 'CGC061097' and 'CGC61097' meet. Returns '' when there is no number.
function licKey(v) {
  const m = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/^([A-Z]*)0*(\d+)$/);
  return m ? `${m[1]}${m[2]}` : '';
}

// Rows of one worksheet XML, resolving shared strings. Enough for a layout sheet.
function xlsxRows(sheetXml, sharedXml = '') {
  const unx = (t) => t.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unx(m[1]));
  return [...sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => [...row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
    const v = (c[2] || '').match(/<v>([\s\S]*?)<\/v>/);
    const inline = (c[2] || '').match(/<is>([\s\S]*?)<\/is>/);
    if (/t="s"/.test(c[1]) && v) return shared[Number(v[1])] ?? '';
    if (inline) return unx(inline[1]);
    return v ? unx(v[1]) : '';
  }));
}

// Fixed-width slice using 1-based inclusive positions from the TCAD layout.
const fixed = (line, start, end) => line.slice(start - 1, end).trim();

// ---------- network ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;
async function http(url, { attempts = 4, method = 'GET', body, json = true } = {}) {
  for (let i = 1; ; i += 1) {
    const wait = 500 - (Date.now() - lastRequest);
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    try {
      const res = await fetch(url, { method, body, headers: { 'User-Agent': UA } });
      if (method === 'HEAD') return res;
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      if (!json) return text;
      const out = JSON.parse(text);
      if (out && out.error) throw new Error(`API error: ${JSON.stringify(out.error).slice(0, 200)}`);
      return out;
    } catch (err) {
      if (i >= attempts) throw new Error(`${err.message} <- ${url.slice(0, 160)}`);
      await sleep(2000 * 2 ** (i - 1));
    }
  }
}
const soql = (base, params, opts) => http(`${base}?${new URLSearchParams(params)}`, opts);
const arcgis = (layer, params) => http(`${layer}/query?${new URLSearchParams({ f: 'json', ...params })}`);

async function download(url, file) {
  const t0 = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} <- ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  const size = fs.statSync(file).size;
  console.log(`  downloaded ${(size / 1e6).toFixed(1)} MB in ${Math.round((Date.now() - t0) / 1000)} s; last-modified ${res.headers.get('last-modified')}`);
  return size;
}
async function eachLine(stream, fn) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) fn(line);
}

const log = (label, v) => console.log(`  ${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const table = (rows) => rows.forEach((r) => console.log(`    ${JSON.stringify(r)}`));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-'));

// Austin permit phones and parcels in the last 90 days (kept in memory only).
let austinCache;
async function austinRecent() {
  if (austinCache) return austinCache;
  const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const rows = [];
  for (let offset = 0; ; offset += 50000) {
    const page = await soql(AUSTIN, {
      $select: 'permittype,contractor_phone,contractor_company_name,tcad_id,original_address1,original_city,original_zip',
      $where: `issue_date >= '${since}'`, $order: ':id', $limit: 50000, $offset: offset,
    });
    rows.push(...page);
    if (page.length < 50000) break;
  }
  austinCache = rows;
  return rows;
}

// ---------- sections ----------
const sections = {};

sections.coords = async () => {
  const meta = await http(AUSTIN_META);
  const cols = meta.columns.map((c) => `${c.fieldName}:${c.dataTypeName}`);
  const geo = meta.columns.filter((c) => /lat|lon|location|coord|point|x_|y_|geocod/i.test(c.fieldName) || /point|location/i.test(c.dataTypeName));
  log('Austin columns', cols.length);
  log('Austin geo-like columns', geo.map((c) => `${c.fieldName}:${c.dataTypeName}`));
  log('Austin licence-like columns', meta.columns.filter((c) => /licen/i.test(c.fieldName)).map((c) => c.fieldName));
  const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  for (const [label, where] of [['all rows', '1=1'], ['issued last 90 days', `issue_date >= '${since}'`]]) {
    const [{ n }] = await soql(AUSTIN, { $select: 'count(*) as n', $where: where });
    const out = { n };
    for (const c of geo.filter((g) => /^(latitude|longitude|location)$/.test(g.fieldName))) {
      try {
        const [r] = await soql(AUSTIN, { $select: 'count(*) as n', $where: `(${where}) AND ${c.fieldName} IS NOT NULL` }, { attempts: 2 });
        out[c.fieldName] = `${pct(Number(r.n), Number(n))}%`;
      } catch (err) { out[c.fieldName] = `error ${err.message.slice(0, 60)}`; }
    }
    log(`Austin fill, ${label}`, out);
    if (label !== 'all rows') {
      const [bb] = await soql(AUSTIN, { $select: 'min(latitude) as a, max(latitude) as b, min(longitude) as c, max(longitude) as d', $where: `(${where}) AND latitude IS NOT NULL` });
      log('Austin lat/long range, last 90 days', bb);
      const byType = await soql(AUSTIN, { $select: 'permittype, count(*) as n, count(latitude) as lat', $where: where, $group: 'permittype', $order: 'n DESC', $limit: 10 });
      log('Austin latitude fill by permittype, last 90 days', byType.map((r) => `${r.permittype}:${pct(Number(r.lat), Number(r.n))}% of ${r.n}`));
    }
  }
  // tcad_id fill and shape
  const [t] = await soql(AUSTIN, { $select: 'count(*) as n, count(tcad_id) as t', $where: `issue_date >= '${since}'` });
  log('Austin tcad_id fill, last 90 days', `${pct(Number(t.t), Number(t.n))}%`);
  const rows = await austinRecent();
  const p = profile();
  rows.forEach((r) => p.add([r.tcad_id]));
  log('Austin tcad_id shapes', p.report(rows.length, { shapes: [0] })[0].shapes);

  const layer = await http(`${MIAMI}?f=json`);
  log('Miami permit layer type / geometryType', `${layer.type} / ${layer.geometryType || 'none'}`);
  log('Miami geo-like fields', (layer.fields || []).filter((f) => /lat|lon|x_?coord|y_?coord|point|shape/i.test(f.name)).map((f) => `${f.name}:${f.type}`));
  if (layer.geometryType) {
    const g = await arcgis(MIAMI, { where: '1=1', outFields: 'ObjectId', returnGeometry: true, resultRecordCount: 200 });
    log('Miami sample rows with geometry', `${g.features.filter((f) => f.geometry).length}/${g.features.length}`);
  }
};

sections.tdlr = async () => {
  const meta = await http(TDLR_META);
  log('rowsUpdatedAt', new Date(meta.rowsUpdatedAt * 1000).toISOString());
  log('columns', meta.columns.map((c) => c.fieldName).filter((f) => !f.startsWith(':')));
  const [tot] = await soql(TDLR, { $select: 'count(*) as n' });
  log('rows', tot.n);
  const byType = await soql(TDLR, {
    $select: 'license_type, count(*) as n, count(business_telephone) as phone, count(business_name) as biz, count(business_address_line1) as addr',
    $group: 'license_type', $order: 'n DESC', $limit: 500,
  });
  log('licence types', byType.length);
  log('rows whose license_type is report boilerplate (not a licence)', byType.filter((r) => /salesforce|confidential|generated by|^CGI|Public Information Act/i.test(r.license_type)).map((r) => Number(r.n)).reduce((a, b) => a + b, 0));
  table(byType.map((r) => ({ type: r.license_type, n: Number(r.n), phonePct: pct(Number(r.phone), Number(r.n)), bizPct: pct(Number(r.biz), Number(r.n)), addrPct: pct(Number(r.addr), Number(r.n)) })));
  const trades = byType.filter((r) => /electric|a\/c|air cond|mechanic/i.test(r.license_type)).map((r) => r.license_type);
  for (const type of trades) {
    const w = `license_type = '${type.replace(/'/g, "''")}'`;
    const subs = await soql(TDLR, { $select: 'license_subtype, count(*) as n, count(business_telephone) as phone', $where: w, $group: 'license_subtype', $order: 'n DESC', $limit: 20 });
    const [same] = await soql(TDLR, { $select: 'count(*) as n', $where: `${w} AND business_name = owner_name` });
    const [phoneSame] = await soql(TDLR, { $select: 'count(*) as n', $where: `${w} AND business_telephone = owner_telephone` });
    const sample = await soql(TDLR, { $select: 'license_number, license_expiration_date_mmddccyy', $where: w, $limit: 2000 });
    const p = profile();
    sample.forEach((r) => p.add([r.license_number, r.license_expiration_date_mmddccyy]));
    const [num, exp] = p.report(sample.length, { shapes: [0, 1] });
    console.log(`  -- ${type}`);
    log('subtypes', subs.map((s) => `${s.license_subtype}:${s.n} (phone ${pct(Number(s.phone), Number(s.n))}%)`));
    log('business_name = owner_name rows', same.n);
    log('business_telephone = owner_telephone rows', phoneSame.n);
    log('license_number shapes', num.shapes);
    log('expiry shapes', exp.shapes);
    if (/contractor$/i.test(type)) {
      const bizRe = /\b(LLC|L\.L\.C|INC|CORP|CORPORATION|CO|COMPANY|LTD|LP|LLP|PLLC|SERVICES?|ELECTRIC(AL)?|AIR|HEATING|COOLING|MECHANICAL|HVAC|ENTERPRISES?|GROUP|SOLUTIONS)\b/i;
      const rows = [];
      for (let offset = 0; ; offset += 50000) {
        const page = await soql(TDLR, { $select: 'business_name, owner_name', $where: w, $order: ':id', $limit: 50000, $offset: offset });
        rows.push(...page);
        if (page.length < 50000) break;
      }
      log('business_name / owner_name looks like a business (suffix or trade word)', `${pct(rows.filter((r) => bizRe.test(r.business_name || '')).length, rows.length)}% / ${pct(rows.filter((r) => bizRe.test(r.owner_name || '')).length, rows.length)}%`);
    }
  }
  // Join test: Austin trade-permit contractor phones found in TDLR business phones.
  if (trades.length) {
    const phones = new Set();
    const names = new Set();
    const norm = (s) => String(s || '').toLowerCase().replace(/\b(llc|inc|co|corp|ltd|lp|company|the)\b/g, '').replace(/[^a-z0-9]/g, '');
    for (const type of trades) {
      for (let offset = 0; ; offset += 50000) {
        const page = await soql(TDLR, { $select: 'business_telephone, business_name', $where: `license_type = '${type.replace(/'/g, "''")}'`, $order: ':id', $limit: 50000, $offset: offset });
        page.forEach((r) => { if (digits(r.business_telephone).length === 10) phones.add(digits(r.business_telephone)); if (norm(r.business_name)) names.add(norm(r.business_name)); });
        if (page.length < 50000) break;
      }
    }
    const rows = await austinRecent();
    for (const code of ['EP', 'MP']) {
      const t = rows.filter((r) => r.permittype === code);
      const withPhone = t.filter((r) => digits(r.contractor_phone).length === 10);
      const companies = [...new Set(t.map((r) => norm(r.contractor_company_name)).filter(Boolean))];
      log(`Austin ${code} last 90 d: phone found in TDLR trade business phones`, `${pct(withPhone.filter((r) => phones.has(digits(r.contractor_phone))).length, withPhone.length)}% of ${withPhone.length}`);
      log(`Austin ${code} last 90 d: distinct companies whose normalized name is a TDLR business_name`, `${pct(companies.filter((c) => names.has(c)).length, companies.length)}% of ${companies.length}`);
    }
  }
};

async function csvProfile(label, url, opts = {}) {
  const file = path.join(tmp, `${label}.csv`);
  await download(url, file);
  const p = profile();
  let n = 0;
  let header = null;
  const widths = new Map();
  const ids = [];
  await eachLine(fs.createReadStream(file, 'latin1'), (line) => {
    if (!line.trim()) return;
    const row = parseCsvLine(line);
    if (n === 0 && opts.header) { header = row.map((h) => h.trim()); n = -1; }
    if (n >= 0) { p.add(row); widths.set(row.length, (widths.get(row.length) || 0) + 1); if (opts.idCols) ids.push(opts.idCols.map((c) => String(row[c] || '').trim().toUpperCase()).concat(String(row[1] || '').trim())); }
    n += 1;
  });
  log('rows', n);
  if (header) log('header', header);
  log('columns per row', Object.fromEntries(widths));
  table(p.report(n, { names: header || opts.names, show: opts.show || [], shapes: opts.shapes || [] }));
  return { n, ids, header };
}

sections.dbpr = async () => {
  const names = ['board', 'occupation_code', 'licensee_name', 'dba_name', 'class_code', 'addr1', 'addr2', 'addr3', 'city', 'state', 'zip', 'county_code', 'license_number', 'primary_status', 'secondary_status', 'original_date', 'effective_date', 'expiration_date', 'blank', 'renewal_period', 'alternate_lic'];
  const all = new Set();
  const allNorm = new Set();
  const occOf = new Map();
  for (const [label, url] of Object.entries(DBPR)) {
    console.log(`  -- DBPR ${label}`);
    const { ids } = await csvProfile(`dbpr-${label}`, url, { names, idCols: [12, 20], show: [0, 1, 4, 9, 13, 14, 19], shapes: [12, 15, 17, 20] });
    for (const [num, alt, occ] of ids) {
      if (num) { all.add(num); occOf.set(num, occ); }
      if (alt) { all.add(alt); allNorm.add(licKey(alt)); occOf.set(licKey(alt), occ); }
    }
  }
  // Join test: Miami-Dade permit ContractorNumber against DBPR licence numbers.
  const since = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
  const nums = [];
  for (let off = 0; off < 10000; off += 1000) {
    const page = await arcgis(MIAMI, { where: `PermitIssuedDate >= TIMESTAMP '${since} 00:00:00'`, outFields: 'ContractorNumber', orderByFields: 'ObjectId', resultOffset: off, resultRecordCount: 1000, returnGeometry: false });
    nums.push(...page.features.map((f) => String(f.attributes.ContractorNumber || '').trim().toUpperCase()));
    if (page.features.length < 1000) break;
  }
  const p = profile();
  nums.forEach((x) => p.add([x]));
  log('Miami ContractorNumber shapes (last 180 d sample)', p.report(nums.length, { shapes: [0] })[0].shapes);
  const present = nums.filter(Boolean);
  const distinct = [...new Set(present)];
  log('Miami sample permits / with ContractorNumber / distinct', `${nums.length} / ${present.length} / ${distinct.length}`);
  log('distinct ContractorNumber exactly in DBPR construction+electrical', `${pct(distinct.filter((x) => all.has(x)).length, distinct.length)}%`);
  log('permits whose ContractorNumber is in DBPR', `${pct(present.filter((x) => all.has(x)).length, present.length)}%`);
  log('distinct ContractorNumber in DBPR alternate_lic after prefix+number normalization', `${pct(distinct.filter((x) => allNorm.has(licKey(x))).length, distinct.length)}%`);
  log('permits matched after normalization', `${pct(present.filter((x) => allNorm.has(licKey(x))).length, present.length)}%`);
  const byShape = new Map();
  for (const x of present) {
    const k = shape(x).replace(/9+$/, '9+');
    const e = byShape.get(k) || { n: 0, hit: 0 };
    e.n += 1; if (allNorm.has(licKey(x))) e.hit += 1;
    byShape.set(k, e);
  }
  log('match by ContractorNumber shape', [...byShape.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([k, e]) => `${k}:${pct(e.hit, e.n)}% of ${e.n}`));
  const byOcc = new Map();
  present.filter((x) => allNorm.has(licKey(x))).forEach((x) => { const o = occOf.get(licKey(x)); byOcc.set(o, (byOcc.get(o) || 0) + 1); });
  log('matched permits by DBPR occupation code', [...byOcc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}:${v}`));
};

sections.tsbpe = async () => {
  for (const [label, url] of Object.entries(TSBPE)) {
    console.log(`  -- TSBPE ${label}`);
    const head = (await http(url, { json: false })).split(/\r?\n/, 1)[0];
    const header = parseCsvLine(head).map((h) => h.trim());
    const idCol = header.findIndex((h) => /licen[sc]e.*(num|no|#)|^lic/i.test(h));
    const phoneCol = header.findIndex((h) => /phone/i.test(h));
    const show = header.map((h, i) => (/type|status|endorse|county|state|class/i.test(h) ? i : -1)).filter((i) => i >= 0);
    const shapes = header.map((h, i) => (/num|no\b|#|date|expir|phone|zip/i.test(h) ? i : -1)).filter((i) => i >= 0);
    const file = path.join(tmp, `tsbpe-${label}.csv`);
    await download(url, file);
    const p = profile();
    let n = -1;
    const phones = new Set();
    const companies = new Set();
    const coCol = header.findIndex((h) => /COMPANY/i.test(h) && !/INSURANCE/i.test(h));
    await eachLine(fs.createReadStream(file, 'latin1'), (line) => {
      if (!line.trim()) return;
      n += 1;
      if (n === 0) return;
      const row = parseCsvLine(line);
      p.add(row);
      if (phoneCol >= 0 && digits(row[phoneCol]).length === 10) phones.add(digits(row[phoneCol]));
      if (coCol >= 0 && normCo(row[coCol])) companies.add(normCo(row[coCol]));
    });
    log('rows', n);
    log('header', header);
    log('licence-number column / phone column', `${header[idCol] ?? 'none'} / ${header[phoneCol] ?? 'none'}`);
    table(p.report(n, { names: header, show, shapes }));
    if (phones.size) {
      const pp = (await austinRecent()).filter((r) => r.permittype === 'PP' && digits(r.contractor_phone).length === 10);
      log(`Austin PP last 90 d: phone found in TSBPE ${label}`, `${pct(pp.filter((r) => phones.has(digits(r.contractor_phone))).length, pp.length)}% of ${pp.length}`);
    }
    if (companies.size) {
      const all = (await austinRecent()).filter((r) => r.permittype === 'PP');
      const names = [...new Set(all.map((r) => normCo(r.contractor_company_name)).filter(Boolean))];
      log(`Austin PP last 90 d: distinct companies whose normalized name is a TSBPE ${label} company`, `${pct(names.filter((c) => companies.has(c)).length, names.length)}% of ${names.length}`);
      log(`TSBPE ${label} distinct companies`, companies.size);
    }
  }
};

sections.tcad = async () => {
  for (const [label, url] of Object.entries(TCAD)) {
    const res = await http(url, { method: 'HEAD' });
    log(`HEAD ${label}`, `${res.status} ${(Number(res.headers.get('content-length')) / 1e6).toFixed(1)} MB, last-modified ${res.headers.get('last-modified')}`);
  }
  const lay = path.join(tmp, 'layout.zip');
  await download(TCAD.layout, lay);
  console.log(execFileSync('unzip', ['-l', lay]).toString().split('\n').slice(0, 30).map((l) => `    ${l}`).join('\n'));
  try {
    const xname = execFileSync('unzip', ['-Z1', lay]).toString().split('\n').find((n) => /\.xlsx$/i.test(n));
    const xfile = path.join(tmp, 'layout.xlsx');
    fs.writeFileSync(xfile, execFileSync('unzip', ['-p', lay, xname], { maxBuffer: 64e6 }));
    const parts = execFileSync('unzip', ['-Z1', xfile]).toString().split('\n').filter(Boolean);
    const read = (n) => execFileSync('unzip', ['-p', xfile, n], { maxBuffer: 64e6 }).toString('utf8');
    const strings = parts.includes('xl/sharedStrings.xml') ? read('xl/sharedStrings.xml') : '';
    const sheetNames = [...read('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => m[1]);
    log('layout sheets', sheetNames);
    const want = /^(prop_id|prop_type_cd|prop_val_yr|geo_id|py_owner_name|py_owner_id|.*confidential.*|situs_street|situs_num|situs_city|situs_zip|legal_desc|appraised_val|assessed_val|market_value|imprv_state_cd|land_state_cd|imprv_det_type_cd|imprv_det_type_desc|yr_built|imprv_det_area|imprv_det_area_type|imprv_det_class_cd|imprv_id|imprv_det_id|.*living.*|.*deed.*)$/i;
    parts.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/))).forEach((n, i) => {
      const rows = xlsxRows(read(n), strings);
      const hits = rows.filter((r) => r.some((c) => want.test(String(c).trim())));
      if (hits.length) {
        console.log(`  layout sheet ${sheetNames[i] || n}: header ${JSON.stringify(rows.find((r) => r.some((c) => /start/i.test(c))) || rows[0])}`);
        hits.slice(0, 40).forEach((r) => console.log(`    ${r.join(' | ').slice(0, 200)}`));
      }
    });
  } catch (err) { log('layout xlsx', `unreadable: ${err.message.slice(0, 120)}`); }
  const zip = path.join(tmp, 'tcad.zip');
  await download(TCAD.supplemental, zip);
  const listing = execFileSync('unzip', ['-l', zip]).toString();
  console.log(listing.split('\n').slice(0, 40).map((l) => `    ${l}`).join('\n'));
  const entry = (re) => (listing.split('\n').map((l) => l.trim().split(/\s+/).slice(3).join(' ')).find((n) => re.test(n)));
  const austinIds = new Set((await austinRecent()).map((r) => String(r.tcad_id || '').trim()).filter(Boolean));
  const ap = profile();
  austinIds.forEach((x) => ap.add([x]));
  log('Austin tcad_id shapes (distinct, last 90 d)', ap.report(austinIds.size, { shapes: [0] })[0].shapes);
  const letterIds = new Map([...austinIds].filter((x) => /^[A-Z]\d+$/i.test(x)).map((x) => [x.slice(1).replace(/^0+/, ''), x]));
  const letterHits = new Set();
  const geoShapes = new Map();
  const unmatchedShapes = new Map();
  const propName = entry(/PROP\.TXT$|APPRAISAL_INFO\.TXT$/i);
  if (!propName) { log('PROP file', 'not found in zip'); return; }
  const lengths = new Map();
  const counts = { n: 0, idNumeric: 0, year: new Map(), type: new Map(), imprvState: new Map(), landState: new Map(), geo: 0, owner: 0, confidential: 0, market: 0, appraised: 0, situs: 0, legal: 0 };
  const props = new Set();
  const geos = new Set();
  await eachLine(spawn('unzip', ['-p', zip, propName]).stdout.setEncoding('latin1'), (line) => {
    if (!line) return;
    counts.n += 1;
    lengths.set(line.length, (lengths.get(line.length) || 0) + 1);
    const id = fixed(line, 1, 12);
    if (/^\d+$/.test(id)) counts.idNumeric += 1;
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    bump(counts.year, fixed(line, 18, 22));
    bump(counts.type, fixed(line, 13, 17));
    bump(counts.imprvState, fixed(line, 2732, 2741));
    bump(counts.landState, fixed(line, 2742, 2751));
    const geo = fixed(line, 547, 596);
    if (geo) { counts.geo += 1; const gs = shape(geo); if (geoShapes.size < 50 || geoShapes.has(gs)) geoShapes.set(gs, (geoShapes.get(gs) || 0) + 1); }
    if (fixed(line, 609, 678)) counts.owner += 1;
    if (fixed(line, 990, 990) === 'T') counts.confidential += 1;
    if (Number(fixed(line, 4214, 4227)) > 0) counts.market += 1;
    if (Number(fixed(line, 1916, 1930)) > 0) counts.appraised += 1;
    if (fixed(line, 1050, 1099)) counts.situs += 1;
    if (fixed(line, 1150, 1404)) counts.legal += 1;
    const bare = id.replace(/^0+/, '');
    if (austinIds.has(bare)) props.add(bare);
    if (letterIds.has(bare)) letterHits.add(letterIds.get(bare));
    if (austinIds.has(geo)) geos.add(geo);
  });
  const top = (m, k = 12) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([a, b]) => `${a || '(blank)'}:${b}`).join(' ');
  log('PROP file', propName);
  log('rows', counts.n);
  log('record lengths', top(lengths, 5));
  log('prop_id numeric', `${pct(counts.idNumeric, counts.n)}%`);
  log('prop_val_yr', top(counts.year, 5));
  log('prop_type_cd', top(counts.type, 8));
  log('imprv_state_cd', top(counts.imprvState, 15));
  log('land_state_cd', top(counts.landState, 15));
  log('fill %', { geo_id: pct(counts.geo, counts.n), py_owner_name: pct(counts.owner, counts.n), market_value: pct(counts.market, counts.n), appraised_val: pct(counts.appraised, counts.n), situs_street: pct(counts.situs, counts.n), legal_desc: pct(counts.legal, counts.n) });
  log('Austin tcad_id (last 90 d) distinct', austinIds.size);
  log('... matching prop_id / geo_id', `${pct(props.size, austinIds.size)}% / ${pct(geos.size, austinIds.size)}%`);
  log('letter+digits Austin ids whose digits are a prop_id', `${letterHits.size}/${letterIds.size}`);
  const anyHit = [...austinIds].filter((x) => geos.has(x) || props.has(x) || letterHits.has(x)).length;
  log('Austin tcad_id matched by geo_id, prop_id or letter+prop_id', `${pct(anyHit, austinIds.size)}%`);
  log('py_confidential_flag = T', `${counts.confidential} (${pct(counts.confidential, counts.n)}%)`);
  log('geo_id shapes', top(geoShapes, 6));
  [...austinIds].filter((x) => !geos.has(x)).forEach((x) => unmatchedShapes.set(shape(x), (unmatchedShapes.get(shape(x)) || 0) + 1));
  log('unmatched Austin tcad_id shapes', top(unmatchedShapes, 6));

  const detName = entry(/IMP_DET\.TXT$|IMPROVEMENT_DETAIL\.TXT$/i);
  if (detName) {
    const d = { n: 0, yr: 0, area: 0, type: new Map(), desc: new Map(), props: new Set(), yrProps: new Set(), lens: new Map(), years: [] };
    await eachLine(spawn('unzip', ['-p', zip, detName]).stdout.setEncoding('latin1'), (line) => {
      if (!line) return;
      d.n += 1;
      const t = fixed(line, 41, 50);
      d.type.set(t, (d.type.get(t) || 0) + 1);
      if (!d.desc.has(t)) d.desc.set(t, fixed(line, 51, 75));
      d.lens.set(line.length, (d.lens.get(line.length) || 0) + 1);
      if (d.n % 97 === 0 && Number(fixed(line, 86, 89)) > 0) d.years.push(Number(fixed(line, 86, 89)));
      const id = fixed(line, 1, 12);
      d.props.add(id);
      if (Number(fixed(line, 86, 89)) > 1800) { d.yr += 1; d.yrProps.add(id); }
      if (Number(fixed(line, 94, 108)) > 0) d.area += 1;
    });
    log('IMP_DET rows / properties with any detail / with a year built', `${d.n} / ${d.props.size} / ${d.yrProps.size}`);
    log('IMP_DET fill %', { yr_built: pct(d.yr, d.n), imprv_det_area: pct(d.area, d.n) });
    log('imprv_det_type_cd top (code=desc:n)', [...d.type.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k}=${d.desc.get(k)}:${v}`));
    log('IMP_DET record lengths', top(d.lens, 3));
    d.years.sort((a, b) => a - b);
    log('yr_built sample p5/p50/p95', `${d.years[Math.floor(d.years.length * 0.05)]}/${d.years[Math.floor(d.years.length / 2)]}/${d.years[Math.floor(d.years.length * 0.95)]}`);
  }

  // Land detail (lot size). Numbers only: this file holds no names. Positions
  // from the layout (tcadLayout, run 43622711795): prop_id 1-12, land_type_cd
  // 29-38, state_cd 64-68, size_acres 70-83 ("4 decimals"), size_square_feet 84-97.
  const landName = entry(/LAND_DET\.TXT$|LAND_DETAIL\.TXT$/i);
  log('land detail file', landName || 'not found');
  if (landName) {
    const l = { n: 0, props: new Set(), sqft: 0, acres: 0, both: 0, lens: new Map(), type: new Map(), state: new Map(), raw: [], ratios: [] };
    await eachLine(spawn('unzip', ['-p', zip, landName]).stdout.setEncoding('latin1'), (line) => {
      if (!line) return;
      l.n += 1;
      l.props.add(fixed(line, 1, 12));
      l.lens.set(line.length, (l.lens.get(line.length) || 0) + 1);
      const t = fixed(line, 29, 38); l.type.set(t, (l.type.get(t) || 0) + 1);
      const st = fixed(line, 64, 68); l.state.set(st, (l.state.get(st) || 0) + 1);
      const ac = fixed(line, 70, 83); const sf = fixed(line, 84, 97);
      if (Number(sf) > 0) l.sqft += 1;
      if (Number(ac) > 0) l.acres += 1;
      if (Number(sf) > 0 && Number(ac) > 0) { l.both += 1; if (l.both % 101 === 0) l.ratios.push(Number(sf) / Number(ac)); }
      if (l.n % 50021 === 0 && l.raw.length < 12) l.raw.push(`acres=[${ac}] sqft=[${sf}]`);
    });
    log('LAND_DET rows / properties', `${l.n} / ${l.props.size}`);
    log('LAND_DET fill %', { size_square_feet: pct(l.sqft, l.n), size_acres: pct(l.acres, l.n), both: pct(l.both, l.n) });
    log('LAND_DET record lengths', top(l.lens, 3));
    log('land_type_cd top', top(l.type, 10));
    log('state_cd top', top(l.state, 15));
    log('raw number formats (sample)', l.raw);
    l.ratios.sort((a, b) => a - b);
    log('sqft / acres p5/p50/p95 (43560 if both are plain units)', `${l.ratios[Math.floor(l.ratios.length * 0.05)]}/${l.ratios[Math.floor(l.ratios.length / 2)]}/${l.ratios[Math.floor(l.ratios.length * 0.95)]}`);
  }
};

// Every field of the sheets a TCAD loader reads (names and positions only, no
// data), so the loader is written against the published layout.
sections.tcadLayout = async () => {
  const lay = path.join(tmp, 'layout.zip');
  await download(TCAD.layout, lay);
  const xname = execFileSync('unzip', ['-Z1', lay]).toString().split('\n').find((n) => /\.xlsx$/i.test(n));
  const xfile = path.join(tmp, 'layout.xlsx');
  fs.writeFileSync(xfile, execFileSync('unzip', ['-p', lay, xname], { maxBuffer: 64e6 }));
  const parts = execFileSync('unzip', ['-Z1', xfile]).toString().split('\n').filter(Boolean);
  const read = (n) => execFileSync('unzip', ['-p', xfile, n], { maxBuffer: 64e6 }).toString('utf8');
  const strings = parts.includes('xl/sharedStrings.xml') ? read('xl/sharedStrings.xml') : '';
  const sheetNames = [...read('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => m[1]);
  const sheets = parts.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/)));
  sheets.forEach((n, i) => {
    if (!['Header', 'Property', 'Improvement', 'ImprovementDetail', 'LandDetail'].includes(sheetNames[i])) return;
    console.log(`  == ${sheetNames[i]}`);
    xlsxRows(read(n), strings).forEach((r) => {
      if (r[0] && /^\d+$/.test(String(r[2]).trim())) console.log(`    ${String(r[0]).trim()} ${r[1]} ${r[2]}-${r[3]} :: ${String(r[5] || '').replace(/\s+/g, ' ').slice(0, 90)}`);
    });
  });
};

sections.mdpa = async () => {
  const svc = await http(`${MDPA}?f=json`);
  log('layers', (svc.layers || []).map((l) => `${l.id}:${l.name}`));
  log('service copyright / description', `${(svc.copyrightText || '').slice(0, 200)} | ${(svc.serviceDescription || '').slice(0, 200)}`);
  const layer = await http(`${MDPA}/0?f=json`);
  log('layer', `${layer.name} ${layer.type} ${layer.geometryType} maxRecordCount=${layer.maxRecordCount}`);
  log('lastEditDate', layer.editingInfo && new Date(layer.editingInfo.lastEditDate || layer.editingInfo.dataLastEditDate).toISOString());
  log('fields', layer.fields.map((f) => `${f.name}:${f.type.replace('esriFieldType', '')}`));
  const count = await arcgis(`${MDPA}/0`, { where: '1=1', returnCountOnly: true });
  log('rows', count.count);
  const want = layer.fields.filter((f) => /FOLIO|DOR|YEAR|BUILT|AREA|SQ|VAL|BED|BATH|UNIT|STOR|FLOOR|LOT|OWNER|LAND|USE|ZONE|ZIP/i.test(f.name));
  const fills = {};
  for (const f of want) {
    const str = /String/.test(f.type);
    const w = str ? `${f.name} IS NOT NULL AND ${f.name} <> ''` : `${f.name} IS NOT NULL AND ${f.name} > 0`;
    const r = await arcgis(`${MDPA}/0`, { where: w, returnCountOnly: true });
    fills[f.name] = pct(r.count, count.count);
  }
  log('fill % (non-empty / > 0)', fills);
  const dorField = layer.fields.find((f) => /DOR_DESC|DOR_CODE/i.test(f.name));
  if (dorField) {
    const g = await arcgis(`${MDPA}/0`, { where: '1=1', groupByFieldsForStatistics: dorField.name, outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: 'OBJECTID', outStatisticFieldName: 'n' }]), orderByFields: 'n DESC', resultRecordCount: 15 });
    log(`top ${dorField.name}`, (g.features || []).slice(0, 15).map((x) => `${x.attributes[dorField.name]}:${x.attributes.n}`));
  }
  // Join test: permit FolioNumber against the layer's FOLIO.
  const folioField = layer.fields.find((f) => /^FOLIO$/i.test(f.name)) || layer.fields.find((f) => /FOLIO/i.test(f.name));
  const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const page = await arcgis(MIAMI, { where: `PermitIssuedDate >= TIMESTAMP '${since} 00:00:00'`, outFields: 'FolioNumber', orderByFields: 'ObjectId DESC', resultRecordCount: 1000, returnGeometry: false });
  const folios = [...new Set(page.features.map((f) => String(f.attributes.FolioNumber || '').trim()).filter(Boolean))].slice(0, 400);
  const p = profile();
  folios.forEach((x) => p.add([x]));
  log('permit FolioNumber shapes', p.report(folios.length, { shapes: [0] })[0].shapes);
  const sample = await arcgis(`${MDPA}/0`, { where: '1=1', outFields: folioField.name, resultRecordCount: 500, returnGeometry: false });
  const p2 = profile();
  sample.features.forEach((f) => p2.add([f.attributes[folioField.name]]));
  log(`PA ${folioField.name} shapes`, p2.report(sample.features.length, { shapes: [0] })[0].shapes);
  let hit = 0;
  for (let i = 0; i < folios.length; i += 50) {
    const chunk = folios.slice(i, i + 50).map((x) => `'${x.replace(/'/g, "''")}'`).join(',');
    const r = await arcgis(`${MDPA}/0`, { where: `${folioField.name} IN (${chunk})`, outFields: folioField.name, returnGeometry: false });
    hit += new Set(r.features.map((f) => String(f.attributes[folioField.name]).trim())).size;
  }
  log('distinct permit folios (last 90 d sample) found in PA layer', `${hit}/${folios.length} = ${pct(hit, folios.length)}%`);
};

sections.census = async () => {
  const rows = (await austinRecent()).filter((r) => r.original_address1 && r.original_zip).slice(0, 50);
  const csv = rows.map((r, i) => [i + 1, r.original_address1, r.original_city || 'AUSTIN', 'TX', r.original_zip]
    .map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')).join('\n');
  const form = new FormData();
  form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv');
  form.append('benchmark', 'Public_AR_Current');
  const t0 = Date.now();
  const text = await http(CENSUS, { method: 'POST', body: form, json: false });
  const out = text.split(/\r?\n/).filter(Boolean).map(parseCsvLine);
  const status = new Map();
  out.forEach((r) => status.set(`${r[2]}${r[3] ? `/${r[3]}` : ''}`, (status.get(`${r[2]}${r[3] ? `/${r[3]}` : ''}`) || 0) + 1));
  log('batch of', rows.length);
  log('response rows / seconds', `${out.length} / ${Math.round((Date.now() - t0) / 1000)}`);
  log('match status', Object.fromEntries(status));
  log('output columns per row', [...new Set(out.map((r) => r.length))]);
  const bm = await http('https://geocoding.geo.census.gov/geocoder/benchmarks');
  log('benchmarks', (bm.benchmarks || []).map((b) => `${b.id}:${b.benchmarkName}`));
};

// Wake County parcels (ADR-23 sprint 1, docs/research/2026-11-14-data-engine/
// property-and-imagery.md): resolve the open-data item to its layer, print
// its licence, fields, row count and fill rates, and test the join from
// Raleigh permit `pin` to the parcel PIN. Owner, mailing and sale fields get a
// fill rate only (never values): they are never loaded (DATA_ENGINE_PLAN 6.4).
const WAKE_ITEM = 'f5ed009c66e844ec82f29064edd95017';
const RALEIGH_BP = 'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Building_Permits/FeatureServer/0';
sections.wake = async () => {
  const item = await http(`https://www.arcgis.com/sharing/rest/content/items/${WAKE_ITEM}?f=json`);
  log('item', `${item.title} | type ${item.type} | owner ${item.owner} | modified ${item.modified && new Date(item.modified).toISOString()}`);
  log('item licence', String(item.licenseInfo || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400));
  log('item access / url', `${item.access} | ${item.url}`);
  for (const u of [`https://hub.arcgis.com/api/v3/datasets/${WAKE_ITEM}_0`, `https://catalog.data.gov/api/3/action/package_search?q=${encodeURIComponent('Wake County parcels')}&rows=5`]) {
    try {
      const h = await http(u);
      if (h.data) log('hub licence', JSON.stringify({ license: h.data.attributes.license, structuredLicense: h.data.attributes.structuredLicense, source: h.data.attributes.source, orgName: h.data.attributes.orgName }).slice(0, 600));
      if (h.result) log('data.gov', h.result.results.map((r) => `${r.title} | ${r.organization && r.organization.title} | ${r.license_id || ''} ${r.license_title || ''} | ${(r.resources || []).map((x) => x.url).find((x) => /wake|arcgis/i.test(x)) || ''}`));
    } catch (err) { log('licence lookup failed', `${u.slice(0, 60)}: ${err.message}`); }
  }
  let layerUrl = item.url;
  if (!/\/\d+$/.test(layerUrl)) {
    const svc = await http(`${layerUrl}?f=json`);
    log('layers', (svc.layers || []).map((l) => `${l.id}:${l.name}`));
    layerUrl = `${layerUrl}/${(svc.layers || [])[0].id}`;
  }
  const layer = await http(`${layerUrl}?f=json`);
  log('layer', `${layerUrl} | ${layer.name} ${layer.geometryType} maxRecordCount=${layer.maxRecordCount}`);
  log('lastEditDate', layer.editingInfo && new Date(layer.editingInfo.lastEditDate || layer.editingInfo.dataLastEditDate).toISOString());
  log('copyright', String(layer.copyrightText || '').slice(0, 200));
  log('fields', layer.fields.map((f) => `${f.name}:${f.type.replace('esriFieldType', '')}`));
  const count = await arcgis(layerUrl, { where: '1=1', returnCountOnly: true });
  log('rows', count.count);
  // Fill from a sample: a string `<> ''` filter returned 0 on this MapServer
  // (run 43593964325), so counts come from the rows themselves. Values are
  // only counted here, never printed.
  const fills = {};
  const sampleRows = (await arcgis(layerUrl, { where: '1=1', outFields: '*', resultRecordCount: 2000, returnGeometry: false })).features.map((f) => f.attributes);
  for (const f of layer.fields.filter((x) => !/^(OBJECTID|Shape|GlobalID)/i.test(x.name) && !/Geometry|OID/.test(x.type))) {
    const n = sampleRows.filter((a) => a[f.name] != null && String(a[f.name]).trim() !== '' && !/^0+(\.0+)?$/.test(String(a[f.name]).trim())).length;
    fills[f.name] = pct(n, sampleRows.length);
  }
  log('fill sample rows', sampleRows.length);
  log('fill % (non-empty)', fills);
  const useField = layer.fields.find((f) => /TYPE_AND_USE|TYPE_USE|LAND_CLASS|PROPDESC|USE/i.test(f.name) && /String/.test(f.type));
  if (useField) {
    const g = await arcgis(layerUrl, { where: '1=1', groupByFieldsForStatistics: useField.name, outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: layer.objectIdField || 'OBJECTID', outStatisticFieldName: 'n' }]), orderByFields: 'n DESC', resultRecordCount: 15 });
    log(`top ${useField.name}`, (g.features || []).slice(0, 15).map((x) => `${x.attributes[useField.name]}:${x.attributes.n}`));
  }
  // Join test: Raleigh building-permit pins from the last 90 days.
  const pinField = layer.fields.find((f) => /^PIN_NUM$/i.test(f.name)) || layer.fields.find((f) => /^PIN/i.test(f.name));
  const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const page = await arcgis(RALEIGH_BP, { where: `issueddate >= TIMESTAMP '${since} 00:00:00'`, outFields: 'pin', resultRecordCount: 1000, returnGeometry: false });
  const pins = [...new Set(page.features.map((f) => String(f.attributes.pin || '').trim()).filter(Boolean))].slice(0, 300);
  const p = profile();
  pins.forEach((x) => p.add([x]));
  log('permit pin shapes', p.report(pins.length, { shapes: [0] })[0].shapes);
  const sample = await arcgis(layerUrl, { where: '1=1', outFields: pinField.name, resultRecordCount: 500, returnGeometry: false });
  const p2 = profile();
  sample.features.forEach((f) => p2.add([f.attributes[pinField.name]]));
  log(`parcel ${pinField.name} shapes`, p2.report(sample.features.length, { shapes: [0] })[0].shapes);
  let found = 0;
  const multi = new Map();
  for (let i = 0; i < pins.length; i += 50) {
    const chunk = pins.slice(i, i + 50);
    const r = await http(`${layerUrl}/query`, { method: 'POST', body: new URLSearchParams({ f: 'json', where: `${pinField.name} IN (${chunk.map((x) => `'${x.replace(/'/g, "''")}'`).join(',')})`, outFields: pinField.name, returnGeometry: 'false' }) });
    for (const f of r.features || []) multi.set(f.attributes[pinField.name], (multi.get(f.attributes[pinField.name]) || 0) + 1);
  }
  // Fixture (hard rule 10): three joined parcels, allowlisted fields only.
  const allow = ['PIN_NUM', 'REID', 'CALC_AREA', 'DEED_ACRES', 'BLDG_VAL', 'LAND_VAL', 'TOTAL_VALUE_ASSD', 'HEATEDAREA', 'YEAR_BUILT', 'TYPE_AND_USE', 'TYPE_USE_DECODE', 'DESIGN_STYLE_DECODE', 'UNITS', 'TOTUNITS', 'TOTSTRUCTS', 'LAND_CLASS_DECODE', 'SITE_ADDRESS', 'CITY_DECODE', 'PLANNING_JURISDICTION', 'ZIPNUM'];
  const fxPins = pins.filter((x) => multi.has(x)).slice(0, 3);
  const fxr = await http(`${layerUrl}/query`, { method: 'POST', body: new URLSearchParams({ f: 'json', where: `${pinField.name} IN (${fxPins.map((x) => `'${x}'`).join(',')})`, outFields: allow.filter((a) => layer.fields.some((f) => f.name === a)).join(','), returnGeometry: 'true', outSR: '4326', maxAllowableOffset: '0.00002', geometryPrecision: '6' }) });
  console.log(`  FIXTURE ${JSON.stringify({ fields: layer.fields.filter((f) => allow.includes(f.name)).map((f) => ({ name: f.name, type: f.type })), features: fxr.features })}`);
  found = pins.filter((x) => multi.has(x)).length;
  log('join: permit pins found as parcels', `${found} of ${pins.length} (${pct(found, pins.length)}); pins with >1 parcel row: ${[...multi.values()].filter((n) => n > 1).length}`);
};

// Texas Comptroller public-data API (ADR-23 sprint 2; owner registered the
// key 2026-11-14 as TX_COMPTROLLER_API_KEY). Franchise-tax search by the most
// frequent Austin contractor business names, then one detail call per exact
// hit: prints status codes, rate-limit headers, response field names and
// business-level values. Officer and registered-agent names are people: only
// their field names are printed, never values.
const CPA = 'https://api.comptroller.texas.gov/public-data/v1/public';
async function cpa(pathAndQuery) {
  const key = process.env.TX_COMPTROLLER_API_KEY;
  if (!key) throw new Error('TX_COMPTROLLER_API_KEY is not set');
  const wait = 600 - (Date.now() - lastRequest);
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  const res = await fetch(`${CPA}${pathAndQuery}`, { headers: { 'x-api-key': key, 'User-Agent': UA, Accept: 'application/json' } });
  const text = await res.text();
  const headers = {};
  for (const [k, v] of res.headers) if (/rate|limit|retry|quota|remaining/i.test(k)) headers[k] = v;
  let body = null;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  return { status: res.status, headers, body };
}
const PERSON_KEYS = /officer|agent|director|manager|member|person|name_?of|first|last|middle/i;
function shapeOf(v, depth = 0) {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, depth > 3 ? typeof x : shapeOf(x, depth + 1)]));
  return typeof v;
}
function businessOnly(v) {
  if (Array.isArray(v)) return v.map(businessOnly);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, PERSON_KEYS.test(k) && !/taxpayer|legal|entity|business|dba|company/i.test(k)
      ? (x && typeof x === 'object' ? `[${Array.isArray(x) ? x.length : 1} redacted]` : '[redacted]') : businessOnly(x)]));
  }
  return v;
}
sections.comptroller = async () => {
  const rows = await austinRecent();
  const counts = new Map();
  for (const r of rows) {
    const n = String(r.contractor_company_name || '').trim();
    if (n.length >= 4) counts.set(n, (counts.get(n) || 0) + 1);
  }
  const names = [...counts].sort((a, b) => b[1] - a[1]).map(([n]) => n)
    .filter((n) => /\b(LLC|L\.L\.C|INC|CORP|CO|COMPANY|LP|LTD|PLLC|SERVICES|ELECTRIC|PLUMBING|HOMES|BUILDERS|CONSTRUCTION)\b/i.test(n)).slice(0, 25);
  log('names probed', names.length);
  const first = await cpa(`/franchise-tax-list?name=${encodeURIComponent(names[0].slice(0, 50))}`);
  log('first call', { status: first.status, headers: first.headers });
  log('list response shape', shapeOf(first.body));
  console.log(`  FIXTURE_LIST ${JSON.stringify(businessOnly(first.body)).slice(0, 4000)}`);
  if (first.status !== 200) return;
  const results = [];
  let detailShown = false;
  for (const name of names) {
    const r = name === names[0] ? first : await cpa(`/franchise-tax-list?name=${encodeURIComponent(name.slice(0, 50))}`);
    const list = Array.isArray(r.body) ? r.body : (r.body && (r.body.data || r.body.results || r.body.items)) || [];
    const top = list[0] || null;
    results.push({ name, status: r.status, hits: Array.isArray(list) ? list.length : null, top: top && businessOnly(top) });
    if (top && !detailShown) {
      const id = top.taxpayerId || top.taxpayerNumber || top.taxpayer_id || top.id;
      if (id) {
        const d = await cpa(`/franchise-tax/${encodeURIComponent(id)}`);
        log('detail call', { status: d.status, headers: d.headers });
        log('detail response shape', shapeOf(d.body));
        console.log(`  FIXTURE_DETAIL ${JSON.stringify(businessOnly(d.body)).slice(0, 4000)}`);
        detailShown = true;
      }
    }
  }
  table(results.map((x) => ({ name: x.name, status: x.status, hits: x.hits, top: x.top && JSON.stringify(x.top).slice(0, 300) })));
  const hit = results.filter((x) => x.hits > 0).length;
  log('names with at least one franchise-tax record', `${hit} of ${results.length} (${pct(hit, results.length)})`);
};

async function main() {
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
  for (const [name, fn] of Object.entries(sections)) {
    if (only.length && !only.includes(name)) continue;
    console.log(`\n=== ${name} ===`);
    const t0 = Date.now();
    try { await fn(); } catch (err) { console.log(`  FAILED: ${err.message}`); }
    console.log(`  (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (require.main === module) main();
module.exports = { shape, digits, parseCsvLine, profile, fixed, licKey, xlsxRows };
