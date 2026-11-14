// Planning-source probe (lane B of the data-engine gap plan, CLAUDE.md rule 10):
// reads the live metadata, licence, volume, status vocabulary, field fill and
// official links of the pre-approval planning sources before any connector is
// written, and prints a redacted fixture of each.
//
//   Raleigh Development_Plans (ArcGIS)           -> raleigh-devplans
//   Austin Site Plan Cases mavg-96ck (Socrata)   -> austin-site-plans
//   Austin Subdivision Cases s7gx-9m54 (Socrata) -> austin-subdivisions
//   Miami-Dade DERM Sewer Allocation (ArcGIS)    -> miami-derm-sewer
//   Miami-Dade Permits Requiring Allocation      -> miami-wasd-allocation
//
// Read-only, <= 2 requests a second, no dependencies. This container cannot
// reach government hosts, so it runs in Actions:
//   feasibility.yml input `planning`: 'all' or a comma list of the keys above.
//   node recon/planning_probe.js [--only=raleigh-devplans,...] [--rows=12]
// Everything is printed to the log; fixtures between BEGIN/END FIXTURE <key>.

const { redactRow } = require('./redact.js');
const { partyKind } = require('../src/contractors.js');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const ONLY = args.only && args.only !== 'all' ? String(args.only).split(',') : null;
const ROWS = Number(args.rows || 12);
const UA = 'permit-leads-planning-probe/0.1 (research; read-only)';
const DAY = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const isoDay = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 10));
const want = (k) => !ONLY || ONLY.includes(k);

let last = 0;
async function get(url, { json = true, attempts = 3, method = 'GET', body } = {}) {
  for (let i = 1; ; i += 1) {
    const wait = 500 - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
      if (!json) return text;
      const out = JSON.parse(text);
      if (out && out.error) throw new Error(`API error: ${JSON.stringify(out.error).slice(0, 200)}`);
      return out;
    } catch (err) {
      if (i >= attempts) throw new Error(`${err.message} <- ${url.slice(0, 200)}`);
      await sleep(2000 * i);
    }
  }
}

const log = (...a) => console.log(...a);
const section = (t) => log(`\n==================== ${t} ====================`);
const show = (label, v) => log(`${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

/** Share of rows with a non-empty value, per field. */
function fillRates(rows) {
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  const out = {};
  for (const k of keys) {
    const n = rows.filter((r) => r[k] != null && String(r[k]).trim() !== '' && String(r[k]).trim() !== '0').length;
    out[k] = pct(n, rows.length);
  }
  return out;
}

/** Top values of one column over the rows. */
function topValues(rows, k, n = 25) {
  const c = new Map();
  for (const r of rows) { const v = r[k] == null ? '(null)' : String(r[k]).trim(); c.set(v, (c.get(v) || 0) + 1); }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** Would a person-name filter treat this as an individual? Only a shape count, values never printed. */
const looksPerson = (v) => typeof v === 'string' && /^[A-Z][a-z]+( [A-Z]\.?)? [A-Z][a-z'-]+$/.test(v.trim());

function fixture(key, meta, rows, extraPersonFields = []) {
  const red = rows.map((r) => {
    const o = redactRow(r);
    // An organisation column keeps its value when it reads as a business, so
    // the fixture can test party kinds; anything else stays redacted.
    for (const k of Object.keys(o)) if (/organi[sz]ation/i.test(k) && r[k] && partyKind(r[k]) === 'business') o[k] = r[k];
    for (const f of extraPersonFields) if (o[f] != null && o[f] !== '' && looksPerson(String(o[f]))) o[f] = 'REDACTED';
    return o;
  });
  log(`BEGIN FIXTURE ${key}`);
  // One row per line: Actions drops a log line over ~64 KB.
  log(JSON.stringify({ source: key, capturedAt: new Date().toISOString(), ...meta }));
  for (const r of red) log(JSON.stringify(r));
  log(`END FIXTURE ${key}`);
}

// ------------------------------------------------------------------ ArcGIS

async function arcItem(itemId) {
  try {
    const it = await get(`https://www.arcgis.com/sharing/rest/content/items/${itemId}?f=json`);
    return { id: itemId, title: it.title, owner: it.owner, url: it.url, type: it.type, modified: isoDay(it.modified),
      licenseInfo: (it.licenseInfo || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 900),
      accessInformation: it.accessInformation, description: (it.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 900) };
  } catch (err) { return { id: itemId, error: err.message }; }
}

