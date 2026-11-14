-- 023: field-level provenance and explicit conflicts (ADR-23, DATA_ENGINE_PLAN
-- 6.3). Applies where more than one source can supply the same attribute;
-- single-source permit fields keep row-level provenance (raw_record_id).
--
-- First entity: the property. One row per official parcel key in a county,
-- stable across provider re-loads (parcels rows can be deleted and re-read;
-- a property row is not). Observations come from the appraiser parcel and
-- from the permits filed on it (permit_facts). Nothing is overwritten: the
-- resolved value is computed over observations by src/fields.js.

CREATE TABLE properties (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  county      TEXT NOT NULL,                 -- jurisdictions.slug of the appraiser's county
  parcel_key  TEXT NOT NULL,                 -- the county's own parcel id (folio, PIN, TCAD id)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (county, parcel_key)
);

CREATE TABLE field_observations (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('property', 'business', 'project')),
  entity_id       BIGINT NOT NULL,
  field           TEXT NOT NULL,             -- src/fields.js FIELDS
  value           JSONB,                     -- NULL: the source says unknown; no row: the source is silent
  value_hash      TEXT NOT NULL,
  source_id       BIGINT NOT NULL REFERENCES sources(id),
  -- Which record of that source: the parcel key, or the permit number. Part of
  -- the key (unlike the plan's sketch) so two permits of one source that
  -- disagree stay two observations.
  source_ref      TEXT NOT NULL,
  raw_record_id   BIGINT REFERENCES raw_records(id) ON DELETE SET NULL,
  method          TEXT NOT NULL CHECK (method IN ('as_published', 'normalized', 'derived', 'matched')),
  confidence      TEXT NOT NULL CHECK (confidence IN ('official', 'high', 'medium', 'low')),
  source_as_of    DATE,                      -- the source's own date (roll year, layer edit date)
  retrieved_at    TIMESTAMPTZ NOT NULL,      -- when we fetched what this came from
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rule_version    TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, field, source_id, source_ref, value_hash)
);
CREATE INDEX field_observations_entity ON field_observations (entity_type, entity_id, field);

CREATE TABLE field_conflicts (
  entity_type     TEXT NOT NULL,
  entity_id       BIGINT NOT NULL,
  field           TEXT NOT NULL,
  observation_ids BIGINT[] NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('disagree', 'stale', 'implausible')),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'auto_resolved', 'reviewed')),
  resolution      TEXT,                      -- which observation won and why
  rule_version    TEXT NOT NULL,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, field)
);
CREATE INDEX field_conflicts_status ON field_conflicts (status, field);
