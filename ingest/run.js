// Incremental ingest: scrape recent permits from each configured source and
// upsert them into Postgres.
//
// Usage:
//   node ingest/run.js                        all default areas, last 14 days
//   node ingest/run.js --area=oregon-statewide --days=30 --max=500
//   node ingest/run.js --all-details          re-fetch details for known permits
//   node ingest/run.js --strict --kind=scheduled   exit 1 if any area fails (CI cron)

const { log } = require('apify');
const { SOURCES, PILOT_AREAS } = require('../src/sources.js');
const { getAdapter } = require('../src/adapters/index.js');
const { scorePermit } = require('../src/scoring.js');
const { toScorable } = require('../src/normalize.js');
const db = require('../db/index.js');
const { toRawRecords, classifyError } = require('./raw.js');
const { detectDrift } = require('./drift.js');
const { upsertPlanningCases } = require('./planning.js');
const { upsertInspections } = require('./inspections.js');
const { effectiveWindows, highWaterValues } = require('./watermark.js');
const { validateRows, validationSeverity } = require('../src/adapters/validate.js');
const { retryTally } = require('../src/adapters/http.js');

// Adapters that hand back unmapped rows for raw_records (migration 002).
const RAW_CAPTURE_TYPES = new Set(['socrata', 'arcgis']);

// The pilot markets. Oregon (Accela) still works but is slow and out of the
// pilot (ADR-5): run it explicitly with --area=clackamas-county-or.
const DEFAULT_AREAS = PILOT_AREAS;
const TRADES = ['flooring', 'hvac', 'plumbing', 'electrical', 'painting', 'roofing'];

/**
 * All six trade scores, precomputed so the API can filter by trade across the
 * whole table. Scoring sees permitType recombined with the description.
 */
function tradeScoresFor(permit) {
  const scorable = toScorable(permit);
  const scores = {};
  for (const trade of TRADES) {
    scores[trade] = scorePermit(scorable, trade).score;
  }
  return scores;
}

function parseArgs(argv) {
  // max: undefined = each source's own maxPerRun (src/sources.js).
  // days: an explicit --days replaces a source's own syncWindows with one
  // window (for backfills); otherwise sources with syncWindows use those.
  const args = { areas: DEFAULT_AREAS, days: 14, daysExplicit: false, max: undefined, allDetails: false };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'area') args.areas = value.split(',');
    else if (key === 'days') { args.days = Number(value); args.daysExplicit = true; }
    else if (key === 'max') args.max = Number(value);
    else if (key === 'all-details') args.allDetails = true;
    else if (key === 'strict') args.strict = true;
    else if (key === 'kind') args.kind = value;
  }
  return args;
}

