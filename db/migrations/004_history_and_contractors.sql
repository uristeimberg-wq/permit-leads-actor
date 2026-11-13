-- 004: permit history, valuation as NULL-when-missing, and contractor
-- resolution (docs/DATA_MODEL.md "Permits" and "Contractors and contacts";
-- ROADMAP M2). Never edit this file after merge; add 005_*.sql instead.

-- ---------------------------------------------------------------------------
-- 1. Valuation: missing is NULL, not 0 (CLAUDE.md rule 1).
-- The prototype stored 0 for "not reported". No source reports a real $0
-- permit value, so existing zeros are the missing marker and become NULL.
ALTER TABLE permits ALTER COLUMN valuation DROP NOT NULL;
ALTER TABLE permits ALTER COLUMN valuation DROP DEFAULT;
UPDATE permits SET valuation = NULL WHERE valuation = 0;

-- ---------------------------------------------------------------------------
-- 2. Permit history. A trigger keeps it, so every write path (ingest, backfill,
-- a manual fix) is versioned the same way and none can forget to.
ALTER TABLE permits ADD COLUMN content_hash TEXT;
ALTER TABLE permits ADD COLUMN last_changed_at TIMESTAMPTZ;

CREATE TABLE permit_versions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  permit_id     BIGINT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  content_hash  TEXT NOT NULL,
  mapped        JSONB NOT NULL,     -- the tracked fields as they were
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (permit_id, content_hash)
);

CREATE TABLE permit_status_history (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  permit_id     BIGINT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  status_raw    TEXT,
  status_stage  TEXT,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX permit_status_history_permit ON permit_status_history (permit_id, observed_at);

-- The fields whose change is a real change to the permit. last_seen_at and
-- trade_scores are deliberately not tracked: they move without the permit
-- changing. Owner and applicant fields are not copied into history either.
CREATE FUNCTION permit_tracked(p permits) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'status_raw', p.status_raw, 'status_stage', p.status_stage,
    'filed_date', p.filed_date, 'valuation', p.valuation,
    'work_description', p.work_description, 'permit_type', p.permit_type,
    'address', p.address, 'city', p.city, 'zip', p.zip,
    'contractor_name', p.contractor_name, 'contractor_phone', p.contractor_phone,
    'contractor_licence', p.contractor_licence, 'contractor_trade', p.contractor_trade)
$$;

CREATE FUNCTION permits_track_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tracked JSONB := permit_tracked(NEW);
  h TEXT := md5(tracked::text);
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.content_hash IS NOT DISTINCT FROM h THEN
    RETURN NEW;
  END IF;
  NEW.content_hash := h;
  NEW.last_changed_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION permits_record_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.content_hash IS NOT DISTINCT FROM NEW.content_hash THEN
    RETURN NULL;
  END IF;
  INSERT INTO permit_versions (permit_id, content_hash, mapped)
  VALUES (NEW.id, NEW.content_hash, permit_tracked(NEW))
  ON CONFLICT (permit_id, content_hash) DO NOTHING;
  IF TG_OP = 'INSERT'
     OR OLD.status_raw IS DISTINCT FROM NEW.status_raw
     OR OLD.status_stage IS DISTINCT FROM NEW.status_stage THEN
    INSERT INTO permit_status_history (permit_id, status_raw, status_stage)
    VALUES (NEW.id, NEW.status_raw, NEW.status_stage);
  END IF;
  RETURN NULL;
END $$;


-- Baseline for rows that exist already: their current state is version 1.
-- Done before the triggers exist, so it is written once, dated when we last
-- saw the row.
UPDATE permits SET content_hash = md5(permit_tracked(permits)::text), last_changed_at = last_seen_at
 WHERE content_hash IS NULL;
INSERT INTO permit_versions (permit_id, content_hash, mapped, observed_at)
SELECT id, content_hash, permit_tracked(permits), last_seen_at FROM permits
ON CONFLICT DO NOTHING;
INSERT INTO permit_status_history (permit_id, status_raw, status_stage, observed_at)
SELECT id, status_raw, status_stage, last_seen_at FROM permits;

