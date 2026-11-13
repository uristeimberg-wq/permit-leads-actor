-- 002: the source registry, sync-run log and append-only raw records
-- (docs/DATA_MODEL.md, "Sources and ingestion"; ROADMAP M1).
--
-- Additive only: the prototype's permits and ingest_runs tables are untouched,
-- and ingest keeps writing ingest_runs (the UI reads it) until M2 moves it.
-- Never edit this file after merge; add 003_*.sql instead.

CREATE TABLE jurisdictions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('city','county','state','other')),
  state         CHAR(2) NOT NULL,
  timezone      TEXT NOT NULL
);

CREATE TABLE sources (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug                  TEXT NOT NULL UNIQUE,  -- the area key in src/sources.js
  jurisdiction_id       BIGINT NOT NULL REFERENCES jurisdictions(id),
  kind                  TEXT NOT NULL,         -- socrata | arcgis | csv | accela
  endpoint_url          TEXT NOT NULL,
  sync_mode             TEXT NOT NULL CHECK (sync_mode IN ('updated_at','snapshot','date_window')),
  schedule_cron         TEXT NOT NULL,
  expected_interval     INTERVAL NOT NULL,     -- drives the "stale" alert
  enabled               BOOLEAN NOT NULL DEFAULT false,
  cursor                JSONB,
  field_list_hash       TEXT,
  terms_url             TEXT,
  terms_reviewed_on     DATE,
  terms_reviewed_by     TEXT,
  automated_access      TEXT NOT NULL DEFAULT 'unknown' CHECK (automated_access IN ('yes','no','unknown')),
  redistribution        TEXT NOT NULL DEFAULT 'unknown' CHECK (redistribution IN ('yes','no','unknown','attribution')),
  attribution_text      TEXT,
  raw_retention_days    INTEGER,
  homeowner_use         TEXT NOT NULL DEFAULT 'blocked' CHECK (homeowner_use IN ('blocked','approved'))
);

CREATE TABLE sync_runs (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id        BIGINT NOT NULL REFERENCES sources(id),
  kind             TEXT NOT NULL CHECK (kind IN ('scheduled','manual','backfill')),
  status           TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  cursor_from      JSONB,
  cursor_to        JSONB,
  requests_made    INTEGER NOT NULL DEFAULT 0,
  records_fetched  INTEGER NOT NULL DEFAULT 0,
  records_new      INTEGER NOT NULL DEFAULT 0,
  records_changed  INTEGER NOT NULL DEFAULT 0,
  records_failed   INTEGER NOT NULL DEFAULT 0,
  -- 'unknown' is allowed and reported, never silently dropped (CLAUDE.md rule 3).
  error_class      TEXT CHECK (error_class IN ('transient','rate_limited','auth','schema','bad_data','bug','unknown')),
  error_detail     TEXT,
  CHECK (status <> 'failed' OR error_class IS NOT NULL)
);
CREATE INDEX sync_runs_source_started ON sync_runs (source_id, started_at DESC);

CREATE TABLE raw_records (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id          BIGINT NOT NULL REFERENCES sources(id),
  source_key         TEXT NOT NULL,
  payload_hash       TEXT NOT NULL,             -- sha256 of canonical JSON
  payload            JSONB NOT NULL,
  source_updated_at  TIMESTAMPTZ,
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_run_id        BIGINT NOT NULL REFERENCES sync_runs(id),
  normalized_at      TIMESTAMPTZ,
  normalize_error    TEXT,
  UNIQUE (source_id, source_key, payload_hash)  -- same content twice = no-op
);
CREATE INDEX raw_records_unnormalized ON raw_records (normalized_at) WHERE normalized_at IS NULL;
CREATE INDEX raw_records_key ON raw_records (source_id, source_key);

-- Seed the registry with what src/sources.js defines today. Terms have not been
-- reviewed for any source (docs/DATA_SOURCES.md), so access and redistribution
-- stay 'unknown' rather than claiming a permission nobody checked.
INSERT INTO jurisdictions (slug, name, kind, state, timezone) VALUES
  ('austin-tx',            'Austin',                'city',   'TX', 'America/Chicago'),
  ('miami-dade-county-fl', 'Miami-Dade County',     'county', 'FL', 'America/New_York'),
  ('portland-or',          'Portland',              'city',   'OR', 'America/Los_Angeles'),
  ('clackamas-county-or',  'Clackamas County',      'county', 'OR', 'America/Los_Angeles'),
  ('oregon',               'Oregon (statewide)',    'state',  'OR', 'America/Los_Angeles');

INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled, attribution_text)
SELECT s.slug, j.id, s.kind, s.endpoint_url, s.sync_mode, s.schedule_cron, s.expected_interval::interval, s.enabled, s.attribution_text
  FROM (VALUES
    -- Austin publishes daily; permits are complete 2-3 days after issue (M1).
    ('austin-tx', 'austin-tx', 'socrata', 'https://data.austintexas.gov/resource/3syk-w9eu.json', 'updated_at', '0 7 * * *', '2 days', true,
     'City of Austin, Texas - data.austintexas.gov'),
    -- Miami-Dade refreshes weekly (layer edited 2026-11-07, latest issue 2026-11-05).
    ('miami-dade-fl', 'miami-dade-county-fl', 'arcgis', 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0', 'snapshot', '0 9 * * *', '8 days', true, NULL),
    ('portland-or', 'portland-or', 'csv', 'https://www.portlandmaps.com/reports/index.cfm?action=rs-issued&format=csv', 'date_window', '0 6 * * *', '2 days', false, NULL),
    ('clackamas-county-or', 'clackamas-county-or', 'accela', 'https://aca-prod.accela.com/CLACKAMAS/', 'date_window', '0 6 * * *', '2 days', false, NULL),
    ('oregon-statewide', 'oregon', 'accela', 'https://aca-oregon.accela.com/oregon/', 'date_window', '0 6 * * *', '2 days', false, NULL)
  ) AS s(slug, jslug, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled, attribution_text)
  JOIN jurisdictions j ON j.slug = s.jslug;
