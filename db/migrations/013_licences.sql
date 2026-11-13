-- Licence verification (ADR-15 item 1). Named registry_licences to keep it
-- apart from 004's contractor_licenses (licence numbers seen on permits). Only licences that match one of our
-- contractors are stored (the full files are ~280k Florida and ~35k Texas
-- business rows; storing them all would cost storage for nothing shown).
-- Codes are kept as published; the holder name may be a person and is never
-- displayed (rule 5).

INSERT INTO jurisdictions (slug, name, kind, state, timezone) VALUES
  ('florida', 'Florida (statewide)', 'state', 'FL', 'America/New_York'),
  ('texas',   'Texas (statewide)',   'state', 'TX', 'America/Chicago')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled, role,
                     terms_url, terms_reviewed_on, terms_reviewed_by, automated_access, redistribution, attribution_text)
SELECT s.slug, j.id, s.kind, s.endpoint_url, 'snapshot', '15 17 * * *', interval '1 day', true, 'enrichment',
       s.terms_url, DATE '2026-11-13', 'claude (not legal advice)', 'unknown', 'unknown', s.attribution_text
  FROM (VALUES
    -- ReadMe and disclaimer read 2026-11-13: free download, no stated
    -- restriction on commercial use (docs/DATA_SOURCES.md).
    ('fl-dbpr', 'florida', 'csv', 'https://www2.myfloridalicense.com/sto/file_download/extracts/', NULL,
     'Florida Department of Business and Professional Regulation, licensee extracts'),
    -- No terms page found. The compliance review asks for this credit
    -- wherever licence data appears.
    ('tx-tdlr', 'texas', 'socrata', 'https://data.texas.gov/resource/7358-krk7.json', NULL,
     'Texas Department of Licensing and Regulation (tdlr.texas.gov/LicenseSearch/licfile.asp)')
  ) AS s(slug, jslug, kind, endpoint_url, terms_url, attribution_text)
  JOIN jurisdictions j ON j.slug = s.jslug
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE registry_licences (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider          TEXT NOT NULL,           -- src/enrichment/licences.js PROVIDERS key
  licence_key       TEXT NOT NULL,           -- comparable form (FL: prefix + number, no leading zeros)
  licence_number    TEXT NOT NULL,           -- as published
  licence_type      TEXT,                    -- DBPR occupation code / TDLR licence type, as published
  class_code        TEXT,
  business_name     TEXT,
  holder_name       TEXT,                    -- may be a person: matching only, never displayed
  city              TEXT,
  state             CHAR(2),
  primary_status    TEXT,                    -- DBPR codes as published (not decoded)
  secondary_status  TEXT,
  expires_on        DATE,
  phone             TEXT,                    -- E.164; TDLR electrical contractors only (a business line)
  file_date         TIMESTAMPTZ,             -- the provider's own last-modified / rowsUpdatedAt
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_run_id       BIGINT NOT NULL REFERENCES sync_runs(id),
  UNIQUE (provider, licence_key)
);

CREATE TABLE contractor_registry_licences (
  contractor_id  BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  licence_id     BIGINT NOT NULL REFERENCES registry_licences(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  match_rule     TEXT NOT NULL CHECK (match_rule IN ('licence', 'phone', 'name_state')),
  match_confidence NUMERIC(3,2) NOT NULL,
  PRIMARY KEY (contractor_id, licence_id)
);
CREATE INDEX contractor_registry_licences_provider ON contractor_registry_licences (provider);
