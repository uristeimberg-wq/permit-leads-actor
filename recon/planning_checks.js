// Hand checks of the planning-case links (read-only, public endpoints only).
//
// The links in ingest/planning.js carry confidences that were estimates
// (0.5, 0.6). This prints real linked pairs side by side so a person can mark
// each one "same project" or not, plus the counts that explain the open
// questions in the data-understanding doc (2026-11-14):
//
//   austin-site     site plan -> plan-review cases on the same propertyrsn
//                   (the link we built), and -> issued building permits on
//                   the same tcad_id (the link we did not build)
//   austin-subdiv   recorded subdivisions: where do their houses' plan-review
//                   cases sit (propertyrsn of houses whose legal description
//                   names the subdivision)?
//   derm-dupes      repeated allocation numbers: how the rows differ
//   derm-codes      field domains and item text for the status codes
//   derm-lead       certification -> county permit, building permits only
//   raleigh         plan -> later building permits on the same PIN
//
// No writes, no database. People's names are never printed: only project
// names, types and descriptions, and a person-shaped value is masked.
//
//   node recon/planning_checks.js [--only=austin-site,derm-dupes] [--pairs=30] [--pad]

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const ONLY = args.only && args.only !== 'all' ? String(args.only).split(',') : null;
const PAIRS = Number(args.pairs || 30);
const UA = 'permit-leads-planning-checks/0.1 (research; read-only)';
const DAY = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (k) => !ONLY || ONLY.includes(k);
const log = (...a) => console.log(...a);
const section = (t) => log(`\n==================== ${t} ====================`);
const show = (label, v) => log(`${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const day = (v) => (v == null ? null : new Date(typeof v === 'number' ? v : Date.parse(v)).toISOString().slice(0, 10));
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const looksPerson = (v) => typeof v === 'string' && /^[A-Z][a-z]+( [A-Z]\.?)? [A-Z][a-z'-]+$/.test(v.trim());
const txt = (v, n = 90) => {
  if (v == null || String(v).trim() === '') return '-';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return looksPerson(s) ? '[person-shaped]' : s.slice(0, n);
};
const quart = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p25: s[Math.floor(s.length / 4)], median: s[Math.floor(s.length / 2)], p75: s[Math.floor((3 * s.length) / 4)] };
};
const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

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

const soql = (id, q) => get(`https://datahub.austintexas.gov/resource/${id}.json?${new URLSearchParams(q)}`);
async function arcRows(layer, { where = '1=1', order, n = 2000, fields = '*' } = {}) {
  const q = new URLSearchParams({ where, outFields: fields, returnGeometry: 'false', resultRecordCount: String(n), f: 'json' });
  if (order) q.set('orderByFields', order);
  return (await get(`${layer}/query?${q}`)).features.map((f) => f.attributes);
}

const SITE = 'mavg-96ck'; const SUBDIV = 's7gx-9m54'; const PLAN_REVIEW = 'n8ck-xkda'; const ISSUED = '3syk-w9eu';
const DERM = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/DERMSewerAllocation_gdb/FeatureServer/0';
const MD_PERMITS = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0';
const RAL = 'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services';
const since = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

/** Rows of `id` whose `field` is in `values`, in chunks. */
async function soqlIn(id, field, values, extra = {}) {
  const out = [];
  for (const c of chunks([...new Set(values)].filter(Boolean), 40)) {
    out.push(...await soql(id, { $where: `${field} in (${c.map(quote).join(',')})`, $limit: 5000, ...extra }));
  }
  return out;
}

// ------------------------------------------------------------------ Austin

async function austinSite() {
  section('austin-site');
  const plans = await soql(SITE, { $where: `application_start_date >= '${since(365)}' AND propertyrsn IS NOT NULL AND propertyrsn != '0'`, $limit: 5000 });
  show('site plans filed in 365 days with a propertyrsn', plans.length);
  show('site plan sub types', Object.entries(plans.reduce((m, p) => ((m[p.sub_type] = (m[p.sub_type] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 12));
  // The link we built: plan review on the same propertyrsn, applied 0-1095 days after.
  const pr = await soqlIn(PLAN_REVIEW, 'propertyrsn', plans.map((p) => p.propertyrsn));
  const byProp = new Map();
  for (const r of pr) (byProp.get(r.propertyrsn) || byProp.set(r.propertyrsn, []).get(r.propertyrsn)).push(r);
  const pairs = [];
  for (const p of plans) {
    const f = Date.parse(p.application_start_date);
    for (const r of byProp.get(p.propertyrsn) || []) {
      const a = Date.parse(r.applied_date);
      if (a >= f && a <= f + 1095 * DAY) pairs.push({ p, r, days: Math.round((a - f) / DAY) });
    }
  }
  const linkedPlans = new Set(pairs.map((x) => x.p.folderrsn));
  show('site plans with a plan-review link / link rows', `${linkedPlans.size} / ${pairs.length}`);
  show('plan-review cases per linked site plan', quart([...linkedPlans].map((k) => pairs.filter((x) => x.p.folderrsn === k).length)));
  show('plan-review sub types on links', Object.entries(pairs.reduce((m, x) => ((m[x.r.sub_type] = (m[x.r.sub_type] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 12));
  log(`\n-- ${PAIRS} linked pairs (one per site plan): SITE PLAN || PLAN REVIEW`);
  const seen = new Set();
  for (const x of pairs) {
    if (seen.has(x.p.folderrsn) || seen.size >= PAIRS) continue;
    seen.add(x.p.folderrsn);
    const n = pairs.filter((y) => y.p.folderrsn === x.p.folderrsn).length;
    log(`SP ${x.p.folderrsn} [${txt(x.p.sub_type, 40)}] "${txt(x.p.case_name, 60)}" @ ${txt([x.p.street_number, x.p.street_name, x.p.street_type].filter(Boolean).join(' '), 40)} | use: ${txt(x.p.proposed_land_use, 40)} | work: ${txt(x.p.description_of_work || x.p.work, 120)}`);
    log(`   -> +${x.days}d PR ${x.r.permit_number} [${txt(x.r.sub_type, 40)}] "${txt(x.r.project_name, 50)}" | ${txt(x.r.folder_description, 100)} | legal: ${txt(x.r.legal_description, 60)} | (${n} PR on this link)`);
  }
  // The link we did not build: issued building permits on the same tcad_id.
  const withTcad = plans.filter((p) => p.tcad_id && !/^0+$/.test(p.tcad_id));
  const issued = await soqlIn(ISSUED, 'tcad_id', withTcad.map((p) => p.tcad_id), { $select: 'permit_number,permittype,permit_class_mapped,work_class,applieddate,description,tcad_id' });
  const issuedPairs = [];
  for (const p of withTcad) {
    const f = Date.parse(p.application_start_date);
    for (const r of issued.filter((i) => i.tcad_id === p.tcad_id && i.permittype === 'BP')) {
      const a = Date.parse(r.applieddate);
      if (a >= f && a <= f + 1095 * DAY) issuedPairs.push({ p, r, days: Math.round((a - f) / DAY) });
    }
  }
  const tcadLinked = new Set(issuedPairs.map((x) => x.p.folderrsn));
  show('site plans with a tcad_id', withTcad.length);
  show('site plans with a building permit (BP) applied after on the same tcad_id', tcadLinked.size);
  show('  of those, Commercial / Residential BP rows', Object.entries(issuedPairs.reduce((m, x) => ((m[x.r.permit_class_mapped] = (m[x.r.permit_class_mapped] || 0) + 1), m), {})));
  show('  days site plan -> first BP applied', quart([...tcadLinked].map((k) => Math.min(...issuedPairs.filter((x) => x.p.folderrsn === k).map((x) => x.days)))));
  log(`\n-- ${Math.min(15, tcadLinked.size)} tcad_id pairs: SITE PLAN || BUILDING PERMIT`);
  const seen2 = new Set();
  for (const x of issuedPairs) {
    if (seen2.has(x.p.folderrsn) || seen2.size >= 15) continue;
    seen2.add(x.p.folderrsn);
    log(`SP ${x.p.folderrsn} [${txt(x.p.sub_type, 40)}] "${txt(x.p.case_name, 60)}" | work: ${txt(x.p.description_of_work || x.p.work, 100)}`);
    log(`   -> +${x.days}d BP ${x.r.permit_number} [${txt(x.r.permit_class_mapped, 12)} ${txt(x.r.work_class, 20)}] ${txt(x.r.description, 110)}`);
  }
}

async function austinSubdiv() {
  section('austin-subdiv');
  const subs = await soql(SUBDIV, { $where: `upper(status) like '%RECORDED%'`, $order: 'status_date DESC', $limit: 60 });
  show('recorded subdivisions read (newest by status date)', subs.length);
  let checked = 0; let withHouses = 0; let sameProp = 0; let otherProp = 0;
  for (const s of subs) {
    if (checked >= 20) break;
    // The plat name is the case name without the usual suffixes.
    const name = String(s.case_name || '').toUpperCase().replace(/[;,].*$/, '').replace(/\b(FINAL PLAT|PRELIMINARY PLAN|PRELIMINARY PLAT|PLAT|PHASE|SECTION|SEC|PH)\b.*$/, '').trim();
    if (name.length < 6) continue;
    checked += 1;
    const houses = await soql(PLAN_REVIEW, { $where: `upper(legal_description) like ${quote(`%${name.replace(/'/g, '')}%`)}`, $select: 'permit_number,propertyrsn,applied_date,sub_type,legal_description', $limit: 500 }).catch((e) => { show('query failed', e.message); return []; });
    const props = new Set(houses.map((h) => h.propertyrsn));
    if (houses.length) withHouses += 1;
    const same = houses.filter((h) => h.propertyrsn === s.propertyrsn).length;
    sameProp += same; otherProp += houses.length - same;
    log(`SUB ${s.projectid} "${txt(s.case_name, 60)}" lots ${s.proposed_no_of_lots || '-'} prop ${s.propertyrsn || '-'} recorded ${day(s.status_date)} | name searched "${name}" -> ${houses.length} plan-review cases on ${props.size} propertyrsn, ${same} on the subdivision's own | e.g. ${houses.slice(0, 2).map((h) => `${txt(h.sub_type, 30)}: ${txt(h.legal_description, 50)}`).join(' ; ') || '-'}`);
  }
  show('subdivisions checked / with house plan review found by legal description', `${checked} / ${withHouses}`);
  show('house plan-review cases on the subdivision propertyrsn / on another propertyrsn', `${sameProp} / ${otherProp}`);
}

// ------------------------------------------------------------------ Miami

async function dermDupes() {
  section('derm-dupes');
  const q = new URLSearchParams({ where: `SWRCRTDATE >= TIMESTAMP '${since(365)} 00:00:00'`, groupByFieldsForStatistics: 'EEOSALLCNO',
    outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: 'OBJECTID', outStatisticFieldName: 'n' }]), f: 'json' });
  const groups = (await get(`${DERM}/query?${q}`)).features.map((f) => f.attributes).filter((a) => a.n > 1).sort((a, b) => b.n - a.n);
  show('allocation numbers with more than one row (certified in 365 days)', groups.length);
  show('rows per repeated number', quart(groups.map((g) => g.n)));
  const nums = groups.slice(0, 25).map((g) => g.EEOSALLCNO);
  const rows = await arcRows(DERM, { where: `EEOSALLCNO IN (${nums.map(quote).join(',')})`, n: 2000, order: 'EEOSALLCNO, OBJECTID' });
  const diffCols = new Map();
  for (const n of nums) {
    const rs = rows.filter((r) => r.EEOSALLCNO === n);
    for (const c of Object.keys(rs[0] || {})) {
      if (['OBJECTID', 'GlobalID', 'Shape__Area', 'Shape__Length'].includes(c)) continue;
      if (new Set(rs.map((r) => String(r[c]))).size > 1) diffCols.set(c, (diffCols.get(c) || 0) + 1);
    }
  }
  show('columns that differ within a repeated number (of 25 numbers)', [...diffCols.entries()].sort((a, b) => b[1] - a[1]));
  for (const n of nums.slice(0, 8)) {
    log(`-- ${n}`);
    for (const r of rows.filter((x) => x.EEOSALLCNO === n)) {
      log(`   folio ${r.FOLIO} | proc ${txt(r.BLDPROCNO, 20)} | ${r.SWRAPVCODE} | cert ${day(r.SWRCRTDATE)} | dealloc ${day(r.SWRDEALLDT)} | flow ${r.PRPDFLWGPD} prev ${r.PREVFLWGPD} | ${txt(r.ADDRESS, 40)} | ${txt(r.EEOSPRJDSC, 50)}`);
    }
  }
}

async function dermCodes() {
  section('derm-codes');
  const meta = await get(`${DERM}?f=json`);
  for (const f of meta.fields) {
    if (f.domain || /CODE|APV|DEAL|NORC|SEWEXT/i.test(f.name)) show(`field ${f.name}`, { alias: f.alias, type: f.type, domain: f.domain || null });
  }
  show('layer description', String(meta.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500));
  try {
    const it = await get('https://www.arcgis.com/sharing/rest/content/items/d583b45dae464e30b4fb438d4da979f2?f=json');
    show('item description', String(it.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000));
    show('item snippet', it.snippet);
  } catch (err) { show('item failed', err.message); }
  // What does each code look like in the data?
  const rows = await arcRows(DERM, { where: `SWRCRTDATE >= TIMESTAMP '${since(365)} 00:00:00'`, n: 2000, fields: 'SWRAPVCODE,SWRDEALLDT,PRPDFLWGPD,PREVFLWGPD,BLDPROCNO,EXPDT90DAY,SWRCRTDATE' });
  const by = {};
  for (const r of rows) {
    const b = (by[r.SWRAPVCODE] ||= { n: 0, dealloc: 0, prevFlow: 0, flowZero: 0, proc: 0, expired: 0 });
    b.n += 1; if (r.SWRDEALLDT) b.dealloc += 1; if (r.PREVFLWGPD > 0) b.prevFlow += 1; if (!r.PRPDFLWGPD) b.flowZero += 1;
    if (r.BLDPROCNO && r.BLDPROCNO !== 'N/A') b.proc += 1; if (r.EXPDT90DAY && r.EXPDT90DAY < Date.now()) b.expired += 1;
  }
  show('per code: rows, with dealloc date, with previous flow, flow 0, with a process number, past the 90-day date', by);
}

async function dermLead() {
  section('derm-lead');
  const certs = await arcRows(DERM, { where: `SWRCRTDATE >= TIMESTAMP '${since(365)} 00:00:00' AND BLDPROCNO <> 'N/A'`, order: 'SWRCRTDATE DESC', n: 2000, fields: 'EEOSALLCNO,BLDPROCNO,SWRCRTDATE,SWRAPVCODE' });
  const procs = [...new Set(certs.map((c) => String(c.BLDPROCNO).trim()))];
  const permits = [];
  for (const c of chunks(procs, 40)) {
    permits.push(...await arcRows(MD_PERMITS, { where: `ProcessNumber IN (${c.map(quote).join(',')})`, fields: 'ProcessNumber,PermitNumber,PermitType,PermitIssuedDate,ApplicationDate,MasterPermitNumber', n: 2000 }).catch(() => []));
  }
  const iss = (p) => (typeof p.PermitIssuedDate === 'string' ? Date.parse(p.PermitIssuedDate) : p.PermitIssuedDate);
  const all = []; const bldg = []; const master = [];
  let linked = 0;
  for (const c of certs) {
    const ps = permits.filter((p) => String(p.ProcessNumber).trim() === String(c.BLDPROCNO).trim() && iss(p));
    if (!ps.length) continue;
    linked += 1;
    for (const p of ps) all.push(Math.round((iss(p) - c.SWRCRTDATE) / DAY));
    const b = ps.filter((p) => p.PermitType === 'BLDG' || p.PermitType === 'MBLD');
    if (b.length) bldg.push(Math.round((Math.min(...b.map(iss)) - c.SWRCRTDATE) / DAY));
    const m = ps.filter((p) => /^0+$/.test(String(p.MasterPermitNumber || '0')));
    if (m.length) master.push(Math.round((Math.min(...m.map(iss)) - c.SWRCRTDATE) / DAY));
  }
  show('certifications in 365 days with a process number', certs.length);
  show('linked to an issued county permit by process number', linked);
  show('permit types on linked permits', Object.entries(permits.reduce((m, p) => ((m[p.PermitType] = (m[p.PermitType] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]));
  show('days, every linked permit row (what the link report measures)', quart(all));
  show('days, first BLDG/MBLD permit per certification', quart(bldg));
  show('days, first master permit (no MasterPermitNumber) per certification', quart(master));
  show('share of linked permit rows before certification (%)', Math.round((1000 * all.filter((d) => d < 0).length) / (all.length || 1)) / 10);
}

// ------------------------------------------------------------------ Raleigh

async function raleigh() {
  section('raleigh');
  const plans = await arcRows(`${RAL}/Development_Plan_Areas/FeatureServer/0`, { where: `apply_date >= TIMESTAMP '${since(1095)} 00:00:00' AND main_parcel_number IS NOT NULL`, order: 'apply_date DESC', n: 2000,
    fields: 'plan_number,plan_type,plan_status,apply_date,project,description,main_parcel_number' });
  show('plans applied in the last 3 years with a PIN (read)', plans.length);
  const bp = `${RAL}/Building_Permits/FeatureServer/0`;
  const permits = [];
  for (const c of chunks([...new Set(plans.map((p) => p.main_parcel_number))], 50)) {
    permits.push(...await arcRows(bp, { where: `pin IN (${c.map(quote).join(',')})`, n: 2000,
      fields: 'pin,permitnum,applieddate,permittypemapped,permitclassmapped,workclassmapped,proposedworkdescription,housingunitstotal,devplanid' }).catch((e) => { show('permit query failed', e.message); return []; }));
  }
  const pairs = [];
  for (const p of plans) {
    for (const r of permits.filter((x) => x.pin === p.main_parcel_number && x.applieddate >= p.apply_date && x.applieddate <= p.apply_date + 1095 * DAY)) {
      pairs.push({ p, r, days: Math.round((r.applieddate - p.apply_date) / DAY) });
    }
  }
  const linked = new Set(pairs.map((x) => x.p.plan_number));
  show('plans with a later permit on the PIN / link rows', `${linked.size} / ${pairs.length}`);
  show('work class on link rows', Object.entries(pairs.reduce((m, x) => ((m[x.r.workclassmapped] = (m[x.r.workclassmapped] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 12));
  show('permits per linked plan', quart([...linked].map((k) => pairs.filter((x) => x.p.plan_number === k).length)));
  const firstNew = [...linked].map((k) => pairs.filter((x) => x.p.plan_number === k && /new/i.test(x.r.workclassmapped || '')).map((x) => x.days)).filter((d) => d.length).map((d) => Math.min(...d));
  show('plans with a later NEW-construction permit on the PIN; days to the first', { plans: firstNew.length, ...quart(firstNew) });
  // The candidate rule: new-construction permits only, every Nth plan so the
  // sample is not just the fastest links.
  const newPairs = pairs.filter((x) => /new/i.test(x.r.workclassmapped || ''));
  const newPlans = [...new Set(newPairs.map((x) => x.p.plan_number))];
  const step = Math.max(1, Math.floor(newPlans.length / PAIRS));
  log(`\n-- ${PAIRS} plans with a later NEW permit (every ${step}th): PLAN || FIRST NEW PERMIT`);
  for (const k of newPlans.filter((_, i) => i % step === 0).slice(0, PAIRS)) {
    const x = newPairs.filter((y) => y.p.plan_number === k).sort((a, b) => a.days - b.days)[0];
    log(`PLAN ${x.p.plan_number} [${txt(x.p.plan_type, 30)}] "${txt(x.p.project, 50)}" | ${txt(x.p.description, 110)}`);
    log(`   -> +${x.days}d ${x.r.permitnum} [${txt(x.r.permittypemapped, 15)} / ${txt(x.r.workclassmapped, 20)} / units ${x.r.housingunitstotal ?? '-'}] ${txt(x.r.proposedworkdescription, 110)} (${newPairs.filter((y) => y.p.plan_number === k).length} new permits on this plan)`);
  }
  log(`\n-- ${PAIRS} linked plans (first later permit): PLAN || PERMIT`);
  const seen = new Set();
  for (const x of [...pairs].sort((a, b) => a.days - b.days)) {
    if (seen.has(x.p.plan_number) || seen.size >= PAIRS) continue;
    seen.add(x.p.plan_number);
    log(`PLAN ${x.p.plan_number} [${txt(x.p.plan_type, 30)}] "${txt(x.p.project, 50)}" | ${txt(x.p.description, 110)}`);
    log(`   -> +${x.days}d ${x.r.permitnum} [${txt(x.r.permittypemapped, 15)} / ${txt(x.r.workclassmapped, 20)} / units ${x.r.housingunitstotal ?? '-'}] ${txt(x.r.proposedworkdescription, 110)} (${pairs.filter((y) => y.p.plan_number === x.p.plan_number).length} permits on this plan)`);
  }
}

(async () => {
  const runs = [['austin-site', austinSite], ['austin-subdiv', austinSubdiv], ['derm-dupes', dermDupes], ['derm-codes', dermCodes], ['derm-lead', dermLead], ['raleigh', raleigh]].filter(([k]) => want(k));
  let failed = 0;
  for (const [k, fn] of runs) {
    try { await fn(); } catch (err) { failed += 1; log(`!! ${k} failed: ${err.stack || err.message}`); }
  }
  if (failed) process.exitCode = 1;
  if (args.pad) for (let i = 0; i < 2000; i += 1) log(`PAD ${'.'.repeat(56)}`);
})();
