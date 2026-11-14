-- 025: planning cases (pre-application signals; docs/DATA_MODEL.md "Planning
-- cases", DATA_ENGINE_PLAN gap plan lane B). Site plans, subdivisions,
-- development plans and utility allocations have a different shape from
-- permits, so they get their own table and are linked to permits, never
-- merged into them. Additive only: nothing existing reads these tables.
--
-- 1. sources.role gains 'planning', so the permit-only steps (geocode,
--    scorecard) that filter on role = 'permits' leave these sources alone.
-- 2. planning_cases: one row per (source, case number), upserted daily.
-- 3. planning_case_status_history: a row whenever the status wording, the
--    stage or the source's status date changes. This is the daily status
--    record: the sources publish current status only.
-- 4. planning_case_parties: participants as published (developer, applicant,
--    owner organisation). Every name is stored; party_kind decides display
--    (rule 5: an individual-looking name is never shown or exported).
-- 5. planning_case_links: a case to the permits it led to, with the basis
--    and confidence of the link (official reference, or parcel and time).

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_role_check;
ALTER TABLE sources ADD CONSTRAINT sources_role_check CHECK (role IN ('permits', 'enrichment', 'planning'));

CREATE TABLE planning_cases (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_area           TEXT NOT NULL,             -- sources.slug, as permits.source_area
  case_number           TEXT NOT NULL,             -- the source's own stable key (Austin folderrsn, Raleigh plan number)
  case_ref              TEXT,                      -- the human case number where the key is internal (SP-2026-0123C)
  case_type_raw         TEXT,                      -- as published
  case_kind             TEXT NOT NULL CHECK (case_kind IN ('site_plan', 'subdivision', 'development_plan', 'zoning', 'variance', 'utility_allocation', 'other')),
  status_raw            TEXT,
  lifecycle_stage       TEXT NOT NULL DEFAULT 'unknown', -- src/lifecycle.js STAGES
  first_seen_stage      TEXT,                      -- stage when we first saw it
  filed_on              DATE,                      -- official, from the source
  stage_since           DATE,                      -- the source's date for the current status
  decided_on            DATE,                      -- approval or certification date, when published
  expires_on            DATE,
  name                  TEXT,                      -- plan or project name
  description           TEXT,
  address_raw           TEXT,
  parcel_id             TEXT,                      -- the source's parcel key (TCAD id, folio, PIN)
  property_ref          TEXT,                      -- the source's own property record (Austin propertyrsn)
  official_ref          TEXT,                      -- the source's key into permits, where it has one
  zoning                TEXT,
  units_proposed        INTEGER,                   -- only when the source states it
  units_approved        INTEGER,
  lots_proposed         INTEGER,
  lots_approved         INTEGER,
  floor_area_sqft       INTEGER,
  acreage               NUMERIC(12, 3),
  flow_gpd              INTEGER,                   -- sewer/water allocation, gallons per day
  lat                   DOUBLE PRECISION,
  lng                   DOUBLE PRECISION,
  record_url            TEXT,
  content_hash          TEXT NOT NULL,             -- of the mapped case; a change writes history
  latest_raw_record_id  BIGINT REFERENCES raw_records(id) ON DELETE SET NULL,
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_area, case_number)
);
CREATE INDEX planning_cases_stage ON planning_cases (source_area, lifecycle_stage);
CREATE INDEX planning_cases_filed ON planning_cases (source_area, filed_on DESC);
CREATE INDEX planning_cases_parcel ON planning_cases (parcel_id) WHERE parcel_id IS NOT NULL;
CREATE INDEX planning_cases_ref ON planning_cases (official_ref) WHERE official_ref IS NOT NULL;
CREATE INDEX planning_cases_property ON planning_cases (property_ref) WHERE property_ref IS NOT NULL;

