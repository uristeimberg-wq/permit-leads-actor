-- Permit locations (ADR-14 step 2, ADR-15 item 4). One point per permit, with
-- how it was found: the source's own coordinates, the appraiser parcel the
-- permit is joined to, or the US Census batch geocoder on the job-site
-- address. Contractor business addresses are never geocoded.

INSERT INTO jurisdictions (slug, name, kind, state, timezone) VALUES
  ('united-states', 'United States (federal)', 'other', 'US', 'America/New_York')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled, role,
                     terms_reviewed_on, terms_reviewed_by, automated_access, redistribution, attribution_text)
SELECT 'us-census-geocoder', j.id, 'other', 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch',
       'snapshot', '15 17 * * *', interval '1 day', true, 'enrichment',
       -- Documentation and API PDF read 2026-11-13: no terms of service there.
       -- The Census Data API notice is shown anyway (docs/COMPLIANCE.md 1.13).
       DATE '2026-11-13', 'claude (not legal advice)', 'unknown', 'unknown',
       'This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.'
  FROM jurisdictions j WHERE j.slug = 'united-states'
ON CONFLICT (slug) DO NOTHING;

-- One answer per job-site address, so an address is asked once. A miss is
-- kept too (matched = false) and asked again only after ingest/geocode.js's
-- retry window.
CREATE TABLE geocode_cache (
  address_key      TEXT PRIMARY KEY,          -- src/enrichment/geocode.js addressKey()
  matched          BOOLEAN NOT NULL,
  quality          TEXT NOT NULL,             -- exact | non_exact | tie | no_match | bad_point
  lat              DOUBLE PRECISION,
  lng              DOUBLE PRECISION,
  matched_address  TEXT,                      -- the Census's own reading of the address
  benchmark        TEXT NOT NULL,
  geocoded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_run_id      BIGINT NOT NULL REFERENCES sync_runs(id),
  CHECK (NOT matched OR (lat IS NOT NULL AND lng IS NOT NULL))
);

CREATE TABLE permit_locations (
  permit_id        BIGINT PRIMARY KEY REFERENCES permits(id) ON DELETE CASCADE,
  lat              DOUBLE PRECISION NOT NULL,
  lng              DOUBLE PRECISION NOT NULL,
  method           TEXT NOT NULL CHECK (method IN ('source', 'parcel', 'census')),
  quality          TEXT,                      -- census: exact | non_exact; otherwise null
  raw_record_id    BIGINT REFERENCES raw_records(id) ON DELETE SET NULL, -- method 'source'
  parcel_id        BIGINT REFERENCES parcels(id) ON DELETE SET NULL,     -- method 'parcel'
  address_key      TEXT REFERENCES geocode_cache(address_key) ON DELETE SET NULL, -- method 'census'
  located_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_run_id      BIGINT NOT NULL REFERENCES sync_runs(id)
);
CREATE INDEX permit_locations_method ON permit_locations (method);
