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

  // 3. trade gap
  const base = (pn) => String(pn || '').trim().replace(/\s+[A-Z]{2,3}$/, '');
  report.austin.permitNumberSamples = rows.slice(0, 8).map((r) => r.permit_number);
  report.austin.workClasses = countBy(rows.filter((r) => r.permittype === 'BP'), (r) => `${r.permit_class_mapped || '?'} | ${r.work_class || '?'}`).slice(0, 20);

  const byBase = new Map(); const byParcel = new Map();
  for (const r of rows) {
    if (!r.issue_date) continue;
    const b = base(r.permit_number);
    if (b) { if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(r); }
    if (r.tcad_id) { if (!byParcel.has(r.tcad_id)) byParcel.set(r.tcad_id, []); byParcel.get(r.tcad_id).push(r); }
  }
  const cutoff = isoDay(new Date(today - 180 * DAY)); // primaries need 180 days of follow-up
  const isPrimary = (r) => r.permittype === 'BP' && /resid/i.test(r.permit_class_mapped || '')
    && /new|addition|remodel|alteration/i.test(r.work_class || '') && r.issue_date && r.issue_date.slice(0, 10) <= cutoff;
  const primaries = rows.filter(isPrimary);
  const trades = { EP: 'electrical', MP: 'mechanical (HVAC)', PP: 'plumbing' };
  const gap = { primaries: primaries.length, byWorkClass: countBy(primaries, 'work_class').slice(0, 8), link: {} };
  for (const [mode, index, keyOf] of [['permit-number base', byBase, (r) => base(r.permit_number)], ['parcel (tcad_id) within -30..+180 days', byParcel, (r) => r.tcad_id]]) {
    const out = {};
    for (const [code, name] of Object.entries(trades)) {
      const deltas = []; let linked = 0;
      for (const p of primaries) {
        const k = keyOf(p); if (!k) continue;
        const sibs = (index.get(k) || []).filter((s) => s.permittype === code);
        const ds = sibs.map((s) => daysBetween(p.issue_date, s.issue_date)).filter((d) => d >= -30 && d <= 180);
        if (ds.length) { linked += 1; deltas.push(Math.min(...ds)); }
      }
      out[name] = {
        primariesWithThisTrade: linked,
        pctOfPrimaries: pct(linked, primaries.length),
        medianDaysAfterBuildingPermit: quantile(deltas, 0.5),
        p25: quantile(deltas, 0.25), p75: quantile(deltas, 0.75),
        timing: buckets(deltas),
        pctIssuedAtLeast7DaysLater: pct(deltas.filter((d) => d >= 7).length, deltas.length),
      };
    }
    gap.link[mode] = out;
  }
  report.austin.tradeGap = gap;
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
  let rows = [];
  for (let off = 0; ; off += 1000) {
    const q = `${MIAMI}/query?where=1%3D1&outFields=${fields.join(',')}&orderByFields=ObjectId&resultOffset=${off}&resultRecordCount=1000&f=json`;
    const page = await getJson(q);
    rows = rows.concat((page.features || []).map((f) => f.attributes));
    if (!page.exceededTransferLimit && (page.features || []).length < 1000) break;
    if (off > 400000) break; // hard stop
  }
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
  report.miami.masterSamples = withMaster.slice(0, 5).map((r) => [r.PermitNumber, r.MasterPermitNumber, r.PermitType]);
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
    L.push('### Trade gap', '', `Primary permits: residential building permits (BP) for new / addition / remodel work issued at least 180 days ago: **${a.tradeGap.primaries}**.`, '');
    for (const [mode, trades] of Object.entries(a.tradeGap.link)) {
      L.push(`Linked by ${mode}:`, '', '| Trade | Share of primaries with this trade permit | Median days after building permit | Issued 7+ days later |', '| --- | --- | --- | --- |');
      for (const [t, v] of Object.entries(trades)) L.push(`| ${t} | ${v.pctOfPrimaries}% (${v.primariesWithThisTrade}) | ${v.medianDaysAfterBuildingPermit} | ${v.pctIssuedAtLeast7DaysLater}% |`);
      L.push('');
    }
  }
  if (r.miami) {
    const m = r.miami;
    L.push('## Miami-Dade', '', `Rows pulled: ${m.rowsPulled} (issued ${m.issuedRange.min} to ${m.issuedRange.max}). Layer last edited: ${m.dataLastEditDate}. Distinct permit numbers: ${m.distinctPermitNumbers}.`, '',
      `With contractor phone: **${m.withContractorPhonePct}%**. Rows whose master permit differs from their own number: ${m.pctWithMasterPermitDifferentFromOwn}%.`, '',
      'Top cities: ' + m.cities.slice(0, 15).map(([c, n]) => `${c} ${n}`).join(' · '), '',
      'Child timing under a master permit: ' + Object.entries(m.childTimingByType).map(([t, v]) => `${t}: n=${v.n}, median ${v.medianDays} d`).join(' · '), '');
  }
  if (r.errors.length) L.push('## Errors', '', ...r.errors.map((e) => `- ${e}`), '');
  return L.join('\n');
}

async function main() {
  const report = { generatedAt: new Date().toISOString(), errors: [] };
  for (const [name, fn] of [['austin', austin], ['miami', miami]]) {
    try { await fn(report); } catch (err) { report.errors.push(`${name}: ${err.message}`); console.error(`${name} failed:`, err.message); }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const md = markdown(report);
  fs.writeFileSync(path.join(OUT, 'report.md'), md);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  if (report.errors.length === 2) process.exitCode = 1;
}

main();
