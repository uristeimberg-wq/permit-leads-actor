-- 035: ingestion hardening (data-engine brief, phase 1;
-- docs/research/2026-11-15-engine-gap-analysis.md). Additive only: no table
-- or column the app reads is renamed or dropped.
--
-- 1. raw_records.source_url: a URL that asks the source again for the rows it
--    publishes under this record's key. source_updated_at is now filled only
--    from a column the source keeps as a record-modification time (Raleigh
--    recordupdatedate). Austin's :updated_at is not one: the publisher
--    reloads all rows daily, so it would claim a freshness the data lacks.
-- 2. source_watermarks: the last successful sync per source and date window.
--    A run widens a window to reach back past the last success, so an outage
--    longer than the window no longer leaves a silent gap.
-- 3. source_events gains validation, rate_limited and watermark_gap, and
--    connector_health_logs reads every connector alert in one place.
-- 4. lifecycle_stage is checked against src/lifecycle.js STAGES on new
--    writes (NOT VALID: existing rows are counted by recon/engine_verify.js
--    and validated in a later migration), and lifecycle_phase() maps it onto
--    the brief's coarser eight values.
-- 5. record_status_changelog: one changelog over the three history tables,
--    in old-value / new-value form. History rows become append-only: an
--    observed value can never be edited or deleted, except that a row goes
--    with its record, and the derived lifecycle_stage may be restaged when
--    the vocabulary is fixed (ingest/lifecycle.js).
-- 6. Indexes the brief names that did not exist yet.

-- 1 ------------------------------------------------------------------------
ALTER TABLE raw_records ADD COLUMN IF NOT EXISTS source_url TEXT;

-- 2 ------------------------------------------------------------------------
CREATE TABLE source_watermarks (
  source_id                BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  window_field             TEXT NOT NULL,          -- the source column the window filters on
  last_successful_sync_at  TIMESTAMPTZ NOT NULL,   -- start of the last run that succeeded untruncated
  last_sync_run_id         BIGINT REFERENCES sync_runs(id) ON DELETE SET NULL,
  high_water_value         TIMESTAMPTZ,            -- newest value of window_field seen so far (the source's own date)
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, window_field)
);

-- 3 ------------------------------------------------------------------------
ALTER TABLE source_events DROP CONSTRAINT IF EXISTS source_events_kind_check;
ALTER TABLE source_events ADD CONSTRAINT source_events_kind_check
  CHECK (kind IN ('schema_change', 'truncated', 'retention', 'missing_at_source',
                  'validation', 'rate_limited', 'watermark_gap'));

CREATE VIEW connector_health_logs AS
SELECT e.created_at AS logged_at, s.slug AS source, e.sync_run_id, e.kind AS alert,
       e.severity, e.detail
  FROM source_events e JOIN sources s ON s.id = e.source_id
UNION ALL
SELECT coalesce(r.finished_at, r.started_at), s.slug, r.id, 'sync_failed', 'error',
       jsonb_build_object('error_class', r.error_class, 'run_kind', r.kind,
                          'error', left(r.error_detail, 500))
  FROM sync_runs r JOIN sources s ON s.id = r.source_id
 WHERE r.status = 'failed';

-- 4 ------------------------------------------------------------------------
ALTER TABLE permits ADD CONSTRAINT permits_lifecycle_stage_check
  CHECK (lifecycle_stage IN ('pre_application', 'submitted', 'in_review', 'corrections', 'approved', 'issued',
                             'inspections', 'completed', 'expired', 'withdrawn', 'cancelled', 'denied', 'unknown')) NOT VALID;
ALTER TABLE planning_cases ADD CONSTRAINT planning_cases_lifecycle_stage_check
  CHECK (lifecycle_stage IN ('pre_application', 'submitted', 'in_review', 'corrections', 'approved', 'issued',
                             'inspections', 'completed', 'expired', 'withdrawn', 'cancelled', 'denied', 'unknown')) NOT VALID;

