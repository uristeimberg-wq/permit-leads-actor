// Early-signal backtest for Austin (docs/DATA_STRATEGY.md section 8, P0; ADR-18).
//
// Question: which public records came before a new main-building permit (BP),
// how often, and how much earlier than the BP application? Built from the
// city's own open data, 2019-2024, read-only. Nothing is written to any
// database; the output is an aggregate report.
//
// Signals: site plans (mavg-96ck), zoning cases (edir-dcnf), subdivision cases
// (s7gx-9m54) and demolition BPs (3syk-w9eu). Outcomes: new main-building BPs
// (3syk-w9eu, census class codes 101-105, 213-214, 318-328; accessory
// structures such as dumpsters and carports, code 329, never count).
// Plan-review cases (n8ck-xkda) give the city's property id (propertyrsn) for
// a BP through masterpermitnum = folderrsn.
//
// Link bases, reported separately and never mixed (DATA_STRATEGY section 6):
//   cited     - the BP description cites the case number (official reference)
//   prsn      - same AMANDA propertyrsn (official city property id)
//   parcel    - same appraisal-district parcel id (tcad_id / appraisal_id)
//   spatial   - within 75 m (inferred; context only)
// Parcels with more than CAP_CASES planning cases or CAP_BPS main BPs are
// excluded from parcel and spatial links (campus parcels over-match).
//
//   node recon/early_backtest.js [--out=recon/out/early-backtest]
//
// Polite: <= 2 requests/second, paged 50k rows. Every filtered query is
// checked to have actually filtered (rule 3: no silent failures).

const fs = require('node:fs');
const path = require('node:path');

const DAY = 864e5;
const WINDOWS = [183, 365, 730];
const LOOKBACK = 1095;           // pre-application capture: signal up to 3 years before the BP application
const SPATIAL_M = 75;
const CAP_CASES = 5;
const CAP_BPS = 20;
const SIGNAL_FROM = '2019-01-01'; const SIGNAL_TO = '2024-10-31';   // 24 months of follow-up observed by 2026-11
const CAPTURE_FROM = '2020-01-01'; const CAPTURE_TO = '2024-12-31';
const BP_FROM = '2013-06-01';    // placebo needs BPs five years before the first signal

const t = (d) => (d ? Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) : NaN);
const days = (a, b) => Math.round((t(b) - t(a)) / DAY);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const dist = (xs) => ({ n: xs.length, p25: quantile(xs, 0.25), p50: quantile(xs, 0.5), p75: quantile(xs, 0.75), p90: quantile(xs, 0.9) });
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
// Wilson 95% interval, in percent.
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96; const p = k / n; const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den; const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.round(1000 * Math.max(0, c - h)) / 10, Math.round(1000 * Math.min(1, c + h)) / 10];
}