async function arcCount(layer, where) {
  const q = new URLSearchParams({ where, returnCountOnly: 'true', f: 'json' });
  return (await get(`${layer}/query?${q}`)).count;
}

async function arcRows(layer, { where = '1=1', order, n = 2000, fields = '*' } = {}) {
  const q = new URLSearchParams({ where, outFields: fields, returnGeometry: 'false', resultRecordCount: String(n), f: 'json' });
  if (order) q.set('orderByFields', order);
  return (await get(`${layer}/query?${q}`)).features.map((f) => f.attributes);
}

async function arcGroup(layer, field, where = '1=1') {
  const q = new URLSearchParams({ where, groupByFieldsForStatistics: field, outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: field, outStatisticFieldName: 'n' }]), f: 'json' });
  try {
    return (await get(`${layer}/query?${q}`)).features.map((f) => [f.attributes[field], f.attributes.n]).sort((a, b) => b[1] - a[1]).slice(0, 40);
  } catch (err) { return `group failed: ${err.message}`; }
}

async function arcMinMax(layer, field) {
  const q = new URLSearchParams({ where: '1=1', outStatistics: JSON.stringify([
    { statisticType: 'min', onStatisticField: field, outStatisticFieldName: 'lo' },
    { statisticType: 'max', onStatisticField: field, outStatisticFieldName: 'hi' }]), f: 'json' });
  try { const a = (await get(`${layer}/query?${q}`)).features[0].attributes; return [isoDay(a.lo), isoDay(a.hi)]; } catch (err) { return `minmax failed: ${err.message}`; }
}

const dateWhere = (field, days) => `${field} >= TIMESTAMP '${new Date(Date.now() - days * DAY).toISOString().slice(0, 19).replace('T', ' ')}'`;

/** Layer metadata, licence, counts, dates, fill, vocab; returns the layer meta and newest rows. */
async function arcProbe(key, layer, { dateFields = [], statusFields = [], personFields = [], ranges = true, days = [30, 90, 365] } = {}) {
  const meta = await get(`${layer}?f=json`);
  const fields = meta.fields.map((f) => `${f.name}:${f.type.replace('esriFieldType', '')}`);
  show('name', meta.name);
  show('fields', fields);
  show('maxRecordCount', meta.maxRecordCount);
  show('lastEditDate', meta.editingInfo && new Date(meta.editingInfo.lastEditDate).toISOString());
  show('serviceItemId', meta.serviceItemId);
  if (meta.serviceItemId) show('item', await arcItem(meta.serviceItemId));
  show('count', await arcCount(layer, '1=1'));
  const dates = meta.fields.filter((f) => f.type === 'esriFieldType' + 'Date').map((f) => f.name);
  const df = dateFields.filter((d) => dates.includes(d));
  if (ranges) for (const d of dates) show(`range ${d}`, await arcMinMax(layer, d));
  for (const d of df) {
    for (const n of days) show(`${d} last ${n}d`, await arcCount(layer, dateWhere(d, n)).catch((e) => e.message));
  }
  for (const s of statusFields.filter((x) => meta.fields.some((f) => f.name === x))) show(`vocab ${s}`, await arcGroup(layer, s));
  const order = df[0] ? `${df[0]} DESC` : undefined;
  const rows = await arcRows(layer, { order, n: Math.min(2000, meta.maxRecordCount || 1000) });
  show('newest rows read', rows.length);
  show('fill % (newest rows)', fillRates(rows));
  for (const p of personFields) show(`person-shaped ${p} %`, pct(rows.filter((r) => looksPerson(r[p])).length, rows.filter((r) => r[p]).length));
  fixture(key, { layer, layerName: meta.name, editedAt: meta.editingInfo && new Date(meta.editingInfo.lastEditDate).toISOString(), declaredFields: fields }, rows.slice(0, ROWS), personFields);
  return { meta, rows };
}

// ----------------------------------------------------------------- Socrata

