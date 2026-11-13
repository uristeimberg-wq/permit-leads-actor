// Market scan, part 2: can building permits be linked to their trade permits
// (the GC-to-sub relationship view) in each candidate market?
//
// Read-only research, not a connector. For each source: fetch 12 months of
// permits, take "primary" building permits issued 12 to 6 months ago, and
// measure how many get a trade permit (electrical / mechanical / plumbing) on
// the same link key within -30..+180 days, and how often the trade permit
// names a different company than the primary (i.e. a sub we can attribute).
//
//   node recon/market_links.js [--only=orlando,miamiCity] [--out=recon/out/links]
// CI: .github/workflows/feasibility.yml, input `market_links`.

const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const OUT = args.out || 'recon/out/links';
const UA = 'permit-leads-market-scan/0.1 (research; read-only)';
const DAY = 864e5;
const NOW = Date.now();
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const FROM = isoDay(NOW - 365 * DAY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\b(LLC|INC|CORP|CO|LTD|COMPANY|CORPORATION|THE|DBA)\b/g, '').replace(/\s+/g, ' ').trim();
const toMs = (v) => (v == null || v === '' ? null : typeof v === 'number' ? v : Date.parse(v));

let last = 0;
async function get(url) {
  for (let i = 1; ; i += 1) {
    const wait = 500 - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(90000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      const body = JSON.parse(text);
      if (body && body.error) throw new Error(`API error: ${JSON.stringify(body.error).slice(0, 200)}`);
      return body;
    } catch (err) {
      if (i >= 3) throw new Error(`${err.message} <- ${url.slice(0, 220)}`);
      await sleep(2000 * i);
    }
  }
}

async function socrataAll(domain, id, where, select = '*', order = ':id') {
  const rows = [];
  for (let off = 0; ; off += 50000) {
    const q = `$select=${encodeURIComponent(select)}&$where=${encodeURIComponent(where)}&$order=${encodeURIComponent(order)}&$limit=50000&$offset=${off}`;
    const page = await get(`https://${domain}/resource/${id}.json?${q}`);
    rows.push(...page);
    if (page.length < 50000 || rows.length > 400000) break;
  }
  return rows;
}

async function arcgisAll(url, where, fields = '*') {
  const meta = await get(`${url}?f=json`);
  const size = Math.min(meta.maxRecordCount || 1000, Number(args.page || 1000));
  const oid = (meta.fields || []).find((f) => f.type === 'esriFieldTypeOID')?.name || 'OBJECTID';
  const rows = [];
  for (let off = 0; ; off += size) {
    const q = `where=${encodeURIComponent(where)}&outFields=${encodeURIComponent(fields)}&returnGeometry=false&orderByFields=${oid}&resultOffset=${off}&resultRecordCount=${size}&f=json`;
    const page = (await get(`${url}/query?${q}`)).features.map((f) => f.attributes);
    rows.push(...page);
    if (page.length < size || rows.length > 300000) break;
  }
  return rows;
}

const TRADES = { electrical: /electr/i, mechanical: /mechan|hvac|heating|air cond|a\/c/i, plumbing: /plumb|gas|fgas/i };
function tradeOf(text) {
  for (const [t, re] of Object.entries(TRADES)) if (re.test(text)) return t;
  return null;
}

// rows: [{ key(s), date (ms), kind: 'primary'|'trade'|null, trade, company }]
function measure(name, rows, keyNames) {
  const out = { name, rows: rows.length, byKind: {} };
  for (const r of rows) out.byKind[r.trade || r.kind || 'other'] = (out.byKind[r.trade || r.kind || 'other'] || 0) + 1;
  const lo = NOW - 365 * DAY; const hi = NOW - 180 * DAY;
  const primaries = rows.filter((r) => r.kind === 'primary' && r.date >= lo && r.date < hi);
  out.primaries = primaries.length;
  out.companyFillPrimary = pct(primaries.filter((r) => r.company).length, primaries.length);
  const trades = rows.filter((r) => r.kind === 'trade');
  out.companyFillTrade = pct(trades.filter((r) => r.company).length, trades.length);
  out.links = {};
  for (const kn of keyNames) {
    const idx = new Map();
    for (const t of trades) { const k = t.keys[kn]; if (!k) continue; if (!idx.has(k)) idx.set(k, []); idx.get(k).push(t); }
    const res = { keyFillPrimary: pct(primaries.filter((p) => p.keys[kn]).length, primaries.length) };
    for (const trade of Object.keys(TRADES)) {
      let linked = 0; let diffCo = 0; let named = 0; const gaps = [];
      for (const p of primaries) {
        const k = p.keys[kn]; if (!k) continue;
        const m = (idx.get(k) || []).filter((t) => t.trade === trade && t.date >= p.date - 30 * DAY && t.date <= p.date + 180 * DAY);
        if (!m.length) continue;
        linked += 1;
        const first = m.sort((a, b) => a.date - b.date)[0];
        gaps.push(Math.round((first.date - p.date) / DAY));
        if (p.company && first.company) { named += 1; if (norm(p.company) !== norm(first.company)) diffCo += 1; }
      }
      gaps.sort((a, b) => a - b);
      res[trade] = { linkedPct: pct(linked, primaries.length), medianDays: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null, differentCompanyPct: pct(diffCo, named) };
    }
    out.links[kn] = res;
  }
  const cos = new Set(rows.filter((r) => r.company).map((r) => norm(r.company)));
  out.distinctCompanies = cos.size;
  return out;
}