-- The brief's eight phases. Finer stages stay in lifecycle_stage; this is a
-- read-side grouping, never stored. denied and cancelled are ends without a
-- build, so they fall in expired_or_withdrawn; unknown stays unknown.
CREATE FUNCTION lifecycle_phase(stage TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE stage
    WHEN 'pre_application' THEN 'pre_application'
    WHEN 'submitted'       THEN 'application_submitted'
    WHEN 'in_review'       THEN 'plan_review'
    WHEN 'corrections'     THEN 'plan_review'
    WHEN 'approved'        THEN 'approved'
    WHEN 'issued'          THEN 'issued'
    WHEN 'inspections'     THEN 'inspection'
    WHEN 'completed'       THEN 'finaled'
    WHEN 'expired'         THEN 'expired_or_withdrawn'
    WHEN 'withdrawn'       THEN 'expired_or_withdrawn'
    WHEN 'cancelled'       THEN 'expired_or_withdrawn'
    WHEN 'denied'          THEN 'expired_or_withdrawn'
    ELSE 'unknown' END
$$;

-- 5 ------------------------------------------------------------------------
-- One row per value that changed. The first observation of a record has
-- old_value NULL. Rows where a history entry repeats the value of a field
-- (another field changed) are left out.
CREATE VIEW record_status_changelog AS
WITH obs AS (
  SELECT 'permit'::text AS record_type, h.permit_id AS record_id, h.id AS history_id, h.observed_at,
         f.field, f.value
    FROM permit_status_history h
   CROSS JOIN LATERAL (VALUES ('status_raw', h.status_raw), ('lifecycle_stage', h.lifecycle_stage),
                              ('stage_since', h.stage_since::text)) AS f(field, value)
  UNION ALL
  SELECT 'planning_case', h.case_id, h.id, h.observed_at, f.field, f.value
    FROM planning_case_status_history h
   CROSS JOIN LATERAL (VALUES ('status_raw', h.status_raw), ('lifecycle_stage', h.lifecycle_stage),
                              ('stage_since', h.stage_since::text)) AS f(field, value)
  UNION ALL
  SELECT 'inspection', h.inspection_id, h.id, h.observed_at, f.field, f.value
    FROM inspection_result_history h
   CROSS JOIN LATERAL (VALUES ('result_raw', h.result_raw), ('result_class', h.result_class),
                              ('completed', h.completed::text)) AS f(field, value)
), seq AS (
  SELECT obs.*,
         lag(value) OVER w AS old_value,
         row_number() OVER w AS n
    FROM obs
  WINDOW w AS (PARTITION BY record_type, record_id, field ORDER BY observed_at, history_id)
)
SELECT record_type, record_id, field AS field_changed, old_value, value AS new_value,
       observed_at AS detected_at, history_id
  FROM seq
 WHERE n = 1 OR old_value IS DISTINCT FROM value;

-- Append-only history. A DELETE is allowed only when the parent record is
-- already gone (ON DELETE CASCADE from a market purge); an UPDATE may change
-- only lifecycle_stage, the derived column ingest/lifecycle.js restages.
CREATE FUNCTION history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_table TEXT := TG_ARGV[0];
  parent_col   TEXT := TG_ARGV[1];
  parent_id    BIGINT;
  still_there  BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_id := (to_jsonb(OLD) ->> parent_col)::bigint;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1)', parent_table) INTO still_there USING parent_id;
    IF still_there THEN
      RAISE EXCEPTION '% is append-only: a history row is deleted only with its record', TG_TABLE_NAME;
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'lifecycle_stage') IS DISTINCT FROM (to_jsonb(OLD) - 'lifecycle_stage') THEN
    RAISE EXCEPTION '% is append-only: only lifecycle_stage may be restaged', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER permit_status_history_append_only BEFORE UPDATE OR DELETE ON permit_status_history
  FOR EACH ROW EXECUTE FUNCTION history_append_only('permits', 'permit_id');
CREATE TRIGGER planning_case_status_history_append_only BEFORE UPDATE OR DELETE ON planning_case_status_history
  FOR EACH ROW EXECUTE FUNCTION history_append_only('planning_cases', 'case_id');
CREATE TRIGGER inspection_result_history_append_only BEFORE UPDATE OR DELETE ON inspection_result_history
  FOR EACH ROW EXECUTE FUNCTION history_append_only('inspections', 'inspection_id');

-- 6 ------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS permits_first_seen ON permits (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS permits_parcel_number ON permits (source_area, parcel_number) WHERE parcel_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS raw_records_fetched ON raw_records (source_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS raw_records_source_updated ON raw_records (source_id, source_updated_at DESC) WHERE source_updated_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS planning_cases_first_seen ON planning_cases (first_seen_at DESC);
