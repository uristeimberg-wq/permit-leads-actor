// Database access. Plain `pg` and hand-written SQL — no ORM, matching the
// dependency-light style of the scraper.

const { Pool, types } = require('pg');
const { migrate } = require('./migrate.js');

// Return DATE (OID 1082) as the plain 'YYYY-MM-DD' string the column actually
// holds. By default node-pg builds a JS Date at LOCAL midnight, which then
// serializes to UTC and shifts the day backwards for any timezone east of UTC —
// a permit filed 2026-09-10 would reach the client as 2026-09-09. A filing date
// is a calendar date, not an instant; it should never move.
types.setTypeParser(1082, (value) => value);

const DEFAULT_URL = 'postgres://permits:permits@localhost:5433/permits';

let pool;

/** Lazily created so importing this module never opens a connection. */
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || DEFAULT_URL,
      max: Number(process.env.PGPOOL_MAX || 10),
    });
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

/** Bring the database up to date by applying pending db/migrations/*.sql. */
async function applySchema() {
  await migrate(getPool());
}

async function close() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

// Postgres' hard ceiling on bind parameters in one statement, with headroom.
const MAX_BIND_PARAMS = 60000;

// Column order shared by the INSERT and its parameter builder.
const COLUMNS = [
  'source_area', 'permit_number', 'jurisdiction', 'address', 'street', 'city',
  'state', 'zip', 'permit_type', 'work_description', 'valuation',
  'status', 'status_raw', 'status_stage',
  'permit_url', 'filed_date', 'trade_scores',
  'owner', 'parcel_number', 'parcel_block', 'parcel_lot', 'parcel_subdivision',
  'construction_type', 'other_construction_type',
  'fees', 'fees_paid', 'fees_balance', 'inspections',
  'contractor_name', 'contractor_phone', 'contractor_licence', 'contractor_trade',
  'contractor_city', 'applicant_name', 'applicant_phone',
];

function toRow(permit, sourceArea) {
  return [
    sourceArea,
    permit.permitNumber,
    permit.jurisdiction ?? null,
    permit.address ?? null,
    permit.street ?? null,
    permit.city ?? null,
    permit.state ?? null,
    permit.zip ?? null,
    permit.permitType ?? null,
    permit.workDescription ?? '',
    permit.valuation ?? 0,
    permit.status ?? null,
    permit.statusRaw ?? null,
    permit.statusStage ?? null,
    permit.permitUrl ?? null,
    permit.filedDate ?? null,
    JSON.stringify(permit.tradeScores ?? {}),
    permit.owner ?? null,
    permit.parcelNumber ?? null,
    permit.parcelBlock ?? null,
    permit.parcelLot ?? null,
    permit.parcelSubdivision ?? null,
    permit.constructionType ?? null,
    permit.otherConstructionType ?? null,
    permit.fees ? JSON.stringify(permit.fees) : null,
    permit.feesPaid ?? null,
    permit.feesBalance ?? null,
    permit.inspections ? JSON.stringify(permit.inspections) : null,
    permit.contractorName ?? null,
    permit.contractorPhone ?? null,
    permit.contractorLicence ?? null,
    permit.contractorTrade ?? null,
    permit.contractorCity ?? null,
    permit.applicantName ?? null,
    permit.applicantPhone ?? null,
  ];
}

/**
 * Upserts a batch of permits. Ingest windows overlap by design, so re-seeing a
 * permit must update it rather than duplicate it or fail.
 *
 * `first_seen_at` is deliberately never overwritten — it records when the permit
 * entered OUR data, which is what "new since you last looked" depends on.
 *
 * @returns {Promise<{written: number, inserted: number}>}
 */
