// Pre-approval scan: which US jurisdictions publish construction applications
// (and pre-application planning signals) before a permit is issued?
//
// Read-only research, not a connector. Passes:
//   1. discover: Socrata catalog and ArcGIS search for application, plan-review,
//      site-plan, zoning and land-use datasets (plus a seed list).
//   2. probe: per dataset, find the status, application-date and issue-date
//      columns and measure: history depth, status mix over the last 90 days,
//      share of recent applications with no issue date (visible pre-approval),
//      rows per application day over the last 21 days (a publication-lag
//      proxy: a short lag shows full volume on recent days), and fill rates of
//      participant columns (contractor, applicant, architect, engineer, owner).
//   3. legistar: public Legistar Web API per client (planning agendas, cases).
//   4. portals: robots.txt of the permit portals (no portal scraping).
//
// No dependencies, <= 2 requests/second. Run:
//   node recon/preapproval_scan.js [--out=recon/out/preapproval] [--only=seeds|discover|legistar|portals]
// CI: .github/workflows/feasibility.yml input `preapproval`.

const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const OUT = args.out || 'recon/out/preapproval';
const ONLY = args.only ? String(args.only).split(',') : null;
const MAX_PROBE = Number(args['max-probe'] || 60);
const UA = 'permit-leads-preapproval-scan/0.1 (research; read-only)';
const DAY = 864e5;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const want = (k) => !ONLY || ONLY.includes(k);

