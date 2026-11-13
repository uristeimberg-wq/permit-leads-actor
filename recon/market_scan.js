// Market scan: find US jurisdictions whose permit data could feed the product.
//
// Read-only research, not a connector. Three passes:
//   1. discover: Socrata's public catalog, ArcGIS Hub search and a few CKAN
//      portals, filtered to permit datasets.
//   2. probe: for every Socrata/ArcGIS candidate with contractor-looking
//      columns (plus a seed list), fetch the live data and measure history,
//      freshness, 90-day volume, contractor name/phone/licence fill and link
//      keys (master/parent permit, parcel), from a sample of recent rows.
//   3. report: report.md / report.json under --out, and a compact log.
//
// No dependencies, <= 2 requests/second. Run:
//   node recon/market_scan.js [--out=recon/out/markets] [--max-probe=80]
//   node recon/market_scan.js --only=socrata:data.cityoforlando.net/ryhf-m453,arcgis:<layer url>
// CI runs it via .github/workflows/feasibility.yml (input `markets`).

const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)];
}));
const OUT = args.out || 'recon/out/markets';
const MAX_PROBE = Number(args['max-probe'] || 80);
const UA = 'permit-leads-market-scan/0.1 (research; read-only)';
const DAY = 864e5;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const since90 = isoDay(Date.now() - 90 * DAY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);

let last = 0;
async function get(url, { json = true, attempts = 3 } = {}) {
  for (let i = 1; ; i += 1) {
    const wait = 500 - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const ctl = AbortSignal.timeout(45000);
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
      if (!json) return text;
      const body = JSON.parse(text);
      if (body && body.error) throw new Error(`API error: ${JSON.stringify(body.error).slice(0, 200)}`);
      return body;
    } catch (err) {
      if (i >= attempts) throw new Error(`${err.message} <- ${url.slice(0, 200)}`);
      await sleep(1500 * i);
    }
  }
}