const normParcel = (v) => { const s = String(v ?? '').toUpperCase().replace(/[^0-9A-Z]/g, ''); return s && !/^0+$/.test(s) ? s : null; };
const normPrsn = (v) => { const s = String(v ?? '').trim(); return s && s !== '0' ? s : null; };
const normCase = (v) => String(v ?? '').toUpperCase().replace(/\s+/g, '').replace(/\(.*$/, '').replace(/\.SH$/, '');
const classCode = (v) => { const m = String(v ?? '').match(/(\d{3})/); return m ? Number(m[1]) : null; };

function segmentOf(code) {
  if (code === 101 || code === 102) return 'single-family';
  if (code === 103 || code === 104) return 'small multifamily (2-4)';
  if (code === 105) return 'multifamily (5+)';
  if (code === 213 || code === 214 || (code >= 318 && code <= 328)) return 'commercial';
  return null;
}
const isMainNew = (b) => b.isNew && segmentOf(b.code) !== null;

// Case numbers cited in BP descriptions: SP-2023-0202C, SPC-2023-0072C, C14-2022-0007, C8-2021-0123, C8J-...
const CITE_RE = /\b(SPC?-\d{2,4}-\s?\d{3,4}[A-Z]{0,2}|C14[A-Z]?-\d{2,4}-\s?\d{3,4}|C8[A-Z]?-\d{2,4}-\s?\d{3,4}[A-Z.]{0,4})/gi;
function citedCases(desc) {
  const out = new Set();
  for (const m of String(desc ?? '').matchAll(CITE_RE)) out.add(normCase(m[1]));
  return [...out];
}

const NON_BUILDING = /\b(row|r\.o\.w|right[- ]of[- ]way|utility|utilities|drainage|street|transit|trail|water quality|stormwater|wastewater|lift station|pipeline|waterline|wastewater line|sidewalk|bridge)\b/i;
const EXTENSION = /\((XT\d*|R\d+)\)|EXTENSION|REVISION|CORRECTION/i;

/** Signal kind for a normalized planning case, or null when it is not used. */
function signalKind(c) {
  if (c.dataset === 'site_plan') {
    if (EXTENSION.test(`${c.caseNumber} ${c.subType}`)) return 'site plan: extension or revision';
    if (NON_BUILDING.test(`${c.subType} ${c.work} ${c.landUse} ${c.name}`)) return 'site plan: non-building (ROW, utility, drainage)';
    return 'site plan: building';
  }
  if (c.dataset === 'zoning') {
    if (!/rezon|zoning/i.test(c.subType || 'zoning')) return 'zoning: other case type';
    return c.approved ? 'rezoning: approved' : 'rezoning: not approved';
  }
  if (c.dataset === 'subdivision') return /prelim/i.test(c.subType) ? 'subdivision: preliminary' : 'subdivision: other (final plat, etc.)';
  return null;
}

// Grid index for the spatial link: ~0.001 degree cells.
function gridIndex(items) {
  const g = new Map();
  for (const it of items) {
    if (!Number.isFinite(it.lat) || !Number.isFinite(it.lon)) continue;
    const k = `${Math.floor(it.lat * 1000)}:${Math.floor(it.lon * 1000)}`;
    if (!g.has(k)) g.set(k, []); g.get(k).push(it);
  }
  return g;
}
function metres(a, b) {
  const R = 6371000; const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r; const dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function near(g, p) {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return [];
  const la = Math.floor(p.lat * 1000); const lo = Math.floor(p.lon * 1000); const out = [];
  for (let i = -1; i <= 1; i += 1) for (let j = -1; j <= 1; j += 1) for (const it of g.get(`${la + i}:${lo + j}`) || []) if (metres(p, it) <= SPATIAL_M) out.push(it);
  return out;
}

const push = (m, k, v) => { if (k == null) return; if (!m.has(k)) m.set(k, []); m.get(k).push(v); };

/**
 * Pure analysis over normalized rows (exported for the offline test).
 * cases: { dataset, caseNumber, filed, approved, status, subType, work, landUse, name, parcel, prsn, lat, lon }
 * bps:   { number, applied, issued, code, isNew, isDemo, master, desc, parcel, lat, lon }
 * reviews (plan review): { folderrsn, prsn, parcel }
 */
function analyze({ cases, bps, reviews }) {
  const out = { config: { WINDOWS, LOOKBACK, SPATIAL_M, CAP_CASES, CAP_BPS, SIGNAL_FROM, SIGNAL_TO, CAPTURE_FROM, CAPTURE_TO } };
  const prByFolder = new Map(reviews.map((r) => [String(r.folderrsn), r]));
  const main = bps.filter(isMainNew).map((b) => {
    const pr = b.master ? prByFolder.get(String(b.master)) : null;
    return { ...b, segment: segmentOf(b.code), prsn: pr ? pr.prsn : null, cites: citedCases(b.desc) };
  });

  // ---- Link quality ----
  const mainInWindow = main.filter((b) => b.applied >= SIGNAL_FROM && b.applied <= CAPTURE_TO);
  const children = new Map(); for (const b of bps) if (b.master) children.set(b.master, (children.get(b.master) || 0) + 1);
  out.linkQuality = {
    mainNewBps: mainInWindow.length,
    pctWithParcel: pct(mainInWindow.filter((b) => b.parcel).length, mainInWindow.length),
    pctWithMaster: pct(mainInWindow.filter((b) => b.master).length, mainInWindow.length),
    pctMasterResolvesToPlanReview: pct(mainInWindow.filter((b) => b.master && prByFolder.has(String(b.master))).length, mainInWindow.filter((b) => b.master).length),
    pctWithPropertyRsnViaPlanReview: pct(mainInWindow.filter((b) => b.prsn).length, mainInWindow.length),
    pctCitingACaseNumber: pct(mainInWindow.filter((b) => b.cites.length).length, mainInWindow.length),
    pctCitingBySegment: Object.fromEntries(['single-family', 'small multifamily (2-4)', 'multifamily (5+)', 'commercial'].map((s) => {
      const xs = mainInWindow.filter((b) => b.segment === s); return [s, { n: xs.length, pct: pct(xs.filter((b) => b.cites.length).length, xs.length) }];
    })),
    umbrellaParentsOver5Children: [...children.values()].filter((n) => n > 5).length,
  };

  // ---- Caps ----
  const casesByParcel = new Map(); for (const c of cases) if (c.parcel) casesByParcel.set(c.parcel, (casesByParcel.get(c.parcel) || 0) + 1);
  const bpsByParcel = new Map(); for (const b of main) if (b.parcel) bpsByParcel.set(b.parcel, (bpsByParcel.get(b.parcel) || 0) + 1);
  const capped = new Set([...casesByParcel].filter(([, n]) => n > CAP_CASES).map(([p]) => p)
    .concat([...bpsByParcel].filter(([, n]) => n > CAP_BPS).map(([p]) => p)));
  out.capExcludedParcels = capped.size;
  const parcelOk = (p) => p && !capped.has(p);

  const mainByParcel = new Map(); const mainByPrsn = new Map(); const mainByCite = new Map();
  for (const b of main) {
    if (parcelOk(b.parcel)) push(mainByParcel, b.parcel, b);
    push(mainByPrsn, b.prsn, b);
    for (const c of b.cites) push(mainByCite, c, b);
  }
  const mainGrid = gridIndex(main.filter((b) => !capped.has(b.parcel)));

  // Normalized signals: planning cases plus demolition BPs.
  const signals = [];
  for (const c of cases) {
    const kind = signalKind(c); if (!kind || !c.filed) continue;
    signals.push({ kind, id: normCase(c.caseNumber), date: c.filed, parcel: c.parcel, prsn: c.prsn, lat: c.lat, lon: c.lon });
  }
  for (const b of bps) {
    if (!b.isDemo || !b.applied) continue;
    const kind = b.code >= 645 && b.code <= 648 ? 'demolition: residential' : 'demolition: commercial/other';
    signals.push({ kind, id: null, date: b.applied, parcel: b.parcel, prsn: null, lat: b.lat, lon: b.lon, demoIssued: b.issued, demoNumber: b.number });
  }

  const linked = (s, basis) => {
    if (basis === 'cited') return s.id ? mainByCite.get(s.id) || [] : [];
    if (basis === 'prsn') return s.prsn ? mainByPrsn.get(s.prsn) || [] : [];
    if (basis === 'parcel') return parcelOk(s.parcel) ? mainByParcel.get(s.parcel) || [] : [];
    if (basis === 'spatial') return capped.has(s.parcel) ? [] : near(mainGrid, s);
    return [];
  };
  const official = (s) => { const m = new Map(); for (const b of ['cited', 'prsn', 'parcel']) for (const x of linked(s, b)) m.set(x.number, x); return [...m.values()]; };

  // ---- Conversion: P(main BP applied within N days after the signal) ----
  const kinds = [...new Set(signals.map((s) => s.kind))].sort();
  out.conversion = {};
  for (const kind of kinds) {
    const ss = signals.filter((s) => s.kind === kind && s.date >= SIGNAL_FROM && s.date <= SIGNAL_TO);
    const row = { signals: ss.length, withParcel: pct(ss.filter((s) => s.parcel).length, ss.length), byBasis: {} };
    for (const basis of ['official (cited, prsn or parcel)', 'cited', 'prsn', 'parcel', 'spatial']) {
      const get = basis.startsWith('official') ? official : (s) => linked(s, basis);
      const eligible = ss.filter((s) => (basis === 'parcel' || basis.startsWith('official') ? parcelOk(s.parcel) || s.prsn || s.id : basis === 'prsn' ? s.prsn : basis === 'cited' ? s.id : Number.isFinite(s.lat)));
      const r = { eligible: eligible.length };
      const leads = [];
      let placeboHits = 0;
      for (const w of WINDOWS) r[`within${w}`] = 0;
      for (const s of eligible) {
        const after = get(s).map((b) => days(s.date, b.applied)).filter((d) => d >= 0);
        const first = after.length ? Math.min(...after) : null;
        for (const w of WINDOWS) if (first != null && first <= w) r[`within${w}`] += 1;
        if (first != null && first <= 730) leads.push(first);
        // Placebo: same link, the same 24-month window five years earlier.
        const shifted = iso(t(s.date) - 1826 * DAY);
        if (get(s).some((b) => { const d = days(shifted, b.applied); return d >= 0 && d <= 730; })) placeboHits += 1;
      }
      for (const w of WINDOWS) r[`pct${w}`] = pct(r[`within${w}`], eligible.length);
      r.ci730 = wilson(r.within730, eligible.length);
      r.placebo730 = pct(placeboHits, eligible.length);
      r.lift730 = placeboHits ? Math.round((10 * r.within730) / placeboHits) / 10 : null;
      r.leadDays = dist(leads);
      row.byBasis[basis] = r;
    }
    if (kind.startsWith('demolition')) {
      // How often the new building's application came BEFORE the demolition was issued.
      const conv = ss.filter((s) => parcelOk(s.parcel)).map((s) => ({ s, b: (mainByParcel.get(s.parcel) || []).filter((b) => days(s.date, b.applied) >= -365 && days(s.date, b.applied) <= 730).sort((a, b) => a.applied.localeCompare(b.applied))[0] })).filter((x) => x.b);
      row.newBuildAppliedBeforeDemoIssued = { converted: conv.length, pct: pct(conv.filter((x) => x.s.demoIssued && x.b.applied < x.s.demoIssued).length, conv.length) };
    }
    out.conversion[kind] = row;
  }

  // ---- Pre-application capture: share of new main BPs with an earlier signal ----
  const sigByParcel = new Map(); const sigByPrsn = new Map(); const sigById = new Map();
  for (const s of signals) { if (parcelOk(s.parcel)) push(sigByParcel, s.parcel, s); push(sigByPrsn, s.prsn, s); push(sigById, s.id, s); }
  const planning = (k) => !k.startsWith('demolition') && k !== 'site plan: non-building (ROW, utility, drainage)';
  const earlier = (b) => {
    const m = new Map();
    for (const s of [...(parcelOk(b.parcel) ? sigByParcel.get(b.parcel) || [] : []), ...(b.prsn ? sigByPrsn.get(b.prsn) || [] : []), ...b.cites.flatMap((c) => sigById.get(c) || [])]) {
      const d = days(s.date, b.applied); if (d >= 1 && d <= LOOKBACK) m.set(`${s.kind}|${s.id || s.demoNumber}|${s.date}`, { ...s, lead: d });
    }
    return [...m.values()];
  };
  const capture = {};
  const targets = main.filter((b) => b.applied >= CAPTURE_FROM && b.applied <= CAPTURE_TO);
  for (const seg of ['single-family', 'small multifamily (2-4)', 'multifamily (5+)', 'commercial', 'all']) {
    const xs = targets.filter((b) => seg === 'all' || b.segment === seg);
    const withPlanning = []; const withAny = []; const byKind = {};
    for (const b of xs) {
      const e = earlier(b); if (!e.length) continue;
      withAny.push(Math.max(...e.map((s) => s.lead)));
      const p = e.filter((s) => planning(s.kind)); if (p.length) withPlanning.push(Math.max(...p.map((s) => s.lead)));
      for (const k of new Set(e.map((s) => s.kind))) byKind[k] = (byKind[k] || 0) + 1;
    }
    capture[seg] = {
      newMainBps: xs.length,
      pctWithEarlierPlanningSignal: pct(withPlanning.length, xs.length),
      ciPlanning: wilson(withPlanning.length, xs.length),
      leadOverApplicationDaysPlanning: dist(withPlanning),
      pctWithAnyEarlierSignal: pct(withAny.length, xs.length),
      leadOverApplicationDaysAny: dist(withAny),
      bySignalKind: Object.fromEntries(Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, pct(n, xs.length)])),
    };
  }
  out.preApplicationCapture = capture;
  return out;
}