let last = 0;
async function get(url, { json = true, attempts = 2 } = {}) {
  for (let i = 1; ; i += 1) {
    const wait = 500 - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(45000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 140).replace(/\s+/g, ' ')}`);
      if (!json) return text;
      const body = JSON.parse(text);
      if (body && body.error) throw new Error(`API error: ${JSON.stringify(body.error).slice(0, 180)}`);
      return body;
    } catch (err) {
      if (i >= attempts) throw new Error(`${err.message} <- ${url.slice(0, 180)}`);
      await sleep(1500 * i);
    }
  }
}

const RX = {
  topic: /appl|pending|review|site.?plan|zoning|rezon|land.?use|development|case|filing|submitt|intake|planning|entitle|variance|subdivision|plat/i,
  status: /status|state$|phase|stage|disposition/i,
  apply: /appl|filed|filing|submit|intake|receiv|open(ed)?_?d|creat|start|accept/i,
  issue: /issue/i,
  role: /contractor|applicant|architect|engineer|owner|design|professional|agent|expedit|filing_?rep|business|consultant|developer|representative|firm|company|licensee/i,
  roleSkip: /phone|addr|street|city|state|zip|email|type|lic.*(exp|date)/i,
};

// ---------------------------------------------------------------- seeds
// Datasets worth probing whatever the catalog search returns. Our 4 live
// markets first, then candidates known to publish filings. Bad ids just error.
const SEEDS = [
  // live markets
  'socrata:data.austintexas.gov/3syk-w9eu',
  'arcgis:https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0',
  'arcgis:https://services1.arcgis.com/CvuPhqcTQpZPT9qY/arcgis/rest/services/Building_Permits_Since_2014/FeatureServer/0',
  'arcgis:https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Building_Permits/FeatureServer/0',
  // candidates publishing filings or in-review records
  'socrata:data.cityofnewyork.us/w9ak-ipjd', // DOB NOW: Build job application filings
  'socrata:data.cityofnewyork.us/ic3t-wcy2', // DOB job application filings (BIS)
  'socrata:data.sfgov.org/i98e-djp9', // DBI building permits (filed..complete)
  'socrata:data.seattle.gov/76t5-zqzr', // SDCI building permits
  'socrata:data.seattle.gov/ht3q-kdvx', // SDCI land use permits
  'socrata:data.lacity.org/pi9x-tg5x',
  'socrata:data.lacity.org/yv23-pmwf',
  'socrata:data.cityoforlando.net/ryhf-m453',
  'socrata:data.montgomerycountymd.gov/m88u-pqki',
  'socrata:data.montgomerycountymd.gov/i26v-w6bd',
  'socrata:data.cityofchicago.org/ydr8-5enu',
  'socrata:data.honolulu.gov/4vab-c87q',
  'socrata:data.kcmo.org/ntw8-aacc',
  'socrata:data.nola.gov/72f9-bi28',
  'socrata:data.cambridgema.gov/qu2z-8suj',
  'socrata:data.brla.gov/7fq7-8j7r',
];
const SOCRATA_DOMAINS = ['data.austintexas.gov', 'data.raleighnc.gov', 'data.cityofnewyork.us', 'data.sfgov.org', 'data.seattle.gov', 'data.lacity.org', 'data.cityoforlando.net', 'data.montgomerycountymd.gov', 'data.nashville.gov', 'data.sanantonio.gov', 'data.miamigov.com', 'opendata.miamidade.gov'];
const ARCGIS_MARKETS = ['Austin', 'Miami-Dade', 'City of Miami', 'Raleigh', 'San Antonio', 'Nashville', 'Orlando', 'Fort Lauderdale', 'Tampa', 'Denver', 'Phoenix', 'Charlotte'];
const LEGISTAR = ['austintexas', 'miamidade', 'miamifl', 'raleighnc', 'sanantonio', 'nashville', 'seattle', 'sfgov', 'orlando', 'denver', 'phoenix', 'charlottenc', 'tampa', 'fortlauderdale', 'mesa', 'chicago'];
const PORTALS = ['https://abc.austintexas.gov', 'https://www.miamidade.gov', 'https://www.miamigov.com', 'https://permitportal.raleighnc.gov', 'https://raleighnc-energovpub.tylerhost.net', 'https://aca-prod.accela.com', 'https://a810-dobnow.nyc.gov', 'https://dbiweb02.sfgov.org', 'https://cosaccela.seattle.gov', 'https://aca-prod.accela.com/SANANTONIO'];

// ------------------------------------------------------------- discover
async function discoverSocrata() {
  const out = new Map();
  const qs = ['permit applications', 'applications submitted', 'pending permits', 'plan review', 'permits applied', 'site plan', 'zoning cases', 'land use permits', 'development applications', 'rezoning', 'planning cases', 'development review', 'job application filings'];
  const add = (r) => {
    const name = r.resource.name || '';
    const desc = (r.resource.description || '').slice(0, 300);
    if (!RX.topic.test(name + ' ' + desc)) return;
    if (!/permit|plan|zon|land|develop|construct|build|filing|case/i.test(name)) return;
    const key = `${r.metadata.domain}/${r.resource.id}`;
    if (out.has(key)) return;
    out.set(key, { spec: `socrata:${key}`, name, domain: r.metadata.domain, updated: (r.resource.data_updated_at || '').slice(0, 10), cols: r.resource.columns_field_name || [] });
  };
  for (const q of qs) {
    try {
      const b = await get(`https://api.us.socrata.com/api/catalog/v1?q=${encodeURIComponent(q)}&only=dataset&limit=100`);
      (b.results || []).forEach(add);
    } catch (e) { console.log(`socrata catalog "${q}": ${e.message}`); }
  }
  for (const d of SOCRATA_DOMAINS) {
    for (const q of ['application', 'permit', 'zoning', 'site plan', 'case']) {
      try {
        const b = await get(`https://api.us.socrata.com/api/catalog/v1?domains=${d}&q=${encodeURIComponent(q)}&only=dataset&limit=50`);
        (b.results || []).forEach(add);
      } catch (e) { console.log(`socrata ${d} "${q}": ${e.message}`); }
    }
  }
  return [...out.values()];
}

