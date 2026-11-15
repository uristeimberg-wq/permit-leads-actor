// Rolling re-read (migration 030). The daily sync reads date windows, so a
// permit outside every window is never fetched again: a status the city
// changes later, a corrected field or a deleted record never reaches us. The
// fidelity check measured it (2026-11-14): City of Miami showed "Active" on
// old permits the City now marks "Final"; 36% of sampled Austin permits kept
// a record link written by an old mapping.
//
// Each run asks each permit source for its least recently confirmed stored
// permits, by number, and runs what comes back through the same path as the
// sync: raw records first, then today's mapping, then the upsert. So the
// whole store is compared with its sources on a rolling cycle.
//
// A permit the source no longer returns gets source_missing_since; nothing is
// deleted. When the source returns none of the permits asked for, or more
// than MAX_MISSING_SHARE of them, the run fails instead of marking them: that
// is a broken query, not mass deletion.
//
//   node ingest/refresh.js [--area=miami-city-fl] [--limit=5000]   (DATABASE_URL)

const db = require('../db/index.js');
const { SOURCES, PILOT_AREAS } = require('../src/sources.js');
const { fetchByKeys } = require('../src/adapters/by_key.js');
const { mapRows } = require('../src/adapters/socrata.js');
const { mapFeatures } = require('../src/adapters/arcgis.js');
const { toRawRecords, classifyError } = require('./raw.js');
const { tradeScoresFor } = require('./run.js');

// Permits seen by a window sync this recently are skipped: the sync has them.
const SKIP_SEEN_DAYS = 2;
const DEFAULT_LIMIT = 5000;
const MAX_MISSING_SHARE = 0.2;
// A handful missing from a small batch is plausible deletion, not a broken query.
const MIN_MISSING_TO_REFUSE = 10;

const SILENT = { info() {}, warn() {}, warning() {}, error() {}, debug() {} };
const say = (m) => process.stdout.write(`${m}\n`);

/** The permit sources a re-read covers: the pilot permit feeds with a raw-row adapter. */
function refreshable(slug) {
  const s = SOURCES[slug];
  return Boolean(s && !['planning', 'inspections'].includes(s.kind) && (s.type === 'socrata' || s.type === 'arcgis'));
}

function mapLive(source, rows) {
  if (source.type === 'socrata') return mapRows(rows, source, { includeIssued: true, log: SILENT });
  return mapFeatures(rows.map((attributes) => ({ attributes })), source, { includeIssued: true, log: SILENT });
}

/** Pure: which asked keys came back, and whether marking the rest is safe. */
function settle(asked, rows, keyField) {
  const found = new Set(rows.map((r) => (r == null || r[keyField] == null ? '' : String(r[keyField]).trim())).filter(Boolean));
  const missing = asked.filter((k) => !found.has(String(k).trim()));
  const share = asked.length ? missing.length / asked.length : 0;
  let refuse = null;
  if (asked.length && found.size === 0) refuse = `the source returned none of the ${asked.length} permits asked for`;
  else if (share > MAX_MISSING_SHARE && missing.length >= MIN_MISSING_TO_REFUSE) refuse = `${missing.length} of ${asked.length} permits missing (${(100 * share).toFixed(1)}%), above ${100 * MAX_MISSING_SHARE}%`;
  return { found, missing, refuse };
}