async function socProbe(key, domain, id, { personFields = [] } = {}) {
  const v = await get(`https://${domain}/api/views/${id}.json`);
  const cols = v.columns.map((c) => `${c.fieldName}:${c.dataTypeName}`);
  show('name', v.name);
  show('columns', cols);
  show('license', v.license || v.licenseId);
  show('rowsUpdatedAt', v.rowsUpdatedAt && new Date(v.rowsUpdatedAt * 1000).toISOString());
  show('description', String(v.description || '').slice(0, 600));
  const dates = v.columns.filter((c) => c.dataTypeName === 'calendar_date').map((c) => c.fieldName);
  const soql = async (q) => get(`https://${domain}/resource/${id}.json?${new URLSearchParams(q)}`);
  show('count', (await soql({ $select: 'count(*) AS n' }))[0].n);
  for (const d of dates) {
    const [r] = await soql({ $select: `min(${d}) AS lo, max(${d}) AS hi, count(${d}) AS n` });
    show(`range ${d}`, r);
    const since = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
    show(`${d} last 30d`, (await soql({ $select: 'count(*) AS n', $where: `${d} >= '${since}'` }))[0].n);
  }
  const statusCols = v.columns.filter((c) => /status|type|kind|class/i.test(c.fieldName) && c.dataTypeName === 'text').map((c) => c.fieldName);
  for (const s of statusCols) {
    show(`vocab ${s}`, await soql({ $select: `${s}, count(*) AS n`, $group: s, $order: 'n DESC', $limit: 40 }).then((x) => x.map((r) => [r[s], Number(r.n)])).catch((e) => e.message));
  }
  const applied = dates.find((d) => /appl|submit|file|intake|creat/i.test(d)) || dates[0];
  show('order by', applied);
  const rows = await soql({ $order: `${applied} DESC`, $where: `${applied} IS NOT NULL`, $limit: 2000 });
  show('newest rows read', rows.length);
  show('fill % (newest rows)', fillRates(rows));
  for (const p of personFields) show(`person-shaped ${p} %`, pct(rows.filter((r) => looksPerson(r[p])).length, rows.filter((r) => r[p]).length));
  fixture(key, { layer: `https://${domain}/resource/${id}.json`, layerName: v.name, editedAt: v.rowsUpdatedAt && new Date(v.rowsUpdatedAt * 1000).toISOString(), licenseInfo: v.license || null, declaredFields: cols }, rows.slice(0, ROWS), personFields);
  return { view: v, rows, soql, applied };
}

// ------------------------------------------------------------------ probes

const RAL = 'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services';
const MD_PERMITS = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0';
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function raleigh() {
  section('raleigh-devplans');
  const layer = `${RAL}/Development_Plans/FeatureServer/0`;
  const { meta, rows } = await arcProbe('raleigh-devplans', layer, {
    dateFields: ['submitted', 'approved', 'updated', 'CreationDate', 'EditDate'],
    statusFields: ['status', 'plan_type', 'zoning', 'missing_middle'],
    personFields: ['developer'],
  });
  const names = meta.fields.map((f) => f.name);
  const keyField = ['plan_number', 'planid', 'devplanid', 'plan_id'].find((f) => names.includes(f));
  show('plan key field', keyField);
  // Official link: Building_Permits.devplanid -> which Development_Plans column?
  const bpLayer = `${RAL}/Building_Permits/FeatureServer/0`;
  const bp = await arcRows(bpLayer, { where: "devplanid IS NOT NULL AND devplanid <> ''", order: 'applieddate DESC', n: 1000, fields: 'permitnum,devplanid,applieddate,issueddate,pin,workclass,permitclassmapped' });
  show('BPs with devplanid (newest 1000) sample values', bp.slice(0, 15).map((r) => r.devplanid));
  show('BP devplanid count', await arcCount(bpLayer, "devplanid IS NOT NULL AND devplanid <> ''").catch((e) => e.message));
  show('BP total count', await arcCount(bpLayer, '1=1').catch((e) => e.message));
  // Try every text/int column of the plans layer as the target of devplanid.
  const ids = [...new Set(bp.map((r) => String(r.devplanid).trim()))].slice(0, 300);
  const cand = meta.fields.filter((f) => /String|Integer|Double|OID/.test(f.type)).map((f) => f.name);
  const res = {};
  for (const c of cand) {
    const vals = new Set(rows.map((r) => (r[c] == null ? '' : String(r[c]).trim())));
    const hit = ids.filter((x) => vals.has(x)).length;
    if (hit) res[c] = `${hit}/${ids.length} (newest 2000 plans only)`;
  }
  show('devplanid matches plans column', res);
  // Unbounded check on the best candidate: query plans by the ids themselves.
  const best = Object.entries(res).sort((a, b) => parseInt(b[1], 10) - parseInt(a[1], 10))[0];
  if (best) {
    const col = best[0];
    const isNum = meta.fields.find((f) => f.name === col).type.match(/Integer|Double|OID/);
    let hit = 0;
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const where = `${col} IN (${chunk.map((x) => (isNum ? Number(x) || -1 : quote(x))).join(',')})`;
      hit += (await arcRows(layer, { where, fields: col, n: 2000 })).length;
    }
    show(`devplanid -> ${col} full-layer matches`, `${hit} plan rows for ${ids.length} distinct ids`);
  }
  // Pre-issue share: plans still under review, and approved plans' later BPs.
  for (const extra of ['Development_Plan_Areas', 'Building_Permits_Pending']) {
    try {
      const svc = await get(`${RAL}/${extra}/FeatureServer?f=json`);
      show(`${extra} layers`, (svc.layers || []).map((l) => `${l.id}:${l.name}`));
      const m = await get(`${RAL}/${extra}/FeatureServer/${(svc.layers[0] || {}).id || 0}?f=json`);
      show(`${extra} fields`, m.fields.map((f) => f.name));
      show(`${extra} count`, await arcCount(`${RAL}/${extra}/FeatureServer/${(svc.layers[0] || {}).id || 0}`, '1=1'));
    } catch (err) { show(extra, err.message); }
  }
}

