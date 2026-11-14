-- 024: business registrations (ADR-23 sprint 2). Texas contractor businesses
-- tied to their legal entity in the Comptroller's franchise-tax records,
-- through the public-data API (key registered by the owner 2026-11-14).
-- Business fields only: officers, the registered agent and street addresses
-- are never stored (rule 5). Matching rules: src/enrichment/registrations.js.

INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled, role,
                     terms_url, terms_reviewed_on, terms_reviewed_by, automated_access, redistribution, attribution_text)
SELECT 'tx-comptroller', j.id, 'api', 'https://api.comptroller.texas.gov/public-data/v1/public',
       'snapshot', '15 17 * * *', interval '1 day', true, 'enrichment', 'https://api-doc.comptroller.texas.gov/',
       -- The API documentation states no terms or rate limits (read 2026-11-14);
       -- access is by a key issued to the owner on registration.
       DATE '2026-11-14', 'claude (not legal advice)', 'yes', 'unknown',
       'Texas Comptroller of Public Accounts, franchise tax account status'
  FROM jurisdictions j WHERE j.slug = 'texas'
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE business_registrations (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider            TEXT NOT NULL,
  registry_id         TEXT NOT NULL,         -- Comptroller taxpayer id (11 digits)
  legal_name          TEXT,
  dba_name            TEXT,
  sos_file_number     TEXT,
  state_of_formation  TEXT,
  sos_status          TEXT,                  -- as published (ACTIVE, FORFEITED, ...)
  right_to_transact   TEXT,                  -- as published
  sos_registered_on   DATE,
  report_year         INTEGER,
  mailing_city        TEXT,
  mailing_state       TEXT,
  mailing_zip         TEXT,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_run_id         BIGINT NOT NULL REFERENCES sync_runs(id),
  UNIQUE (provider, registry_id)
);

-- One lookup per normalised business name, so a name is asked once and
-- re-asked only when its result is old (refreshDays per outcome).
CREATE TABLE registry_lookups (
  provider      TEXT NOT NULL,
  query_key     TEXT NOT NULL,                 -- contractors.normalized_name
  query_text    TEXT NOT NULL,                 -- what was sent
  outcome       TEXT NOT NULL CHECK (outcome IN ('matched', 'ambiguous', 'prefix', 'none', 'error')),
  registry_id   TEXT,                          -- matched: the taxpayer; prefix: the candidate
  candidates    INTEGER,
  error_detail  TEXT,
  looked_up_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_run_id   BIGINT NOT NULL REFERENCES sync_runs(id),
  PRIMARY KEY (provider, query_key)
);

-- Rebuilt each run from registry_lookups (matched only).
CREATE TABLE contractor_registrations (
  contractor_id    BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  registration_id  BIGINT NOT NULL REFERENCES business_registrations(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  match_rule       TEXT NOT NULL CHECK (match_rule IN ('name_state')),
  match_confidence NUMERIC(3,2) NOT NULL,
  PRIMARY KEY (contractor_id, registration_id)
);
CREATE INDEX contractor_registrations_provider ON contractor_registrations (provider);
