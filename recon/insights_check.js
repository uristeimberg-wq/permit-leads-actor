// Read-only check of the ADR-21 estimates against the live database: how many
// filings get one, and whether the ranges hold on permits whose outcome is
// already known (calibration). Prints Markdown; writes nothing.
//
//   DATABASE_URL=... node recon/insights_check.js
// Every connection is set read-only before its first query.
//
// Calibration method (no look-ahead): each test permit is forecast only from
// comparables issued before its own application date, and the range claims
// "the middle 6 in 10", so about 60% should land inside it.

const db = require('../db/index.js');
const F = require('../src/forecast.js');
const { SEGMENTS } = require('../src/filers.js');
const pq = require('../db/pilot_queries.js');

// pg runs a client's queries in order, so this SET precedes anything else on it.
db.getPool().on('connect', (c) => { c.query('SET default_transaction_read_only = on').catch(() => {}); });

const pct = (x) => (x == null ? 'n/a' : `${Math.round(x * 1000) / 10}%`);
const q = async (sql, p) => (await db.query(sql, p)).rows;

async function issueCalibration(source, classPattern, label) {
  const cls = source === 'austin-tx' ? "(SELECT rr.payload ->> 'permit_class' FROM raw_records rr WHERE rr.id = pp.raw_record_id)" : 'NULL::text';
  const rows = await q(`
    SELECT p.submitted_on::text AS s, pp.issued_on::text AS i, (pp.issued_on - p.submitted_on) AS d
      FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
     WHERE p.source_area = $1 AND pp.is_building AND p.submitted_on IS NOT NULL AND pp.issued_on >= p.submitted_on
       AND ($2::text IS NULL OR ${cls} ~* $2)`, [source, classPattern]);
  const all = rows.map((r) => ({ s: r.s, i: r.i, d: Number(r.d) })).sort((a, b) => a.i.localeCompare(b.i));
  const lastIssued = all.length ? all[all.length - 1].i : null;
  if (!lastIssued) return `| ${label} | 0 | | | | |`;
  const cutoff = new Date(Date.parse(lastIssued) - 120 * 86400000).toISOString().slice(0, 10);
  // Test set: applications submitted 120+ days before our newest issue date
  // and issued since; comparables: issued in the 365 days before submission.
  const pool = all.filter((x) => x.s >= new Date(Date.parse(cutoff) - 120 * 86400000).toISOString().slice(0, 10) && x.s < cutoff);
  // An even sample of at most 400 keeps the run short.
  const step = Math.max(1, Math.ceil(pool.length / 400));
  const test = pool.filter((_, i) => i % step === 0);
  let inside = 0; let scored = 0; let thin = 0; let errSum = 0;
  const atAge = [0, 30];
  const res = {};
  for (const age of atAge) {
    inside = 0; scored = 0; thin = 0; errSum = 0;
    for (const t of test) {
      if (t.d <= age) continue;
      const from = new Date(Date.parse(t.s) - 365 * 86400000).toISOString().slice(0, 10);
      const comp = all.filter((x) => x.i < t.s && x.i >= from).map((x) => x.d);
      const fc = F.issueForecast(comp, age);
      if (fc.status !== 'ok') { thin += 1; continue; }
      scored += 1;
      const left = t.d - age;
      if (left >= fc.lowDays && left <= fc.highDays) inside += 1;
      errSum += Math.abs(left - fc.midDays);
    }
    res[age] = { scored, thin, inside: scored ? inside / scored : null, mae: scored ? errSum / scored : null };
  }
  return `| ${label} | ${all.length} | ${test.length} | ${res[0].scored} (${res[0].thin} thin) | ${pct(res[0].inside)} · ${res[0].mae == null ? 'n/a' : Math.round(res[0].mae)} d | ${res[30].scored}: ${pct(res[30].inside)} · ${res[30].mae == null ? 'n/a' : Math.round(res[30].mae)} d |`;
}