async function discoverArcgis() {
  const out = new Map();
  for (const m of ARCGIS_MARKETS) {
    const query = `"${m}" AND (application OR applications OR "site plan" OR zoning OR rezoning OR "development review" OR "plan review" OR pending OR "land use" OR "development case") AND (type:"Feature Service" OR type:"Map Service")`;
    try {
      const b = await get(`https://www.arcgis.com/sharing/rest/search?f=json&num=60&sortField=modified&sortOrder=desc&q=${encodeURIComponent(query)}`);
      for (const r of b.results || []) {
        if (!r.url || !RX.topic.test(r.title || '')) continue;
        if (!out.has(r.url)) out.set(r.url, { market: m, url: r.url, title: r.title, owner: r.owner, modified: isoDay(r.modified), views: r.numViews });
      }
    } catch (e) { console.log(`arcgis "${m}": ${e.message}`); }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- probe
function pickCols(cols) {
  const dates = cols.filter((c) => c.type === 'date').map((c) => c.name);
  const texts = cols.filter((c) => c.type !== 'date').map((c) => c.name);
  const status = texts.find((c) => /^(status|current_?status|status_?current|permit_?status|job_?status|filing_?status|case_?status|statuscurrent|status_?desc|permitstatus|STATUS)$/i.test(c)) || texts.find((c) => RX.status.test(c) && !/date|code$/i.test(c));
  const apply = dates.find((c) => RX.apply.test(c) && !RX.issue.test(c)) || null;
  const issue = dates.find((c) => RX.issue.test(c)) || null;
  const roles = texts.filter((c) => RX.role.test(c) && !RX.roleSkip.test(c)).slice(0, 14);
  return { status, apply, issue, roles, dates };
}

async function probeSocrata(domain, id) {
  const r = { kind: 'socrata', spec: `socrata:${domain}/${id}` };
  try {
    const m = await get(`https://${domain}/api/views/${id}.json`);
    r.name = m.name; r.license = m.license?.name || m.licenseId || null; r.attribution = m.attribution || null;
    r.rowsUpdated = m.rowsUpdatedAt ? isoDay(m.rowsUpdatedAt * 1000) : null;
    const cols = (m.columns || []).filter((c) => !c.fieldName.startsWith(':')).map((c) => ({ name: c.fieldName, type: /date|calendar/i.test(c.dataTypeName) ? 'date' : 'text' }));
    // Text columns that hold dates (common in older datasets)
    Object.assign(r, pickCols(cols));
    r.cols = cols.map((c) => c.name);
    const base = `https://${domain}/resource/${id}.json`;
    const sq = (p) => get(`${base}?${p}`);
    r.total = Number((await sq('$select=count(*) as n'))[0].n);
    const dcol = r.apply || r.issue || r.dates[0];
    r.dateCol = dcol;
    if (dcol) {
      const s = (await sq(`$select=min(${dcol}) as lo, max(${dcol}) as hi`))[0];
      r.minDate = s.lo?.slice(0, 10); r.maxDate = s.hi?.slice(0, 10);
      const since90 = isoDay(Date.now() - 90 * DAY);
      const w90 = `${dcol} >= '${since90}T00:00:00' and ${dcol} <= '${isoDay(Date.now() + DAY)}T00:00:00'`;
      r.n90 = Number((await sq(`$select=count(*) as n&$where=${encodeURIComponent(w90)}`))[0].n);
      if (r.status) {
        const g = await sq(`$select=${r.status} as s, count(*) as n&$where=${encodeURIComponent(w90)}&$group=${r.status}&$order=n desc&$limit=25`);
        r.statusMix = g.map((x) => `${x.s ?? 'NULL'}:${x.n}`);
      }
      if (r.apply && r.issue) {
        const w30 = `${r.apply} >= '${isoDay(Date.now() - 30 * DAY)}T00:00:00'`;
        const all = Number((await sq(`$select=count(*) as n&$where=${encodeURIComponent(w30)}`))[0].n);
        const open = Number((await sq(`$select=count(*) as n&$where=${encodeURIComponent(`${w30} and ${r.issue} is null`)}`))[0].n);
        r.applied30 = all; r.applied30NoIssue = open; r.pctPreIssue30 = pct(open, all);
      }
      const w21 = `${dcol} >= '${isoDay(Date.now() - 21 * DAY)}T00:00:00'`;
      const daily = await sq(`$select=date_trunc_ymd(${dcol}) as d, count(*) as n&$where=${encodeURIComponent(w21)}&$group=d&$order=d desc&$limit=30`);
      r.daily21 = daily.map((x) => `${String(x.d).slice(5, 10)}:${x.n}`);
      const rows = await sq(`$order=${dcol} desc&$limit=500&$where=${encodeURIComponent(w90)}`);
      r.roleFill = Object.fromEntries(r.roles.map((c) => [c, pct(rows.filter((x) => String(x[c] ?? '').trim()).length, rows.length)]));
      r.sampleN = rows.length;
    }
  } catch (e) { r.error = e.message; }
  return r;
}

async function probeArcgis(url) {
  const r = { kind: 'arcgis', spec: `arcgis:${url}` };
  try {
    let lurl = url.replace(/\/+$/, '');
    let l = await get(`${lurl}?f=json`);
    if (!/\/\d+$/.test(lurl)) {
      const first = [...(l.layers || []), ...(l.tables || [])][0];
      if (!first) throw new Error('no layers');
      lurl = `${lurl}/${first.id}`; l = await get(`${lurl}?f=json`);
      r.spec = `arcgis:${lurl}`;
    }
    r.name = l.name; r.copyright = String(l.copyrightText || '').slice(0, 160);
    r.lastEdit = l.editingInfo?.lastEditDate ? isoDay(l.editingInfo.lastEditDate) : null;
    const cols = (l.fields || []).map((f) => ({ name: f.name, type: f.type === 'esriFieldTypeDate' || f.type === 'esriFieldTypeDateOnly' ? 'date' : 'text' }));
    Object.assign(r, pickCols(cols));
    r.cols = cols.map((c) => c.name);
    const q = (p) => get(`${lurl}/query?f=json&${p}`);
    r.total = (await q('where=1%3D1&returnCountOnly=true')).count;
    const dcol = r.apply || r.issue || r.dates[0];
    r.dateCol = dcol;
    if (dcol) {
      const stats = encodeURIComponent(JSON.stringify([{ statisticType: 'min', onStatisticField: dcol, outStatisticFieldName: 'lo' }, { statisticType: 'max', onStatisticField: dcol, outStatisticFieldName: 'hi' }]));
      try { const s = (await q(`where=1%3D1&outStatistics=${stats}`)).features[0].attributes; r.minDate = s.lo ? isoDay(s.lo) : null; r.maxDate = s.hi ? isoDay(s.hi) : null; } catch (e) { r.statsError = e.message.slice(0, 100); }
      const ts = (d) => `TIMESTAMP '${isoDay(Date.now() - d * DAY)} 00:00:00'`;
      const w90 = encodeURIComponent(`${dcol} >= ${ts(90)}`);
      r.n90 = (await q(`where=${w90}&returnCountOnly=true`)).count;
      if (r.status) {
        const st = encodeURIComponent(JSON.stringify([{ statisticType: 'count', onStatisticField: r.status, outStatisticFieldName: 'n' }]));
        try {
          const g = await q(`where=${w90}&outStatistics=${st}&groupByFieldsForStatistics=${r.status}&orderByFields=n%20DESC`);
          r.statusMix = g.features.slice(0, 25).map((f) => `${f.attributes[r.status] ?? 'NULL'}:${f.attributes.n}`);
        } catch (e) { r.statusError = e.message.slice(0, 100); }
      }
      if (r.apply && r.issue) {
        const w30 = `${r.apply} >= ${ts(30)}`;
        r.applied30 = (await q(`where=${encodeURIComponent(w30)}&returnCountOnly=true`)).count;
        r.applied30NoIssue = (await q(`where=${encodeURIComponent(`${w30} AND ${r.issue} IS NULL`)}&returnCountOnly=true`)).count;
        r.pctPreIssue30 = pct(r.applied30NoIssue, r.applied30);
      }
      const rows = (await q(`where=${encodeURIComponent(`${dcol} >= ${ts(21)}`)}&outFields=*&returnGeometry=false&orderByFields=${encodeURIComponent(dcol + ' DESC')}&resultRecordCount=2000`)).features.map((f) => f.attributes);
      const byDay = {};
      for (const x of rows) if (x[dcol]) { const d = isoDay(x[dcol]).slice(5); byDay[d] = (byDay[d] || 0) + 1; }
      r.daily21 = Object.entries(byDay).sort().reverse().map(([d, n]) => `${d}:${n}`);
      const s500 = rows.slice(0, 500);
      r.roleFill = Object.fromEntries(r.roles.map((c) => [c, pct(s500.filter((x) => String(x[c] ?? '').trim()).length, s500.length)]));
      r.sampleN = s500.length;
    }
  } catch (e) { r.error = e.message; }
  return r;
}

// ------------------------------------------------------------- legistar
async function legistar(client) {
  const r = { client };
  try {
    const since = isoDay(Date.now() - 45 * DAY);
    const ev = await get(`https://webapi.legistar.com/v1/${client}/events?$filter=${encodeURIComponent(`EventDate ge datetime'${since}'`)}&$top=500`);
    r.events45 = ev.length;
    const bodies = [...new Set(ev.map((e) => e.EventBodyName))];
    r.planningBodies = bodies.filter((b) => /plan|zon|land|develop|board of adjust|historic|design/i.test(b)).slice(0, 8);
    r.agendasPublished = ev.filter((e) => e.EventAgendaFile).length;
    const mt = await get(`https://webapi.legistar.com/v1/${client}/mattertypes`);
    r.zoningMatterTypes = mt.map((m) => m.MatterTypeName).filter((n) => /zon|plan|site|plat|variance|land|develop|annex/i.test(n)).slice(0, 8);
    const m = await get(`https://webapi.legistar.com/v1/${client}/matters?$orderby=MatterIntroDate%20desc&$top=1`);
    r.latestMatter = m[0] ? `${String(m[0].MatterIntroDate).slice(0, 10)} ${m[0].MatterTypeName}: ${String(m[0].MatterTitle || m[0].MatterName || '').slice(0, 80)}` : null;
  } catch (e) { r.error = e.message.slice(0, 160); }
  return r;
}

async function robots(base) {
  try {
    const t = await get(`${new URL(base).origin}/robots.txt`, { json: false, attempts: 1 });
    const lines = t.split(/\r?\n/).filter((l) => /^(user-agent|disallow|allow|crawl-delay)/i.test(l.trim())).slice(0, 12);
    return { base, robots: lines.join(' | ').slice(0, 400) || '(empty)' };
  } catch (e) { return { base, error: e.message.slice(0, 120) }; }
}

// ------------------------------------------------------------- indirect
// Indirect early signals (ADR-16 research): datasets that reveal construction
// before or beside the building permit. Discovery by keyword on the market
// portals; each hit is probed like any other dataset.
const INDIRECT_TERMS = ['architectural barriers', 'TABS', 'right of way', 'right-of-way', 'driveway', 'street cut', 'excavation', 'tree permit', 'tree removal', 'demolition', 'certificate of occupancy', 'water tap', 'utility service', 'meter', 'stormwater', 'notice of intent', 'TABC', 'alcoholic beverage', 'liquor license', 'food establishment', 'health permit', 'fire plan review', 'fire permit', 'solicitation', 'bid opportunities', 'notice of commencement', 'subdivision plat', 'pre-application', 'development agreement', 'board of adjustment'];
const INDIRECT_DOMAINS = ['data.austintexas.gov', 'data.texas.gov', 'data.raleighnc.gov', 'data.miamigov.com', 'data.sanantonio.gov', 'data.cityoforlando.net'];
async function discoverIndirect() {
  const out = new Map();
  for (const d of INDIRECT_DOMAINS) {
    for (const q of INDIRECT_TERMS) {
      try {
        const b = await get(`https://api.us.socrata.com/api/catalog/v1?domains=${d}&q=${encodeURIComponent(q)}&only=dataset&limit=8`);
        for (const r of b.results || []) {
          const key = `${r.metadata.domain}/${r.resource.id}`;
          if (out.has(key)) { out.get(key).terms.push(q); continue; }
          out.set(key, { spec: `socrata:${key}`, name: r.resource.name, updated: (r.resource.data_updated_at || '').slice(0, 10), terms: [q] });
        }
      } catch (e) { /* domain not on Socrata */ }
    }
  }
  const arc = new Map();
  for (const m of ['Austin', 'Miami-Dade', 'Miami', 'Raleigh']) {
    const query = `"${m}" AND ("right of way" OR "tree" OR demolition OR "certificate of occupancy" OR "notice of commencement" OR stormwater OR "utility" OR "site plan" OR "development") AND (type:"Feature Service")`;
    try {
      const b = await get(`https://www.arcgis.com/sharing/rest/search?f=json&num=80&sortField=modified&sortOrder=desc&q=${encodeURIComponent(query)}`);
      for (const r of b.results || []) if (r.url && !arc.has(r.url)) arc.set(r.url, { market: m, url: r.url, title: r.title, owner: r.owner, modified: isoDay(r.modified) });
    } catch (e) { console.log(`arcgis indirect ${m}: ${e.message}`); }
  }
  return { socrata: [...out.values()], arcgis: [...arc.values()] };
}

// ----------------------------------------------------------------- main
function line(r) {
  if (r.error) return `ERR ${r.spec}: ${r.error.slice(0, 200)}`;
  const roles = Object.entries(r.roleFill || {}).map(([c, v]) => `${c}=${v}%`).join(' ');
  return [
    `${r.spec} | ${r.name}`,
    `  total=${r.total} n90=${r.n90} date=${r.dateCol} ${r.minDate}..${r.maxDate} updated=${r.rowsUpdated || r.lastEdit || '?'} licence=${r.license || r.copyright || '?'}`,
    `  status=${r.status} apply=${r.apply} issue=${r.issue} preIssue30=${r.pctPreIssue30 ?? '-'}% (${r.applied30NoIssue ?? '-'}/${r.applied30 ?? '-'})`,
    `  statusMix90: ${(r.statusMix || []).join(', ').slice(0, 600)}`,
    `  daily21: ${(r.daily21 || []).join(' ')}`,
    `  roles(n=${r.sampleN}): ${roles.slice(0, 500)}`,
    ...(args.cols ? [`  cols: ${(r.cols || []).join(',').slice(0, 1500)}`] : []),
    ...(r.groups ? Object.entries(r.groups).map(([c, g]) => `  group ${c}: ${g.join(', ').slice(0, 700)}`) : []),
  ].join('\n');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const report = { at: new Date().toISOString() };
  const specs = new Set();
  if (want('seeds') && (!ONLY || !ONLY.includes('indirect'))) SEEDS.forEach((s) => specs.add(s));
  if (want('discover')) {
    const soc = await discoverSocrata();
    report.socrataFound = soc.map(({ cols, ...x }) => x);
    console.log(`\n== Socrata candidates (${soc.length})`);
    for (const s of soc) console.log(`  ${s.spec} | ${s.updated} | ${s.name}`);
    const recent = soc.filter((s) => s.updated >= isoDay(Date.now() - 60 * DAY));
    recent.slice(0, MAX_PROBE).forEach((s) => specs.add(s.spec));
    const arc = await discoverArcgis();
    report.arcgisFound = arc;
    console.log(`\n== ArcGIS candidates (${arc.length})`);
    for (const a of arc) console.log(`  [${a.market}] ${a.modified} ${a.title} (${a.owner}) ${a.url}`);
    arc.filter((a) => a.modified >= isoDay(Date.now() - 60 * DAY)).slice(0, 40).forEach((a) => specs.add(`arcgis:${a.url}`));
  }
  if (want('indirect')) {
    const ind = await discoverIndirect();
    report.indirect = ind;
    console.log(`\n== Indirect signal candidates: Socrata ${ind.socrata.length}, ArcGIS ${ind.arcgis.length}`);
    for (const s of ind.socrata) console.log(`  ${s.spec} | ${s.updated} | ${s.name} | ${s.terms.join(';')}`);
    for (const a of ind.arcgis) console.log(`  [${a.market}] ${a.modified} ${a.title} (${a.owner}) ${a.url}`);
    ind.socrata.filter((s) => s.updated >= isoDay(Date.now() - 45 * DAY)).slice(0, 45).forEach((s) => specs.add(s.spec));
    ind.arcgis.filter((a) => a.modified >= isoDay(Date.now() - 30 * DAY) && /right|tree|demol|occupan|commence|storm|site|develop|utility|tap/i.test(a.title)).slice(0, 25).forEach((a) => specs.add(`arcgis:${a.url}`));
  }
  // --soql="domain/id?query;domain/id?query": raw Socrata queries, first rows printed
  if (args.soql) {
    for (const q of String(args.soql).split(';')) {
      try { const rows = await get(`https://${q.replace('?', '.json?').replace(/^([^/]+)\//, '$1/resource/')}`); console.log(`\n== SoQL ${q}\n  ${JSON.stringify(rows).slice(0, 1500)}`); } catch (e) { console.log(`soql ${q}: ${e.message}`); }
    }
  }
  // --austinlink: do Austin plan-review applications become the same permit number in the issued dataset?
  if (args.austinlink) {
    try {
      const pr = await get(`https://datahub.austintexas.gov/resource/n8ck-xkda.json?$select=permit_number,applied_date,issued_date,status_current,applicant_organization_name&$where=${encodeURIComponent("applied_date >= '2026-05-01T00:00:00' and applied_date < '2026-07-01T00:00:00' and issued_date is not null")}&$limit=400`);
      // Plan-review numbers look like '2026-054688 PR'; issued permits share the base ('2026-054688 BP').
      const base = (n) => String(n).split(' ')[0];
      const nums = [...new Set(pr.map((r) => base(r.permit_number)).filter(Boolean))].slice(0, 120);
      const hit = [];
      for (let i = 0; i < nums.length; i += 40) {
        const ors = nums.slice(i, i + 40).map((n) => `starts_with(permit_number,'${n} ')`).join(' or ');
        hit.push(...await get(`https://data.austintexas.gov/resource/3syk-w9eu.json?$select=permit_number,permit_class_mapped,applieddate,issue_date,contractor_company_name,contractor_trade&$where=${encodeURIComponent(ors)}&$limit=1000`));
      }
      const found = new Set(hit.map((h) => base(h.permit_number)));
      const sameIssue = nums.filter((n) => { const p0 = pr.find((r) => base(r.permit_number) === n); return hit.some((h) => base(h.permit_number) === n && String(h.issue_date).slice(0, 10) === String(p0.issued_date).slice(0, 10)); }).length;
      const sameApplied = nums.filter((n) => { const p0 = pr.find((r) => base(r.permit_number) === n); return hit.some((h) => base(h.permit_number) === n && String(h.applieddate).slice(0, 10) === String(p0.applied_date).slice(0, 10)); }).length;
      const suffixes = {}; for (const h of hit) { const s2 = String(h.permit_number).split(' ')[1] || '-'; suffixes[s2] = (suffixes[s2] || 0) + 1; }
      console.log(`\n== Austin link: plan-review cases issued May-Jun 2026 (bases) = ${nums.length}; base found in 3syk-w9eu = ${found.size} (${pct(found.size, nums.length)}%); same issue date = ${sameIssue}; same applied date = ${sameApplied}; issued suffixes ${JSON.stringify(suffixes)}`);
      const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(llc|inc|corp|co|ltd|lp)\b/g, '').replace(/\s+/g, ' ').trim();
      let withOrg = 0; let orgIsBpContractor = 0; let orgIsAnyContractor = 0;
      for (const n of found) {
        const p0 = pr.find((r) => base(r.permit_number) === n);
        if (!norm(p0.applicant_organization_name)) continue;
        withOrg += 1;
        const hs = hit.filter((h) => base(h.permit_number) === n);
        if (hs.some((h) => / BP$/.test(h.permit_number) && norm(h.contractor_company_name) === norm(p0.applicant_organization_name))) orgIsBpContractor += 1;
        if (hs.some((h) => norm(h.contractor_company_name) === norm(p0.applicant_organization_name))) orgIsAnyContractor += 1;
      }
      console.log(`  applicant org on the application: ${withOrg} of ${found.size} linked; equals the BP contractor ${orgIsBpContractor} (${pct(orgIsBpContractor, withOrg)}%); equals any contractor on the job ${orgIsAnyContractor} (${pct(orgIsAnyContractor, withOrg)}%)`);
      const topOrgs = {}; for (const r of pr) { const o = norm(r.applicant_organization_name); if (o) topOrgs[o] = (topOrgs[o] || 0) + 1; }
      console.log(`  most frequent applicant orgs (expediter check): ${JSON.stringify(Object.entries(topOrgs).sort((a, b) => b[1] - a[1]).slice(0, 12))}`);
      console.log(`  sample plan-review: ${JSON.stringify(pr.slice(0, 3).map(({ applicant_organization_name, ...x }) => x))}`);
      console.log(`  sample issued: ${JSON.stringify(hit.slice(0, 3))}`);
      const open = await get(`https://datahub.austintexas.gov/resource/n8ck-xkda.json?$select=permit_type,count(*) as n&$where=${encodeURIComponent("issued_date is null and applied_date >= '2026-08-15T00:00:00'")}&$group=permit_type&$order=n desc`);
      console.log(`  open (not issued) applications since 2026-08-15 by permit_type: ${JSON.stringify(open)}`);
      const ages = await get(`https://datahub.austintexas.gov/resource/n8ck-xkda.json?$select=max(update_date) as u, max(applied_date) as a, max(status_date) as s`);
      console.log(`  freshness: ${JSON.stringify(ages)}`);
    } catch (e) { console.log(`austinlink: ${e.message}`); }
  }
  // --arcsearch="q1;q2": raw ArcGIS Online searches, listed only
  if (args.arcsearch) {
    for (const q of String(args.arcsearch).split(';')) {
      try {
        const b = await get(`https://www.arcgis.com/sharing/rest/search?f=json&num=40&sortField=modified&sortOrder=desc&q=${encodeURIComponent(q)}`);
        console.log(`\n== ArcGIS search: ${q}`);
        for (const r of b.results || []) console.log(`  ${isoDay(r.modified)} ${r.type} ${r.title} (${r.owner}) ${r.url || ''}`);
      } catch (e) { console.log(`arcsearch ${q}: ${e.message}`); }
    }
  }
  // --specs=socrata:dom/id#groupCol|groupCol2,arcgis:url#col (explicit probes, optional group-bys)
  const groupsFor = {};
  if (args.specs) for (const raw of String(args.specs).split(',')) { const [sp, g] = raw.split('#'); specs.add(sp); if (g) groupsFor[sp] = g.split('|'); }
  report.probes = [];
  console.log(`\n== Probes (${specs.size})`);
  for (const s of specs) {
    const i = s.indexOf(':');
    const kind = s.slice(0, i); const rest = s.slice(i + 1);
    const r = kind === 'socrata' ? await probeSocrata(rest.split('/')[0], rest.split('/')[1]) : await probeArcgis(rest);
    if (groupsFor[s] && !r.error) {
      r.groups = {};
      for (const c of groupsFor[s]) {
        try {
          if (kind === 'socrata') {
            const [dom, id] = rest.split('/');
            const g = await get(`https://${dom}/resource/${id}.json?$select=${c} as v, count(*) as n&$group=${c}&$order=n desc&$limit=20`);
            r.groups[c] = g.map((x) => `${x.v ?? 'NULL'}:${x.n}`);
          } else {
            const st = encodeURIComponent(JSON.stringify([{ statisticType: 'count', onStatisticField: c, outStatisticFieldName: 'n' }]));
            const u = r.spec.slice(7);
            const g = await get(`${u}/query?f=json&where=1%3D1&outStatistics=${st}&groupByFieldsForStatistics=${c}&orderByFields=n%20DESC`);
            r.groups[c] = g.features.slice(0, 20).map((f) => `${f.attributes[c] ?? 'NULL'}:${f.attributes.n}`);
          }
        } catch (e) { r.groups[c] = [`ERR ${e.message.slice(0, 100)}`]; }
      }
    }
    report.probes.push(r);
    console.log(line(r));
  }
  if (want('legistar')) {
    console.log('\n== Legistar');
    report.legistar = [];
    for (const c of LEGISTAR) { const r = await legistar(c); report.legistar.push(r); console.log(`  ${JSON.stringify(r)}`); }
  }
  if (want('portals')) {
    console.log('\n== Portal robots.txt');
    report.portals = [];
    for (const p of PORTALS) { const r = await robots(p); report.portals.push(r); console.log(`  ${JSON.stringify(r)}`); }
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\nwrote ${path.join(OUT, 'report.json')}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { pickCols };
