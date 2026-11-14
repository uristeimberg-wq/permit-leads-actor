-- 020: building facts the sources publish but permits never mapped (ADR-23,
-- data audit 2026-11-14). One row per permit, rebuilt from the permit's latest
-- raw record by ingest/facts.js; raw_record_id is the evidence (rule 6).
-- NULL means the source did not publish it (rule 1). Additive only.

CREATE TABLE permit_facts (
  permit_id          BIGINT PRIMARY KEY REFERENCES permits(id) ON DELETE CASCADE,
  units              INTEGER,
  floors             NUMERIC,
  building_sqft      NUMERIC,      -- the source's total / existing building area
  new_sqft           NUMERIC,      -- new or added area
  remodel_sqft       NUMERIC,
  use_class          TEXT CHECK (use_class IN ('residential', 'commercial')),
  proposed_use       TEXT,         -- as published
  construction_type  TEXT,         -- as published
  zoning             TEXT,         -- as published (City of Miami: Miami 21 transect zone)
  plan_review_days   INTEGER,      -- as published (City of Miami)
  completed_on       DATE,
  last_inspection_on DATE,
  planning_ref       TEXT,         -- the source's planning case id (Raleigh devplanid)
  property_ref       TEXT,         -- the source's own property id (Austin propertyrsn)
  project_ref        TEXT,         -- the source's own project id (Austin project_id)
  record_url         TEXT,         -- the official record on the source's own service
  raw_record_id      BIGINT REFERENCES raw_records(id) ON DELETE SET NULL,
  facts_version      TEXT NOT NULL,
  extracted_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX permit_facts_planning_ref ON permit_facts (planning_ref) WHERE planning_ref IS NOT NULL;
CREATE INDEX permit_facts_property_ref ON permit_facts (property_ref) WHERE property_ref IS NOT NULL;
