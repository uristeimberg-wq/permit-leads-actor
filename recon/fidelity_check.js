// Fidelity check: re-fetch a random sample of permits from each official source
// by permit number and compare, field by field, with what we store and show.
// Read-only against the database; reads the public source APIs only.
//
//   DATABASE_URL=... node recon/fidelity_check.js [--per-stratum=150] [--only=austin-tx] [--seed=2026-11-14] [--json=out.json]
//
// Per source, two strata: filings dated in the last 30 days, and older ones
// (outside most sync windows). Prints Markdown; --json writes the counts.
// Field values are never printed, only field names, counts and permit numbers.

const fs = require('node:fs');
const db = require('../db/index.js');
const { SOURCES } = require('../src/sources.js');
const { fetchWithRetry } = require('../src/adapters/http.js');
const { FIELDS, judge, keyWhere, wilson } = require('./fidelity.js');

db.getPool().on('connect', (c) => {
  c.query("SET default_transaction_read_only = on; SET statement_timeout = '120s'").catch(() => {});
});

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const PER_STRATUM = Number(args['per-stratum'] || 150);
const SEED = String(args.seed || new Date().toISOString().slice(0, 10));
const BATCH = 50;
const SLUGS = ['austin-tx', 'austin-plan-review-tx', 'miami-dade-fl', 'miami-city-fl', 'raleigh-nc']
  .filter((s) => !args.only || String(args.only).split(',').includes(s));

const say = (m) => process.stderr.write(`${m}\n`);
const log = { info() {}, debug() {}, warn: say, warning: say, error: say };
// Fields whose values are public facts (no person data), so examples may be printed.
const PRINTABLE = new Set(['permit_url', 'permit_type', 'status_raw', 'lifecycle_stage', 'filed_date', 'submitted_on', 'stage_since', 'valuation', 'zip']);
const out = (s = '') => process.stdout.write(`${s}\n`);
const pct = (k, n) => (n ? `${((100 * k) / n).toFixed(1)}%` : 'n/a');
const ci = (k, n) => {
  const [lo, hi] = wilson(k, n);
  return n ? `${(100 * lo).toFixed(1)}-${(100 * hi).toFixed(1)}%` : '';
};

async function getJson(url) {
  const res = await fetchWithRetry(fetch, url, undefined, { log });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 120)}`);
  const body = await res.json();
  if (body && body.error) throw new Error(`ArcGIS error ${body.error.code}: ${body.error.message}`);
  return body;
}

/** Is the key column numeric on the live service? (decides quoting) */
async function keyIsNumeric(source, layerUrl) {
  const keyField = source.fieldMap.permitNumber;
  if (source.type === 'socrata') {
    const meta = await getJson(`https://${source.domain}/api/views/${source.datasetId}.json`);
    const col = (meta.columns || []).find((c) => c.fieldName === keyField);
    return Boolean(col && col.dataTypeName === 'number');
  }
  const meta = await getJson(`${layerUrl.replace(/\/+$/, '')}?f=json`);
  const f = (meta.fields || []).find((x) => x.name === keyField);
  return Boolean(f && !/String|GUID/i.test(f.type));
}

/** Live rows by key: Map(key -> payload[]). */
async function fetchLive(source, keys) {
  const keyField = source.fieldMap.permitNumber;
  const byKey = new Map();
  const add = (row) => {
    const k = String(row[keyField]).trim();
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(row);
  };
  if (source.type === 'socrata') {
    const numeric = await keyIsNumeric(source);
    for (let i = 0; i < keys.length; i += BATCH) {
      const where = keyWhere(keyField, keys.slice(i, i + BATCH), numeric);
      const p = new URLSearchParams({ $where: where, $limit: '5000' });
      const rows = await getJson(`https://${source.domain}/resource/${source.datasetId}.json?${p}`);
      rows.forEach(add);
    }
    return byKey;
  }
  const layers = source.layerUrls || [source.layerUrl];
  for (const layer of layers) {
    const numeric = await keyIsNumeric(source, layer);
    for (let i = 0; i < keys.length; i += BATCH) {
      const p = new URLSearchParams({
        f: 'json', where: keyWhere(keyField, keys.slice(i, i + BATCH), numeric), outFields: '*', returnGeometry: 'false',
      });
      const body = await getJson(`${layer.replace(/\/+$/, '')}/query?${p}`);
      (body.features || []).forEach((f) => add(f.attributes || f));
    }
  }
  return byKey;
}

