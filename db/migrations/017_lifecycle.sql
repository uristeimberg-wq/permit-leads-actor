-- Lifecycle model, first slice (ADR-16; docs/DATA_MODEL.md "Lifecycle model",
-- migration order steps 1 and part of 5). Additive only.
--
-- 1. Each filing carries its canonical stage, the official submission date
--    and the source's date for the current status, kept apart from our own
--    first_seen_at. first_seen_stage is the stage when we first saw it: the
--    early-discovery fact. It is written on insert only, so rows that existed
--    before this migration keep NULL ("not recorded"), never a guess.
-- 2. The status history (trigger, 004) also records the stage and the
--    source's status date.
-- 3. permit_links: one filing leads to another (an Austin plan-review case to
--    its building permit), with the basis of the link.
-- 4. The Austin plan-review source (n8ck-xkda): building applications before
--    approval.

ALTER TABLE permits
  ADD COLUMN filing_kind      TEXT,                              -- 'building_application' | NULL (a permit)
  ADD COLUMN lifecycle_stage  TEXT NOT NULL DEFAULT 'unknown',   -- src/lifecycle.js STAGES
  ADD COLUMN submitted_on     DATE,                              -- official, from the source; NULL if not published
  ADD COLUMN stage_since      DATE,                              -- the source's date for the current status
  ADD COLUMN first_seen_stage TEXT;                              -- stage at first_seen_at; NULL before 017
CREATE INDEX permits_lifecycle ON permits (source_area, lifecycle_stage);

ALTER TABLE permit_status_history
  ADD COLUMN lifecycle_stage TEXT,
  ADD COLUMN stage_since     DATE;

-- Same function as 004, plus the lifecycle columns. A history row is still
-- written only when the wording changes: a stage that changes because the
-- vocabulary was fixed is not a permit change, so ingest/lifecycle.js updates
-- it in place (permits and history alike) and writes no new row.
CREATE OR REPLACE FUNCTION permits_record_version() RETURNS trigger LANGUAGE plpgsql AS $$
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
    INSERT INTO permit_status_history (permit_id, status_raw, status_stage, lifecycle_stage, stage_since)
    VALUES (NEW.id, NEW.status_raw, NEW.status_stage, NEW.lifecycle_stage, NEW.stage_since);
  END IF;
  RETURN NULL;
END $$;

CREATE TABLE permit_links (
  from_permit_id  BIGINT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,  -- the earlier filing (application)
  to_permit_id    BIGINT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,  -- the later one (issued permit)
  link_basis      TEXT NOT NULL CHECK (link_basis IN ('same_record', 'official_reference', 'parcel_window', 'address_window')),
  basis_detail    TEXT NOT NULL,            -- e.g. 'masterpermitnum = folderrsn'
  confidence      NUMERIC(3,2) NOT NULL,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_permit_id, to_permit_id)
);
CREATE INDEX permit_links_to ON permit_links (to_permit_id);

-- Austin Plan Review Cases. Public Domain (dataset metadata, read 2026-11-13
-- by the fixture capture). Same publisher and portal terms as austin-tx.
INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled,
                     terms_url, terms_reviewed_on, terms_reviewed_by, automated_access, redistribution, attribution_text)
SELECT 'austin-plan-review-tx', j.id, 'socrata', 'https://datahub.austintexas.gov/resource/n8ck-xkda.json', 'date_window',
       '15 17 * * *', interval '1 day', true,
       'https://data.austintexas.gov/stories/s/City-of-Austin-Open-Data-Terms-of-Use/ranj-cccq/', DATE '2026-11-13',
       'claude (not legal advice)', 'unknown', 'yes', 'City of Austin Open Data (Plan Review Cases), public domain'
  FROM jurisdictions j WHERE j.slug = 'austin-tx'
ON CONFLICT (slug) DO NOTHING;