const SOURCES = {
  async orlando() {
    const rows = await socrataAll('data.cityoforlando.net', 'ryhf-m453', `issue_permit_date >= '${FROM}'`, 'permit_number,application_type,worktype,parcel_number,contractor_name,issue_permit_date,plan_review_type');
    return measure('Orlando (ryhf-m453)', rows.map((r) => {
      const t = r.application_type || '';
      const kind = /^Building Permit$/i.test(t) && /residential/i.test(r.plan_review_type || '') ? 'primary' : tradeOf(t) ? 'trade' : null;
      return { kind, trade: kind === 'trade' ? tradeOf(t) : null, date: toMs(r.issue_permit_date), company: r.contractor_name, keys: { parcel: r.parcel_number } };
    }), ['parcel']);
  },
  async miamiCity() {
    const url = 'https://services1.arcgis.com/CvuPhqcTQpZPT9qY/arcgis/rest/services/Building_Permits_Since_2014/FeatureServer/0';
    const rows = await arcgisAll(url, `IssuedDate >= TIMESTAMP '${FROM} 00:00:00'`, 'PermitNumber,ApplicationNumber,ProcessNumber,FolioNumber,CompanyName,IssuedDate,PropertyType,ScopeofWork,WorkItems');
    const suffix = {};
    const mapped = rows.map((r) => {
      const m = String(r.PermitNumber || '').match(/^[A-Z]{2}\d{8}\d{3}([A-Z]+)\d{3}$/);
      const s = m ? m[1] : '?';
      suffix[s] = (suffix[s] || 0) + 1;
      const trade = s === 'E' ? 'electrical' : (s === 'M' || s === 'ME') ? 'mechanical' : (s === 'P' || s === 'PG') ? 'plumbing' : null;
      const kind = s === 'B' && /resid|family|duplex/i.test(r.PropertyType || '') ? 'primary' : trade ? 'trade' : null;
      return { kind, trade, date: r.IssuedDate, company: r.CompanyName, keys: { application: r.ApplicationNumber, folio: r.FolioNumber } };
    });
    const res = measure('City of Miami (Building_Permits_Since_2014)', mapped, ['application', 'folio']);
    res.permitSuffixes = Object.entries(suffix).sort((a, b) => b[1] - a[1]).slice(0, 15);
    res.propertyTypes = Object.entries(rows.reduce((m, r) => { m[r.PropertyType] = (m[r.PropertyType] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 10);
    return res;
  },
  async nola() {
    const rows = await socrataAll('data.nola.gov', '72f9-bi28', `issuedate >= '${FROM}'`, 'permitnum,permittype,permittypedesc,workclass,permitclass,pin,contractorcompanyname,issuedate');
    const res = measure('New Orleans (72f9-bi28)', rows.map((r) => {
      const t = `${r.permittypedesc || ''} ${r.workclass || ''}`;
      const resi = /family|resid/i.test(r.permitclass || '');
      const kind = resi && /new construction|renovation|addition/i.test(t) && !tradeOf(r.permittypedesc || '') ? 'primary' : tradeOf(r.permittypedesc || '') ? 'trade' : null;
      return { kind, trade: kind === 'trade' ? tradeOf(r.permittypedesc) : null, date: toMs(r.issuedate), company: r.contractorcompanyname, keys: { pin: r.pin } };
    }), ['pin']);
    res.types = Object.entries(rows.reduce((m, r) => { m[r.permittypedesc] = (m[r.permittypedesc] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 15);
    return res;
  },
  async philadelphia() {
    const url = 'https://services.arcgis.com/fLeGjb7u4uXqeF9q/arcgis/rest/services/PERMITS/FeatureServer/0';
    const rows = await arcgisAll(url, `permitissuedate >= TIMESTAMP '${FROM} 00:00:00'`, 'permitnumber,permittype,typeofwork,commercialorresidential,parcel_id_num,parentjobid,posse_jobid,contractorname,permitissuedate');
    const res = measure('Philadelphia (PERMITS)', rows.map((r) => {
      const t = r.permittype || '';
      const kind = /building/i.test(t) && /resid/i.test(r.commercialorresidential || t) && /new|addition|alter/i.test(r.typeofwork || '') ? 'primary' : tradeOf(t) ? 'trade' : null;
      return { kind, trade: kind === 'trade' ? tradeOf(t) : null, date: r.permitissuedate, company: r.contractorname, keys: { parentjob: r.parentjobid || r.posse_jobid, parcel: r.parcel_id_num } };
    }), ['parentjob', 'parcel']);
    res.types = Object.entries(rows.reduce((m, r) => { m[r.permittype] = (m[r.permittype] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 12);
    return res;
  },
  async cleveland() {
    const url = 'https://services3.arcgis.com/dty2kHktVXHrqO8i/arcgis/rest/services/Building_Permits/FeatureServer/0';
    const rows = await arcgisAll(url, `ISSUE_DATE >= TIMESTAMP '${FROM} 00:00:00'`, 'PERMIT_ID,PERMIT_TYPE,PERMIT_SUBTYPE,PERMIT_CATEGORY,PARCEL_NUMBER,ASSOCIATED_PROJECT,CONTRATOR_BUSINESS_NAME,ISSUE_DATE');
    const res = measure('Cleveland (Building_Permits)', rows.map((r) => {
      const c = r.PERMIT_CATEGORY || '';
      const kind = /resid/i.test(c) && /new|addition|alter|building|remodel/i.test(c) && !tradeOf(c) ? 'primary' : tradeOf(c) ? 'trade' : null;
      return { kind, trade: kind === 'trade' ? tradeOf(c) : null, date: r.ISSUE_DATE, company: r.CONTRATOR_BUSINESS_NAME, keys: { project: r.ASSOCIATED_PROJECT, parcel: r.PARCEL_NUMBER } };
    }), ['project', 'parcel']);
    res.categories = Object.entries(rows.reduce((m, r) => { m[r.PERMIT_CATEGORY] = (m[r.PERMIT_CATEGORY] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 15);
    return res;
  },
  async nyc() {
    const rows = await socrataAll('data.cityofnewyork.us', 'rbx6-tga4', `issued_date >= '${FROM}'`, 'job_filing_number,work_permit,work_type,bin,applicant_business_name,permittee_s_license_type,issued_date,filing_reason');
    const res = measure('New York City (DOB NOW rbx6-tga4)', rows.map((r) => {
      const w = r.work_type || '';
      const kind = /general construction/i.test(w) ? 'primary' : /plumb|mechanical|sprinkler|standpipe/i.test(w) ? 'trade' : null;
      const trade = /plumb|sprinkler|standpipe/i.test(w) ? 'plumbing' : /mechanical/i.test(w) ? 'mechanical' : null;
      return { kind, trade: kind === 'trade' ? trade : null, date: toMs(r.issued_date), company: r.applicant_business_name, keys: { job: String(r.job_filing_number || '').split('-')[0], bin: r.bin } };
    }), ['job', 'bin']);
    res.workTypes = Object.entries(rows.reduce((m, r) => { m[r.work_type] = (m[r.work_type] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 12);
    res.licenceTypes = Object.entries(rows.reduce((m, r) => { m[r.permittee_s_license_type] = (m[r.permittee_s_license_type] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return res;
  },
  async raleigh() {
    const base = 'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services';
    const w = `issueddate >= TIMESTAMP '${FROM} 00:00:00'`;
    const monthly = async (url, fields) => {
      const out = [];
      for (let m = 0; m < 13; m += 1) {
        const a = isoDay(NOW - (365 - 30 * m) * DAY); const b = isoDay(NOW - (365 - 30 * (m + 1)) * DAY);
        out.push(...await arcgisAll(url, `issueddate >= TIMESTAMP '${a} 00:00:00' AND issueddate < TIMESTAMP '${b} 00:00:00'`, fields));
      }
      return out;
    };
    const bld = await monthly(`${base}/Building_Permits/FeatureServer/0`, 'issueddate,permitclassmapped,workclass,workclassmapped,contractorcompanyname,contractorphone,pin,projectname,permitnum');
    const oth = await monthly(`${base}/Permits_Other_Than_Buildings/FeatureServer/0`, 'issueddate,permittype,permittypemapped,workclass,contractorcompanyname,contractorphone,contractortype,pin,projectname,permitnum');
    const pinOf = (r) => r.pin || r.PIN || r.pinnum || r.pin_num || null;
    const phone = (r) => String(r.contractorphone || '').replace(/\D/g, '').length >= 10;
    const rows = [
      ...bld.map((r) => ({ kind: /resid/i.test(r.permitclassmapped || '') && /new|addition|alter|remodel|upfit/i.test(`${r.workclass || ''} ${r.workclassmapped || ''}`) ? 'primary' : null, trade: null, date: r.issueddate, company: r.contractorcompanyname, keys: { pin: pinOf(r), project: r.projectname } })),
      ...oth.map((r) => { const t = tradeOf(`${r.permittypemapped || ''} ${r.permittype || ''}`); return { kind: t ? 'trade' : null, trade: t, date: r.issueddate, company: r.contractorcompanyname, keys: { pin: pinOf(r), project: r.projectname } }; }),
    ];
    const res = measure('Raleigh (Building_Permits + Permits_Other_Than_Buildings)', rows, ['pin', 'project']);
    res.subPermitPct = pct(oth.filter((r) => /sub permit/i.test(r.workclass || '')).length, oth.length);
    res.otherTypes = Object.entries(oth.reduce((m, r) => { const k = r.permittypemapped || r.permittype; m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 10);
    res.otherCols = Object.keys(oth[0] || {}).join(',').slice(0, 800);
    res.phonePct = { building: pct(bld.filter(phone).length, bld.length), other: pct(oth.filter(phone).length, oth.length) };
    res.workclasses = Object.entries(bld.reduce((m, r) => { m[r.workclass] = (m[r.workclass] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 10);
    return res;
  },
  async sandiego() {
    const dom = 'internal-sandiegocounty.data.socrata.com';
    const permits = await socrataAll(dom, 'red2-qccu', `issued_date >= '${FROM}' and issued_date <= '${isoDay(NOW)}'`, 'record_id,record_category,record_subtype,issued_date,contractor_name,parcel_number');
    const ids = new Set(permits.map((p) => p.record_id));
    const contractors = await socrataAll(dom, '4ju2-mf55', `last_updated >= '${isoDay(NOW - 500 * DAY)}'`, 'permit_number,constractor_company_name,contractor_license_number,contractor_phone');
    const trades = await socrataAll(dom, 'wc68-2ej9', '1=1', 'contractor_license_number,contractor_trade');
    const tradeByLic = new Map();
    for (const t of trades) { if (!tradeByLic.has(t.contractor_license_number)) tradeByLic.set(t.contractor_license_number, new Set()); tradeByLic.get(t.contractor_license_number).add(t.contractor_trade); }
    const byPermit = new Map();
    for (const c of contractors) { if (!ids.has(c.permit_number)) continue; if (!byPermit.has(c.permit_number)) byPermit.set(c.permit_number, []); byPermit.get(c.permit_number).push(c); }
    const resi = permits.filter((p) => /resid/i.test(p.record_category || ''));
    const withC = resi.filter((p) => byPermit.has(p.record_id));
    const multi = withC.filter((p) => new Set(byPermit.get(p.record_id).map((c) => c.contractor_license_number)).size >= 2);
    const subTrade = { electrical: 0, mechanical: 0, plumbing: 0 };
    for (const p of withC) {
      const ts = new Set(byPermit.get(p.record_id).flatMap((c) => [...(tradeByLic.get(c.contractor_license_number) || [])]));
      for (const t of ts) { const k = tradeOf(t); if (k) subTrade[k] += 1; }
    }
    const phones = withC.flatMap((p) => byPermit.get(p.record_id)).filter((c) => String(c.contractor_phone || '').replace(/\D/g, '').length >= 10).length;
    return {
      name: 'San Diego County, unincorporated (red2-qccu + 4ju2-mf55 + wc68-2ej9)',
      permits12m: permits.length, residential12m: resi.length,
      categories: Object.entries(permits.reduce((m, r) => { m[r.record_category] = (m[r.record_category] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 10),
      residentialWithContractorRows: pct(withC.length, resi.length),
      residentialWith2plusContractors: pct(multi.length, resi.length),
      residentialWithTradeLicensee: Object.fromEntries(Object.entries(subTrade).map(([k, v]) => [k, pct(v, resi.length)])),
      contractorRowPhonePct: pct(phones, withC.flatMap((p) => byPermit.get(p.record_id)).length),
      contractorRowsFetched: contractors.length, tradeLicences: tradeByLic.size,
    };
  },
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const only = args.only ? String(args.only).split(',') : Object.keys(SOURCES);
  const report = { at: new Date().toISOString(), from: FROM };
  for (const k of only) {
    try {
      console.log(`\n### ${k}`);
      report[k] = await SOURCES[k]();
      console.log(JSON.stringify(report[k]));
    } catch (e) { report[k] = { error: e.message }; console.log(`ERR ${k}: ${e.message}`); }
  }
  fs.writeFileSync(path.join(OUT, 'links.json'), JSON.stringify(report, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
