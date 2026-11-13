// Plan-review timing and sub-hiring signals for Austin (docs/ROADMAP.md, M1 follow-up).
//
// The M1 trade-gap result (docs/DATA_SOURCES.md) is an upper bound on the
// sales window: a trade permit is pulled after the sub is hired. The open risk
// is that subs are hired during plan review, before the building permit (BP)
// is issued and before our lead exists. This script measures, from live data:
//   1. BP review time: applieddate -> issue_date for residential new /
//      addition / remodel building permits
//   2. When the linked trade permits (EP, MP, PP) were APPLIED FOR, relative to
//      the BP's application, its issue, and the day the BP becomes visible to
//      us (issue + publication lag)
//   3. GC-to-sub stickiness: how often a trade permit goes to a sub the same
//      GC already used on an earlier project
//
// Read-only, polite (<= 2 requests/second), no dependencies. Run:
//   node recon/plan_review.js [--out=recon/out/plan-review] [--months=24]
// Writes report.md and report.json. CI runs it via .github/workflows/feasibility.yml.

const fs = require('node:fs');
const path = require('node:path');

const DAY = 864e5;
const PUBLICATION_LAG_DAYS = 3; // measured in M1: permits appear 2-3 days after issue
const TRADES = { EP: 'electrical', MP: 'mechanical (HVAC)', PP: 'plumbing' };

const isoDay = (d) => d.toISOString().slice(0, 10);
const day = (s) => (s ? String(s).slice(0, 10) : null);
const daysBetween = (a, b) => Math.round((Date.parse(`${day(b)}T00:00:00Z`) - Date.parse(`${day(a)}T00:00:00Z`)) / DAY);
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const dist = (xs) => ({
  n: xs.length, p10: quantile(xs, 0.1), p25: quantile(xs, 0.25), p50: quantile(xs, 0.5),
  p75: quantile(xs, 0.75), p90: quantile(xs, 0.9),
});
const base = (pn) => String(pn || '').trim().replace(/\s+[A-Z]{2,3}$/, '');
const company = (r) => (r.contractor_company_name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const isResidentialBp = (r) => r.permittype === 'BP' && /resid/i.test(r.permit_class_mapped || '')
  && /new|addition|remodel|alteration/i.test(r.work_class || '');
const workGroup = (r) => (/new/i.test(r.work_class || '') ? 'new' : 'addition/remodel');

function reviewBuckets(ds) {
  const b = { 'same day': 0, '1-7 days': 0, '8-30 days': 0, '31-60 days': 0, '61-90 days': 0, '91-180 days': 0, '181+ days': 0 };
  for (const d of ds) {
    if (d <= 0) b['same day'] += 1;
    else if (d <= 7) b['1-7 days'] += 1;
    else if (d <= 30) b['8-30 days'] += 1;
    else if (d <= 60) b['31-60 days'] += 1;
    else if (d <= 90) b['61-90 days'] += 1;
    else if (d <= 180) b['91-180 days'] += 1;
    else b['181+ days'] += 1;
  }
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { n: v, pct: pct(v, ds.length) }]));
}

