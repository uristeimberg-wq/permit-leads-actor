-- Permit search platform schema.
--
-- One row per permit per source. Ingest is incremental and re-runs overlap, so
-- everything is written as an upsert keyed on (source_area, permit_number) —
-- the only identifier a portal guarantees to be stable.

CREATE TABLE IF NOT EXISTS permits (
  id               BIGSERIAL PRIMARY KEY,

  -- Natural key. permit_number is unique only within a source, so both are needed.
  source_area      TEXT NOT NULL,
  permit_number    TEXT NOT NULL,

  -- Issuing agency. Statewide feeds span many counties (e.g. 'YAMHILL_CO'),
  -- which is what makes a county picker possible.
  jurisdiction     TEXT,

  -- Raw address kept for display; the parsed parts are what queries filter on.
  address          TEXT,
  street           TEXT,
  city             TEXT,
  state            TEXT,
  zip              TEXT,

  permit_type      TEXT,
  work_description TEXT NOT NULL DEFAULT '',
  valuation        NUMERIC(14,2) NOT NULL DEFAULT 0,

  -- Three status columns, each with a distinct job. status_stage exists because
  -- collapsing everything into applied/issued made a FINISHED job
  -- indistinguishable from one approved yesterday — opposite things when you're
  -- looking for work that hasn't happened yet.
  status           TEXT,  -- applied/issued; what scoring's TIMING_BONUS reads
  status_raw       TEXT,  -- the portal's exact wording, shown as-is
  status_stage     TEXT,  -- pending | approved | finished | cancelled | unknown

  permit_url       TEXT,
  filed_date       DATE,

  -- Detail-page fields, so a permit can be read in full without leaving for
  -- the county portal.
  owner                   TEXT,
  parcel_number           TEXT,
  parcel_block            TEXT,
  parcel_lot              TEXT,
  parcel_subdivision      TEXT,
  construction_type       TEXT,
  other_construction_type TEXT,

  -- All six trade scores precomputed at ingest. Trade is an optional filter, so
  -- scoring at query time would make filtering across the table impossible.
  trade_scores     JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- first_seen_at is when WE first saw it, which is what "new since your last
  -- visit" and future alerting key off; filed_date is what the portal reports.
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT permits_source_number_key UNIQUE (source_area, permit_number)
);

-- Added after the table already existed in deployed databases; these keep an
-- existing install migrating forward rather than needing a rebuild.
ALTER TABLE permits ADD COLUMN IF NOT EXISTS status_raw              TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS status_stage            TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS owner                   TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS parcel_number           TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS parcel_block            TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS parcel_lot              TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS parcel_subdivision      TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS construction_type       TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS other_construction_type TEXT;
-- Fees and inspections come from lazily-loaded tabs, so they are only present
-- for sources with fetchTabs enabled. NULL means "not collected", which is
-- different from an empty list meaning "collected, and there are none".
ALTER TABLE permits ADD COLUMN IF NOT EXISTS fees          JSONB;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS fees_paid     NUMERIC(14,2);
ALTER TABLE permits ADD COLUMN IF NOT EXISTS fees_balance  NUMERIC(14,2);
ALTER TABLE permits ADD COLUMN IF NOT EXISTS inspections   JSONB;
-- Contractor contact. Availability differs sharply by market: Austin's open
-- data publishes the phone outright, Miami-Dade a name and licence number but
-- no phone, and the Oregon portals publish neither. Phones are stored as bare
-- digits so they compare and de-duplicate reliably.
ALTER TABLE permits ADD COLUMN IF NOT EXISTS contractor_name    TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS contractor_phone   TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS contractor_licence TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS contractor_trade   TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS contractor_city    TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS applicant_name     TEXT;
ALTER TABLE permits ADD COLUMN IF NOT EXISTS applicant_phone    TEXT;

CREATE INDEX IF NOT EXISTS permits_contractor_idx ON permits (contractor_name);

-- The primary access path: "recent permits in this ZIP".
CREATE INDEX IF NOT EXISTS permits_zip_filed_idx     ON permits (zip, filed_date DESC);
CREATE INDEX IF NOT EXISTS permits_state_city_idx    ON permits (state, city);
CREATE INDEX IF NOT EXISTS permits_jurisdiction_idx  ON permits (jurisdiction);
CREATE INDEX IF NOT EXISTS permits_filed_idx         ON permits (filed_date DESC);
-- Stage is on nearly every query, since finished work is excluded by default.
CREATE INDEX IF NOT EXISTS permits_stage_filed_idx   ON permits (status_stage, filed_date DESC);
CREATE INDEX IF NOT EXISTS permits_trade_scores_idx  ON permits USING GIN (trade_scores);

-- Free-text search over the fields a user would actually type into a search box.
ALTER TABLE permits
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(work_description, '') || ' ' ||
      coalesce(permit_type, '')      || ' ' ||
      coalesce(address, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS permits_search_idx ON permits USING GIN (search_tsv);

-- Ingest bookkeeping. "Latest permits" is a claim about recency, so the UI has
-- to be able to say when the data was last refreshed — and say so honestly when
-- a run failed.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id            BIGSERIAL PRIMARY KEY,
  source_area   TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  permits_seen  INTEGER NOT NULL DEFAULT 0,
  permits_new   INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS ingest_runs_area_idx ON ingest_runs (source_area, started_at DESC);