async function austin() {
  for (const [key, id] of [['austin-site-plans', 'mavg-96ck'], ['austin-subdivisions', 's7gx-9m54']]) {
    if (!want(key)) continue;
    section(key);
    let p;
    for (const domain of ['datahub.austintexas.gov', 'data.austintexas.gov']) {
      try { show('domain', domain); p = await socProbe(key, domain, id, { personFields: ['applicant_full_name', 'owner_full_name', 'other_full_name'] }); break; } catch (err) { show(`${domain} failed`, err.message); }
    }
    if (!p) continue;
    const cols = p.view.columns.map((c) => c.fieldName);
    show('link columns present', cols.filter((c) => /rsn|tcad|appraisal|related|case|folder|permit|parcel|propert/i.test(c)));
    // Official link to plan review / BPs: propertyrsn shared with n8ck-xkda?
    if (cols.includes('propertyrsn')) {
      const rsns = [...new Set(p.rows.map((r) => r.propertyrsn).filter(Boolean))].slice(0, 200);
      let hitPR = 0; let hitBP = 0;
      for (let i = 0; i < rsns.length; i += 40) {
        const chunk = rsns.slice(i, i + 40).map(quote).join(',');
        hitPR += (await get(`https://datahub.austintexas.gov/resource/n8ck-xkda.json?${new URLSearchParams({ $select: 'distinct propertyrsn', $where: `propertyrsn in (${chunk})`, $limit: 1000 })}`).catch(() => [])).length;
        hitBP += (await get(`https://data.austintexas.gov/resource/3syk-w9eu.json?${new URLSearchParams({ $select: 'distinct propertyrsn', $where: `propertyrsn in (${chunk})`, $limit: 1000 })}`).catch(() => [])).length;
      }
      show('propertyrsn shared with plan review n8ck-xkda', `${hitPR}/${rsns.length}`);
      show('propertyrsn shared with issued permits 3syk-w9eu', `${hitBP}/${rsns.length}`);
    }
    // Same-day publication: rows applied yesterday and today.
    const today = new Date().toISOString().slice(0, 10);
    const y = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    show(`rows ${p.applied} >= yesterday`, (await p.soql({ $select: 'count(*) AS n', $where: `${p.applied} >= '${y}'` }))[0].n);
    show('today', today);
  }
}