function markdown(r) {
  const L = [];
  const lq = r.linkQuality;
  L.push('# Austin early-signal backtest (P0)', '',
    `Generated ${r.generatedAt} by \`recon/early_backtest.js\` from the City of Austin open data (read-only). Rows: ${JSON.stringify(r.rows)}.`,
    `Signals filed ${r.config.SIGNAL_FROM} to ${r.config.SIGNAL_TO} (24 months of follow-up observed). Capture measured on new main BPs applied ${r.config.CAPTURE_FROM} to ${r.config.CAPTURE_TO}, looking back ${r.config.LOOKBACK} days.`,
    `Parcels excluded by the campus cap (>${r.config.CAP_CASES} cases or >${r.config.CAP_BPS} main BPs): ${r.capExcludedParcels}.`, '',
    '## 1. Link quality', '',
    `New main-building BPs applied 2019-2024: **${lq.mainNewBps}**. Parcel id ${lq.pctWithParcel}%; masterpermitnum ${lq.pctWithMaster}%; masterpermitnum found as a plan-review folder ${lq.pctMasterResolvesToPlanReview}%; city property id (propertyrsn) through plan review ${lq.pctWithPropertyRsnViaPlanReview}%; description cites a case number ${lq.pctCitingACaseNumber}%. Parents with more than 5 child BPs: ${lq.umbrellaParentsOver5Children}.`, '',
    'Description cites a case number, by segment: ' + Object.entries(lq.pctCitingBySegment).map(([k, v]) => `${k} ${v.pct}% (n=${v.n})`).join(' · '), '',
    '## 2. Pre-application capture (share of new main BPs with an earlier planning signal)', '',
    '| Segment | New main BPs | Earlier planning signal | 95% CI | Median lead over application (days) | p75 | Any earlier signal incl. demolition | Median lead (any) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [k, v] of Object.entries(r.preApplicationCapture)) {
    L.push(`| ${k} | ${v.newMainBps} | ${v.pctWithEarlierPlanningSignal}% | ${v.ciPlanning ? v.ciPlanning.join('-') : ''} | ${v.leadOverApplicationDaysPlanning.p50 ?? ''} | ${v.leadOverApplicationDaysPlanning.p75 ?? ''} | ${v.pctWithAnyEarlierSignal}% | ${v.leadOverApplicationDaysAny.p50 ?? ''} |`);
  }
  L.push('', 'By signal kind (share of BPs in the segment): ' + Object.entries(r.preApplicationCapture).map(([k, v]) => `**${k}**: ${Object.entries(v.bySignalKind).map(([a, b]) => `${a} ${b}%`).join(', ')}`).join(' · '), '',
    '## 3. Conversion: P(new main BP applied within 6 / 12 / 24 months of the signal)', '',
    'Placebo = the same link checked for the 24 months starting five years earlier (how often that parcel gets a BP anyway). Lift = 24-month hits / placebo hits.', '',
    '| Signal | Basis | Eligible | 6 mo | 12 mo | 24 mo | 95% CI (24 mo) | Placebo 24 mo | Lift | Median lead (days) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [k, v] of Object.entries(r.conversion)) {
    for (const [b, x] of Object.entries(v.byBasis)) {
      if (!x.eligible) continue;
      L.push(`| ${k} (n=${v.signals}) | ${b} | ${x.eligible} | ${x.pct183}% | ${x.pct365}% | ${x.pct730}% | ${x.ci730 ? x.ci730.join('-') : ''} | ${x.placebo730}% | ${x.lift730 ?? ''} | ${x.leadDays.p50 ?? ''} |`);
    }
    if (v.newBuildAppliedBeforeDemoIssued) L.push(`| ${k}: new building applied before the demolition was issued | | ${v.newBuildAppliedBeforeDemoIssued.converted} | | | ${v.newBuildAppliedBeforeDemoIssued.pct}% | | | | |`);
  }
  L.push('', 'Read with care: "spatial" is an inferred link (75 m) and is context only. Statuses are current values, so no outcome-dependent status is used as a predictor.', '');
  return L.join('\n');
}