-- From here on, every insert or real change is versioned.
CREATE TRIGGER permits_track_change BEFORE INSERT OR UPDATE ON permits
  FOR EACH ROW EXECUTE FUNCTION permits_track_change();
CREATE TRIGGER permits_record_version AFTER INSERT OR UPDATE ON permits
  FOR EACH ROW EXECUTE FUNCTION permits_record_version();

-- ---------------------------------------------------------------------------
-- 3. Contractors. Built by ingest/resolve.js from the latest raw record of
-- each permit; rules and confidence in src/contractors.js and ADR-12.
CREATE TABLE contractors (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  identity_key      TEXT NOT NULL UNIQUE,   -- 'lic:FL:CGC1234' or 'name:TX:acme builders'
  display_name      TEXT NOT NULL,
  normalized_name   TEXT NOT NULL,
  party_kind        TEXT NOT NULL CHECK (party_kind IN ('business','individual','unknown')),
  primary_trade     TEXT,
  business_city     TEXT,
  business_state    CHAR(2),
  first_permit_on   DATE,
  last_permit_on    DATE,
  permit_count      INTEGER NOT NULL DEFAULT 0,
  resolver_version  TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX contractors_normalized_name ON contractors (normalized_name);

CREATE TABLE contractor_aliases (
  contractor_id   BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  raw_name        TEXT NOT NULL,
  source_id       BIGINT NOT NULL REFERENCES sources(id),
  seen_count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (contractor_id, raw_name, source_id)
);

CREATE TABLE contractor_licenses (
  contractor_id   BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  licence_state   CHAR(2) NOT NULL,
  licence_number  TEXT NOT NULL,
  source          TEXT NOT NULL,          -- 'permit:miami-dade-fl' until licence files are loaded
  PRIMARY KEY (licence_state, licence_number)
);

CREATE TABLE contact_points (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contractor_id    BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('phone','email','website','address')),
  value            TEXT NOT NULL,          -- E.164 for phones
  party_kind       TEXT NOT NULL CHECK (party_kind IN ('business','individual','unknown')),
  -- Rule 5: only 'show' reaches a client. Individual-looking contacts are
  -- 'hide'; unclear ones are 'review' (hidden until a person approves them).
  display_policy   TEXT NOT NULL CHECK (display_policy IN ('show','hide','review')),
  source           TEXT NOT NULL,          -- 'permit:austin-tx'
  source_ref       TEXT,                   -- the most recent permit number it came from
  verification     TEXT NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified','corroborated','verified')),
  seen_on_permits  INTEGER NOT NULL DEFAULT 1,
  shared_with_other_contractors INTEGER NOT NULL DEFAULT 0,
  last_seen_on     DATE,
  UNIQUE (contractor_id, kind, value)
);

CREATE TABLE permit_parties (
  permit_id        BIGINT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('contractor')),  -- owner/applicant stay off (ADR-10)
  contractor_id    BIGINT REFERENCES contractors(id) ON DELETE SET NULL,
  raw_name         TEXT,
  raw_trade        TEXT,
  match_rule       TEXT NOT NULL CHECK (match_rule IN ('licence','name_state','owner_builder','unresolved')),
  match_confidence NUMERIC(3,2),
  raw_record_id    BIGINT REFERENCES raw_records(id),
  PRIMARY KEY (permit_id, role)
);
CREATE INDEX permit_parties_contractor ON permit_parties (contractor_id);

-- GC -> sub relationships: a building permit's contractor (the GC) and the
-- contractors on its trade permits (same permit-number base in Austin, same
-- master permit in Miami-Dade). Derived; rebuilt by ingest/resolve.js.
CREATE TABLE contractor_relationships (
  gc_id          BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  sub_id         BIGINT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  trade          TEXT NOT NULL CHECK (trade IN ('electrical','mechanical','plumbing')),
  jobs           INTEGER NOT NULL,
  first_job_on   DATE,
  last_job_on    DATE,
  PRIMARY KEY (gc_id, sub_id, trade)
);
CREATE INDEX contractor_relationships_sub ON contractor_relationships (sub_id);

CREATE TABLE resolver_runs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  resolver_version TEXT NOT NULL,
  stats         JSONB,
  error_detail  TEXT
);