CREATE TABLE planning_case_status_history (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id          BIGINT NOT NULL REFERENCES planning_cases(id) ON DELETE CASCADE,
  status_raw       TEXT,
  lifecycle_stage  TEXT NOT NULL,
  stage_since      DATE,
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX planning_case_status_history_case ON planning_case_status_history (case_id, observed_at);

-- Written by the database, so no code path can upsert a case and forget it.
CREATE FUNCTION planning_cases_record_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR OLD.status_raw IS DISTINCT FROM NEW.status_raw
     OR OLD.stage_since IS DISTINCT FROM NEW.stage_since THEN
    INSERT INTO planning_case_status_history (case_id, status_raw, lifecycle_stage, stage_since)
    VALUES (NEW.id, NEW.status_raw, NEW.lifecycle_stage, NEW.stage_since);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER planning_cases_status AFTER INSERT OR UPDATE ON planning_cases
  FOR EACH ROW EXECUTE FUNCTION planning_cases_record_status();

CREATE TABLE planning_case_parties (
  case_id     BIGINT NOT NULL REFERENCES planning_cases(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,                       -- 'developer' | 'applicant' | 'owner' | 'agent'
  name        TEXT NOT NULL,                       -- as published
  party_kind  TEXT NOT NULL CHECK (party_kind IN ('business', 'individual', 'unknown')),
  PRIMARY KEY (case_id, role, name)
);

CREATE TABLE planning_case_links (
  case_id       BIGINT NOT NULL REFERENCES planning_cases(id) ON DELETE CASCADE,
  permit_id     BIGINT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  link_basis    TEXT NOT NULL CHECK (link_basis IN ('official_reference', 'parcel_window', 'address_window')),
  basis_detail  TEXT NOT NULL,                     -- e.g. 'Building_Permits.devplanid = plan id'
  confidence    NUMERIC(3, 2) NOT NULL,
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, permit_id)
);
CREATE INDEX planning_case_links_permit ON planning_case_links (permit_id);

-- The four planning sources (src/sources.js, kind 'planning'), read live
-- 2026-11-14 (recon/planning_probe.js). Enabled: they join the daily sync.
-- Austin: Public Domain (dataset licence). Raleigh: Open Raleigh Data Policy,
-- under which the City may require us to stop (switch off = enabled false).
INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled, role,
                     terms_url, terms_reviewed_on, terms_reviewed_by, automated_access, redistribution, attribution_text)
SELECT s.slug, j.id, s.kind, s.endpoint_url, 'date_window', '15 17 * * *', interval '1 day', true, 'planning',
       s.terms_url, DATE '2026-11-14', 'claude (not legal advice)', 'unknown', s.redistribution, s.attribution_text
  FROM (VALUES
    ('austin-site-plans-tx', 'austin-tx', 'socrata', 'https://datahub.austintexas.gov/resource/mavg-96ck.json',
     'https://data.austintexas.gov/stories/s/City-of-Austin-Open-Data-Terms-of-Use/ranj-cccq/', 'yes',
     'City of Austin Open Data (Site Plan Cases), public domain'),
    ('austin-subdivisions-tx', 'austin-tx', 'socrata', 'https://datahub.austintexas.gov/resource/s7gx-9m54.json',
     'https://data.austintexas.gov/stories/s/City-of-Austin-Open-Data-Terms-of-Use/ranj-cccq/', 'yes',
     'City of Austin Open Data (Subdivision Cases), public domain'),
    ('raleigh-plan-areas-nc', 'raleigh-nc', 'arcgis',
     'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Development_Plan_Areas/FeatureServer/0',
     NULL, 'unknown', 'City of Raleigh Open Data (Development Plan Areas)'),
    ('raleigh-devplans-nc', 'raleigh-nc', 'arcgis',
     'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Development_Plans/FeatureServer/0',
     'https://www.arcgis.com/home/item.html?id=0cded58c5048437d8da83608818650ba', 'unknown',
     'City of Raleigh Open Data (Development Plans)'),
    ('miami-derm-sewer-fl', 'miami-dade-county-fl', 'arcgis',
     'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/DERMSewerAllocation_gdb/FeatureServer/0',
     'https://www.miamidade.gov/global/disclaimer/disclaimer.page', 'unknown',
     'Miami-Dade County Open Data (DERM Sewer Allocation)')
  ) AS s(slug, jslug, kind, endpoint_url, terms_url, redistribution, attribution_text)
  JOIN jurisdictions j ON j.slug = s.jslug
ON CONFLICT (slug) DO NOTHING;
