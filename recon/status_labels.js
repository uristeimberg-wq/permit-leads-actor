// Read-only: how many records show a status label that contradicts their own
// source status, with the old labels and with web/public/stages.js. Also
// checks one reported record (Austin plan review, 1110 W 6TH ST) field by
// field against the live source. Prints Markdown, counts only.
//
//   DATABASE_URL=... node recon/status_labels.js
//
// "Contradicts" = the label claims a stage the source's own wording does not
// allow. The source's wording is read through each source's reviewed
// lifecycle table (src/sources.js); where that table has no entry, the raw
// wording itself is tested for approval, issue and completion words.

const db = require('../db/index.js');
const Stages = require('../web/public/stages.js');

db.getPool().on('connect', (c) => {
  c.query("SET default_transaction_read_only = on; SET statement_timeout = '180s'").catch(() => {});
});
const q = async (sql, p) => (await db.query(sql, p)).rows;
const out = (s = '') => process.stdout.write(`${s}\n`);
const table = (head, rows) => {
  out(`| ${head.join(' | ')} |`);
  out(`|${head.map(() => '---').join('|')}|`);
  for (const r of rows) out(`| ${r.map((x) => (x == null ? '' : String(x).replace(/\|/g, '/'))).join(' | ')} |`);
  out();
};

// The labels the search screen showed before this change (app.js STAGES).
const OLD = { pending: 'Waiting for approval', approved: 'Approved', finished: 'Finished', cancelled: 'Cancelled', unknown: 'Unknown' };
// Stages each old label is compatible with.
const OLD_OK = {
  'Waiting for approval': ['pre_application', 'submitted', 'in_review', 'corrections'],
  Approved: ['approved', 'issued', 'inspections'],
  Finished: ['completed'],
  Cancelled: ['expired', 'withdrawn', 'cancelled', 'denied'],
};

// What the raw wording itself says, for statuses with no lifecycle entry.
function wordingStage(raw) {
  const r = String(raw || '').trim().toLowerCase();
  if (/prerequisite review approved/.test(r)) return null;
  if (/^(approved|ready (to|for) issu)/.test(r)) return 'approved';
  if (/^(issued|permit issued|active)$/.test(r)) return 'issued';
  if (/^(final|finaled|completed?|closed)$/.test(r)) return 'completed';
  return null;
}

function contradicts(label, stage) {
  if (!stage || stage === 'unknown') return false;
  if (OLD_OK[label]) return !OLD_OK[label].includes(stage);
  // New labels: a finer label is that stage; a group label covers its group.
  const fine = Object.entries(Stages.LIFECYCLE_LABEL).find(([, l]) => l === label);
  if (fine && fine[0] !== 'unknown') return fine[0] !== stage && !(label === 'Issued' && stage === 'inspections');
  const group = Stages.GROUPS.find(([, l]) => l === label);
  if (group && group[0] !== 'unknown') return Stages.GROUP_OF_LIFECYCLE[stage] !== group[0];
  return false;
}

async function labels() {
  const rows = await q(`
    SELECT source_area, coalesce(filing_kind, 'permit') AS kind, status_raw, status_stage, lifecycle_stage, count(*)::int AS n
      FROM permits GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 6 DESC`);
  const per = new Map();
  const detail = [];
  let total = 0; let before = 0; let after = 0;
  for (const r of rows) {
    const truth = r.lifecycle_stage && r.lifecycle_stage !== 'unknown' ? r.lifecycle_stage : wordingStage(r.status_raw);
    const oldLabel = OLD[r.status_stage] || 'Unknown';
    const newLabel = Stages.badge(r).label;
    const b = contradicts(oldLabel, truth); const a = contradicts(newLabel, truth);
    const k = `${r.source_area} (${r.kind})`;
    const p = per.get(k) || { n: 0, before: 0, after: 0 };
    p.n += r.n; if (b) p.before += r.n; if (a) p.after += r.n;
    per.set(k, p);
    total += r.n; if (b) before += r.n; if (a) after += r.n;
    if (b || a || r.n >= 50) detail.push([k, r.status_raw, r.status_stage, r.lifecycle_stage, oldLabel, newLabel, b ? 'yes' : '', a ? 'yes' : '', r.n]);
  }
  out('## Status labels that contradict the source status');
  out();
  table(['Source (kind)', 'Records', 'Contradicting, old labels', 'Contradicting, new labels'],
    [...per].map(([k, v]) => [k, v.n, v.before, v.after]).concat([['**All**', total, before, after]]));
  out('### Every status wording with a contradiction, or 50+ records');
  out();
  table(['Source', 'Status as published', 'Group', 'Lifecycle', 'Old label', 'New label', 'Old contradicts', 'New contradicts', 'Records'], detail);
}

