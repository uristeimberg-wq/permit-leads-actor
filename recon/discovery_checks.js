// Read-only checks on the discovery-scan candidates (recon/discovery_scan.js),
// before any connector: vocabularies, keys that link to our permit sources,
// how often the link finds a permit, lead time, and linked pairs to read by
// hand. Names that look like a person's are masked.
//
//   miami-tree      City of Miami tree permits -> City of Miami permits by plan number
//   raleigh-row     Raleigh right-of-way occupancy permits -> building permits by PIN
//   raleigh-pending Raleigh Building_Permits_Pending vs Building_Permits (overlap)
//   miami-norc      Miami-Dade WASD notices of required connection -> county permits by folio
//   miami-hearing   Miami-Dade zoning hearings (Land Management) -> county permits by folio
//
//   node recon/discovery_checks.js [--only=miami-tree,...] [--pairs=30] [--pad]
// CI: feasibility.yml input `discover` = 'checks' or 'checks:<list>'.

const { partyKind } = require('../src/contractors.js');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const ONLY = args.only ? String(args.only).split(',') : null;
const want = (k) => !ONLY || ONLY.includes(k);
const PAIRS = Number(args.pairs || 30);
const UA = 'permit-leads-discovery-checks/0.1 (research; read-only)';
const DAY = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const show = (k, v) => log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const section = (k) => log(`\n==================== ${k} ====================`);
const day = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString().slice(0, 10));
const txt = (s, n = 80) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const mask = (s) => (s && partyKind(String(s)) === 'individual' ? '[person]' : txt(s, 50));
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const quart = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return { n: 0 };
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p25: q(0.25), median: q(0.5), p75: q(0.75), min: s[0], max: s[s.length - 1] };
};
const vocab = (rows, f, n = 15) => Object.entries(rows.reduce((m, r) => ((m[r[f]] = (m[r[f]] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, n);
const fill = (rows, fields) => Object.fromEntries(fields.map((f) => [f, rows.length ? Math.round((1000 * rows.filter((r) => r[f] != null && String(r[f]).trim() !== '').length) / rows.length) / 10 : null]));
const ts = (days) => `TIMESTAMP '${new Date(Date.now() - days * DAY).toISOString().slice(0, 19).replace('T', ' ')}'`;

let last = 0;
async function get(url, attempts = 3) {
  for (let i = 1; ; i += 1) {
    const wait = 500 - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
      const out = JSON.parse(text);
      if (out && out.error) throw new Error(`API error: ${JSON.stringify(out.error).slice(0, 200)}`);
      return out;
    } catch (err) {
      if (i >= attempts) throw new Error(`${err.message} <- ${url.slice(0, 200)}`);
      await sleep(2000 * i);
    }
  }
}
async function rows(layer, { where = '1=1', order, n = 2000, fields = '*', pages = 1 } = {}) {
  const out = [];
  for (let p = 0; p < pages; p += 1) {
    const q = new URLSearchParams({ where, outFields: fields, returnGeometry: 'false', resultRecordCount: String(n), resultOffset: String(p * n), f: 'json' });
    if (order) q.set('orderByFields', order);
    const got = (await get(`${layer}/query?${q}`)).features.map((f) => f.attributes);
    out.push(...got);
    if (got.length < n) break;
  }
  return out;
}
async function rowsIn(layer, field, values, opts = {}) {
  const out = [];
  for (const c of chunks([...new Set(values)].filter(Boolean), 50)) out.push(...await rows(layer, { ...opts, where: `${field} IN (${c.map(quote).join(',')})` }));
  return out;
}

const RAL = 'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services';
const MD = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services';
const CM = 'https://services1.arcgis.com/CvuPhqcTQpZPT9qY/arcgis/rest/services';
const RAL_BP = `${RAL}/Building_Permits/FeatureServer/0`;
const MD_PERMITS = `${MD}/miamidade_permit_data/FeatureServer/0`;
const CM_PERMITS = `${CM}/Building_Permits_Since_2014/FeatureServer/0`;

// ------------------------------------------------------------------ Miami trees
async function miamiTree() {
  section('miami-tree');
  const layer = `${CM}/Tree_Permits/FeatureServer/0`;
  const t = await rows(layer, { where: `ReviewStatusChangedDate >= ${ts(365)}`, order: 'ReviewStatusChangedDate DESC', pages: 3 });
  show('tree rows changed in 365 days', t.length);
  show('ReviewStatus', vocab(t, 'ReviewStatus'));
  show('PlanNumber patterns', vocab(t.map((r) => ({ p: String(r.PlanNumber || '').replace(/\d/g, '9') })), 'p', 10));
  show('rows per PlanNumber', quart(Object.values(t.reduce((m, r) => ((m[r.PlanNumber] = (m[r.PlanNumber] || 0) + 1), m), {}))));
  const plans = [...new Set(t.map((r) => r.PlanNumber).filter(Boolean))];
  // City permit numbers look like BD26009606001E001; tree PlanNumber like BD13025553001.
  const byPermit = await rowsIn(CM_PERMITS, 'PermitNumber', plans, { fields: 'PermitNumber,ApplicationNumber,IssuedDate,ScopeofWork,CompanyName' });
  const apps = [...new Set(plans.map((p) => String(p).slice(0, 10)))];
  const byApp = await rowsIn(CM_PERMITS, 'ApplicationNumber', apps, { fields: 'PermitNumber,ApplicationNumber,IssuedDate,ScopeofWork,CompanyName,DeliveryAddress' });
  show('distinct plan numbers', plans.length);
  show('plan numbers equal to a permit PermitNumber', new Set(byPermit.map((r) => r.PermitNumber)).size);
  show('plan numbers whose first 10 chars equal a permit ApplicationNumber', new Set(byApp.map((r) => r.ApplicationNumber)).size + ` of ${apps.length} application prefixes`);
  const firstIssue = new Map();
  for (const r of byApp.concat(byPermit)) {
    const k = String(r.ApplicationNumber || r.PermitNumber).slice(0, 10);
    if (r.IssuedDate != null && (!firstIssue.has(k) || r.IssuedDate < firstIssue.get(k).IssuedDate)) firstIssue.set(k, r);
  }
  const leads = []; let before = 0; let none = 0;
  for (const r of t) {
    const k = String(r.PlanNumber || '').slice(0, 10);
    const p = firstIssue.get(k);
    if (!p) { none += 1; continue; }
    const d = Math.round((p.IssuedDate - r.ReviewStatusChangedDate) / DAY);
    leads.push(d); if (d > 0) before += 1;
  }
  // Does the application number join the same property? House number and
  // first street word of the tree row against every permit on the application.
  const norm = (a) => { const m = String(a || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').trim().split(/\s+/); return m.length > 1 ? `${m[0]} ${m.slice(1).find((w) => !/^(N|S|E|W|NE|NW|SE|SW)$/.test(w)) || ''}` : null; };
  const addrsByApp = byApp.reduce((m, r) => ((m[r.ApplicationNumber] = (m[r.ApplicationNumber] || new Set()).add(norm(r.DeliveryAddress))), m), {});
  let agree = 0; let disagree = 0; const off = [];
  for (const r of t) {
    const set = addrsByApp[String(r.PlanNumber || '').slice(0, 10)];
    if (!set || !norm(r.PropertyAddress)) continue;
    if (set.has(norm(r.PropertyAddress))) agree += 1; else { disagree += 1; if (off.length < 15) off.push(`${r.PlanNumber} ${txt(r.PropertyAddress, 40)} vs ${[...set].join(' / ')}`); }
  }
  show('address agreement on joined rows (house number + street word)', `${agree} agree, ${disagree} differ`);
  for (const o of off) log(`  differs: ${o}`);
  show('tree rows with no issued city permit on that application yet', `${none} of ${t.length}`);
  show('tree status change -> first issued permit (days; positive = tree row first)', quart(leads));
  show('tree rows dated before the first issued permit', `${before} of ${leads.length}`);
  log(`\n-- ${PAIRS} pairs: TREE ROW || FIRST ISSUED PERMIT ON THE APPLICATION`);
  let n = 0;
  for (const r of t) {
    if (n >= PAIRS) break;
    const p = firstIssue.get(String(r.PlanNumber || '').slice(0, 10));
    if (!p) continue;
    n += 1;
    log(`TREE ${r.PlanNumber} [${txt(r.ReviewStatus, 20)} ${day(r.ReviewStatusChangedDate)}] @ ${txt(r.PropertyAddress, 40)} -> ${p.PermitNumber} issued ${day(p.IssuedDate)} | ${txt(p.ScopeofWork, 100)} | ${mask(p.CompanyName)}`);
  }
}

// ---------------------------------------------------------------- Raleigh ROW
async function raleighRow() {
  section('raleigh-row');
  const layer = `${RAL}/Right_of_Way_Occupancy_Permit_Locations/FeatureServer/0`;
  const meta = await get(`${layer}?f=json`);
  show('fields', meta.fields.map((f) => f.name));
  const r = await rows(layer, { where: `application_date >= ${ts(365)}`, order: 'application_date DESC', pages: 2 });
  show('applications in 365 days (read)', r.length);
  show('permit_status', vocab(r, 'permit_status'));
  show('fill', fill(r, meta.fields.map((f) => f.name)));
  show('description words', vocab(r.map((x) => ({ d: txt(x.description, 30).toUpperCase() })), 'd', 25));
  show('company_name kinds', vocab(r.map((x) => ({ k: x.company_name ? partyKind(String(x.company_name)) : 'missing' })), 'k'));
  show('top companies (business only)', vocab(r.filter((x) => x.company_name && partyKind(String(x.company_name)) !== 'individual'), 'company_name', 20));
  show('days application -> issue', quart(r.filter((x) => x.issue_date).map((x) => Math.round((x.issue_date - x.application_date) / DAY))));
  show('days application -> work begins', quart(r.filter((x) => x.work_will_begin_on).map((x) => Math.round((x.work_will_begin_on - x.application_date) / DAY))));
  // Link: building permits on the same PIN, applied within 2 years before or after.
  const pins = [...new Set(r.map((x) => String(x.pin_number || '').trim()).filter((p) => /^\d{10}$/.test(p)))];
  show('distinct 10-digit PINs', pins.length);
  const bp = await rowsIn(RAL_BP, 'pin', pins.slice(0, 1500), { fields: 'pin,permitnum,applieddate,issueddate,workclassmapped,proposedworkdescription,contractorcompanyname' });
  const byPin = new Map();
  for (const b of bp) (byPin.get(String(b.pin)) || byPin.set(String(b.pin), []).get(String(b.pin))).push(b);
  const pairs = [];
  for (const x of r) {
    const cand = (byPin.get(String(x.pin_number || '').trim()) || []).filter((b) => b.applieddate && Math.abs(b.applieddate - x.application_date) <= 730 * DAY);
    if (!cand.length) continue;
    cand.sort((a, b) => Math.abs(a.applieddate - x.application_date) - Math.abs(b.applieddate - x.application_date));
    pairs.push({ x, b: cand[0], n: cand.length, days: Math.round((x.application_date - cand[0].applieddate) / DAY) });
  }
  show('ROW applications with a building permit on the PIN within 2 years', `${pairs.length} of ${r.length}`);
  show('days building permit applied -> ROW application (nearest)', quart(pairs.map((p) => p.days)));
  show('ROW applications before any building permit on the PIN', pairs.filter((p) => p.days < 0).length);
  const same = pairs.filter((p) => p.x.company_name && p.b.contractorcompanyname && String(p.x.company_name).toLowerCase().split(/\W+/)[0] === String(p.b.contractorcompanyname).toLowerCase().split(/\W+/)[0]);
  show('pairs where the ROW company first word = the permit contractor first word', `${same.length} of ${pairs.length}`);
  log(`\n-- ${PAIRS} pairs sampled evenly: ROW PERMIT || NEAREST BUILDING PERMIT ON THE PIN`);
  const step = Math.max(1, Math.floor(pairs.length / PAIRS));
  for (let i = 0, k = 0; i < pairs.length && k < PAIRS; i += step, k += 1) {
    const p = pairs[i];
    log(`#${k + 1} ROW ${p.x.permit_number} ${day(p.x.application_date)} [${txt(p.x.permit_status, 12)}] "${txt(p.x.description, 60)}" @ ${txt(p.x.address, 40)} | ${mask(p.x.company_name)}`);
    log(`   -> ${p.days >= 0 ? '+' : ''}${p.days}d BP ${p.b.permitnum} [${txt(p.b.workclassmapped, 10)}] ${txt(p.b.proposedworkdescription, 90)} | ${mask(p.b.contractorcompanyname)} (${p.n} permits on PIN in window)`);
  }
}

// ------------------------------------------------------------ Raleigh pending
async function raleighPending() {
  section('raleigh-pending');
  const layer = `${RAL}/Building_Permits_Pending/FeatureServer/0`;
  const meta = await get(`${layer}?f=json`);
  const key = meta.fields.find((f) => /^permitnum$/i.test(f.name));
  show('has permitnum', Boolean(key));
  const p = await rows(layer, { where: `applieddate >= ${ts(365)}`, pages: 2 });
  show('pending rows applied in 365 days', p.length);
  show('statuscurrent', vocab(p, 'statuscurrent'));
  if (!key) return;
  const inMain = await rowsIn(RAL_BP, 'permitnum', p.map((x) => x.permitnum), { fields: 'permitnum,issueddate,statuscurrent' });
  const found = new Set(inMain.map((x) => x.permitnum));
  show('pending rows also in Building_Permits (we ingest that layer)', `${p.filter((x) => found.has(x.permitnum)).length} of ${p.length}`);
  show('pending rows missing from Building_Permits, by workclass', vocab(p.filter((x) => !found.has(x.permitnum)), 'workclass'));
}

// -------------------------------------------------------------- Miami NORC
async function miamiNorc() {
  section('miami-norc');
  const layer = `${MD}/NoticeOfReqConnectionpoly_gdb/FeatureServer/0`;
  const r = await rows(layer, { where: `STATUSDATE >= ${ts(365)}`, order: 'STATUSDATE DESC', pages: 2 });
  show('notices with a status date in 365 days', r.length);
  show('APPSTATUS', vocab(r, 'APPSTATUS'));
  show('CONNECTION', vocab(r, 'CONNECTION'));
  show('fill', fill(r, ['FOLIO', 'NORCID', 'ALLOC_ID', 'PSOWNER', 'PSNUMBER', 'WATERDATE', 'SEWERDATE', 'APPNAME']));
  show('APPNAME kinds', vocab(r.map((x) => ({ k: x.APPNAME ? partyKind(String(x.APPNAME)) : 'missing' })), 'k'));
  const folios = [...new Set(r.map((x) => String(x.FOLIO || '').trim()).filter((f) => /^\d{13}$/.test(f)))];
  const permits = await rowsIn(MD_PERMITS, 'FolioNumber', folios.slice(0, 800), { fields: 'FolioNumber,ProcessNumber,PermitIssuedDate,ApplicationTypeDescription,ProposedUseDescription' });
  const byFolio = new Map();
  for (const p of permits) (byFolio.get(String(p.FolioNumber)) || byFolio.set(String(p.FolioNumber), []).get(String(p.FolioNumber))).push(p);
  const leads = [];
  for (const x of r) {
    const later = (byFolio.get(String(x.FOLIO)) || []).filter((p) => p.PermitIssuedDate && p.PermitIssuedDate >= x.STATUSDATE).sort((a, b) => a.PermitIssuedDate - b.PermitIssuedDate);
    if (later.length) leads.push({ x, p: later[0], days: Math.round((later[0].PermitIssuedDate - x.STATUSDATE) / DAY) });
  }
  show('notices with a county permit issued on the folio after the status date', `${leads.length} of ${r.length}`);
  show('days status date -> first later county permit', quart(leads.map((l) => l.days)));
  log(`\n-- ${PAIRS} pairs: NOTICE || FIRST LATER COUNTY PERMIT ON THE FOLIO`);
  const step = Math.max(1, Math.floor(leads.length / PAIRS));
  for (let i = 0, k = 0; i < leads.length && k < PAIRS; i += step, k += 1) {
    const l = leads[i];
    log(`#${k + 1} NORC ${l.x.NORCID} [${txt(l.x.APPSTATUS, 15)} ${day(l.x.STATUSDATE)} ${txt(l.x.CONNECTION, 3)}] folio ${l.x.FOLIO} -> +${l.days}d ${l.p.ProcessNumber} [${txt(l.p.ApplicationTypeDescription, 30)}] ${txt(l.p.ProposedUseDescription, 60)}`);
  }
}

// ----------------------------------------------------------- Miami hearings
async function miamiHearing() {
  section('miami-hearing');
  const layer = `${MD}/LandManagementHearingView/FeatureServer/0`;
  const r = await rows(layer, { pages: 1 });
  show('hearing cases', r.length);
  show('CASE_TYPE', vocab(r, 'CASE_TYPE'));
  show('WORK_TYPE', vocab(r, 'WORK_TYPE', 20));
  show('APPL_STATUS', vocab(r, 'APPL_STATUS'));
  show('PROC_NUM years', vocab(r.map((x) => ({ y: String(x.PROC_NUM || '').slice(1, 5) })), 'y'));
  show('fill', fill(r, ['PROC_NUM', 'CASE_NUM', 'FOLIO', 'LOC_ADDR', 'APPL_DESC', 'APPL_LINK']));
  const folios = [...new Set(r.map((x) => String(x.FOLIO || '').trim()).filter((f) => /^\d{13}$/.test(f)))];
  const permits = await rowsIn(MD_PERMITS, 'FolioNumber', folios.slice(0, 600), { fields: 'FolioNumber,ProcessNumber,PermitIssuedDate,ApplicationTypeDescription,ProposedUseDescription' });
  show('hearing folios with any county permit', `${new Set(permits.map((p) => String(p.FolioNumber))).size} of ${folios.length}`);
  log('\n-- 12 sample hearings (description shortened; names masked as written)');
  for (const x of r.slice(0, 12)) log(`${x.PROC_NUM} [${txt(x.CASE_TYPE, 30)} / ${txt(x.WORK_TYPE, 40)} / ${txt(x.APPL_STATUS, 20)}] @ ${txt(x.LOC_ADDR, 40)} | ${txt(String(x.APPL_DESC || '').replace(/^[^,;]*?(&|and)[^,;]*?(,|;)/, '[applicants],'), 80)}`);
}

async function main() {
  const runs = [['miami-tree', miamiTree], ['raleigh-row', raleighRow], ['raleigh-pending', raleighPending], ['miami-norc', miamiNorc], ['miami-hearing', miamiHearing]];
  for (const [k, fn] of runs) if (want(k)) await fn().catch((e) => log(`${k} failed: ${e.message}`));
  if (args.pad) for (let i = 0; i < 400; i += 1) log(`PAD ${'.'.repeat(200)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
