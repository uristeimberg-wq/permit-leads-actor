-- 030: rolling re-read of stored permits (ingest/refresh.js), and the repair
-- of Austin's official record links. Fidelity check 2026-11-14
-- (docs/research/2026-11-14-fidelity-check.md):
--   - 108 of 300 sampled Austin permits stored the literal JSON
--     {"url":"https://abc.austintexas.gov/..."} instead of the URL. Rows
--     written before the urlOf fix were never re-fetched, so never rewritten.
--   - City of Miami showed "Active" on permits the City now marks "Final",
--     on old permits no date window re-reads (2 of 39 in about a day).
--
-- The re-read fetches stored permits by number, oldest check first, so every
-- stored permit is compared with its source on a rolling cycle. A permit the
-- source no longer returns is marked, never deleted.

-- Permits: when the re-read last asked the source about this permit, and
-- since when the source has stopped returning it (NULL = it still does).
ALTER TABLE permits ADD COLUMN IF NOT EXISTS source_checked_at    TIMESTAMPTZ;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS source_missing_since TIMESTAMPTZ;
-- The re-read's cursor: least recently confirmed first.
CREATE INDEX IF NOT EXISTS permits_reread_idx ON permits (source_area, (coalesce(source_checked_at, last_seen_at)));

-- A re-read is its own kind of sync run, and a permit gone from its source an
-- event health reports.
ALTER TABLE sync_runs DROP CONSTRAINT IF EXISTS sync_runs_kind_check;
ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_kind_check
  CHECK (kind IN ('scheduled', 'manual', 'backfill', 'refresh'));
ALTER TABLE source_events DROP CONSTRAINT IF EXISTS source_events_kind_check;
ALTER TABLE source_events ADD CONSTRAINT source_events_kind_check
  CHECK (kind IN ('schema_change', 'truncated', 'retention', 'missing_at_source'));

-- Freshness must come from the window sync: a successful re-read must not
-- make a source look fresh while its new-permit sync fails. Same columns as
-- 006; only the run kinds read differ.
CREATE OR REPLACE VIEW source_health AS
SELECT s.id AS source_id, s.slug, s.expected_interval,
       ok.finished_at AS last_success_at,
       last.status AS last_status, last.started_at AS last_attempt_at, last.error_class AS last_error_class,
       (SELECT count(*)::int FROM sync_runs f
         WHERE f.source_id = s.id AND f.status = 'failed' AND f.kind <> 'refresh'
           AND f.started_at > coalesce(ok.finished_at, '-infinity')) AS consecutive_failures,
       (ok.finished_at IS NULL OR ok.finished_at < now() - s.expected_interval * 1.5) AS stale,
       (SELECT coalesce(sum(r.records_new), 0)::int FROM sync_runs r
         WHERE r.source_id = s.id AND r.started_at > now() - interval '7 days') AS new_records_7d,
       (SELECT count(*)::int FROM source_events e
         WHERE e.source_id = s.id AND e.severity <> 'info' AND e.created_at > now() - interval '7 days') AS warnings_7d
  FROM sources s
  LEFT JOIN LATERAL (SELECT finished_at FROM sync_runs WHERE source_id = s.id AND status = 'succeeded' AND kind <> 'refresh'
                      ORDER BY finished_at DESC LIMIT 1) ok ON true
  LEFT JOIN LATERAL (SELECT status, started_at, error_class FROM sync_runs WHERE source_id = s.id AND kind <> 'refresh'
                      ORDER BY started_at DESC LIMIT 1) last ON true
 WHERE s.enabled;

-- Austin record links: take the URL out of the stored JSON text. Only rows
-- whose text holds a "url" string are touched; the value is the source's own.
UPDATE permits
   SET permit_url = substring(permit_url FROM '"url"\s*:\s*"([^"]+)"')
 WHERE permit_url LIKE '{%'
   AND substring(permit_url FROM '"url"\s*:\s*"([^"]+)"') IS NOT NULL;