async function upsertPermits(permits, sourceArea) {
  // A single INSERT ... ON CONFLICT cannot touch the same row twice, and source
  // data really does repeat: Austin's dataset ships ~1.5% exact duplicate rows
  // (same permit number, date, address and contractor). De-duplicating on the
  // natural key keeps the last occurrence, which is the freshest.
  const byKey = new Map();
  for (const permit of permits) {
    if (permit.permitNumber) byKey.set(permit.permitNumber, permit);
  }
  const rows = [...byKey.values()];
  if (rows.length === 0) return { written: 0, inserted: 0 };

  // Postgres accepts at most 65,535 bind parameters per statement. With ~31
  // columns per row that caps a single INSERT at ~2,100 rows, and open-data
  // sources return far more than that in one run, so the batch is chunked.
  const perChunk = Math.floor(MAX_BIND_PARAMS / COLUMNS.length);
  if (rows.length > perChunk) {
    const totals = { written: 0, inserted: 0 };
    for (let i = 0; i < rows.length; i += perChunk) {
      const result = await upsertPermits(rows.slice(i, i + perChunk), sourceArea);
      totals.written += result.written;
      totals.inserted += result.inserted;
    }
    return totals;
  }

  const values = [];
  const params = [];
  rows.forEach((permit, i) => {
    const base = i * COLUMNS.length;
    values.push(`(${COLUMNS.map((_, c) => `$${base + c + 1}`).join(', ')})`);
    params.push(...toRow(permit, sourceArea));
  });

  const sql = `
    INSERT INTO permits (${COLUMNS.join(', ')})
    VALUES ${values.join(', ')}
    ON CONFLICT (source_area, permit_number) DO UPDATE SET
      jurisdiction     = EXCLUDED.jurisdiction,
      address          = EXCLUDED.address,
      street           = EXCLUDED.street,
      city             = EXCLUDED.city,
      state            = EXCLUDED.state,
      zip              = EXCLUDED.zip,
      permit_type      = EXCLUDED.permit_type,
      -- Detail-derived fields are only overwritten when the incoming row
      -- actually carries them. An incremental run deliberately SKIPS detail
      -- pages for permits it already holds, so those fields arrive empty —
      -- writing them straight through would wipe good data on every re-run.
      work_description = CASE WHEN EXCLUDED.work_description <> ''
                              THEN EXCLUDED.work_description
                              ELSE permits.work_description END,
      valuation        = CASE WHEN EXCLUDED.valuation > 0
                              THEN EXCLUDED.valuation
                              ELSE permits.valuation END,
      trade_scores     = CASE WHEN EXCLUDED.work_description <> ''
                              THEN EXCLUDED.trade_scores
                              ELSE permits.trade_scores END,
      status           = EXCLUDED.status,
      status_raw       = EXCLUDED.status_raw,
      status_stage     = EXCLUDED.status_stage,
      permit_url       = EXCLUDED.permit_url,
      filed_date       = EXCLUDED.filed_date,
      -- Same no-clobber rule as work_description: an incremental run skips
      -- detail pages, so these arrive empty and must not erase stored values.
      owner                   = COALESCE(EXCLUDED.owner, permits.owner),
      parcel_number           = COALESCE(EXCLUDED.parcel_number, permits.parcel_number),
      parcel_block            = COALESCE(EXCLUDED.parcel_block, permits.parcel_block),
      parcel_lot              = COALESCE(EXCLUDED.parcel_lot, permits.parcel_lot),
      parcel_subdivision      = COALESCE(EXCLUDED.parcel_subdivision, permits.parcel_subdivision),
      construction_type       = COALESCE(EXCLUDED.construction_type, permits.construction_type),
      other_construction_type = COALESCE(EXCLUDED.other_construction_type, permits.other_construction_type),
      fees         = COALESCE(EXCLUDED.fees, permits.fees),
      fees_paid    = COALESCE(EXCLUDED.fees_paid, permits.fees_paid),
      fees_balance = COALESCE(EXCLUDED.fees_balance, permits.fees_balance),
      inspections  = COALESCE(EXCLUDED.inspections, permits.inspections),
      contractor_name    = COALESCE(EXCLUDED.contractor_name, permits.contractor_name),
      contractor_phone   = COALESCE(EXCLUDED.contractor_phone, permits.contractor_phone),
      contractor_licence = COALESCE(EXCLUDED.contractor_licence, permits.contractor_licence),
      contractor_trade   = COALESCE(EXCLUDED.contractor_trade, permits.contractor_trade),
      contractor_city    = COALESCE(EXCLUDED.contractor_city, permits.contractor_city),
      applicant_name     = COALESCE(EXCLUDED.applicant_name, permits.applicant_name),
      applicant_phone    = COALESCE(EXCLUDED.applicant_phone, permits.applicant_phone),
      last_seen_at     = now()
    RETURNING (xmax = 0) AS inserted`;

  const result = await query(sql, params);
  return {
    written: result.rowCount,
    inserted: result.rows.filter((r) => r.inserted).length,
  };
}