async function sample(slug) {
  const { rows } = await db.query(
    `WITH s AS (
       SELECT p.*, CASE WHEN coalesce(p.submitted_on, p.filed_date) >= current_date - 30 THEN 'recent' ELSE 'older' END AS stratum
         FROM permits p WHERE p.source_area = $1)
     SELECT * FROM (SELECT s.*, row_number() OVER (PARTITION BY stratum ORDER BY md5(s.id::text || $2)) AS rn FROM s) x
      WHERE rn <= $3`, [slug, SEED, PER_STRATUM]);
  const keys = rows.map((r) => r.permit_number);
  const raw = await db.query(
    `SELECT DISTINCT ON (r.source_key) r.source_key, r.payload, r.fetched_at
       FROM raw_records r JOIN sources s ON s.id = r.source_id
      WHERE s.slug = $1 AND r.source_key = ANY($2)
      ORDER BY r.source_key, r.fetched_at DESC`, [slug, keys]);
  const rawByKey = new Map(raw.rows.map((r) => [r.source_key, r]));
  return rows.map((r) => ({ stored: r, raw: rawByKey.get(r.permit_number) || null }));
}

function blank() {
  return { n: 0, found: 0, noRaw: 0, multiple: 0, rawChanged: 0, substantive: 0, gap: 0, shownAny: 0, pipelineAny: 0,
    shown: {}, present: {}, shownKind: {}, pipeline: {}, changedKeys: {}, missingExamples: [], gapExamples: [], examples: {} };
}

function tally(t, v, stored) {
  t.n += 1;
  if (!v.found) { if (t.missingExamples.length < 10) t.missingExamples.push(stored.permit_number); return; }
  t.found += 1;
  if (v.multiple) t.multiple += 1;
  if (v.rawChanged == null) t.noRaw += 1;
  if (v.rawChanged && v.rawChanged.length) t.rawChanged += 1;
  if (v.substantive && v.substantive.length) {
    t.substantive += 1;
    for (const k of v.substantive) t.changedKeys[k] = (t.changedKeys[k] || 0) + 1;
    if (!v.caughtByWindow) { t.gap += 1; if (t.gapExamples.length < 10) t.gapExamples.push(stored.permit_number); }
  }
  if (v.shown.length) t.shownAny += 1;
  for (const f of v.present) t.present[f] = (t.present[f] || 0) + 1;
  for (const d of v.shown) {
    if (PRINTABLE.has(d.field)) {
      const ex = (t.examples[d.field] = t.examples[d.field] || []);
      if (ex.length < 3) ex.push(`${stored.permit_number}: ours ${JSON.stringify(d.ours)} / source ${JSON.stringify(d.theirs)}`);
    }
    t.shown[d.field] = (t.shown[d.field] || 0) + 1;
    t.shownKind[`${d.field}:${d.kind}`] = (t.shownKind[`${d.field}:${d.kind}`] || 0) + 1;
  }
  if (v.pipeline && v.pipeline.length) t.pipelineAny += 1;
  for (const d of v.pipeline || []) t.pipeline[d.field] = (t.pipeline[d.field] || 0) + 1;
}