async function ingestArea(area, { days, daysExplicit = false, max: requestedMax, allDetails, kind = 'manual' }) {
  const source = SOURCES[area];
  if (!source) throw new Error(`Unknown area "${area}". Known: ${Object.keys(SOURCES).join(', ')}`);
  // A backfill may exceed the daily cap, up to the source's own backfill ceiling.
  const ceiling = kind === 'backfill' && source.backfillMaxPerRun ? source.backfillMaxPerRun : source.maxPerRun;
  const max = requestedMax === undefined ? ceiling : Math.min(requestedMax, ceiling);

  const runId = await db.startIngestRun(area);
  // sync_runs is the new record of every attempt; ingest_runs stays until the
  // UI moves over (M2).
  const captureRaw = RAW_CAPTURE_TYPES.has(source.type);
  const sourceId = await db.getSourceId(area);
  // Taken before the run starts, so a watermark never claims rows that
  // changed while the run was reading.
  const runStartedAt = new Date();
  const syncRunId = await db.startSyncRun(sourceId, kind);
  const stats = { requests: 0, fetched: 0, newCount: 0, changed: 0, failed: 0 };
  // Windows: the source's own (ADR-11), or one window on its date field. An
  // explicit --days (a backfill) is one window and leaves the watermarks be.
  const configured = !daysExplicit && captureRaw
    ? (source.syncWindows || (source.dateField ? [{ field: source.dateField, days }] : null))
    : null;
  let windows = !daysExplicit && source.syncWindows ? source.syncWindows : undefined;
  let windowText = `last ${days} days`;
  // Every retry and rate limit the source answers with, for one event per run.
  const retries = retryTally();
  let validation = null;
  let rawRows = [];
  let truncated = false;
  // A planning source (kind 'planning', src/planning.js) writes planning_cases
  // from its raw rows, never permits.
  const planning = source.kind === 'planning';
  // An inspections source (kind 'inspections', src/inspections.js) writes
  // inspections from its raw rows, never permits.
  const inspections = source.kind === 'inspections';
  let rawRecords = [];

  try {
    if (configured) {
      // Watermarks (migration 035): reach back past the last success.
      const { marks, fallback } = await db.getWatermarks(sourceId);
      const eff = effectiveWindows(configured, marks, { fallback });
      windows = eff.windows;
      for (const w of eff.widened) log.warning(`[${area}] window ${w.field} widened ${w.from}d -> ${w.to}d to reach the last success (${w.lastSuccess})`);
      if (eff.gaps.length) {
        log.error(`[${area}] ${eff.gaps.length} window(s) cannot reach the last success; run a backfill`);
        await db.recordSourceEvent(sourceId, syncRunId, 'watermark_gap', 'error', { gaps: eff.gaps });
      }
    }
    if (windows) windowText = windows.map((w) => `${w.field} last ${w.days}d`).join(' + ');
    log.info(`[${area}] ingest start (${windowText}, max ${max})`);

    const fetchSource = getAdapter(source.type);

    // Skip detail pages for permits already stored — one query for the whole
    // grid, then fetch details only for what's genuinely new. This is what
    // makes a wide date range affordable (and polite) on repeat runs.
    const selectDetailTargets = allDetails
      ? undefined
      : async (records) => {
          const known = await db.existingPermitNumbers(
            area,
            records.map((r) => r.permitNumber).filter(Boolean),
          );
          return records.filter((r) => !known.has(r.permitNumber));
        };

    const permits = await fetchSource(source, {
      includeIssued: true,
      daysBack: days,
      windows,
      maxRecords: max,
      log,
      selectDetailTargets,
      retry: { onRetry: retries.onRetry },
      // Raw rows are stored before mapping, so a mapping bug never loses data.
      onRaw: captureRaw ? async (rows, meta) => {
        const { records, failed } = toRawRecords(rows, source, meta);
        rawRecords = records;
        rawRows = rows;
        // Row validation (Zod, src/adapters/validate.js): bad keys and dates
        // are counted and recorded; the rows are still stored raw.
        validation = validateRows(rows, source, { windows: windows || [] });
        if (validation.invalid) {
          const severity = validationSeverity(validation);
          log.warning(`[${area}] ${validation.invalid} of ${rows.length} rows failed validation: ${JSON.stringify(validation.byColumn)}`);
          await db.recordSourceEvent(sourceId, syncRunId, 'validation', severity, validation);
        }
        const { newCount, changed } = await db.insertRawRecords(sourceId, syncRunId, records);
        Object.assign(stats, { requests: meta.requests, fetched: rows.length, newCount, changed, failed });
        truncated = Boolean(meta.truncated);
        log.info(`[${area}] raw: ${rows.length} fetched, ${newCount} new, ${changed} changed, ${failed} without a key`);
        // Schema drift (ADR-14): a renamed or dropped column is recorded today,
        // not discovered weeks later as falling coverage.
        // Monitoring must never stop the data: a failure here is logged loudly,
        // and the health check notices the missing field list.
        try {
          const drift = detectDrift(await db.getFieldList(sourceId), rows, source.fieldMap);
          await db.recordFieldList(sourceId, syncRunId, drift);
          for (const m of drift.missing) log.warning(`[${area}] mapped field "${m.field}" (${m.key}) is missing from all ${rows.length} rows`);
          if (drift.added.length) log.info(`[${area}] new fields from the source: ${drift.added.join(', ')}`);
        } catch (err) {
          log.error(`[${area}] schema-drift check failed (sync continues): ${err.message}`);
        }
      } : undefined,
    });
    if (!captureRaw) stats.fetched = permits.length;

    // Adapters return newest first, so hitting the cap means the OLDEST permits
    // in the window were not fetched. Say so rather than look complete.
    if (truncated || permits.length >= max) {
      log.warning(`[${area}] hit the ${max}-record cap (${windowText}); older permits in the window were not fetched. Use a shorter --days or run more often.`);
      await db.recordSourceEvent(sourceId, syncRunId, 'truncated', 'warning', { max, window: windowText });
    }

    let written; let inserted;
    if (planning) {
      const r = await upsertPlanningCases(area, sourceId, rawRecords);
      ({ inserted } = r);
      written = r.cases;
      log.info(`[${area}] planning cases: ${r.cases} seen, ${r.inserted} new, ${r.changed} changed, ${r.parties} parties, ${r.skipped} without a case number`);
    } else if (inspections) {
      const r = await upsertInspections(area, sourceId, rawRecords);
      ({ inserted } = r);
      written = r.inspections;
      log.info(`[${area}] inspections: ${r.inspections} seen, ${r.inserted} new, ${r.changed} changed, ${r.skipped} without a key or permit number`);
    } else {
      const withScores = permits.map((p) => ({ ...p, tradeScores: tradeScoresFor(p) }));
      ({ written, inserted } = await db.upsertPermits(withScores, area));
    }

    await db.finishIngestRun(runId, { seen: permits.length, inserted });
    await db.finishSyncRun(syncRunId, { status: 'succeeded', ...stats });
    await recordRetries(sourceId, syncRunId, retries, area);
    // A truncated run dropped the oldest rows of a window: the watermark stays
    // put so the next run reads them again.
    if (configured && !truncated) {
      await db.saveWatermarks(sourceId, syncRunId, runStartedAt, windows.map((w) => w.field), highWaterValues(rawRows, windows));
    }
    log.info(`[${area}] done: ${permits.length} scraped, ${written} written, ${inserted} new`);
    return { seen: permits.length, written, inserted };
  } catch (err) {
    await db.finishIngestRun(runId, { error: err.message });
    await db.finishSyncRun(syncRunId, {
      status: 'failed', ...stats, errorClass: classifyError(err), errorDetail: String(err.stack || err.message).slice(0, 4000),
    });
    await recordRetries(sourceId, syncRunId, retries, area).catch((e) => log.error(`[${area}] could not record retries: ${e.message}`));
    log.error(`[${area}] FAILED: ${err.message}`);
    throw err;
  }
}