// ------------------------------------------------------------- fetch

const DATASETS = {
  site_plan: { domain: 'datahub.austintexas.gov', id: 'mavg-96ck', date: ['application_start_date', 'applied_date', 'filed_date'] },
  zoning: { domain: 'datahub.austintexas.gov', id: 'edir-dcnf', date: ['application_start_date', 'applied_date', 'filed_date'] },
  subdivision: { domain: 'datahub.austintexas.gov', id: 's7gx-9m54', date: ['application_start_date', 'applied_date', 'filed_date'] },
  review: { domain: 'datahub.austintexas.gov', id: 'n8ck-xkda', date: ['applied_date'] },
  bp: { domain: 'data.austintexas.gov', id: '3syk-w9eu', date: ['applieddate'] },
};
// Role -> candidate column names. A required role with no column stops the run (rule 1: no guessed maps).
const ROLES = {
  caseNumber: ['permit_number', 'case_number', 'permitnum'], folderrsn: ['folderrsn'], status: ['status_current', 'status', 'detailed_status'],
  approved: ['approval_date', 'approved_date'], subType: ['sub_type', 'case_type', 'permit_sub_type'], work: ['work', 'work_type'],
  landUse: ['proposed_land_use', 'land_use'], name: ['case_name', 'project_name'], parcel: ['tcad_id', 'appraisal_id'],
  prsn: ['propertyrsn'], lat: ['latitude'], lon: ['longitude'],
};
const REQUIRED = { site_plan: ['caseNumber', 'parcel', 'prsn'], zoning: ['caseNumber', 'parcel', 'prsn', 'approved'], subdivision: ['caseNumber', 'parcel', 'prsn'], review: ['folderrsn', 'prsn', 'parcel'] };

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const OUT = args.out || 'recon/out/early-backtest';
  const UA = 'permit-leads-feasibility/0.1 (research; read-only)';
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let last = 0; let requests = 0;
  async function getJson(url, attempts = 4) {
    for (let i = 1; ; i += 1) {
      const wait = 500 - (Date.now() - last); if (wait > 0) await sleep(wait); last = Date.now(); requests += 1;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        return JSON.parse(text);
      } catch (err) {
        if (i >= attempts) throw new Error(`${err.message} <- ${url}`);
        await sleep(2000 * 2 ** (i - 1));
      }
    }
  }
  async function pull(key, extraWhere, from, to) {
    const ds = DATASETS[key];
    const meta = await getJson(`https://${ds.domain}/api/views/${ds.id}.json`);
    const cols = new Set(meta.columns.map((c) => c.fieldName));
    const dateCol = ds.date.find((c) => cols.has(c));
    if (!dateCol) throw new Error(`${ds.id}: no date column among ${ds.date.join(', ')}`);
    const map = {};
    if (key === 'bp') {
      for (const c of ['permit_number', 'permittype', 'permit_class', 'work_class', 'applieddate', 'issue_date', 'masterpermitnum', 'tcad_id', 'description', 'latitude', 'longitude']) {
        if (!cols.has(c)) throw new Error(`3syk-w9eu: missing column ${c}`);
      }
    } else {
      for (const [role, cands] of Object.entries(ROLES)) { const c = cands.find((x) => cols.has(x)); if (c) map[role] = c; }
      const missing = (REQUIRED[key] || []).filter((r) => !map[r]);
      if (missing.length) throw new Error(`${ds.id}: missing required roles ${missing.join(', ')} (columns: ${[...cols].join(', ')})`);
    }
    const select = key === 'bp'
      ? ['permit_number', 'permittype', 'permit_class', 'work_class', 'applieddate', 'issue_date', 'masterpermitnum', 'tcad_id', 'description', 'latitude', 'longitude']
      : key === 'review' ? [dateCol, map.folderrsn, map.prsn, map.parcel] : [...new Set([dateCol, ...Object.values(map)])];
    const where = `${dateCol} >= '${from}T00:00:00' AND ${dateCol} <= '${to}T23:59:59'${extraWhere ? ` AND ${extraWhere}` : ''}`;
    const count = async (w) => Number((await getJson(`https://${ds.domain}/resource/${ds.id}.json?$select=count(*)%20as%20n${w ? `&$where=${encodeURIComponent(w)}` : ''}`))[0].n);
    const total = await count(null); const expected = await count(where);
    if (!(expected > 0 && expected < total)) throw new Error(`${ds.id}: the filter did not filter (total ${total}, filtered ${expected})`);
    let rows = [];
    for (let off = 0; ; off += 50000) {
      const page = await getJson(`https://${ds.domain}/resource/${ds.id}.json?$select=${encodeURIComponent(select.join(','))}&$where=${encodeURIComponent(where)}&$order=${encodeURIComponent(':id')}&$limit=50000&$offset=${off}`);
      rows = rows.concat(page); if (page.length < 50000) break;
    }
    if (rows.length !== expected) throw new Error(`${ds.id}: fetched ${rows.length} rows, count said ${expected}`);
    console.log(`${ds.id}: ${rows.length} rows (${dateCol}; roles ${JSON.stringify(map)})`);
    return { rows, dateCol, map };
  }
  const num = (v) => (v == null || v === '' ? NaN : Number(v));
  const d10 = (v) => (v ? String(v).slice(0, 10) : null);
  const cases = [];
  for (const key of ['site_plan', 'zoning', 'subdivision']) {
    const { rows, dateCol, map } = await pull(key, null, '2017-01-01', SIGNAL_TO);
    for (const r of rows) {
      cases.push({ dataset: key, caseNumber: r[map.caseNumber], filed: d10(r[dateCol]), approved: d10(r[map.approved]), status: r[map.status] || '',
        subType: r[map.subType] || '', work: r[map.work] || '', landUse: r[map.landUse] || '', name: r[map.name] || '',
        parcel: normParcel(r[map.parcel]), prsn: normPrsn(r[map.prsn]), lat: num(r[map.lat]), lon: num(r[map.lon]) });
    }
  }
  const rev = await pull('review', null, '2012-01-01', CAPTURE_TO);
  const reviews = rev.rows.map((r) => ({ folderrsn: String(r[rev.map.folderrsn]), prsn: normPrsn(r[rev.map.prsn]), parcel: normParcel(r[rev.map.parcel]) }));
  const bpRaw = await pull('bp', "permittype = 'BP' AND (work_class = 'New' OR work_class = 'Demolition')", BP_FROM, CAPTURE_TO);
  const bps = bpRaw.rows.map((r) => ({ number: r.permit_number, applied: d10(r.applieddate), issued: d10(r.issue_date), code: classCode(r.permit_class),
    isNew: /^new$/i.test(r.work_class || ''), isDemo: /demolition/i.test(r.work_class || ''), master: r.masterpermitnum ? String(r.masterpermitnum) : null,
    desc: r.description || '', parcel: normParcel(r.tcad_id), lat: num(r.latitude), lon: num(r.longitude) }));
  const report = {
    generatedAt: new Date().toISOString(), requests,
    rows: { cases: cases.length, reviews: reviews.length, bps: bps.length },
    ...analyze({ cases, bps, reviews }),
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const md = markdown(report);
  fs.writeFileSync(path.join(OUT, 'report.md'), md);
  console.log(md);
  console.log('\n<details><summary>report.json</summary>\n\n```json');
  console.log(JSON.stringify(report));
  console.log('```\n</details>');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
}

module.exports = { analyze, markdown, signalKind, citedCases, segmentOf, normCase, normParcel, wilson };
if (require.main === module) main().catch((err) => { console.error(err.message); process.exitCode = 1; });
