// Milestone 1 data-feasibility measurements (docs/ROADMAP.md, M1).
//
// Answers, with numbers from the live sources rather than assumptions:
//   1. Contractor phone coverage and contact quality (Austin, Miami-Dade)
//   2. Publication lag: how long after issue a permit appears (Austin, via the
//      Socrata :created_at system field, if it is meaningful)
//   3. The "trade gap": after a residential building permit, how often and how
//      much later do electrical / mechanical / plumbing permits follow?
//   4. Miami-Dade coverage: which cities the county layer actually contains
//
// Read-only, polite (<= 2 requests/second), no dependencies. Run:
//   node recon/feasibility.js [--out=recon/out/feasibility] [--months=18]
// Writes report.md (human summary) and report.json (all numbers) to --out.
// CI runs it via .github/workflows/feasibility.yml (manual trigger).

const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const OUT = args.out || 'recon/out/feasibility';
const MONTHS = Number(args.months || 18);
const UA = 'permit-leads-feasibility/0.1 (research; read-only)';

const AUSTIN = 'https://data.austintexas.gov';
const AUSTIN_ID = '3syk-w9eu';
const MIAMI = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0';

const DAY = 864e5;
const today = new Date();
const isoDay = (d) => d.toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequest = 0;
async function getJson(url, { attempts = 4 } = {}) {
  for (let i = 1; ; i += 1) {
    const wait = 500 - (Date.now() - lastRequest);
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      const body = JSON.parse(text);
      if (body && body.error) throw new Error(`API error: ${JSON.stringify(body.error).slice(0, 300)}`);
      return body;
    } catch (err) {
      if (i >= attempts) throw new Error(`${err.message} <- ${url}`);
      await sleep(2000 * 2 ** (i - 1));
    }
  }
}

