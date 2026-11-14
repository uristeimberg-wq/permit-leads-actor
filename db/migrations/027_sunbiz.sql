-- 027: Florida Sunbiz corporate records as legal-entity keys for Florida
-- contractor businesses (lane C, ADR-23 sprint 2). Same tables as the Texas
-- Comptroller (024), provider 'fl-sunbiz'. Business fields only: the
-- registered agent, officers and FEI number are never read or stored
-- (rule 5; src/enrichment/sunbiz.js). Matching rules are in that file.

INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled, role,
                     terms_url, terms_reviewed_on, terms_reviewed_by, automated_access, redistribution, attribution_text)
SELECT 'fl-sunbiz', j.id, 'sftp', 'sftp://sftp.floridados.gov/doc/cor/',
       'snapshot', '15 17 * * *', interval '1 day', true, 'enrichment',
       'https://dos.fl.gov/sunbiz/other-services/data-downloads/',
       -- "free data downloads for informational purposes ... offered as is";
       -- the Data Usage Guide states no fee, licence or redistribution clause
       -- (read 2026-11-14). Public records under Florida ch. 119.
       DATE '2026-11-14', 'claude (not legal advice)', 'yes', 'unknown',
       'Florida Department of State, Division of Corporations (sunbiz.org)'
  FROM jurisdictions j WHERE j.slug = 'florida'
ON CONFLICT (slug) DO NOTHING;

-- Sunbiz-specific business facts. NULL for Texas rows.
ALTER TABLE business_registrations
  ADD COLUMN entity_type          TEXT,   -- Sunbiz filing type as published (FLAL, DOMP, ...)
  ADD COLUMN principal_city       TEXT,
  ADD COLUMN principal_state      TEXT,
  ADD COLUMN principal_zip        TEXT,
  ADD COLUMN last_transaction_on  DATE,
  -- The date the provider's file speaks for (the daily file's date, or the
  -- quarterly file's). An older file never overwrites a newer one.
  ADD COLUMN source_as_of         DATE,
  ADD COLUMN name_key             TEXT;   -- normalizeName(legal_name), for matching

CREATE INDEX business_registrations_name_key ON business_registrations (provider, name_key);

-- Several Florida entities with one name, exactly one active: matched to that one.
ALTER TABLE contractor_registrations DROP CONSTRAINT contractor_registrations_match_rule_check;
ALTER TABLE contractor_registrations ADD CONSTRAINT contractor_registrations_match_rule_check
  CHECK (match_rule IN ('name_state', 'name_state_active'));

-- Bulk files already applied, so a re-run never applies one twice (rule 2)
-- and a missed day is caught up.
CREATE TABLE registry_files (
  provider      TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  file_date     DATE,
  records       INTEGER NOT NULL,
  kept          INTEGER NOT NULL,
  layout_failed INTEGER NOT NULL,
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_run_id   BIGINT NOT NULL REFERENCES sync_runs(id),
  PRIMARY KEY (provider, file_name)
);

-- contractors-v5 rule 3: identities joined by one Sunbiz entity.
ALTER TABLE permit_parties DROP CONSTRAINT permit_parties_match_rule_check;
ALTER TABLE permit_parties ADD CONSTRAINT permit_parties_match_rule_check
  CHECK (match_rule IN ('licence', 'name_state', 'legal_entity', 'owner_builder', 'unresolved'));

-- Design participants on a permit (lane C): Miami-Dade's ArchitectName, the
-- architect or engineer of record. Rebuilt by ingest/resolve.js with the
-- other parties. A person's name is stored for matching and never shown
-- (rule 5): only display_policy 'show' (a firm) reaches a client.
CREATE TABLE permit_participants (
  permit_id        BIGINT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('architect')),
  raw_name         TEXT NOT NULL,
  normalized_name  TEXT NOT NULL,
  party_kind       TEXT NOT NULL CHECK (party_kind IN ('business','individual','unknown')),
  display_policy   TEXT NOT NULL CHECK (display_policy IN ('show','hide','review')),
  raw_record_id    BIGINT REFERENCES raw_records(id) ON DELETE SET NULL,
  PRIMARY KEY (permit_id, role)
);
CREATE INDEX permit_participants_firm ON permit_participants (role, normalized_name) WHERE display_policy = 'show';
