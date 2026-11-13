-- Property enrichment (ADR-14 step 3). Parcel facts from an official
-- appraiser, keyed by its own parcel id, linked to permits through the parcel
-- id the permit source publishes. Every row keeps what was fetched (owner
-- fields are never requested) and when, so each displayed value has a source.

-- Sources now include enrichment providers as well as permit feeds. Both are
-- recorded in sync_runs and watched by source_health.
ALTER TABLE sources ADD COLUMN role TEXT NOT NULL DEFAULT 'permits' CHECK (role IN ('permits', 'enrichment'));

INSERT INTO jurisdictions (slug, name, kind, state, timezone) VALUES
  ('miami-dade-county-fl', 'Miami-Dade County', 'county', 'FL', 'America/New_York')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled, role,
                     terms_reviewed_on, terms_reviewed_by, automated_access, redistribution, attribution_text)
SELECT 'miami-dade-pa', j.id, 'arcgis',
       'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/PaGISView_gdb/FeatureServer/0',
       'snapshot', '15 17 * * *', interval '1 day', true, 'enrichment',
       -- The layer's licence note was read 2026-11-13: "as is", approximate,
       -- for illustration only. The open-data hub terms are unread.
       DATE '2026-11-13', 'claude (not legal advice)', 'unknown', 'unknown',
       'Miami-Dade County Property Appraiser (public GIS layer); approximate, for illustration only'
  FROM jurisdictions j WHERE j.slug = 'miami-dade-county-fl'
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE parcels (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider          TEXT NOT NULL,             -- src/enrichment/parcels.js PROVIDERS key
  parcel_key        TEXT NOT NULL,             -- the provider's id (Miami-Dade: 13-digit folio)
  found             BOOLEAN NOT NULL,          -- false: we asked and the provider has no such parcel
  land_use_code     TEXT,
  land_use          TEXT,
  year_built        INTEGER,
  heated_sqft       NUMERIC,
  building_sqft     NUMERIC,
  lot_sqft          NUMERIC,
  bedrooms          NUMERIC,
  bathrooms         NUMERIC,
  units             NUMERIC,
  floors            NUMERIC,
  assessed_value    NUMERIC,
  assessment_year   INTEGER,
  site_city         TEXT,
  site_zip          TEXT,
  lat               DOUBLE PRECISION,
  lng               DOUBLE PRECISION,
  payload           JSONB NOT NULL,            -- the attributes as fetched, owners excluded
  source_edited_at  TIMESTAMPTZ,               -- the layer's lastEditDate when fetched
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_run_id       BIGINT NOT NULL REFERENCES sync_runs(id),
  UNIQUE (provider, parcel_key)
);
CREATE INDEX parcels_fetched ON parcels (provider, fetched_at);

-- Which parcel a permit is on, by provider. Rebuilt by ingest/enrich_parcels.js.
CREATE TABLE permit_parcels (
  permit_id   BIGINT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  parcel_id   BIGINT NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
  match_rule  TEXT NOT NULL,                   -- e.g. 'folio' (the source's own parcel id)
  raw_record_id BIGINT REFERENCES raw_records(id) ON DELETE SET NULL,
  PRIMARY KEY (permit_id, provider)
);
CREATE INDEX permit_parcels_parcel ON permit_parcels (parcel_id);