// ---------- small stats helpers ----------
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
function countBy(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = typeof key === 'function' ? key(r) : r[key]; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function buckets(deltas) {
  const b = { 'before or same day': 0, '1-7 days': 0, '8-30 days': 0, '31-90 days': 0, '91-180 days': 0 };
  for (const d of deltas) {
    if (d <= 0) b['before or same day'] += 1;
    else if (d <= 7) b['1-7 days'] += 1;
    else if (d <= 30) b['8-30 days'] += 1;
    else if (d <= 90) b['31-90 days'] += 1;
    else b['91-180 days'] += 1;
  }
  return b;
}
const digits = (p) => String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

// ---------- Austin ----------
async function austin(report) {
  const meta = await getJson(`${AUSTIN}/api/views/${AUSTIN_ID}.json`);
  const cols = meta.columns.map((c) => c.fieldName);
  const linkCols = cols.filter((c) => /project|master|parent|related|folder/i.test(c));
  report.austin = {
    rowsUpdatedAt: meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString() : null,
    columnCount: cols.length,
    columns: cols,
    possibleLinkColumns: linkCols,
  };

  const since = new Date(today); since.setUTCMonth(since.getUTCMonth() - MONTHS);
  const want = ['permit_number', 'permittype', 'permit_type_desc', 'permit_class_mapped', 'permit_class',
    'work_class', 'tcad_id', 'issue_date', 'applieddate', 'status_current', 'contractor_trade',
    'contractor_company_name', 'contractor_phone', 'total_job_valuation', ...linkCols]
    .filter((c, i, a) => cols.includes(c) && a.indexOf(c) === i);

  // Try to include Socrata system timestamps; fall back if the API refuses them.
  let select = [...want, ':created_at', ':updated_at'].join(',');
  let systemFields = true;
  const where = `issue_date >= '${isoDay(since)}T00:00:00'`;
  const pageUrl = (offset) => `${AUSTIN}/resource/${AUSTIN_ID}.json?$select=${encodeURIComponent(select)}`
    + `&$where=${encodeURIComponent(where)}&$order=${encodeURIComponent(':id')}&$limit=50000&$offset=${offset}`;
  let rows = [];
  try {
    for (let off = 0; ; off += 50000) {
      const page = await getJson(pageUrl(off));
      rows = rows.concat(page);
      if (page.length < 50000) break;
    }
  } catch (err) {
    systemFields = false;
    report.austin.systemFieldsError = err.message.slice(0, 300);
    select = want.join(',');
    rows = [];
    for (let off = 0; ; off += 50000) {
      const page = await getJson(pageUrl(off));
      rows = rows.concat(page);
      if (page.length < 50000) break;
    }
  }
  report.austin.rowsPulled = rows.length;
  report.austin.window = { from: isoDay(since), to: isoDay(today) };
  report.austin.permitTypes = countBy(rows, (r) => `${r.permittype || '?'} | ${r.permit_type_desc || '?'}`).slice(0, 15);

  // 1. contact coverage, last 90 days
  const d90 = isoDay(new Date(today - 90 * DAY));
  const recent = rows.filter((r) => (r.issue_date || '') >= d90);
  const withPhone = recent.filter((r) => digits(r.contractor_phone).length >= 10);
  const companies = new Set(recent.map((r) => (r.contractor_company_name || '').trim().toLowerCase()).filter(Boolean));
  const phoneToCompanies = new Map();
  for (const r of withPhone) {
    const p = digits(r.contractor_phone); const c = (r.contractor_company_name || '').trim().toLowerCase();
    if (!phoneToCompanies.has(p)) phoneToCompanies.set(p, new Set());
    if (c) phoneToCompanies.get(p).add(c);
  }
  report.austin.contact90d = {
    permits: recent.length,
    withContractorPhonePct: pct(withPhone.length, recent.length),
    withCompanyNamePct: pct(recent.filter((r) => r.contractor_company_name).length, recent.length),
    distinctCompanies: companies.size,
    distinctPhones: phoneToCompanies.size,
    phonesSharedByMultipleCompanies: [...phoneToCompanies.values()].filter((s) => s.size > 1).length,
    phoneCoverageByType: countBy(recent, 'permittype').slice(0, 8).map(([t, n]) => [t, n,
      pct(recent.filter((r) => r.permittype === t && digits(r.contractor_phone).length >= 10).length, n)]),
    contractorTradeValues: countBy(recent, 'contractor_trade').slice(0, 15),
  };

  // 2. publication lag via :created_at
  if (systemFields) {
    const d60 = isoDay(new Date(today - 60 * DAY));
    const lagRows = rows.filter((r) => (r.issue_date || '') >= d60 && r[':created_at']);
    const lags = lagRows.map((r) => (Date.parse(r[':created_at']) - Date.parse(r.issue_date)) / DAY);
    const createdDays = countBy(lagRows, (r) => r[':created_at'].slice(0, 10));
    report.austin.publicationLag60d = {
      permits: lagRows.length,
      lagDaysP10: quantile(lags, 0.1), lagDaysP50: quantile(lags, 0.5), lagDaysP90: quantile(lags, 0.9),
      // If most rows share one :created_at day, the dataset was bulk-reloaded and
      // :created_at says nothing about publication time. Then we need snapshots.
      topCreatedAtDays: createdDays.slice(0, 5),
      createdAtLooksLikeBulkReload: createdDays.length > 0 && createdDays[0][1] > 0.5 * lagRows.length,
    };
  }

  // 2b. Freshness proxy that doesn't depend on :created_at: permits per issue
  // day for the last 21 days against the median weekday count of days 22-90.
  // A low ratio for recent days means records arrive late.
  {
    const perDay = new Map(countBy(rows.filter((r) => r.issue_date), (r) => r.issue_date.slice(0, 10)));
    const weekday = (d) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return w > 0 && w < 6; };
    const ref = [];
    for (let i = 22; i <= 90; i += 1) { const d = isoDay(new Date(today - i * DAY)); if (weekday(d)) ref.push(perDay.get(d) || 0); }
    const baseline = quantile(ref, 0.5);
    const recentDays = [];
    for (let i = 0; i <= 21; i += 1) {
      const d = isoDay(new Date(today - i * DAY));
      if (weekday(d)) recentDays.push({ day: d, ageDays: i, permits: perDay.get(d) || 0, pctOfBaseline: pct(perDay.get(d) || 0, baseline) });
    }
    report.austin.arrivalByIssueAge = { baselineWeekdayPermits: baseline, recentDays };
  }

  // 3. trade gap
  const base = (pn) => String(pn || '').trim().replace(/\s+[A-Z]{2,3}$/, '');
  report.austin.permitNumberSamples = rows.slice(0, 8).map((r) => r.permit_number);
  report.austin.workClasses = countBy(rows.filter((r) => r.permittype === 'BP'), (r) => `${r.permit_class_mapped || '?'} | ${r.work_class || '?'}`).slice(0, 20);

  const byBase = new Map(); const byParcel = new Map(); const byMaster = new Map();
  const masterCol = cols.includes('masterpermitnum') ? 'masterpermitnum' : null;
  const push = (m, k, r) => { if (!m.has(k)) m.set(k, []); m.get(k).push(r); };
  for (const r of rows) {
    if (!r.issue_date) continue;
    const b = base(r.permit_number);
    if (b) push(byBase, b, r);
    if (r.tcad_id) push(byParcel, r.tcad_id, r);
    if (masterCol && r[masterCol]) push(byMaster, String(r[masterCol]).trim(), r);
  }
  report.austin.masterPermitColumn = masterCol;
  report.austin.pctRowsWithMasterPermit = masterCol ? pct(rows.filter((r) => r[masterCol]).length, rows.length) : null;
  const company = (r) => (r.contractor_company_name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const cutoff = isoDay(new Date(today - 180 * DAY)); // primaries need 180 days of follow-up
  const isPrimary = (r) => r.permittype === 'BP' && /resid/i.test(r.permit_class_mapped || '')
    && /new|addition|remodel|alteration/i.test(r.work_class || '') && r.issue_date && r.issue_date.slice(0, 10) <= cutoff;
  const primaries = rows.filter(isPrimary);
  const trades = { EP: 'electrical', MP: 'mechanical (HVAC)', PP: 'plumbing' };
  const gap = { primaries: primaries.length, byWorkClass: countBy(primaries, 'work_class').slice(0, 8), link: {} };
  const modes = [['permit-number base', byBase, (r) => base(r.permit_number)], ['parcel (tcad_id) within -30..+180 days', byParcel, (r) => r.tcad_id]];
  // A trade permit can hang off the building permit's own number or share its master.
  if (masterCol) modes.push(['master permit (masterpermitnum)', byMaster, (r) => (r[masterCol] ? String(r[masterCol]).trim() : String(r.permit_number || '').trim())]);
  for (const [mode, index, keyOf] of modes) {
    const out = {};
    for (const [code, name] of Object.entries(trades)) {
      const deltas = []; let linked = 0; let sameCompany = 0; let bothNamed = 0;
      for (const p of primaries) {
        const k = keyOf(p); if (!k) continue;
        const sibs = (index.get(k) || []).filter((s) => s.permittype === code && s !== p)
          .map((s) => [s, daysBetween(p.issue_date, s.issue_date)]).filter(([, d]) => d >= -30 && d <= 180)
          .sort((a, b) => a[1] - b[1]);
        if (!sibs.length) continue;
        linked += 1; deltas.push(sibs[0][1]);
        // If the building permit's company also pulls the trade permit, the trade
        // work was never open to an outside sub: no lead.
        const a = company(p); const b = company(sibs[0][0]);
        if (a && b) { bothNamed += 1; if (a === b) sameCompany += 1; }
      }
      out[name] = {
        primariesWithThisTrade: linked,
        pctOfPrimaries: pct(linked, primaries.length),
        medianDaysAfterBuildingPermit: quantile(deltas, 0.5),
        p25: quantile(deltas, 0.25), p75: quantile(deltas, 0.75),
        timing: buckets(deltas),
        pctIssuedAtLeast7DaysLater: pct(deltas.filter((d) => d >= 7).length, deltas.length),
        pctSameCompanyAsBuildingPermit: pct(sameCompany, bothNamed),
      };
    }
    gap.link[mode] = out;
  }
  report.austin.tradeGap = gap;
}

// ---------- Austin :updated_at behaviour (sync-mode decision) ----------
// The updated_at sync mode only works if :updated_at moves when a row really
// changes. If the publisher reloads the whole dataset, every row's :updated_at
// moves at once and an "incremental" sync would pull millions of rows.
async function austinUpdatedAt(report) {
  const soql = async (select, where) => {
    const q = new URLSearchParams({ $select: select });
    if (where) q.set('$where', where);
    return getJson(`${AUSTIN}/resource/${AUSTIN_ID}.json?${q}`);
  };
  const out = {};
  out.total = Number((await soql('count(*) as n'))[0].n);
  const [range] = await soql('min(:updated_at) as min_u, max(:updated_at) as max_u, min(:created_at) as min_c, max(:created_at) as max_c');
  out.range = range;
  const ts = (d) => `'${new Date(today - d * DAY).toISOString().slice(0, 19)}'`;
  out.updatedWithin = {};
  for (const d of [1, 2, 3, 7, 30]) out.updatedWithin[`${d}d`] = Number((await soql('count(*) as n', `:updated_at >= ${ts(d)}`))[0].n);
  out.createdWithin = {};
  for (const d of [1, 2, 3, 7, 30]) out.createdWithin[`${d}d`] = Number((await soql('count(*) as n', `:created_at >= ${ts(d)}`))[0].n);
  // Top :updated_at days over the last 30 days.
  const q = new URLSearchParams({
    $select: "date_trunc_ymd(to_floating_timestamp(:updated_at, 'UTC')) as day, count(*) as n", $where: `:updated_at >= ${ts(30)}`,
    $group: 'day', $order: 'day DESC', $limit: '40',
  });
  try {
    out.updatedByDay = (await getJson(`${AUSTIN}/resource/${AUSTIN_ID}.json?${q}`)).map((r) => [String(r.day).slice(0, 10), Number(r.n)]);
  } catch (err) { out.updatedByDay = []; out.updatedByDayError = err.message.slice(0, 200); }
  // If :updated_at is useless, a status-change window needs statusdate: how
  // many rows change status per week, and how many of those were issued long
  // ago (an issue_date window would miss them)?
  try {
    out.statusChangedWithin7d = Number((await soql('count(*) as n', `statusdate >= ${ts(7)}`))[0].n);
    out.statusChangedWithin7dIssuedOver30dAgo = Number((await soql('count(*) as n', `statusdate >= ${ts(7)} AND issue_date < ${ts(30)}`))[0].n);
    out.statusDateNull = Number((await soql('count(*) as n', 'statusdate IS NULL'))[0].n);
    out.issuedWithin7d = Number((await soql('count(*) as n', `issue_date >= ${ts(7)}`))[0].n);
    out.statusDateMax = (await soql('max(statusdate) as m'))[0].m;
  } catch (err) { out.statusDateError = err.message.slice(0, 200); }
  out.verdict = out.updatedWithin['2d'] > 0.5 * out.total
    ? 'bulk: most rows move together, so updated_at mode would re-pull the dataset. Use a date_window plus hash diff instead'
    : 'incremental: only a small share of rows move per day, so updated_at mode is viable';
  report.austinUpdatedAt = out;
}

// ---------- Austin sync windows, through the real adapter (ADR-11) ----------
async function austinWindows(report) {
  const { SOURCES } = require('../src/sources.js');
  const { fetchSocrataSource } = require('../src/adapters/socrata.js');
  const source = SOURCES['austin-tx'];
  const quiet = { info() {}, warning() {}, error() {} };
  let meta = null; let rawCount = 0;
  const started = Date.now();
  const permits = await fetchSocrataSource(source, {
    windows: source.syncWindows, maxRecords: source.maxPerRun, log: quiet,
    onRaw: (rows, m) => { meta = m; rawCount = rows.length; },
  });
  report.austinWindows = {
    windows: source.syncWindows, maxPerRun: source.maxPerRun, rawRows: rawCount, permits: permits.length,
    requests: meta && meta.requests, truncated: meta && meta.truncated, seconds: Math.round((Date.now() - started) / 1000),
    withPhonePct: pct(permits.filter((p) => digits(p.contractorPhone).length >= 10).length, permits.length),
  };
}

// ---------- Miami-Dade window through the real adapter ----------
async function miamiWindow(report) {
  const { SOURCES } = require('../src/sources.js');
  const { fetchArcgisSource } = require('../src/adapters/arcgis.js');
  const source = SOURCES['miami-dade-fl'];
  const warnings = [];
  const log = { info() {}, warning: (m) => warnings.push(m), error() {} };
  let meta = null; let raw = [];
  const started = Date.now();
  const permits = await fetchArcgisSource(source, {
    daysBack: 14, maxRecords: source.maxPerRun, log, onRaw: (rows, m) => { meta = m; raw = rows; },
  });
  const keys = raw.map((r) => r.PermitNumber);
  report.miamiWindow = {
    daysBack: 14, maxPerRun: source.maxPerRun, rawRows: raw.length, distinctKeys: new Set(keys).size, permits: permits.length,
    requests: meta && meta.requests, seconds: Math.round((Date.now() - started) / 1000), retries: warnings.length,
    newestIssued: permits.map((p) => p.filedDate).filter(Boolean).sort().at(-1) || null,
    withPhonePct: pct(permits.filter((p) => digits(p.contractorPhone).length >= 10).length, permits.length),
  };
}

// ---------- Miami-Dade ----------
async function miami(report) {
  const layer = await getJson(`${MIAMI}?f=json`);
  report.miami = {
    dataLastEditDate: layer.editingInfo?.dataLastEditDate ? new Date(layer.editingInfo.dataLastEditDate).toISOString() : null,
    fields: layer.fields.map((f) => f.name),
  };
  const fields = ['PermitNumber', 'MasterPermitNumber', 'PermitType', 'ApplicationTypeDescription', 'ResidentialCommercial',
    'PermitIssuedDate', 'FolioNumber', 'City', 'ContractorName', 'ContractorPhone'].filter((f) => report.miami.fields.includes(f));
  // Whole-layer facts from the server, not from a sample.
  const total = await getJson(`${MIAMI}/query?where=1%3D1&returnCountOnly=true&f=json`);
  report.miami.totalRows = total.count;
  const stats = await getJson(`${MIAMI}/query?where=1%3D1&outStatistics=${encodeURIComponent(JSON.stringify([
    { statisticType: 'max', onStatisticField: 'PermitIssuedDate', outStatisticFieldName: 'maxIssued' },
    { statisticType: 'min', onStatisticField: 'PermitIssuedDate', outStatisticFieldName: 'minIssued' }]))}&f=json`);
  const st = stats.features?.[0]?.attributes || {};
  const asIso = (v) => (v == null ? null : typeof v === 'number' ? new Date(v).toISOString().slice(0, 10) : String(v).slice(0, 10));
  report.miami.layerIssuedRange = { min: asIso(st.minIssued), max: asIso(st.maxIssued) };
  // Then pull only the analysis window.
  const since = new Date(today); since.setUTCMonth(since.getUTCMonth() - MONTHS);
  const where = encodeURIComponent(`PermitIssuedDate >= TIMESTAMP '${isoDay(since)} 00:00:00'`);
  const windowCount = await getJson(`${MIAMI}/query?where=${where}&returnCountOnly=true&f=json`);
  report.miami.windowRows = windowCount.count;
  let rows = [];
  for (let off = 0; ; off += 1000) {
    const q = `${MIAMI}/query?where=${where}&outFields=${fields.join(',')}&orderByFields=ObjectId&resultOffset=${off}&resultRecordCount=1000&f=json`;
    const page = await getJson(q);
    rows = rows.concat((page.features || []).map((f) => f.attributes));
    if (!page.exceededTransferLimit && (page.features || []).length < 1000) break;
    if (off > 1000000) throw new Error('Miami-Dade window larger than 1M rows; narrow --months');
  }
  if (windowCount.count != null && rows.length !== windowCount.count) report.miami.pullMismatch = { expected: windowCount.count, got: rows.length };
  const toIso = (v) => (typeof v === 'number' ? new Date(v).toISOString().slice(0, 10) : String(v || '').slice(0, 10));
  for (const r of rows) r.issued = toIso(r.PermitIssuedDate);
  const issued = rows.map((r) => r.issued).filter(Boolean).sort();
  report.miami.rowsPulled = rows.length;
  report.miami.issuedRange = { min: issued[0], max: issued.at(-1) };
  report.miami.withContractorPhonePct = pct(rows.filter((r) => digits(r.ContractorPhone).length >= 10).length, rows.length);
  report.miami.distinctPermitNumbers = new Set(rows.map((r) => r.PermitNumber)).size;
  report.miami.cities = countBy(rows, (r) => (r.City || '(blank)').trim().toUpperCase()).slice(0, 30);
  report.miami.permitTypes = countBy(rows, 'PermitType').slice(0, 15);
  report.miami.applicationTypes = countBy(rows, 'ApplicationTypeDescription').slice(0, 20);
  const withMaster = rows.filter((r) => r.MasterPermitNumber && String(r.MasterPermitNumber).trim() && r.MasterPermitNumber !== r.PermitNumber);
  report.miami.pctWithMasterPermitDifferentFromOwn = pct(withMaster.length, rows.length);
  report.miami.masterSamples = withMaster.slice(0, 8).map((r) => [r.PermitNumber, r.MasterPermitNumber, r.PermitType, r.City]);
  report.miami.distinctMasters = new Set(withMaster.map((r) => String(r.MasterPermitNumber).trim())).size;
  // Trade gap by master permit: a building-type master and its trade children.
  const byMaster = new Map();
  for (const r of rows) {
    const m = r.MasterPermitNumber && String(r.MasterPermitNumber).trim();
    if (!m) continue; if (!byMaster.has(m)) byMaster.set(m, []); byMaster.get(m).push(r);
  }
  const byNumber = new Map(rows.map((r) => [r.PermitNumber, r]));
  const childTypes = countBy(withMaster, 'PermitType').slice(0, 10);
  const deltas = {};
  for (const [m, kids] of byMaster) {
    const parent = byNumber.get(m);
    if (!parent || !parent.issued) continue;
    for (const k of kids) {
      if (k.PermitNumber === m || !k.issued) continue;
      (deltas[k.PermitType] ||= []).push(daysBetween(parent.issued, k.issued));
    }
  }
  report.miami.childPermitTypesUnderAMaster = childTypes;
  report.miami.childTimingByType = Object.fromEntries(Object.entries(deltas)
    .sort((a, b) => b[1].length - a[1].length).slice(0, 6)
    .map(([t, ds]) => [t, { n: ds.length, medianDays: quantile(ds, 0.5), p75: quantile(ds, 0.75), timing: buckets(ds) }]));
}

// ---------- report ----------
function markdown(r) {
  const L = [];
  L.push(`# Data feasibility report`, '', `Generated ${r.generatedAt}. Window: last ${MONTHS} months. All numbers computed from live API responses by \`recon/feasibility.js\`.`, '');
  if (r.austin) {
    const a = r.austin;
    L.push('## Austin', '', `Rows pulled: ${a.rowsPulled} (${a.window.from} to ${a.window.to}). Dataset rows updated: ${a.rowsUpdatedAt}.`, '');
    L.push(`Possible project-link columns: ${a.possibleLinkColumns.length ? a.possibleLinkColumns.join(', ') : 'none'}. Permit number samples: ${a.permitNumberSamples.join(' · ')}`, '');
    const c = a.contact90d;
    L.push('### Contact coverage (last 90 days)', '', `| Measure | Value |`, `| --- | --- |`,
      `| Permits | ${c.permits} |`, `| With contractor phone | ${c.withContractorPhonePct}% |`, `| With company name | ${c.withCompanyNamePct}% |`,
      `| Distinct companies | ${c.distinctCompanies} |`, `| Distinct phones | ${c.distinctPhones} |`, `| Phones shared by 2+ company names | ${c.phonesSharedByMultipleCompanies} |`, '');
    L.push('Phone coverage by permit type: ' + c.phoneCoverageByType.map(([t, n, p]) => `${t} ${p}% of ${n}`).join(' · '), '');
    if (a.publicationLag60d) {
      const p = a.publicationLag60d;
      L.push('### Publication lag (last 60 days, from `:created_at`)', '', `p10 ${p.lagDaysP10?.toFixed?.(1)} d · p50 ${p.lagDaysP50?.toFixed?.(1)} d · p90 ${p.lagDaysP90?.toFixed?.(1)} d over ${p.permits} permits. Bulk reload suspected: **${p.createdAtLooksLikeBulkReload}** (top created days: ${p.topCreatedAtDays.map(([d, n]) => `${d}: ${n}`).join(', ')}).`, '');
    } else {
      L.push('### Publication lag', '', `Not measurable from system fields: ${a.systemFieldsError}`, '');
    }
    if (a.arrivalByIssueAge) {
      const f = a.arrivalByIssueAge;
      L.push('### Arrival by issue-date age (freshness proxy)', '', `Baseline: median ${f.baselineWeekdayPermits} permits per weekday (days 22-90). Recent weekdays, as % of baseline:`, '',
        f.recentDays.map((d) => `${d.day} (age ${d.ageDays}): ${d.permits} = ${d.pctOfBaseline}%`).join(' · '), '');
    }
    if (a.masterPermitColumn) L.push(`Rows with \`${a.masterPermitColumn}\`: ${a.pctRowsWithMasterPermit}%.`, '');
    L.push('### Trade gap', '', `Primary permits: residential building permits (BP) for new / addition / remodel work issued at least 180 days ago: **${a.tradeGap.primaries}**.`, '');
    for (const [mode, trades] of Object.entries(a.tradeGap.link)) {
      L.push(`Linked by ${mode}:`, '', '| Trade | Share of primaries with this trade permit | Median days after building permit | Issued 7+ days later | Same company as building permit |', '| --- | --- | --- | --- | --- |');
      for (const [t, v] of Object.entries(trades)) L.push(`| ${t} | ${v.pctOfPrimaries}% (${v.primariesWithThisTrade}) | ${v.medianDaysAfterBuildingPermit} | ${v.pctIssuedAtLeast7DaysLater}% | ${v.pctSameCompanyAsBuildingPermit}% |`);
      L.push('');
    }
  }
  if (r.miami) {
    const m = r.miami;
    L.push('## Miami-Dade', '', `Whole layer: ${m.totalRows} rows, issued ${m.layerIssuedRange.min} to ${m.layerIssuedRange.max}. Layer last edited: ${m.dataLastEditDate}.`, '',
      `Window (last ${MONTHS} months): ${m.windowRows} rows on the server, ${m.rowsPulled} pulled (issued ${m.issuedRange.min} to ${m.issuedRange.max})${m.pullMismatch ? ' **MISMATCH**' : ''}. Distinct permit numbers: ${m.distinctPermitNumbers}. Distinct masters: ${m.distinctMasters}.`, '',
      'Master samples (permit, master, type, city): ' + m.masterSamples.map((x) => x.join(' / ')).join(' · '), '',
      `With contractor phone: **${m.withContractorPhonePct}%**. Rows whose master permit differs from their own number: ${m.pctWithMasterPermitDifferentFromOwn}%.`, '',
      'Top cities: ' + m.cities.slice(0, 15).map(([c, n]) => `${c} ${n}`).join(' · '), '',
      'Child timing under a master permit: ' + Object.entries(m.childTimingByType).map(([t, v]) => `${t}: n=${v.n}, median ${v.medianDays} d`).join(' · '), '');
  }
  if (r.austinWindows) {
    const w = r.austinWindows;
    L.push('## Austin sync windows (real adapter)', '', `${w.windows.map((x) => `${x.field} ${x.days}d`).join(' + ')}: ${w.rawRows} raw rows, ${w.permits} permits, ${w.requests} requests, ${w.seconds}s, truncated: **${w.truncated}** (cap ${w.maxPerRun}). Phone on ${w.withPhonePct}%.`, '');
  }
  if (r.miamiWindow) {
    const w = r.miamiWindow;
    L.push('## Miami-Dade window (real adapter)', '', `Last ${w.daysBack} days: ${w.rawRows} raw rows (${w.distinctKeys} distinct permit numbers), ${w.permits} permits, ${w.requests} requests, ${w.retries} retries, ${w.seconds}s (cap ${w.maxPerRun}). Newest issue date ${w.newestIssued}. Phone on ${w.withPhonePct}%.`, '');
  }
  if (r.austinUpdatedAt) {
    const u = r.austinUpdatedAt;
    L.push('## Austin `:updated_at` behaviour', '', `Rows: ${u.total}. :updated_at ${u.range.min_u} to ${u.range.max_u}; :created_at ${u.range.min_c} to ${u.range.max_c}.`, '',
      'Updated within: ' + Object.entries(u.updatedWithin).map(([k, v]) => `${k} ${v}`).join(' · '), '',
      'Created within: ' + Object.entries(u.createdWithin).map(([k, v]) => `${k} ${v}`).join(' · '), '',
      'Updated by day: ' + u.updatedByDay.map(([d, n]) => `${d}: ${n}`).join(' · '), '',
      `statusdate: max ${u.statusDateMax}; changed in last 7 days ${u.statusChangedWithin7d}, of which issued 30+ days ago ${u.statusChangedWithin7dIssuedOver30dAgo}; NULL ${u.statusDateNull}. Issued in last 7 days: ${u.issuedWithin7d}.${u.statusDateError ? ` Error: ${u.statusDateError}` : ''}`, '',
      `**Verdict:** ${u.verdict}`, '');
  }
  if (r.errors.length) L.push('## Errors', '', ...r.errors.map((e) => `- ${e}`), '');
  return L.join('\n');
}

async function main() {
  const report = { generatedAt: new Date().toISOString(), errors: [] };
  const ALL = [['austin', austin], ['austinUpdatedAt', austinUpdatedAt], ['austinWindows', austinWindows], ['miamiWindow', miamiWindow], ['miami', miami]];
  const only = args.only ? String(args.only).split(',') : null;
  const jobs = only ? ALL.filter(([n]) => only.includes(n)) : ALL;
  for (const [name, fn] of jobs) {
    try { await fn(report); } catch (err) { report.errors.push(`${name}: ${err.message}`); console.error(`${name} failed:`, err.message); }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const md = markdown(report);
  fs.writeFileSync(path.join(OUT, 'report.md'), md);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  if (report.errors.length === jobs.length) process.exitCode = 1;
}

main();
