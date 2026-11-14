-- 018: who filed each Austin building application, and what kind of business
-- it is (ADR-19, docs/DATA_STRATEGY.md section 8, pilot P2). Additive only.
-- Never edit this file after merge; add 019_*.sql instead.
--
-- The plan-review feed names organisations (applicant and "other" contact)
-- before any contractor is on record: builders, owners' companies and permit
-- expediters. Both tables are derived from the latest raw record and rebuilt
-- wholesale by ingest/filers.js, like the resolver's tables (ADR-12).
--
-- Rule 5: owner fields and *_full_name fields are never copied here. An
-- organisation equal to the owner organisation is not stored as a filer.

CREATE TABLE filing_filers (
  permit_id      BIGINT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  source_field   TEXT NOT NULL CHECK (source_field IN ('applicant_organization_name', 'other_organization_name')),
  raw_name       TEXT NOT NULL,           -- as published
  org_key        TEXT NOT NULL,           -- src/contractors.js normalizeName of the cleaned name
  raw_record_id  BIGINT REFERENCES raw_records(id) ON DELETE SET NULL,
  PRIMARY KEY (permit_id, source_field)
);
CREATE INDEX filing_filers_org ON filing_filers (org_key);

CREATE TABLE filer_orgs (
  org_key              TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,      -- the most frequent spelling, account marks removed
  party_kind           TEXT NOT NULL CHECK (party_kind IN ('business', 'individual', 'unknown')),
  role                 TEXT NOT NULL CHECK (role IN ('builder', 'expediter', 'unknown')),
  basis                TEXT NOT NULL,      -- the evidence, in words
  filings              INTEGER NOT NULL,
  linked_bps           INTEGER NOT NULL,   -- building permits linked to its filings (permit_links)
  self_bps             INTEGER NOT NULL,   -- of those, pulled by a contractor with the same name
  distinct_contractors INTEGER NOT NULL,
  contractor_id        BIGINT REFERENCES contractors(id) ON DELETE SET NULL,  -- same-name building contractor
  classifier_version   TEXT NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX filer_orgs_contractor ON filer_orgs (contractor_id);