async function refreshArea(slug, { limit, fetchImpl = fetch, skipSeenDays = SKIP_SEEN_DAYS } = {}) {
  const source = SOURCES[slug];
  if (!refreshable(slug)) throw new Error(`${slug} is not a re-readable permit source`);
  const n = limit ?? source.refreshPerRun ?? DEFAULT_LIMIT;
  const keyField = source.fieldMap.permitNumber;
  const sourceId = await db.getSourceId(slug);
  const syncRunId = await db.startSyncRun(sourceId, 'refresh');
  const stats = { requests: 0, fetched: 0, newCount: 0, changed: 0, failed: 0 };
  try {
    const { rows: due } = await db.query(
      `SELECT permit_number, source_missing_since IS NOT NULL AS gone FROM permits
        WHERE source_area = $1 AND last_seen_at < now() - make_interval(days => $3)
        ORDER BY coalesce(source_checked_at, last_seen_at), id
        LIMIT $2`, [slug, n, skipSeenDays]);
    const asked = due.map((r) => r.permit_number);
    const { rows, requests } = await fetchByKeys(source, asked, { fetchImpl, log: SILENT });
    stats.requests = requests;
    stats.fetched = rows.length;
    // The safety rule reads only permits not already marked gone: a batch of
    // permits that stay deleted is not a broken query.
    const { found, missing } = settle(asked, rows, keyField);
    const { refuse } = settle(due.filter((r) => !r.gone).map((r) => r.permit_number), rows, keyField);
    if (refuse) throw Object.assign(new Error(`re-read refused to mark permits missing: ${refuse}`), { errorClass: 'bad_data' });

    const { records, failed } = toRawRecords(rows, source);
    Object.assign(stats, await db.insertRawRecords(sourceId, syncRunId, records), { failed });
    const permits = mapLive(source, rows).filter((p) => p.permitNumber && found.has(String(p.permitNumber).trim()));
    const { rows: statusBefore } = await db.query(
      'SELECT permit_number, status_raw FROM permits WHERE source_area = $1 AND permit_number = ANY($2)', [slug, asked]);
    const prior = new Map(statusBefore.map((r) => [r.permit_number, r.status_raw]));
    const statusChanged = permits.filter((p) => prior.has(p.permitNumber) && (prior.get(p.permitNumber) ?? null) !== (p.statusRaw ?? null)).length;
    if (permits.length) await db.upsertPermits(permits.map((p) => ({ ...p, tradeScores: tradeScoresFor(p) })), slug);

    // Every permit asked about is checked; those not returned are marked gone.
    await db.query('UPDATE permits SET source_checked_at = now() WHERE source_area = $1 AND permit_number = ANY($2)', [slug, asked]);
    let newlyMissing = 0;
    if (missing.length) {
      const r = await db.query(
        `UPDATE permits SET source_missing_since = now()
          WHERE source_area = $1 AND permit_number = ANY($2) AND source_missing_since IS NULL`, [slug, missing]);
      newlyMissing = r.rowCount;
      await db.recordSourceEvent(sourceId, syncRunId, 'missing_at_source', 'warning',
        { asked: asked.length, missing: missing.length, newlyMissing, examples: missing.slice(0, 10) });
    }
    await db.finishSyncRun(syncRunId, { status: 'succeeded', ...stats });
    const summary = { slug, asked: asked.length, returned: found.size, missing: missing.length, newlyMissing,
      rawChanged: stats.changed, statusChanged, requests };
    say(`| ${slug} | ${summary.asked} | ${summary.returned} | ${summary.rawChanged} | ${summary.statusChanged} | ${summary.missing} (${summary.newlyMissing} new) | ${requests} |`);
    return summary;
  } catch (err) {
    await db.finishSyncRun(syncRunId, {
      status: 'failed', ...stats, errorClass: err.errorClass || classifyError(err), errorDetail: String(err.stack || err.message).slice(0, 4000),
    });
    say(`| ${slug} | failed: ${String(err.message).replace(/\|/g, '/').slice(0, 200)} | | | | | |`);
    throw err;
  }
}

/** How far behind the cycle is: per source, the oldest confirmation and the count missing. */
async function cycleReport() {
  const { rows } = await db.query(
    `SELECT source_area, count(*)::int AS permits,
            (current_date - min(coalesce(source_checked_at, last_seen_at))::date)::int AS oldest_days,
            count(*) FILTER (WHERE source_missing_since IS NOT NULL)::int AS missing
       FROM permits WHERE source_area = ANY($1) GROUP BY 1 ORDER BY 1`, [PILOT_AREAS.filter(refreshable)]);
  return rows;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const areas = args.area ? String(args.area).split(',') : PILOT_AREAS.filter(refreshable);
  await db.applySchema();
  say('## Rolling re-read');
  say('');
  say('Stored permits re-fetched by number, least recently confirmed first (migration 030). Nothing is deleted.');
  say('');
  say('| Source | Asked | Returned | Raw row changed | Status changed | Gone from source | Requests |');
  say('| --- | --- | --- | --- | --- | --- | --- |');
  let failures = 0;
  for (const slug of areas) {
    try { await refreshArea(slug, { limit: args.limit ? Number(args.limit) : undefined }); } catch { failures += 1; }
  }
  say('');
  say('| Source | Permits stored | Oldest confirmation (days) | Marked gone from source |');
  say('| --- | --- | --- | --- |');
  for (const r of await cycleReport()) say(`| ${r.source_area} | ${r.permits} | ${r.oldest_days} | ${r.missing} |`);
  await db.close();
  if (failures) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exitCode = 1; });
}

module.exports = { refreshArea, refreshable, settle, cycleReport, MAX_MISSING_SHARE, MIN_MISSING_TO_REFUSE };