function report(slug, strata) {
  out(`## ${slug}`);
  out();
  const all = Object.values(strata);
  out('| stratum | sampled | not found at source (95% CI) | raw row changed | substantive edit | edit the next sync misses | any shown field wrong | any pipeline mismatch |');
  out('|---|---|---|---|---|---|---|---|');
  for (const [name, t] of Object.entries(strata)) {
    out(`| ${name} | ${t.n} | ${t.n - t.found} (${pct(t.n - t.found, t.n)}, ${ci(t.n - t.found, t.n)}) | ${pct(t.rawChanged, t.found)} | ${t.substantive} (${pct(t.substantive, t.found)}) | ${t.gap} (${pct(t.gap, t.found)}) | ${t.shownAny} (${pct(t.shownAny, t.found)}) | ${t.pipelineAny} (${pct(t.pipelineAny, t.found)}) |`);
  }
  out();
  const found = all.reduce((a, t) => a + t.found, 0);
  out('Per-field accuracy of what we store, against the live source (found records):');
  out();
  out('Match is over records where our value or the source value is non-empty; both empty is not counted as a check.');
  out();
  out('| field | compared (non-empty) | match | 95% CI | wrong | of which: we show a value the source removed | we lack a value the source has | pipeline mismatches |');
  out('|---|---|---|---|---|---|---|---|');
  for (const [col] of FIELDS) {
    const wrong = all.reduce((a, t) => a + (t.shown[col] || 0), 0);
    const kept = all.reduce((a, t) => a + (t.shownKind[`${col}:kept_ours`] || 0), 0);
    const lacking = all.reduce((a, t) => a + (t.shownKind[`${col}:missing_ours`] || 0), 0);
    const pipe = all.reduce((a, t) => a + (t.pipeline[col] || 0), 0);
    const n = all.reduce((a, t) => a + (t.present[col] || 0), 0);
    out(`| ${col} | ${n} | ${pct(n - wrong, n)} | ${ci(n - wrong, n)} | ${wrong} | ${kept} | ${lacking} | ${pipe} |`);
  }
  out();
  const keys = {};
  for (const t of all) for (const [k, n] of Object.entries(t.changedKeys)) keys[k] = (keys[k] || 0) + n;
  const top = Object.entries(keys).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) out(`Raw columns the source edited since our last fetch: ${top.map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  const missing = all.flatMap((t) => t.missingExamples).slice(0, 10);
  if (missing.length) out(`Not found at source (examples): ${missing.join(', ')}.`);
  const gaps = all.flatMap((t) => t.gapExamples).slice(0, 10);
  if (gaps.length) out(`Edited outside the sync windows (examples): ${gaps.join(', ')}.`);
  for (const [col] of FIELDS) {
    const ex = all.flatMap((t) => t.examples[col] || []).slice(0, 3);
    if (ex.length) out(`Examples, ${col}: ${ex.join('; ')}.`);
  }
  const noRaw = all.reduce((a, t) => a + t.noRaw, 0);
  if (noRaw) out(`${noRaw} sampled permits have no raw record (pre-raw rows); pipeline and edit checks skip them.`);
  const multiple = all.reduce((a, t) => a + t.multiple, 0);
  if (multiple) out(`${multiple} sampled permit numbers return more than one live row.`);
  out();
}

async function main() {
  out(`# Fidelity check, ${new Date().toISOString()} (seed ${SEED}, up to ${PER_STRATUM} per stratum)`);
  out();
  out('Compares each sampled permit with the record the official source serves now. "Pipeline" compares it with what today\'s code makes from the raw row we stored. Values are not printed.');
  out();
  const results = {};
  for (const slug of SLUGS) {
    const source = SOURCES[slug];
    if (!source) continue;
    const t0 = Date.now();
    try {
      const items = await sample(slug);
      const live = await fetchLive(source, [...new Set(items.map((i) => String(i.stored.permit_number).trim()))]);
      const strata = { recent: blank(), older: blank() };
      for (const { stored, raw } of items) {
        const v = judge({ source, stored, storedRaw: raw ? raw.payload : null, liveRows: live.get(String(stored.permit_number).trim()) });
        tally(strata[stored.stratum], v, stored);
      }
      results[slug] = strata;
      report(slug, strata);
    } catch (err) {
      out(`## ${slug}`);
      out();
      out(`_Check failed: ${err.message}_`);
      out();
      results[slug] = { error: err.message };
      process.exitCode = 1;
    }
    process.stderr.write(`${slug}: ${Date.now() - t0} ms\n`);
  }
  if (args.json) fs.writeFileSync(String(args.json), JSON.stringify({ at: new Date().toISOString(), seed: SEED, results }, null, 2));
  await db.close();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  await db.close().catch(() => {});
});