async function miami() {
  for (const [key, itemId] of [['miami-derm-sewer', 'd583b45dae464e30b4fb438d4da979f2']]) {
    if (!want(key)) continue;
    section(key);
    const item = await arcItem(itemId);
    show('item', item);
    let layer = item.url;
    if (!layer) { show('no item url', 'stop'); continue; }
    if (!/\/\d+$/.test(layer)) {
      const svc = await get(`${layer}?f=json`);
      show('service layers', (svc.layers || []).concat(svc.tables || []).map((l) => `${l.id}:${l.name}`));
      layer = `${layer}/${((svc.layers || [])[0] || (svc.tables || [])[0] || { id: 0 }).id}`;
    }
    show('layer', layer);
    const { meta, rows } = await arcProbe(key, layer, {
      dateFields: ['SWRCRTDATE', 'SWRRCTDATE', 'EXPDT90DAY', 'SWRDEALLDT', 'EFFECTIVE', 'DEALLOCDT', 'CreationDate', 'EditDate'],
      statusFields: ['SWRAPVCODE', 'SEWEXTREQD', 'DEALLOCTYP', 'PERMTYPE', 'PERMSTATUS', 'STATUS'],
    });
    const names = meta.fields.map((f) => f.name);
    show('date-like fields', meta.fields.filter((f) => /Date/.test(f.type)).map((f) => f.name));
    // Official link to the county permit layer: process number or permit number.
    for (const col of names.filter((n) => /PROC|PERM|BLD|FOLIO/i.test(n))) {
      const vals = [...new Set(rows.map((r) => r[col]).filter((v) => v != null && String(v).trim() !== '').map((v) => String(v).trim()))].slice(0, 200);
      if (!vals.length) { show(`${col}`, 'empty'); continue; }
      show(`${col} sample`, vals.slice(0, 8));
      for (const target of ['ProcessNumber', 'PermitNumber', 'MasterPermitNumber', 'FolioNumber']) {
        let hit = 0; let issuedAfter = 0;
        for (let i = 0; i < vals.length; i += 40) {
          const chunk = vals.slice(i, i + 40);
          const where = `${target} IN (${chunk.map(quote).join(',')})`;
          const got = await arcRows(MD_PERMITS, { where, fields: `${target},PermitIssuedDate`, n: 2000 }).catch(() => []);
          hit += new Set(got.map((g) => String(g[target]).trim())).size;
          issuedAfter += got.length;
        }
        if (hit) show(`${col} -> permits.${target}`, `${hit}/${vals.length} distinct values found (${issuedAfter} permit rows)`);
      }
    }
  }
}

// Raleigh's second planning layer: the plan areas carry plplanid (the target
// of Building_Permits.devplanid?) and the main parcel PIN.
async function raleighAreas() {
  section('raleigh-plan-areas');
  const layer = `${RAL}/Development_Plan_Areas/FeatureServer/0`;
  const { meta, rows } = await arcProbe('raleigh-plan-areas', layer, {
    dateFields: ['apply_date', 'lastchangedon', 'complete_date'], statusFields: ['plan_status', 'plan_type', 'district'], ranges: false,
  });
  const names = meta.fields.map((f) => f.name);
  show('fields present', names);
  const bpLayer = `${RAL}/Building_Permits/FeatureServer/0`;
  const bp = await arcRows(bpLayer, { where: 'devplanid IS NOT NULL AND devplanid > 0', order: 'applieddate DESC', n: 2000, fields: 'permitnum,devplanid,applieddate,issueddate,pin,permitclassmapped,workclass' });
  const ids = [...new Set(bp.map((r) => String(r.devplanid).trim()))];
  const plIds = new Set(rows.map((r) => String(r.plplanid).trim()));
  show('newest BP devplanids found among newest 2000 plan areas (plplanid)', `${ids.filter((x) => plIds.has(x)).length}/${ids.length}`);
  // plplanid is a GUID and devplanid an integer (read 2026-11-14), so they
  // cannot be the same key. Is devplanid any column of the areas at all?
  for (const c of meta.fields.map((f) => f.name)) {
    const vals = new Set(rows.map((r) => String(r[c] ?? '').trim()));
    const n = ids.filter((x) => vals.has(x)).length;
    if (n) show(`devplanid values found in areas.${c}`, `${n}/${ids.length}`);
  }
  // Parcel link: plan PIN -> later Raleigh building permits on the same pin.
  const pins = [...new Set(rows.map((r) => r.main_parcel_number).filter(Boolean))].slice(0, 300);
  const byPin = new Map(rows.filter((r) => r.main_parcel_number).map((r) => [r.main_parcel_number, r]));
  let pinHit = 0; const leads = [];
  for (let i = 0; i < pins.length; i += 50) {
    const got = await arcRows(bpLayer, { where: `pin IN (${pins.slice(i, i + 50).map(quote).join(',')})`, fields: 'pin,permitnum,applieddate,permitclassmapped,workclass', n: 2000 }).catch((e) => { show('pin query failed', e.message); return []; });
    const seenPins = new Set();
    for (const g of got) {
      const plan = byPin.get(g.pin);
      if (!plan || !g.applieddate || g.applieddate < plan.apply_date) continue;
      if (!seenPins.has(g.pin)) { seenPins.add(g.pin); leads.push(Math.round((g.applieddate - plan.apply_date) / DAY)); }
    }
    pinHit += seenPins.size;
  }
  leads.sort((a, b) => a - b);
  show('plan PINs (newest 300) with a BP applied on/after the plan on the same pin', `${pinHit}/${pins.length}`);
  show('days plan applied -> first later BP applied: p25, median, p75', [leads[Math.floor(leads.length / 4)], leads[Math.floor(leads.length / 2)], leads[Math.floor((3 * leads.length) / 4)]]);
  show('plan number shapes (areas)', topValues(rows.map((r) => ({ s: String(r.plan_number || '').replace(/\d/g, '9') })), 's', 15));
  // Same plans as Development_Plans? Overlap by plan_number.
  const dp = await arcRows(`${RAL}/Development_Plans/FeatureServer/0`, { order: 'submitted DESC', n: 2000, fields: 'plan_number,developer,submitted' });
  const dpNums = new Set(dp.map((r) => r.plan_number));
  show('newest 2000 Development_Plans plan_numbers also in the newest 2000 plan areas', `${rows.filter((r) => dpNums.has(r.plan_number)).length} of ${rows.length} area rows`);
}