// Pure analysis over already-fetched rows; exported for the offline test.
// `today` is an ISO day. Primaries for the trade analysis need 180 days of
// follow-up, so they are BPs issued between `months` ago and 180 days ago.
function analyze(rows, { today, months = 24 } = {}) {
  const t0 = new Date(`${today}T00:00:00Z`);
  const since = new Date(t0); since.setUTCMonth(since.getUTCMonth() - months);
  const reviewFrom = new Date(t0); reviewFrom.setUTCMonth(reviewFrom.getUTCMonth() - 18);
  const followCutoff = isoDay(new Date(t0 - 180 * DAY));
  const out = {};

  // ---- 1. BP review time (BPs issued in the last 18 months) ----
  const bps = rows.filter((r) => isResidentialBp(r) && r.issue_date && day(r.issue_date) >= isoDay(reviewFrom));
  const withApplied = bps.filter((r) => r.applieddate);
  const review = withApplied.map((r) => daysBetween(r.applieddate, r.issue_date));
  const byGroup = {};
  for (const g of ['new', 'addition/remodel']) {
    const ds = withApplied.filter((r) => workGroup(r) === g).map((r) => daysBetween(r.applieddate, r.issue_date));
    byGroup[g] = { ...dist(ds), buckets: reviewBuckets(ds) };
  }
  const byQuarter = {};
  for (const r of withApplied) {
    const d = day(r.issue_date); const q = `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
    (byQuarter[q] ||= []).push(daysBetween(r.applieddate, r.issue_date));
  }
  out.reviewTime = {
    window: { from: isoDay(reviewFrom), to: today },
    residentialBps: bps.length,
    pctWithAppliedDate: pct(withApplied.length, bps.length),
    negativeDurations: review.filter((d) => d < 0).length,
    all: { ...dist(review), buckets: reviewBuckets(review) },
    byWorkGroup: byGroup,
    byWorkClass: Object.entries(withApplied.reduce((m, r) => { (m[r.work_class] ||= []).push(daysBetween(r.applieddate, r.issue_date)); return m; }, {}))
      .sort((a, b) => b[1].length - a[1].length).slice(0, 8).map(([k, ds]) => [k, ds.length, quantile(ds, 0.5), quantile(ds, 0.9)]),
    medianByIssueQuarter: Object.entries(byQuarter).sort().map(([q, ds]) => [q, ds.length, quantile(ds, 0.5)]),
  };

  // ---- 2. When were the linked trade permits applied for? ----
  const byBase = new Map();
  for (const r of rows) { const b = base(r.permit_number); if (b) { if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(r); } }
  const primaries = rows.filter((r) => isResidentialBp(r) && r.applieddate && r.issue_date
    && day(r.issue_date) >= isoDay(since) && day(r.issue_date) <= followCutoff);
  const timing = { primaries: primaries.length, linkedBy: 'permit-number base (2026-104544 BP <-> 2026-104544 EP)', byTrade: {} };
  const pairs = []; // [bp, trade, code] for stickiness
  for (const [code, name] of Object.entries(TRADES)) {
    const c = { linked: 0, tradeHasAppliedDate: 0, appliedSameDayAsBp: 0, appliedBeforeBpApplied: 0,
      appliedDuringReview: 0, appliedBeforeVisible: 0, appliedAfterVisible: 0, appliedAfterVisible7: 0,
      tradeCompanyNamedAtLatestPull: 0 };
    const vsIssue = []; const vsVisible = [];
    for (const p of primaries) {
      const sibs = (byBase.get(base(p.permit_number)) || []).filter((s) => s.permittype === code && s !== p);
      if (!sibs.length) continue;
      c.linked += 1;
      const dated = sibs.filter((s) => s.applieddate).sort((a, b) => day(a.applieddate).localeCompare(day(b.applieddate)));
      if (!dated.length) continue;
      const s = dated[0];
      c.tradeHasAppliedDate += 1;
      if (company(s)) c.tradeCompanyNamedAtLatestPull += 1;
      pairs.push([p, s, code]);
      const visible = isoDay(new Date(Date.parse(`${day(p.issue_date)}T00:00:00Z`) + PUBLICATION_LAG_DAYS * DAY));
      const dApp = daysBetween(p.applieddate, s.applieddate);
      const dIss = daysBetween(p.issue_date, s.applieddate);
      const dVis = daysBetween(visible, s.applieddate);
      vsIssue.push(dIss); vsVisible.push(dVis);
      if (dApp === 0) c.appliedSameDayAsBp += 1;
      if (dApp < 0) c.appliedBeforeBpApplied += 1;
      else if (dIss < 0) c.appliedDuringReview += 1;
      if (dVis < 0) c.appliedBeforeVisible += 1; else c.appliedAfterVisible += 1;
      if (dVis >= 7) c.appliedAfterVisible7 += 1;
    }
    const n = c.tradeHasAppliedDate;
    timing.byTrade[name] = {
      linked: c.linked, pctOfPrimaries: pct(c.linked, primaries.length), withAppliedDate: n,
      pctAppliedSameDayAsBp: pct(c.appliedSameDayAsBp, n),
      pctAppliedBeforeBpApplied: pct(c.appliedBeforeBpApplied, n),
      pctAppliedDuringBpReview: pct(c.appliedDuringReview, n),
      pctAppliedBeforeLeadVisible: pct(c.appliedBeforeVisible, n),
      pctAppliedAfterLeadVisible: pct(c.appliedAfterVisible, n),
      pctAppliedAtLeast7DaysAfterLeadVisible: pct(c.appliedAfterVisible7, n),
      tradeAppliedDaysAfterBpIssue: dist(vsIssue),
      pctTradeCompanyNamed: pct(c.tradeCompanyNamedAtLatestPull, n),
    };
  }
  out.tradeApplicationTiming = timing;

  // ---- 3. GC-to-sub stickiness ----
  // A trade permit is a "repeat" when the same GC (BP company) used the same sub
  // for the same trade on an EARLIER project (earlier BP issue date). High repeat
  // rates mean the GC has a standing sub and the job is not really open.
  const named = pairs.filter(([p, s]) => company(p) && company(s) && company(p) !== company(s))
    .sort((a, b) => day(a[0].issue_date).localeCompare(day(b[0].issue_date)));
  const gcProjects = new Map();
  for (const r of rows.filter((x) => isResidentialBp(x) && x.issue_date && day(x.issue_date) >= isoDay(since))) {
    const g = company(r); if (g) gcProjects.set(g, (gcProjects.get(g) || 0) + 1);
  }
  const sizeBand = (g) => { const k = gcProjects.get(g) || 0; return k >= 20 ? '20+ BPs' : k >= 5 ? '5-19 BPs' : '1-4 BPs'; };
  const seen = new Map(); // gc|trade -> Set(sub)
  const priorUses = new Map(); // gc|trade -> count of earlier named pairs
  const rep = { all: [0, 0, 0], byTrade: {}, byGcSize: {} };
  const bump = (o, k, isRepeat, eligible) => { o[k] ||= [0, 0, 0]; o[k][0] += 1; if (eligible) { o[k][1] += 1; if (isRepeat) o[k][2] += 1; } };
  for (const [p, s, code] of named) {
    const key = `${company(p)}|${code}`;
    const prior = priorUses.get(key) || 0;
    const isRepeat = (seen.get(key) || new Set()).has(company(s));
    const eligible = prior > 0; // only GCs with an earlier job in this trade can repeat
    bump(rep.byTrade, TRADES[code], isRepeat, eligible);
    bump(rep.byGcSize, sizeBand(company(p)), isRepeat, eligible);
    rep.all[0] += 1; if (eligible) { rep.all[1] += 1; if (isRepeat) rep.all[2] += 1; }
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(company(s));
    priorUses.set(key, prior + 1);
  }
  const fmt = (v) => ({ pairs: v[0], withEarlierJobSameTrade: v[1], repeatSub: v[2] || 0, pctRepeatOfEligible: pct(v[2] || 0, v[1]) });
  // Concentration: for GCs with 5+ named jobs in a trade, the share going to their top sub.
  const perGc = new Map();
  for (const [p, s, code] of named) {
    const key = `${company(p)}|${code}`; if (!perGc.has(key)) perGc.set(key, new Map());
    const m = perGc.get(key); m.set(company(s), (m.get(company(s)) || 0) + 1);
  }
  const topShares = []; let topJobs = 0; let topTotal = 0;
  for (const m of perGc.values()) {
    const tot = [...m.values()].reduce((a, b) => a + b, 0); if (tot < 5) continue;
    const top = Math.max(...m.values()); topShares.push(top / tot); topJobs += top; topTotal += tot;
  }
  const bpsInWindow = [...gcProjects.values()].reduce((a, b) => a + b, 0);
  const bandShare = (lo, hi) => pct([...gcProjects.values()].filter((k) => k >= lo && k <= hi).reduce((a, b) => a + b, 0), bpsInWindow);
  out.stickiness = {
    namedPairsDifferentCompany: named.length,
    all: fmt(rep.all),
    byTrade: Object.fromEntries(Object.entries(rep.byTrade).map(([k, v]) => [k, fmt(v)])),
    byGcSize: Object.fromEntries(Object.entries(rep.byGcSize).map(([k, v]) => [k, fmt(v)])),
    gcTradeCombosWith5PlusJobs: topShares.length,
    medianTopSubShare: topShares.length ? Math.round(100 * quantile(topShares, 0.5)) : null,
    pooledTopSubShare: pct(topJobs, topTotal),
    shareOfResidentialBpsByGcSize: { '1-4 BPs': bandShare(1, 4), '5-19 BPs': bandShare(5, 19), '20+ BPs': bandShare(20, Infinity) },
  };
  return out;
}

function markdown(r) {
  const L = [];
  const rt = r.reviewTime;
  L.push('# Austin plan-review timing', '', `Generated ${r.generatedAt} by \`recon/plan_review.js\` from the live Austin API. Rows pulled: ${r.rowsPulled} (issued ${r.window.from} to ${r.window.to}). Dataset rows updated: ${r.rowsUpdatedAt}.`, '');
  L.push('## 1. Building-permit review time (applied to issued)', '',
    `Residential BP new / addition / remodel, issued ${rt.window.from} to ${rt.window.to}: **${rt.residentialBps}** (${rt.pctWithAppliedDate}% have \`applieddate\`; ${rt.negativeDurations} negative durations).`, '',
    '| Group | n | p10 | p25 | median | p75 | p90 |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const [g, v] of [['all', rt.all], ...Object.entries(rt.byWorkGroup)]) L.push(`| ${g} | ${v.n} | ${v.p10} | ${v.p25} | ${v.p50} | ${v.p75} | ${v.p90} |`);
  L.push('', '| Review time | all | new | addition/remodel |', '| --- | --- | --- | --- |');
  for (const k of Object.keys(rt.all.buckets)) L.push(`| ${k} | ${rt.all.buckets[k].pct}% | ${rt.byWorkGroup.new.buckets[k].pct}% | ${rt.byWorkGroup['addition/remodel'].buckets[k].pct}% |`);
  L.push('', 'By work class (n, median, p90): ' + rt.byWorkClass.map(([k, n, m, p]) => `${k}: ${n}, ${m}, ${p}`).join(' · '), '',
    'Median by issue quarter (n, median): ' + rt.medianByIssueQuarter.map(([q, n, m]) => `${q}: ${n}, ${m}`).join(' · '), '');
  const t = r.tradeApplicationTiming;
  L.push('## 2. When trade permits were applied for', '', `Primaries: ${t.primaries} residential BPs issued 6 to ${r.months} months ago, linked by ${t.linkedBy}. Earliest trade application per BP. "Lead visible" = BP issue + ${PUBLICATION_LAG_DAYS} days.`, '',
    '| Trade | Linked | Same day as BP application | Before BP application | During BP review | Before lead visible (total) | After lead visible | 7+ days after visible | Median days, trade applied vs BP issue | Trade company named |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [k, v] of Object.entries(t.byTrade)) {
    L.push(`| ${k} | ${v.pctOfPrimaries}% (${v.withAppliedDate}) | ${v.pctAppliedSameDayAsBp}% | ${v.pctAppliedBeforeBpApplied}% | ${v.pctAppliedDuringBpReview}% | ${v.pctAppliedBeforeLeadVisible}% | ${v.pctAppliedAfterLeadVisible}% | ${v.pctAppliedAtLeast7DaysAfterLeadVisible}% | ${v.tradeAppliedDaysAfterBpIssue.p50} (p25 ${v.tradeAppliedDaysAfterBpIssue.p25}, p75 ${v.tradeAppliedDaysAfterBpIssue.p75}) | ${v.pctTradeCompanyNamed}% |`);
  }
  const s = r.stickiness;
  L.push('', '## 3. GC-to-sub stickiness', '', `Named pairs (BP company and trade company both present and different): ${s.namedPairsDifferentCompany}. A pair is a repeat when the same GC used the same sub for the same trade on an earlier project; only pairs where the GC had an earlier job in that trade are eligible.`, '',
    '| Slice | Pairs | Eligible | Repeat sub | Repeat rate |', '| --- | --- | --- | --- | --- |',
    `| all | ${s.all.pairs} | ${s.all.withEarlierJobSameTrade} | ${s.all.repeatSub} | ${s.all.pctRepeatOfEligible}% |`);
  for (const [k, v] of [...Object.entries(s.byTrade), ...Object.entries(s.byGcSize)]) L.push(`| ${k} | ${v.pairs} | ${v.withEarlierJobSameTrade} | ${v.repeatSub} | ${v.pctRepeatOfEligible}% |`);
  L.push('', `GC-trade combinations with 5+ named jobs: ${s.gcTradeCombosWith5PlusJobs}. Median share going to the GC's top sub: ${s.medianTopSubShare}%. Pooled: ${s.pooledTopSubShare}%.`, '',
    `Share of residential BPs by GC volume: 1-4 BPs ${s.shareOfResidentialBpsByGcSize['1-4 BPs']}%, 5-19 BPs ${s.shareOfResidentialBpsByGcSize['5-19 BPs']}%, 20+ BPs ${s.shareOfResidentialBpsByGcSize['20+ BPs']}%.`, '');
  return L.join('\n');
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const OUT = args.out || 'recon/out/plan-review';
  const MONTHS = Number(args.months || 24);
  const AUSTIN = 'https://data.austintexas.gov'; const ID = '3syk-w9eu';
  const UA = 'permit-leads-feasibility/0.1 (research; read-only)';
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let last = 0;
  async function getJson(url, attempts = 4) {
    for (let i = 1; ; i += 1) {
      const wait = 500 - (Date.now() - last); if (wait > 0) await sleep(wait); last = Date.now();
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
  const today = isoDay(new Date());
  const meta = await getJson(`${AUSTIN}/api/views/${ID}.json`);
  const cols = meta.columns.map((c) => c.fieldName);
  const want = ['permit_number', 'permittype', 'permit_class_mapped', 'work_class', 'tcad_id', 'applieddate', 'issue_date',
    'status_current', 'contractor_company_name'];
  const missing = want.filter((c) => !cols.includes(c));
  if (missing.length) throw new Error(`Austin schema changed; missing columns: ${missing.join(', ')}`);
  const since = new Date(); since.setUTCMonth(since.getUTCMonth() - MONTHS);
  const where = `issue_date >= '${isoDay(since)}T00:00:00' AND permittype in ('BP','EP','MP','PP')`;
  let rows = [];
  for (let off = 0; ; off += 50000) {
    const url = `${AUSTIN}/resource/${ID}.json?$select=${encodeURIComponent(want.join(','))}&$where=${encodeURIComponent(where)}`
      + `&$order=${encodeURIComponent(':id')}&$limit=50000&$offset=${off}`;
    const page = await getJson(url);
    rows = rows.concat(page);
    if (page.length < 50000) break;
  }
  const report = {
    generatedAt: new Date().toISOString(), months: MONTHS, rowsPulled: rows.length,
    rowsUpdatedAt: meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString() : null,
    window: { from: isoDay(since), to: today },
    ...analyze(rows, { today, months: MONTHS }),
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

module.exports = { analyze, base, daysBetween };
if (require.main === module) main().catch((err) => { console.error(err.message); process.exitCode = 1; });