async function main() {
  const out = ['# ADR-21 estimates: live check', '', `Run ${new Date().toISOString()}.`, ''];

  // 1. What the Early screen shows today.
  out.push('## 1. Early screen coverage (last 30 days)', '', '| Market | View | Filings | ok | thin | overdue | no date | basis: class / segment / all | median range width (days) |', '|---|---|---|---|---|---|---|---|---|');
  for (const [source, segment] of [['austin-tx', 'homes'], ['austin-tx', null], ['raleigh-nc', null]]) {
    const e = await pq.listEarly(pq.parseFilters({ source }), { days: 30, segment, limit: 1000 });
    const fs = e.filings.map((x) => x.issueForecast || {});
    const by = (k, v) => fs.filter((x) => x[k] === v).length;
    const bb = (v) => fs.filter((x) => x.basis && x.basis.basis === v).length;
    const widths = fs.filter((x) => x.status === 'ok').map((x) => x.highDays - x.lowDays).sort((a, b) => a - b);
    out.push(`| ${source} | ${segment || 'all'} | ${fs.length} | ${by('status', 'ok')} | ${by('status', 'thin')} | ${by('status', 'overdue')} | ${by('status', 'no_date')} | ${bb('class')} / ${bb('segment')} / ${bb('all')} | ${F.quantile(widths, 0.5) ?? 'n/a'} |`);
  }

  // 2. Is a BP's own application date the plan-review case's date? (Austin)
  const [link] = await q(`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE t.submitted_on = f.submitted_on)::int AS same_day,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY t.submitted_on - f.submitted_on) AS median_gap,
           percentile_disc(0.9) WITHIN GROUP (ORDER BY abs(t.submitted_on - f.submitted_on)) AS p90_abs_gap
      FROM permit_links k JOIN permits f ON f.id = k.from_permit_id JOIN permits t ON t.id = k.to_permit_id
     WHERE f.source_area = 'austin-plan-review-tx' AND f.submitted_on IS NOT NULL AND t.submitted_on IS NOT NULL`);
  out.push('', '## 2. Austin: plan-review date vs the issued BP\'s own application date', '',
    `Linked pairs: ${link.n}; same day: ${link.same_day} (${pct(link.n ? link.same_day / link.n : null)}); median gap ${link.median_gap ?? 'n/a'} days; 90th pct absolute gap ${link.p90_abs_gap ?? 'n/a'} days.`,
    'If these match, BP applieddate -> issue is a fair comparable for a plan-review case.');

  // 3. Calibration of the issue window.
  out.push('', '## 3. Issue window calibration (target: about 60% inside)', '',
    '| Comparables | Permits with dates | Test set | Scored at submission | Inside range · mean abs error of median | At 30 days open: scored: inside · error |', '|---|---|---|---|---|---|');
  out.push(await issueCalibration('austin-tx', SEGMENTS.homes.pattern, 'Austin new homes (R-101..104)'));
  out.push(await issueCalibration('austin-tx', null, 'Austin all building permits'));
  out.push(await issueCalibration('raleigh-nc', null, 'Raleigh building'));

  // 4. Trade timing calibration: jobs watched for the full horizon recently,
  // forecast at day 0 from jobs whose BP was issued earlier.
  const H = F.TRADE_HORIZON_DAYS;
  out.push('', `## 4. Trade timing calibration (Austin, market basis, at the BP's issue day; horizon ${H} days)`, '',
    '| Trade | Test jobs | Predicted likelihood | Actual share that got one | Inside range (of those that got one) |', '|---|---|---|---|---|');
  const jobs = await q(`
    WITH bp AS (SELECT pp.job_key, min(pp.issued_on) AS bp_on FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id
                 WHERE pp.is_building AND pp.job_key IS NOT NULL AND p.source_area = 'austin-tx' GROUP BY 1),
    tr AS (SELECT t.job_key, t.trade, min(t.issued_on) AS on_ FROM permit_parties t JOIN permits p ON p.id = t.permit_id
            WHERE t.trade IS NOT NULL AND p.source_area = 'austin-tx' GROUP BY 1, 2)
    SELECT bp.bp_on::text AS bp_on, x.trade, tr.on_ - bp.bp_on AS lag
      FROM bp CROSS JOIN (VALUES ('electrical'), ('mechanical'), ('plumbing')) x(trade)
      LEFT JOIN tr ON tr.job_key = bp.job_key AND tr.trade = x.trade
     WHERE bp.bp_on <= current_date - $1::int`, [H]);
  const [{ max_on: maxOn }] = await q("SELECT max(pp.issued_on)::text AS max_on FROM permit_parties pp JOIN permits p ON p.id = pp.permit_id WHERE p.source_area = 'austin-tx'");
  const watchedTo = new Date(Date.parse(maxOn) - H * 86400000).toISOString().slice(0, 10);
  const testFrom = new Date(Date.parse(watchedTo) - 60 * 86400000).toISOString().slice(0, 10);
  for (const t of ['electrical', 'mechanical', 'plumbing']) {
    const js = jobs.filter((j) => j.trade === t).map((j) => ({ on: j.bp_on, lag: j.lag == null || Number(j.lag) > H ? null : Math.max(0, Number(j.lag)) }));
    const test = js.filter((j) => j.on >= testFrom && j.on <= watchedTo);
    const comp = js.filter((j) => j.on < testFrom).map((j) => j.lag);
    const fc = F.tradeTiming(comp, 0, { min: F.MIN_MARKET_TRADE });
    if (fc.status !== 'ok' || !test.length) { out.push(`| ${t} | ${test.length} | ${fc.status} (n=${fc.n}) | | |`); continue; }
    const got = test.filter((j) => j.lag != null);
    const inside = fc.lowDays == null ? null : got.filter((j) => j.lag >= fc.lowDays && j.lag <= fc.highDays).length / (got.length || 1);
    out.push(`| ${t} | ${test.length} (comparables ${comp.length}) | ${pct(fc.likelihood)} | ${pct(got.length / test.length)} | ${pct(inside)} (range ${fc.lowDays}-${fc.highDays} d) |`);
  }

  // 5. Momentum today.
  out.push('', '## 5. Builder momentum today (90 vs 90 days)', '', '| Market | View | History covers | Builders | rising | new | slowing | steady | with applications filed |', '|---|---|---|---|---|---|---|---|---|');
  for (const [source, segment] of [['austin-tx', 'homes'], ['austin-tx', null], ['raleigh-nc', null], ['miami-dade-fl', null]]) {
    const m = await pq.listMomentum(pq.parseFilters({ source }), { segment, limit: 10000 });
    const withApps = m.builders.filter((b) => b.applications && b.applications.filed > 0).length;
    const c = m.counts;
    out.push(`| ${source} | ${segment || 'all'} | ${m.historyCovers} | ${m.total} | ${c.rising || 0} | ${c.new || 0} | ${c.slowing || 0} | ${c.steady || 0} | ${m.hasApplications ? withApps : 'n/a'} |`);
  }
  console.log(out.join('\n'));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.close());