const RX = {
  permit: /permit/i,
  contractor: /contractor|contr_|cntr|licensee|business_?name|company/i,
  phone: /phone|tel/i,
  license: /lic(ense|ence)?_?(no|num|number|#)?$|license|licence|lic_no|state_lic/i,
  link: /master|parent|project|related|parcel|apn|folio|pin$|tax_?id|tcad|bbl|bin__?$|bin$/i,
  type: /type|class|work|categ|desc|subtype|trade/i,
  dateIssue: /issue|issued/i,
  dateOther: /appl|filed|creat|submit|open|status_?date|final|date/i,
};
const PHONE_IN_TEXT = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const digits = (v) => String(v ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

// ---------------------------------------------------------------- discover
async function discoverSocrata() {
  const out = new Map();
  for (const q of ['building permits', 'permits issued', 'construction permits', 'electrical permits', 'contractor permits']) {
    for (let offset = 0; offset < 400; offset += 100) {
      let body;
      try {
        body = await get(`https://api.us.socrata.com/api/catalog/v1?q=${encodeURIComponent(q)}&only=dataset&limit=100&offset=${offset}`);
      } catch (e) { console.log(`socrata catalog: ${e.message}`); break; }
      for (const r of body.results || []) {
        const cols = r.resource.columns_field_name || [];
        const name = r.resource.name || '';
        if (!RX.permit.test(name + ' ' + (r.resource.description || '').slice(0, 200))) continue;
        const key = `${r.metadata.domain}/${r.resource.id}`;
        if (out.has(key)) continue;
        out.set(key, {
          kind: 'socrata', domain: r.metadata.domain, id: r.resource.id, name,
          updated: r.resource.data_updated_at || r.resource.updatedAt,
          cols, contractorCols: cols.filter((c) => RX.contractor.test(c)),
          phoneCols: cols.filter((c) => RX.phone.test(c)),
          views: r.resource.page_views?.page_views_total ?? null,
        });
      }
      if ((body.results || []).length < 100) break;
    }
  }
  return [...out.values()];
}

async function discoverArcgis() {
  const out = new Map();
  for (const q of ['building permits', 'permits issued', 'construction permits', 'permit contractor']) {
    for (let start = 1; start < 400; start += 100) {
      let body;
      try {
        const query = `(${q}) AND (type:"Feature Service" OR type:"Map Service")`;
        body = await get(`https://www.arcgis.com/sharing/rest/search?f=json&num=100&start=${start}&sortField=numviews&sortOrder=desc&q=${encodeURIComponent(query)}`);
      } catch (e) { console.log(`arcgis search: ${e.message}`); break; }
      for (const r of body.results || []) {
        if (!r.url || !RX.permit.test(r.title || '')) continue;
        if (out.has(r.url)) continue;
        out.set(r.url, { kind: 'arcgis-item', url: r.url, title: r.title, owner: r.owner, modified: r.modified, views: r.numViews, tags: (r.tags || []).slice(0, 6) });
      }
      if (!body.nextStart || body.nextStart < 0) break;
    }
  }
  return [...out.values()];
}

// Resolve an ArcGIS service to its layers that look like permit tables and
// carry contractor columns.
async function arcgisLayers(item) {
  let url = item.url.replace(/\/+$/, '');
  const layers = [];
  try {
    if (/\/\d+$/.test(url)) {
      const l = await get(`${url}?f=json`);
      layers.push({ url, l });
    } else {
      const svc = await get(`${url}?f=json`);
      const ls = [...(svc.layers || []), ...(svc.tables || [])].slice(0, 6);
      for (const s of ls) {
        try { layers.push({ url: `${url}/${s.id}`, l: await get(`${url}/${s.id}?f=json`) }); } catch (e) { /* skip */ }
      }
    }
  } catch (e) { return [{ url, error: e.message }]; }
  return layers.map(({ url: u, l, error }) => {
    if (error) return { url: u, error };
    const cols = (l.fields || []).map((f) => f.name);
    return {
      kind: 'arcgis', url: u, name: `${item.title} / ${l.name}`, owner: item.owner,
      cols, fields: l.fields || [], contractorCols: cols.filter((c) => RX.contractor.test(c)),
      phoneCols: cols.filter((c) => RX.phone.test(c)),
      lastEdit: l.editingInfo?.lastEditDate || l.editingInfo?.dataLastEditDate || null,
      maxRecordCount: l.maxRecordCount, description: String(l.description || '').replace(/<[^>]+>/g, ' ').slice(0, 300),
      copyright: String(l.copyrightText || '').slice(0, 200),
    };
  });
}

async function discoverCkan() {
  const portals = ['https://data.sanantonio.gov', 'https://data.boston.gov', 'https://data.wprdc.org', 'https://data.sanjoseca.gov', 'https://data.houstontx.gov', 'https://opendata.dc.gov', 'https://data.louisvilleky.gov'];
  const out = [];
  for (const p of portals) {
    try {
      const body = await get(`${p}/api/3/action/package_search?q=permits&rows=15`);
      for (const pk of body.result?.results || []) {
        out.push({ kind: 'ckan', portal: p, name: pk.title, modified: pk.metadata_modified, license: pk.license_title, resources: (pk.resources || []).filter((r) => r.datastore_active || /csv/i.test(r.format)).map((r) => ({ id: r.id, name: r.name, format: r.format, datastore: !!r.datastore_active, modified: r.last_modified || r.metadata_modified })).slice(0, 4) });
      }
    } catch (e) { out.push({ kind: 'ckan', portal: p, error: e.message }); }
  }
  return out;
}

async function ckanProbe(portal, resourceId) {
  const r = { kind: 'ckan', portal, id: resourceId };
  try {
    const b = await get(`${portal}/api/3/action/datastore_search?resource_id=${resourceId}&limit=500&sort=_id%20desc`);
    const rows = b.result.records || [];
    r.total = b.result.total;
    r.cols = (b.result.fields || []).map((f) => f.id);
    Object.assign(r, sampleStats(rows, r.cols));
  } catch (e) { r.error = e.message; }
  return r;
}

// ------------------------------------------------------------------- probe
function pickDate(cols, types) {
  const dateCols = cols.filter((c) => !types || /date|time/i.test(types[c] || ''));
  return dateCols.find((c) => RX.dateIssue.test(c)) || dateCols.find((c) => /appl|filed|submit/i.test(c)) || dateCols.find((c) => RX.dateOther.test(c)) || dateCols[0] || null;
}

function sampleStats(rows, cols) {
  const n = rows.length;
  const filled = (c) => rows.filter((r) => r[c] !== null && r[c] !== undefined && String(r[c]).trim() !== '' && !/^0+$/.test(String(r[c]).trim())).length;
  const fill = (re) => Object.fromEntries(cols.filter((c) => re.test(c)).map((c) => [c, pct(filled(c), n)]));
  const phoneCols = cols.filter((c) => RX.phone.test(c));
  const contractorCols = cols.filter((c) => RX.contractor.test(c));
  const anyPhone = rows.filter((r) => phoneCols.some((c) => digits(r[c]).length >= 10) || contractorCols.some((c) => PHONE_IN_TEXT.test(String(r[c] ?? '')))).length;
  const typeCol = cols.find((c) => /permit_?type|permittype|type_?desc|work_?class|permit_?class|application_?type|subtype|^type$|record_?type|worktype|permit_?category/i.test(c)) || cols.find((c) => RX.type.test(c));
  const typeDist = typeCol ? Object.entries(rows.reduce((m, r) => { const k = String(r[typeCol] ?? '∅').slice(0, 40); m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}:${v}`) : null;
  const numCol = cols.find((c) => /permit_?(num|no|number|nbr|id)$|^permit$|permitnum|record_?id|permit_?#/i.test(c));
  return {
    sampleN: n,
    contractorFill: fill(RX.contractor),
    phoneFill: fill(RX.phone),
    anyPhonePct: pct(anyPhone, n),
    licenseFill: fill(/lic/i),
    linkFill: fill(RX.link),
    typeCol, typeDist,
    permitNumExamples: numCol ? rows.slice(0, 6).map((r) => r[numCol]) : null,
    ownerCols: cols.filter((c) => /owner/i.test(c)),
    valueCols: cols.filter((c) => /valu|cost|amount|fee/i.test(c)).slice(0, 6),
    dump: rows.slice(0, 3).map((row) => Object.fromEntries(Object.entries(row).filter(([k, v]) => v !== null && v !== '' && !/owner|shape|geom|location|^the_geom|:@/i.test(k)).map(([k, v]) => [k, String(v).slice(0, 60)]))),
  };
}

async function probeSocrata(domain, id, forceDate) {
  const base = `https://${domain}`;
  const r = { kind: 'socrata', domain, id, endpoint: `${base}/resource/${id}.json` };
  try {
    const m = await get(`${base}/api/views/${id}.json`);
    r.name = m.name;
    r.rowsUpdated = m.rowsUpdatedAt ? isoDay(m.rowsUpdatedAt * 1000) : null;
    r.license = m.license?.name || m.licenseId || null;
    r.attribution = m.attribution || null;
    r.freqText = JSON.stringify(m.metadata?.custom_fields || {}).match(/"[^"]*(frequen|update)[^"]*":"[^"]*"/i)?.[0] || null;
    const types = Object.fromEntries((m.columns || []).filter((c) => !c.fieldName.startsWith(':')).map((c) => [c.fieldName, c.dataTypeName]));
    r.cols = Object.keys(types);
    r.dateCol = forceDate || pickDate(r.cols, Object.fromEntries(Object.entries(types).map(([k, v]) => [k, v === 'calendar_date' ? 'date' : ''])));
    r.textDateCols = r.cols.filter((c) => /date/i.test(c) && types[c] === 'text');
    const q = (soql) => get(`${base}/resource/${id}.json?${soql}`);
    r.total = Number((await q('$select=count(*) as n'))[0].n);
    let rows;
    if (r.dateCol) {
      const mm = (await q(`$select=min(${r.dateCol}) as lo, max(${r.dateCol}) as hi`))[0];
      r.minDate = mm.lo?.slice(0, 10); r.maxDate = mm.hi?.slice(0, 10);
      // Some datasets carry far-future typos; take the max that is not in the future.
      if (r.maxDate && r.maxDate > isoDay(Date.now() + DAY)) {
        r.maxDate = (await q(`$select=max(${r.dateCol}) as hi&$where=${r.dateCol} <= '${isoDay(Date.now())}'`))[0].hi?.slice(0, 10);
      }
      r.n90 = Number((await q(`$select=count(*) as n&$where=${r.dateCol} >= '${since90}' and ${r.dateCol} <= '${isoDay(Date.now() + DAY)}'`))[0].n);
      rows = await q(`$where=${r.dateCol} >= '${since90}'&$order=${r.dateCol} DESC&$limit=2000`);
    } else {
      rows = await q('$limit=2000&$order=:id DESC');
    }
    Object.assign(r, sampleStats(rows, r.cols));
  } catch (e) { r.error = e.message; }
  return r;
}

async function probeArcgis(url, known, forceDate) {
  const r = { kind: 'arcgis', url, endpoint: url };
  try {
    const l = known?.fields ? known : await (async () => { const j = await get(`${url}?f=json`); return { fields: j.fields || [], name: j.name, lastEdit: j.editingInfo?.lastEditDate, maxRecordCount: j.maxRecordCount, description: String(j.description || '').replace(/<[^>]+>/g, ' ').slice(0, 300), copyright: j.copyrightText }; })();
    r.name = known?.name || l.name;
    r.lastEdit = l.lastEdit ? isoDay(l.lastEdit) : null;
    r.maxRecordCount = l.maxRecordCount;
    r.description = l.description; r.copyright = l.copyright;
    const types = Object.fromEntries(l.fields.map((f) => [f.name, f.type === 'esriFieldTypeDate' ? 'date' : '']));
    r.cols = Object.keys(types);
    r.dateCol = forceDate || pickDate(r.cols, types);
    const q = (p) => get(`${url}/query?f=json&${p}`);
    r.total = (await q('where=1%3D1&returnCountOnly=true')).count;
    let rows;
    if (r.dateCol) {
      const stats = encodeURIComponent(JSON.stringify([{ statisticType: 'min', onStatisticField: r.dateCol, outStatisticFieldName: 'lo' }, { statisticType: 'max', onStatisticField: r.dateCol, outStatisticFieldName: 'hi' }]));
      try {
        const s = (await q(`where=1%3D1&outStatistics=${stats}`)).features[0].attributes;
        r.minDate = s.lo ? isoDay(s.lo) : null; r.maxDate = s.hi ? isoDay(s.hi) : null;
      } catch (e) { r.statsError = e.message.slice(0, 120); }
      const w = encodeURIComponent(`${r.dateCol} >= TIMESTAMP '${since90} 00:00:00'`);
      try { r.n90 = (await q(`where=${w}&returnCountOnly=true`)).count; } catch (e) {
        const w2 = encodeURIComponent(`${r.dateCol} >= DATE '${since90}'`);
        r.n90 = (await q(`where=${w2}&returnCountOnly=true`)).count;
      }
      const page = Math.min(1000, l.maxRecordCount || 1000);
      rows = (await q(`where=${w}&outFields=*&returnGeometry=false&orderByFields=${encodeURIComponent(r.dateCol + ' DESC')}&resultRecordCount=${page}`)).features.map((f) => f.attributes);
    } else {
      rows = (await q('where=1%3D1&outFields=*&returnGeometry=false&resultRecordCount=1000')).features.map((f) => f.attributes);
    }
    Object.assign(r, sampleStats(rows, r.cols));
  } catch (e) { r.error = e.message; }
  return r;
}

// Seeds: likely sources the keyword search can miss. Unknown ids just error.
const SEEDS = [
  'socrata:www.dallasopendata.com/e7gq-4sah',
  'socrata:data.cityoforlando.net/ryhf-m453',
  'socrata:data.cityofnewyork.us/ipu4-2q9a',
  'socrata:data.cityofnewyork.us/rbx6-tga4',
  'socrata:data.cityofchicago.org/ydr8-5enu',
  'socrata:data.nola.gov/72f9-bi28',
  'socrata:data.mesaaz.gov/2gkz-7z4f',
  'socrata:data.kcmo.org/ntw8-aacc',
  'socrata:data.honolulu.gov/4vab-c87q',
  'socrata:data.cincinnati-oh.gov/uhjb-xac9',
  'socrata:data.montgomerycountymd.gov/m88u-pqki',
];

function parseSpec(s) {
  const [kind, rest] = [s.slice(0, s.indexOf(':')), s.slice(s.indexOf(':') + 1)];
  if (kind === 'socrata') { const [ds, dateCol] = rest.split('@'); const [domain, id] = ds.split('/'); return { kind, domain, id, dateCol }; }
  if (kind === 'ckan') { const i = rest.lastIndexOf('/'); return { kind, portal: rest.slice(0, i), id: rest.slice(i + 1) }; }
  const [url, dateCol] = rest.split('@');
  return { kind: 'arcgis', url, dateCol };
}

function line(r) {
  if (r.error) return `ERR ${r.kind} ${r.domain || r.portal || ''}${r.id ? '/' + r.id : ''}${r.url || ''} :: ${r.error.slice(0, 160)}`;
  return [
    `## ${r.kind} ${r.name || ''} :: ${r.endpoint || (r.portal + ' ' + r.id)}`,
    `total=${r.total} date=${r.dateCol} ${r.minDate || ''}..${r.maxDate || ''} n90=${r.n90 ?? ''} updated=${r.rowsUpdated || r.lastEdit || ''} lic=${r.license || r.copyright || ''} ${r.freqText || ''}`,
    `contractor=${JSON.stringify(r.contractorFill)} phone=${JSON.stringify(r.phoneFill)} anyPhone=${r.anyPhonePct}% licence=${JSON.stringify(r.licenseFill)}`,
    `link=${JSON.stringify(r.linkFill)} owner=${JSON.stringify(r.ownerCols)} value=${JSON.stringify(r.valueCols)} textDates=${JSON.stringify(r.textDateCols || [])}`,
    `type(${r.typeCol})=${JSON.stringify(r.typeDist)}`,
    `permitNums=${JSON.stringify(r.permitNumExamples)}`,
    `cols=${(r.cols || []).join(',').slice(0, 900)}`,
    ...(args.only || args.cities ? (r.dump || []).map((d) => `row=${JSON.stringify(d).slice(0, 1500)}`) : []),
  ].join('\n');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const report = { at: new Date().toISOString(), since90 };
  let targets = [];
  if (args.only || args.cities) {
    targets = String(args.only || '').split(',').filter(Boolean).map(parseSpec);
    for (const city of String(args.cities || '').split(',').filter(Boolean)) {
      const hits = [];
      try {
        const query = `"${city}" permits AND (type:"Feature Service" OR type:"Map Service")`;
        const body = await get(`https://www.arcgis.com/sharing/rest/search?f=json&num=25&q=${encodeURIComponent(query)}`);
        for (const it of (body.results || []).filter((x) => x.url && /permit/i.test(x.title))) {
          for (const l of await arcgisLayers(it)) {
            if (l.error) continue;
            console.log(`CITY ${city} A ${l.url} edit=${l.lastEdit ? isoDay(l.lastEdit) : ''} con=${l.contractorCols.join('|')} ph=${l.phoneCols.join('|')} :: ${l.name.slice(0, 70)} (${l.owner})`);
            if (l.contractorCols.length && /build|construct|permit/i.test(l.name) && (!l.lastEdit || l.lastEdit > Date.now() - 60 * DAY)) hits.push({ kind: 'arcgis', url: l.url, known: l });
          }
        }
      } catch (e) { console.log(`CITY ${city} arcgis ERR ${e.message.slice(0, 120)}`); }
      try {
        const body = await get(`https://api.us.socrata.com/api/catalog/v1?q=${encodeURIComponent(city + ' building permits')}&only=dataset&limit=10`);
        for (const x of body.results || []) console.log(`CITY ${city} S ${x.metadata.domain}/${x.resource.id} upd=${String(x.resource.data_updated_at).slice(0, 10)} con=${(x.resource.columns_field_name || []).filter((c) => RX.contractor.test(c)).join('|')} :: ${x.resource.name}`);
      } catch (e) { console.log(`CITY ${city} socrata ERR ${e.message.slice(0, 120)}`); }
      targets.push(...hits.slice(0, 2));
    }
    for (const portal of String(args.ckan || '').split(',').filter(Boolean)) {
      try {
        const body = await get(`${portal}/api/3/action/package_search?q=${encodeURIComponent('building permits')}&rows=25`);
        for (const pk of body.result?.results || []) console.log(`CK ${portal} :: ${pk.title} mod=${String(pk.metadata_modified).slice(0, 10)} res=${(pk.resources || []).map((x) => `${x.id}${x.datastore_active ? '*' : ''}@${String(x.last_modified || '').slice(0, 10)}`).slice(0, 3).join(',')}`);
      } catch (e) { console.log(`CK ${portal} ERR ${e.message.slice(0, 120)}`); }
    }
  } else {
    const soc = await discoverSocrata();
    report.socrata = soc;
    console.log(`\n# Socrata catalog: ${soc.length} permit datasets`);
    for (const d of soc.sort((a, b) => (b.contractorCols.length - a.contractorCols.length))) {
      console.log(`S ${d.domain}/${d.id} upd=${String(d.updated).slice(0, 10)} con=${d.contractorCols.join('|')} ph=${d.phoneCols.join('|')} :: ${d.name.slice(0, 70)}`);
    }
    const items = await discoverArcgis();
    console.log(`\n# ArcGIS search: ${items.length} permit services`);
    const layers = [];
    for (const it of items.slice(0, 160)) {
      for (const l of await arcgisLayers(it)) {
        if (l.error) continue;
        layers.push(l);
        if (l.contractorCols.length) console.log(`A ${l.url} edit=${l.lastEdit ? isoDay(l.lastEdit) : ''} con=${l.contractorCols.join('|')} ph=${l.phoneCols.join('|')} :: ${l.name.slice(0, 70)} (${l.owner})`);
      }
    }
    report.arcgis = layers.map(({ fields, ...rest }) => rest);
    const ck = await discoverCkan();
    report.ckan = ck;
    console.log('\n# CKAN');
    for (const c of ck) console.log(c.error ? `C ${c.portal} ERR ${c.error.slice(0, 120)}` : `C ${c.portal} :: ${c.name} mod=${String(c.modified).slice(0, 10)} lic=${c.license} res=${c.resources.map((x) => `${x.id}${x.datastore ? '*' : ''}`).join(',')}`);

    const socT = soc.filter((d) => d.contractorCols.length && new Date(d.updated) > Date.now() - 60 * DAY).map((d) => ({ kind: 'socrata', domain: d.domain, id: d.id }));
    const arcT = layers.filter((l) => l.contractorCols.length && (!l.lastEdit || l.lastEdit > Date.now() - 60 * DAY)).map((l) => ({ kind: 'arcgis', url: l.url, known: l }));
    const ckT = ck.filter((c) => !c.error && /permit/i.test(c.name)).flatMap((c) => c.resources.filter((x) => x.datastore).slice(0, 1).map((x) => ({ kind: 'ckan', portal: c.portal, id: x.id })));
    const seen = new Set();
    targets = [...SEEDS.map(parseSpec), ...socT, ...arcT, ...ckT].filter((t) => { const k = t.url || `${t.domain || t.portal}/${t.id}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_PROBE);
  }
  console.log(`\n# Probing ${targets.length} datasets (90-day window from ${since90})`);
  report.probes = [];
  for (const t of targets) {
    const r = t.kind === 'socrata' ? await probeSocrata(t.domain, t.id, t.dateCol) : t.kind === 'ckan' ? await ckanProbe(t.portal, t.id) : await probeArcgis(t.url, t.known, t.dateCol);
    report.probes.push(r);
    console.log('\n' + line(r));
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(OUT, 'report.md'), report.probes.map(line).join('\n\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