async function record() {
  out('## The reported record: 1110 W 6TH ST, Austin plan review');
  out();
  const rows = await q(`
    SELECT p.id, p.permit_number, p.status_raw, p.status_stage, p.lifecycle_stage, p.filed_date, p.submitted_on, p.stage_since,
           p.valuation, p.first_seen_at, p.first_seen_stage, r.payload, r.fetched_at
      FROM permits p LEFT JOIN raw_records r ON r.id = (SELECT max(id) FROM raw_records rr JOIN sources s ON s.id = rr.source_id
                                                         WHERE s.slug = p.source_area AND rr.source_key = p.permit_number)
     WHERE p.source_area = 'austin-plan-review-tx' AND p.address ILIKE '1110 W 6TH%'`);
  if (!rows.length) { out('_Not found._'); return; }
  const FIELDS = ['permit_number', 'status_current', 'applied_date', 'status_date', 'total_job_valuation', 'total_valuation_remodel',
    'building_valuation_remodel', 'sub_type', 'project_name'];
  for (const p of rows) {
    let live = null;
    try {
      const u = `https://datahub.austintexas.gov/resource/n8ck-xkda.json?permit_number=${encodeURIComponent(p.permit_number)}`;
      const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
      live = (await res.json())[0] || null;
    } catch (err) { out(`_Live fetch failed: ${err.message}_`); }
    out(`Permit ${p.permit_number} (id ${p.id}). Stored: status "${p.status_raw}", group ${p.status_stage}, lifecycle ${p.lifecycle_stage}, filed ${iso(p.filed_date)}, submitted ${iso(p.submitted_on)}, stage since ${iso(p.stage_since)}, value ${p.valuation}, first seen ${iso(p.first_seen_at)} while ${p.first_seen_stage}. Raw record fetched ${iso(p.fetched_at)}.`);
    out();
    table(['Source field', 'Our raw record', 'Live source now'], FIELDS.map((f) => [f, p.payload ? p.payload[f] : '', live ? live[f] : '']));
    const hist = await q(`SELECT status_raw, lifecycle_stage, stage_since, observed_at FROM permit_status_history WHERE permit_id = $1 ORDER BY observed_at`, [p.id]);
    table(['History: status', 'lifecycle', 'source status date', 'we observed'], hist.map((h) => [h.status_raw, h.lifecycle_stage, iso(h.stage_since), iso(h.observed_at)]));
  }
  // Why "first seen" can be years after the application: when did each
  // source's rows first arrive, and how many old filings arrived late?
  out('### When we first loaded plan-review cases');
  out();
  table(['First seen (UTC day)', 'Cases', 'of which applied before 2026'], (await q(`
    SELECT first_seen_at::date AS d, count(*)::int AS n, count(*) FILTER (WHERE submitted_on < DATE '2026-01-01')::int AS old
      FROM permits WHERE source_area = 'austin-plan-review-tx' GROUP BY 1 ORDER BY 1`)).map((r) => [iso(r.d), r.n, r.old]));
}

async function live() {
  out('## What the live site serves');
  out();
  const base = 'https://permits-production-9581a3c0.up.railway.app';
  for (const path of ['/healthz/schema', '/app.js', '/stages.js']) {
    try {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      out(`- ${path}: HTTP ${res.status}${path === '/healthz/schema' ? ` ${text.slice(0, 200)}` : `, ${text.length} bytes, "Waiting for approval" ${text.includes('Waiting for approval') ? 'present' : 'absent'}, "declared" ${text.includes('declared') ? 'present' : 'absent'}`}`);
    } catch (err) { out(`- ${path}: ${err.message}`); }
  }
  out();
}

const iso = (d) => (d == null ? '' : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d)));

(async () => {
  for (const fn of [labels, record, live]) {
    try { await fn(); } catch (err) { out(`_Section failed: ${err.code || ''} ${err.message}_`); out(); }
  }
  await db.getPool().end();
})();