// DERM: is a sewer certification earlier than the county building permit on
// the same folio, and by how much?
async function dermLead() {
  section('miami-derm-lead');
  const layer = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/DERMSewerAllocation_gdb/FeatureServer/0';
  const certs = await arcRows(layer, { where: dateWhere('SWRCRTDATE', 365), order: 'SWRCRTDATE DESC', n: 2000, fields: 'EEOSALLCNO,FOLIO,BLDPROCNO,SWRCRTDATE,SWRAPVCODE,PRPDFLWGPD' });
  show('certifications in the last 365d read', certs.length);
  show('BLDPROCNO shapes', topValues(certs.map((r) => ({ s: String(r.BLDPROCNO || '').replace(/\d/g, '9') })), 's', 20));
  show('status codes, last 365d', topValues(certs, 'SWRAPVCODE'));
  const folios = [...new Set(certs.map((r) => r.FOLIO).filter(Boolean))].slice(0, 400);
  const permitsByFolio = new Map();
  for (let i = 0; i < folios.length; i += 40) {
    const chunk = folios.slice(i, i + 40);
    const got = await arcRows(MD_PERMITS, { where: `FolioNumber IN (${chunk.map(quote).join(',')})`, fields: 'FolioNumber,PermitNumber,ProcessNumber,PermitIssuedDate,ApplicationDate,PermitType', n: 2000 }).catch(() => []);
    // The county layer's dates are 'YYYY-MM-DD' strings, DERM's epoch ms.
    for (const g of got) {
      g.PermitIssuedDate = typeof g.PermitIssuedDate === 'string' ? Date.parse(g.PermitIssuedDate) : g.PermitIssuedDate;
      (permitsByFolio.get(g.FolioNumber) || permitsByFolio.set(g.FolioNumber, []).get(g.FolioNumber)).push(g);
    }
  }
  let withPermit = 0; let after = 0; const leads = []; let procHit = 0; const typeCount = new Map(); const procLeads = [];
  for (const c of certs.filter((x) => folios.includes(x.FOLIO))) {
    const ps = permitsByFolio.get(c.FOLIO) || [];
    if (!ps.length) continue;
    withPermit += 1;
    const same = ps.filter((p) => String(p.ProcessNumber).trim() === String(c.BLDPROCNO).trim());
    if (same.length) {
      procHit += 1;
      const first = same.map((p) => p.PermitIssuedDate).filter(Boolean).sort((a, b) => a - b)[0];
      if (first) procLeads.push(Math.round((first - c.SWRCRTDATE) / DAY));
    }
    const later = ps.filter((p) => p.PermitIssuedDate && p.PermitIssuedDate >= c.SWRCRTDATE).map((p) => p.PermitIssuedDate).sort((a, b) => a - b);
    for (const p of ps) typeCount.set(`${p.PermitType}|${p.PermitIssuedDate >= c.SWRCRTDATE ? 'after' : 'before'}`, (typeCount.get(`${p.PermitType}|${p.PermitIssuedDate >= c.SWRCRTDATE ? 'after' : 'before'}`) || 0) + 1);
    if (later.length) { after += 1; leads.push(Math.round((later[0] - c.SWRCRTDATE) / DAY)); }
  }
  leads.sort((a, b) => a - b);
  const n = certs.filter((x) => folios.includes(x.FOLIO)).length;
  show('certs checked (first 400 folios)', n);
  show('with any county permit on the folio', withPermit);
  show('BLDPROCNO equals a county ProcessNumber on the same folio', procHit);
  show('permit types on these folios, issued before/after the certification', [...typeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20));
  show('with a county permit issued on/after certification', after);
  procLeads.sort((a, b) => a - b);
  show('same process number: days certification -> permit issued, n, p25, median, p75, share negative', [procLeads.length, procLeads[Math.floor(procLeads.length / 4)], procLeads[Math.floor(procLeads.length / 2)], procLeads[Math.floor((3 * procLeads.length) / 4)], pct(procLeads.filter((x) => x < 0).length, procLeads.length)]);
  const bpStates = topValues(certs.filter((c) => folios.includes(c.FOLIO)).map((c) => ({ s: (permitsByFolio.get(c.FOLIO) || []).some((p) => String(p.ProcessNumber).trim() === String(c.BLDPROCNO).trim()) ? 'process issued' : 'no issued permit with this process' })), 's');
  show('certifications by whether their process has an issued county permit yet', bpStates);
  show('days certification -> next BLDG issue: p25, median, p75', [leads[Math.floor(leads.length / 4)], leads[Math.floor(leads.length / 2)], leads[Math.floor((3 * leads.length) / 4)]]);
}