/**
 * Which permits we already hold WITH their detail-page fields filled in.
 *
 * The "with details" part matters: a detail fetch can fail (a flaky network, a
 * portal hiccup) and still leave the permit stored. Treating that row as known
 * would skip it forever, so a permit with neither a description nor a valuation
 * is reported as missing and gets retried on the next run.
 */
async function existingPermitNumbers(sourceArea, permitNumbers) {
  if (permitNumbers.length === 0) return new Set();
  const { rows } = await query(
    `SELECT permit_number
       FROM permits
      WHERE source_area = $1
        AND permit_number = ANY($2::text[])
        AND (work_description <> '' OR valuation > 0)`,
    [sourceArea, permitNumbers],
  );
  return new Set(rows.map((r) => r.permit_number));
}

async function startIngestRun(sourceArea) {
  const { rows } = await query(
    'INSERT INTO ingest_runs (source_area) VALUES ($1) RETURNING id',
    [sourceArea],
  );
  return rows[0].id;
}

async function finishIngestRun(id, { seen = 0, inserted = 0, error = null } = {}) {
  await query(
    `UPDATE ingest_runs
        SET finished_at = now(), permits_seen = $2, permits_new = $3, error = $4
      WHERE id = $1`,
    [id, seen, inserted, error],
  );
}

// ---------- sources, sync_runs, raw_records (migration 002) ----------

async function getSourceId(slug) {
  const { rows } = await query('SELECT id FROM sources WHERE slug = $1', [slug]);
  if (!rows[0]) throw new Error(`Source "${slug}" is not in the sources table; add it in a migration`);
  return rows[0].id;
}

async function startSyncRun(sourceId, kind) {
  const { rows } = await query(
    `INSERT INTO sync_runs (source_id, kind, status) VALUES ($1, $2, 'running') RETURNING id`,
    [sourceId, kind],
  );
  return rows[0].id;
}

/**
 * Closes a sync run. A failed run must carry an error class (the table checks
 * it), so a failure can never be recorded silently.
 */
async function finishSyncRun(id, {
  status, requests = 0, fetched = 0, newCount = 0, changed = 0, failed = 0, errorClass = null, errorDetail = null,
}) {
  await query(
    `UPDATE sync_runs
        SET finished_at = now(), status = $2, requests_made = $3, records_fetched = $4,
            records_new = $5, records_changed = $6, records_failed = $7,
            error_class = $8, error_detail = $9
      WHERE id = $1`,
    [id, status, requests, fetched, newCount, changed, failed, errorClass, errorDetail],
  );
}

/**
 * Appends raw records. Unchanged content is a no-op (unique on source, key,
 * hash). Returns how many rows were new keys and how many were new versions of
 * keys already stored.
 */
async function insertRawRecords(sourceId, syncRunId, records, { batchSize = 500 } = {}) {
  let newCount = 0; let changed = 0;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const { rows } = await query(
      `WITH input AS (
         SELECT * FROM unnest($3::text[], $4::text[], $5::jsonb[], $6::timestamptz[])
                  AS t(source_key, payload_hash, payload, source_updated_at)
       ), prior AS (
         SELECT DISTINCT source_key FROM raw_records
          WHERE source_id = $1 AND source_key IN (SELECT source_key FROM input)
       ), ins AS (
         INSERT INTO raw_records (source_id, source_key, payload_hash, payload, source_updated_at, sync_run_id)
         SELECT $1, source_key, payload_hash, payload, source_updated_at, $2 FROM input
         ON CONFLICT (source_id, source_key, payload_hash) DO NOTHING
         RETURNING source_key
       )
       SELECT count(*) FILTER (WHERE ins.source_key NOT IN (SELECT source_key FROM prior))::int AS new_count,
              count(*) FILTER (WHERE ins.source_key IN (SELECT source_key FROM prior))::int AS changed
         FROM ins`,
      [sourceId, syncRunId,
        batch.map((r) => r.sourceKey), batch.map((r) => r.payloadHash),
        batch.map((r) => JSON.stringify(r.payload)), batch.map((r) => r.sourceUpdatedAt)],
    );
    newCount += rows[0].new_count; changed += rows[0].changed;
  }
  return { newCount, changed };
}

module.exports = {
  getPool, query, close, applySchema,
  upsertPermits, existingPermitNumbers,
  startIngestRun, finishIngestRun,
  getSourceId, startSyncRun, finishSyncRun, insertRawRecords,
};
