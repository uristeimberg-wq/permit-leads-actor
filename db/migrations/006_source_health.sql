-- 006: source health and schema-drift tracking (ADR-14).
-- A sync that never runs records nothing, so staleness is computed from the
-- last success, by a check that runs separately from the sync (health.yml).
-- Never edit this file after merge; add 007_*.sql instead.

-- The field names a source last returned, so a renamed or dropped column is
-- noticed the day it happens instead of as a slow drop in coverage.
ALTER TABLE sources ADD COLUMN field_list JSONB;

CREATE TABLE source_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id   BIGINT NOT NULL REFERENCES sources(id),
  sync_run_id BIGINT REFERENCES sync_runs(id),
  kind        TEXT NOT NULL CHECK (kind IN ('schema_change','truncated','retention')),
  severity    TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  detail      JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX source_events_recent ON source_events (source_id, created_at DESC);

-- One row per enabled source. "stale" = no success within 1.5x the expected
-- interval. consecutive_failures counts failed runs since the last success.
CREATE VIEW source_health AS
SELECT s.id AS source_id, s.slug, s.expected_interval,
       ok.finished_at AS last_success_at,
       last.status AS last_status, last.started_at AS last_attempt_at, last.error_class AS last_error_class,
       (SELECT count(*)::int FROM sync_runs f
         WHERE f.source_id = s.id AND f.status = 'failed'
           AND f.started_at > coalesce(ok.finished_at, '-infinity')) AS consecutive_failures,
       (ok.finished_at IS NULL OR ok.finished_at < now() - s.expected_interval * 1.5) AS stale,
       (SELECT coalesce(sum(r.records_new), 0)::int FROM sync_runs r
         WHERE r.source_id = s.id AND r.started_at > now() - interval '7 days') AS new_records_7d,
       (SELECT count(*)::int FROM source_events e
         WHERE e.source_id = s.id AND e.severity <> 'info' AND e.created_at > now() - interval '7 days') AS warnings_7d
  FROM sources s
  LEFT JOIN LATERAL (SELECT finished_at FROM sync_runs WHERE source_id = s.id AND status = 'succeeded'
                      ORDER BY finished_at DESC LIMIT 1) ok ON true
  LEFT JOIN LATERAL (SELECT status, started_at, error_class FROM sync_runs WHERE source_id = s.id
                      ORDER BY started_at DESC LIMIT 1) last ON true
 WHERE s.enabled;

-- The pilot sources are synced daily (sync.yml, 17:15 UTC), so a success older
-- than 36 hours means a missed day. 002 seeded the source's own publication
-- cadence here; publication lag is checked separately (maxDataAgeDays in
-- src/sources.js, ingest/health.js).
UPDATE sources SET expected_interval = '1 day', schedule_cron = '15 17 * * *'
 WHERE slug IN ('austin-tx', 'miami-dade-fl');