// WASD permits requiring allocation: 439k rows, so no full-table statistics
// except grouped counts on recent rows.
async function wasd() {
  section('miami-wasd-allocation');
  const layer = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/PermitsRequiringAllocation_gdb/FeatureServer/0';
  const meta = await get(`${layer}?f=json`);
  show('fields', meta.fields.map((f) => `${f.name}:${f.type.replace('esriFieldType', '')}`));
  show('count', await arcCount(layer, '1=1').catch((e) => e.message));
  for (const d of ['INSERTDATE', 'UPDATEDATE', 'BLDPRCISDT', 'BLDPRMIDT']) show(`${d} last 30d`, await arcCount(layer, dateWhere(d, 30)).catch((e) => e.message));
  const recent = dateWhere('INSERTDATE', 90);
  for (const g of ['MUNICID', 'BLDPRCSTAT', 'BLDPRMSTAT', 'SERVICETYP', 'BLDPRMTYP', 'COTYPE', 'EFFECTIVE', 'DEALLOCTYP']) show(`vocab ${g} (inserted last 90d)`, await arcGroup(layer, g, recent));
  const rows = await arcRows(layer, { where: recent, order: 'INSERTDATE DESC', n: 2000 });
  show('rows inserted last 90d read', rows.length);
  show('fill % (newest inserted)', fillRates(rows));
  show('no building permit number yet %', pct(rows.filter((r) => !r.BLDPRMNO || !String(r.BLDPRMNO).trim()).length, rows.length));
  show('no permit issue date yet %', pct(rows.filter((r) => !r.BLDPRMIDT).length, rows.length));
  const lag = rows.filter((r) => r.BLDPRCISDT && r.BLDPRMIDT).map((r) => Math.round((r.BLDPRMIDT - r.BLDPRCISDT) / DAY)).sort((a, b) => a - b);
  show('BLDPRCISDT -> BLDPRMIDT days: n, median', [lag.length, lag[Math.floor(lag.length / 2)]]);
  const ins = rows.filter((r) => r.INSERTDATE && r.BLDPRMIDT).map((r) => Math.round((r.INSERTDATE - r.BLDPRMIDT) / DAY)).sort((a, b) => a - b);
  show('permit issued -> row inserted days: n, median (negative = row before issue)', [ins.length, ins[Math.floor(ins.length / 2)]]);
  const nums = [...new Set(rows.map((r) => r.BLDPRMNO).filter(Boolean).map((v) => String(v).trim()))].slice(0, 200);
  let hit = 0;
  for (let i = 0; i < nums.length; i += 40) {
    const got = await arcRows(MD_PERMITS, { where: `PermitNumber IN (${nums.slice(i, i + 40).map(quote).join(',')})`, fields: 'PermitNumber', n: 2000 }).catch(() => []);
    hit += new Set(got.map((g) => g.PermitNumber)).size;
  }
  show('BLDPRMNO -> county PermitNumber', `${hit}/${nums.length}`);
  show('distinct BLDPRCNO / rows (newest inserted)', `${new Set(rows.map((r) => String(r.BLDPRCNO).trim())).size}/${rows.length}`);
  show('distinct ID / rows', `${new Set(rows.map((r) => r.ID)).size}/${rows.length}`);
  show('INSERTDATE batches (newest inserted)', topValues(rows.map((r) => ({ d: isoDay(r.INSERTDATE) })), 'd', 10));
  // Same process across the whole layer: one row per process, or a row per event?
  const sample = [...new Set(rows.map((r) => String(r.BLDPRCNO).trim()))].slice(0, 120);
  let total = 0;
  for (let i = 0; i < sample.length; i += 40) total += await arcCount(layer, `BLDPRCNO IN (${sample.slice(i, i + 40).map(quote).join(',')})`).catch(() => 0);
  show('rows in the whole layer for 120 recent process numbers', total);
  // Do processes link to the county permit layer's ProcessNumber once issued?
  const old = await arcRows(layer, { where: "BLDPRMNO <> ' ' AND BLDPRMIDT IS NOT NULL AND MUNICID = '30'", order: 'BLDPRMIDT DESC', n: 300, fields: 'BLDPRCNO,BLDPRMNO,BLDPRCISDT,BLDPRMIDT,INSERTDATE' }).catch((e) => { show('issued query failed', e.message); return []; });
  const procs = [...new Set(old.map((r) => String(r.BLDPRCNO).trim()))].slice(0, 200);
  let ph = 0;
  for (let i = 0; i < procs.length; i += 40) {
    const got = await arcRows(MD_PERMITS, { where: `ProcessNumber IN (${procs.slice(i, i + 40).map(quote).join(',')})`, fields: 'ProcessNumber', n: 2000 }).catch(() => []);
    ph += new Set(got.map((g) => String(g.ProcessNumber).trim())).size;
  }
  show('issued county processes: BLDPRCNO -> county permits ProcessNumber', `${ph}/${procs.length}`);
  const lead = old.filter((r) => r.BLDPRCISDT && r.BLDPRMIDT).map((r) => Math.round((r.BLDPRMIDT - r.BLDPRCISDT) / DAY)).sort((a, b) => a - b);
  show('issued county processes: application -> issue days p25/median/p75', [lead[Math.floor(lead.length / 4)], lead[Math.floor(lead.length / 2)], lead[Math.floor((3 * lead.length) / 4)]]);
  const insLag = old.filter((r) => r.INSERTDATE && r.BLDPRCISDT).map((r) => Math.round((r.INSERTDATE - r.BLDPRCISDT) / DAY)).sort((a, b) => a - b);
  show('issued county processes: application -> row inserted days p25/median/p75', [insLag[Math.floor(insLag.length / 4)], insLag[Math.floor(insLag.length / 2)], insLag[Math.floor((3 * insLag.length) / 4)]]);
  fixture('miami-wasd-allocation', { layer, layerName: meta.name, editedAt: meta.editingInfo && new Date(meta.editingInfo.lastEditDate).toISOString(), declaredFields: meta.fields.map((f) => f.name) }, rows.slice(0, ROWS));
}

(async () => {
  const runs = [];
  if (want('raleigh-devplans')) runs.push(['raleigh-devplans', raleigh]);
  if (want('austin-site-plans') || want('austin-subdivisions')) runs.push(['austin', austin]);
  if (want('raleigh-plan-areas')) runs.push(['raleigh-plan-areas', raleighAreas]);
  if (want('miami-derm-sewer')) runs.push(['miami', miami]);
  if (want('miami-derm-lead')) runs.push(['miami-derm-lead', dermLead]);
  if (want('miami-wasd-allocation')) runs.push(['miami-wasd-allocation', wasd]);
  let failed = 0;
  for (const [k, fn] of runs) {
    try { await fn(); } catch (err) { failed += 1; log(`!! ${k} failed: ${err.stack || err.message}`); }
  }
  if (failed) process.exitCode = 1;
  // --pad: ~120 KB of filler after the report, so the log is too big to come
  // back inline through the GitHub tool and is saved as a file instead.
  if (args.pad) for (let i = 0; i < 2000; i += 1) log(`PAD ${'.'.repeat(56)}`);
})();
