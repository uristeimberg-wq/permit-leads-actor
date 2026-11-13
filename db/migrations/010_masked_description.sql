-- 010: free-text search runs on the masked description (docs/COMPLIANCE.md 2.5).
-- Names inside a description are masked for display by src/description_names.js.
-- Searching the raw text would still let someone find a homeowner's permit by
-- typing their name, so search_tsv is rebuilt over work_description_public,
-- which holds the masked copy. It is written at ingest and refreshed by the
-- resolver (db/index.js maskStoredDescriptions). Until a row is refreshed its
-- description is simply not searchable; type and address still are.
-- Never edit this file after merge; add 011_*.sql instead.

ALTER TABLE permits ADD COLUMN work_description_public TEXT;

DROP INDEX IF EXISTS permits_search_idx;
ALTER TABLE permits DROP COLUMN search_tsv;
ALTER TABLE permits
  ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(work_description_public, '') || ' ' ||
      coalesce(permit_type, '')             || ' ' ||
      coalesce(address, ''))
  ) STORED;
CREATE INDEX permits_search_idx ON permits USING GIN (search_tsv);
