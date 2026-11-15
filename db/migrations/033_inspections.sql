-- 033: building inspections and their results (docs/DATA_MODEL.md
-- "Inspections"; src/inspections.js). Found 2026-11-15 by
-- recon/lifecycle_scan.js: Miami-Dade and Raleigh publish open inspection
-- layers that hold a rolling window only (about a week; two days), so the
-- daily read is the record and the result history is ours. Additive only:
-- nothing existing reads these tables, and nothing displays them yet.
--
-- 1. sources.role gains 'inspections', so the permit-only steps that filter
--    on role = 'permits' leave these sources alone.
-- 2. inspections: one row per (source, inspection key), upserted daily, with
--    the result wording as published and its class from the source's own
--    vocabulary (unknown wording = 'unknown', reported by ingest/inspections.js).
-- 3. inspection_result_history: a row whenever the result wording or the
--    completed flag changes (trigger), the transition log the sources do not
--    keep.
-- 4. permit_id: the permit the source's own permit number names, set by
--    ingest/inspections.js (an official reference; NULL when we do not hold
--    that permit).

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_role_check;
ALTER TABLE sources ADD CONSTRAINT sources_role_check CHECK (role IN ('permits', 'enrichment', 'planning', 'inspections'));

CREATE TABLE inspections (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_area           TEXT NOT NULL,             -- sources.slug
  inspection_key        TEXT NOT NULL,             -- the source's inspection id, or its key columns joined by ' | '
  permit_number         TEXT NOT NULL,             -- as published; the official link to the permit
  permit_id             BIGINT REFERENCES permits(id) ON DELETE SET NULL,
  permit_type_raw       TEXT,
  inspection_type_raw   TEXT,
  result_raw            TEXT,
  result_class          TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (result_class IN ('approved', 'partial', 'rejected', 'not_ready', 'not_inspected', 'cancelled', 'scheduled', 'other', 'unknown')),
  completed             BOOLEAN,                   -- only where the source publishes it (Raleigh)
  scheduled_on          DATE,                      -- the source's inspection or request date
  address_raw           TEXT,
  content_hash          TEXT NOT NULL,
  latest_raw_record_id  BIGINT REFERENCES raw_records(id) ON DELETE SET NULL,
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_area, inspection_key)
);
CREATE INDEX inspections_permit ON inspections (permit_id) WHERE permit_id IS NOT NULL;
CREATE INDEX inspections_number ON inspections (source_area, permit_number);
CREATE INDEX inspections_scheduled ON inspections (source_area, scheduled_on DESC);

CREATE TABLE inspection_result_history (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inspection_id  BIGINT NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  result_raw     TEXT,
  result_class   TEXT NOT NULL,
  completed      BOOLEAN,
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inspection_result_history_inspection ON inspection_result_history (inspection_id, observed_at);

-- Written by the database, so no code path can upsert an inspection and
-- forget its history.
CREATE FUNCTION inspections_record_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR OLD.result_raw IS DISTINCT FROM NEW.result_raw
     OR OLD.completed IS DISTINCT FROM NEW.completed THEN
    INSERT INTO inspection_result_history (inspection_id, result_raw, result_class, completed)
    VALUES (NEW.id, NEW.result_raw, NEW.result_class, NEW.completed);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER inspections_result AFTER INSERT OR UPDATE ON inspections
  FOR EACH ROW EXECUTE FUNCTION inspections_record_result();

-- The two inspection sources (src/sources.js, kind 'inspections'), read live
-- 2026-11-15. Enabled: they join the daily sync. Neither states a licence
-- (Miami-Dade: county disclaimer, no licence granted; Raleigh: item has no
-- licence text), so redistribution is unknown and nothing is displayed.
INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled, role,
                     terms_url, terms_reviewed_on, terms_reviewed_by, automated_access, redistribution, attribution_text)
SELECT s.slug, j.id, 'arcgis', s.endpoint_url, 'snapshot', '15 17 * * *', interval '1 day', true, 'inspections',
       s.terms_url, DATE '2026-11-15', 'claude (not legal advice)', 'unknown', 'unknown', s.attribution_text
  FROM (VALUES
    ('miami-dade-inspections-fl', 'miami-dade-county-fl',
     'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/inspectionsData/FeatureServer/0',
     'https://www.miamidade.gov/global/disclaimer/disclaimer.page', 'Miami-Dade County Open Data (Inspections Data)'),
    ('raleigh-inspections-nc', 'raleigh-nc',
     'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Inspection_Schedule_Public/FeatureServer/1',
     'https://www.arcgis.com/home/item.html?id=fdffab26766e43af8df194b86ed6da97', 'City of Raleigh Open Data (Inspection Schedule)')
  ) AS s(slug, jslug, endpoint_url, terms_url, attribution_text)
  JOIN jurisdictions j ON j.slug = s.jslug
ON CONFLICT (slug) DO NOTHING;
