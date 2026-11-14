-- 021: data-quality scorecard (ADR-23, docs/DATA_ENGINE_PLAN.md section 7).
-- One value per market, metric and day, written by ingest/scorecard.js after
-- the daily sync. Re-running on the same day replaces that day's value, so
-- there are no duplicates. numerator / denominator are kept so a rate can be
-- re-checked by hand.

CREATE TABLE scorecard_snapshots (
  measured_on     DATE NOT NULL,
  market          TEXT NOT NULL,           -- a source_area, or 'all'
  metric          TEXT NOT NULL,           -- src/scorecard.js METRICS key
  value           NUMERIC,                 -- a share 0-1, or a count / days (see unit)
  unit            TEXT NOT NULL CHECK (unit IN ('share', 'days', 'count')),
  numerator       NUMERIC,
  denominator     NUMERIC,
  method_version  TEXT NOT NULL,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (measured_on, market, metric)
);
