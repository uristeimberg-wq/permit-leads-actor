-- 005: job links on permit_parties, so the pilot screens can ask "which trade
-- permits belong to this building job" in SQL, filtered by date and ZIP.
-- contractor_relationships stays as the all-time rollup; these columns are the
-- per-permit detail behind it. Written by ingest/resolve.js (ADR-12).
-- Never edit this file after merge; add 006_*.sql instead.

ALTER TABLE permit_parties ADD COLUMN job_key     TEXT;     -- Austin permit-number base, Miami-Dade master permit
ALTER TABLE permit_parties ADD COLUMN is_building BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE permit_parties ADD COLUMN trade       TEXT CHECK (trade IN ('electrical','mechanical','plumbing'));
ALTER TABLE permit_parties ADD COLUMN issued_on   DATE;

CREATE INDEX permit_parties_job ON permit_parties (job_key);
CREATE INDEX permit_parties_gc_jobs ON permit_parties (contractor_id, issued_on) WHERE is_building;