/** One source event per run that had to retry: a 429 is a warning, the rest info. */
async function recordRetries(sourceId, syncRunId, tally, area) {
  if (!tally.retries) return;
  const { onRetry, ...detail } = tally;
  log.info(`[${area}] retries: ${JSON.stringify(detail)}`);
  await db.recordSourceEvent(sourceId, syncRunId, 'rate_limited', tally.rateLimited ? 'warning' : 'info', detail);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await db.applySchema();

  const totals = { seen: 0, written: 0, inserted: 0 };
  const failures = [];

  for (const area of args.areas) {
    try {
      const result = await ingestArea(area, args);
      totals.seen += result.seen;
      totals.written += result.written;
      totals.inserted += result.inserted;
    } catch (err) {
      // One portal being down shouldn't abandon the others.
      failures.push({ area, message: err.message });
    }
  }

  log.info(`TOTAL: ${totals.seen} scraped, ${totals.written} written, ${totals.inserted} new`);
  if (failures.length) {
    for (const f of failures) log.error(`  failed: ${f.area} — ${f.message}`);
  }
  await db.close();
  // --strict (the scheduled CI sync): any failed area fails the process, so the
  // scheduler notifies someone. Without it, only a total failure does.
  process.exitCode = (args.strict ? failures.length > 0 : failures.length === args.areas.length) ? 1 : 0;
}

if (require.main === module) {
  main().catch(async (err) => {
    log.error(err.stack || err.message);
    await db.close();
    process.exit(1);
  });
}

module.exports = { ingestArea, tradeScoresFor, TRADES };
