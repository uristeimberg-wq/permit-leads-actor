# Data model

Status: **proposed**, 2026-11-13. This is the target schema. Today's schema
(`db/schema.sql`) is one `permits` table plus `ingest_runs`, and it becomes
migration `001`. Tables arrive in the order of [ROADMAP.md](ROADMAP.md). Types
are PostgreSQL 17, with PostGIS once geometry lands.

Conventions:

- `id BIGINT GENERATED ALWAYS AS IDENTITY` primary keys.
- `created_at` and `updated_at` are `TIMESTAMPTZ`.
- `NULL` means not provided. Never use `''` or `0` as "missing".
- Natural keys are enforced with `UNIQUE` constraints, because that is what
  makes re-runs idempotent.
- Every derived row records the version of the code or rules that produced it.

## Entity overview

```
jurisdictions 1--* sources 1--* sync_runs
                     |
                     1--* raw_records *--1 sync_runs
                     |
                     1--* permits 1--* permit_versions
                            |   1--* permit_status_history
                            |   *--* parties (permit_parties) --> contractors 1--* contractor_licenses
                            |                                                1--* contact_points
                            |                                                1--* contractor_aliases
                            *--* projects (project_permits) 1--* project_trades
                            *--1 properties
projects 1--* leads *--* digest_items *--1 digests *--1 subscriptions *--1 organizations 1--* users
digest_items 1--* feedback ; organizations 1--* outcome_reports
suppressions, data_requests, audit_log, contractor_merges (standalone)
```

## Sources and ingestion

Built in `db/migrations/002_sources_sync_runs_raw_records.sql` (2026-11-13).
Ingest writes `sync_runs` and `raw_records` for Socrata and ArcGIS sources;
`ingest_runs` is still written for the UI until M2.

```sql
CREATE TABLE jurisdictions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,          -- 'austin-tx', 'miami-dade-county-fl'
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('city','county','state','other')),
  state         CHAR(2) NOT NULL,
  timezone      TEXT NOT NULL                  -- 'America/Chicago'
);

CREATE TABLE sources (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug                  TEXT NOT NULL UNIQUE,  -- matches src/sources/<slug>.js
  jurisdiction_id       BIGINT NOT NULL REFERENCES jurisdictions(id),
  kind                  TEXT NOT NULL,         -- socrata | arcgis | csv | accela
  endpoint_url          TEXT NOT NULL,
  sync_mode             TEXT NOT NULL CHECK (sync_mode IN ('updated_at','snapshot','date_window')),
  schedule_cron         TEXT NOT NULL,
  expected_interval     INTERVAL NOT NULL,     -- drives the "stale" alert
  enabled               BOOLEAN NOT NULL DEFAULT false,
  cursor                JSONB,                 -- connector-defined resume point
  field_list_hash       TEXT,                  -- schema-drift detection
  -- compliance (see COMPLIANCE.md)
  terms_url             TEXT,
  terms_reviewed_on     DATE,
  terms_reviewed_by     TEXT,
  automated_access      TEXT NOT NULL DEFAULT 'unknown' CHECK (automated_access IN ('yes','no','unknown')),
  redistribution        TEXT NOT NULL DEFAULT 'unknown' CHECK (redistribution IN ('yes','no','unknown','attribution')),
  attribution_text      TEXT,
  raw_retention_days    INTEGER,               -- NULL = keep
  homeowner_use         TEXT NOT NULL DEFAULT 'blocked' CHECK (homeowner_use IN ('blocked','approved'))  -- ADR-10 gate
);

CREATE TABLE sync_runs (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id        BIGINT NOT NULL REFERENCES sources(id),
  kind             TEXT NOT NULL CHECK (kind IN ('scheduled','manual','backfill')),
  status           TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  cursor_from      JSONB,
  cursor_to        JSONB,
  requests_made    INTEGER NOT NULL DEFAULT 0,
  records_fetched  INTEGER NOT NULL DEFAULT 0,
  records_new      INTEGER NOT NULL DEFAULT 0,   -- new raw hashes
  records_changed  INTEGER NOT NULL DEFAULT 0,
  records_failed   INTEGER NOT NULL DEFAULT 0,
  error_class      TEXT,                          -- transient | rate_limited | auth | schema | bad_data | bug | unknown
  error_detail     TEXT,
  CHECK (status <> 'failed' OR error_class IS NOT NULL)   -- no silent failures
);
CREATE INDEX ON sync_runs (source_id, started_at DESC);

CREATE TABLE raw_records (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id          BIGINT NOT NULL REFERENCES sources(id),
  source_key         TEXT NOT NULL,               -- permit number or source row id
  payload_hash       TEXT NOT NULL,               -- sha256 of canonical JSON
  payload            JSONB NOT NULL,
  source_updated_at  TIMESTAMPTZ,                 -- from the source, if it says
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_run_id        BIGINT NOT NULL REFERENCES sync_runs(id),
  normalized_at      TIMESTAMPTZ,
  normalize_error    TEXT,
  UNIQUE (source_id, source_key, payload_hash)    -- same content twice = no-op
);
CREATE INDEX ON raw_records (normalized_at) WHERE normalized_at IS NULL;
```

## Permits

```sql
CREATE TABLE permits (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id             BIGINT NOT NULL REFERENCES sources(id),
  source_permit_number  TEXT NOT NULL,
  source_url            TEXT,
  jurisdiction_id       BIGINT NOT NULL REFERENCES jurisdictions(id),
  sub_jurisdiction      TEXT,                     -- e.g. municipality within a county feed
  permit_type_raw       TEXT,
  permit_subtype_raw    TEXT,
  work_class_raw        TEXT,
  work_description      TEXT,
  residential_commercial TEXT CHECK (residential_commercial IN ('residential','commercial','mixed')),
  status_raw            TEXT,
  status_stage          TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (status_stage IN ('pending','approved','finished','cancelled','unknown')),
  applied_on            DATE,
  issued_on             DATE,
  expires_on            DATE,
  finaled_on            DATE,
  valuation_usd         NUMERIC(14,2),            -- NULL when not reported; never 0-as-missing
  valuation_source_field TEXT,                    -- which source column it came from
  address_raw           TEXT,
  street                TEXT,
  city                  TEXT,
  state                 CHAR(2),
  zip                   TEXT,
  parcel_id             TEXT,                     -- Austin tcad_id, Miami-Dade FolioNumber
  master_permit_number  TEXT,                     -- Miami-Dade MasterPermitNumber
  location              GEOGRAPHY(Point, 4326),   -- only from source coordinates
  location_precision    TEXT CHECK (location_precision IN ('rooftop','parcel','zip_centroid','city_centroid')),
  owner_builder         BOOLEAN NOT NULL DEFAULT false,
  content_hash          TEXT NOT NULL,            -- hash of mapped fields; versioning trigger
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_changed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  latest_raw_record_id  BIGINT REFERENCES raw_records(id),
  mapper_version        TEXT NOT NULL,
  UNIQUE (source_id, source_permit_number)
);
CREATE INDEX ON permits (jurisdiction_id, issued_on DESC);
CREATE INDEX ON permits (zip, issued_on DESC);
CREATE INDEX ON permits (status_stage, issued_on DESC);
CREATE INDEX ON permits (parcel_id);
CREATE INDEX ON permits (master_permit_number) WHERE master_permit_number IS NOT NULL;
CREATE INDEX ON permits (first_seen_at DESC);
CREATE INDEX ON permits USING GIST (location);
-- plus the existing generated tsvector + GIN index, carried over

CREATE TABLE permit_versions (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  permit_id        BIGINT NOT NULL REFERENCES permits(id),
  content_hash     TEXT NOT NULL,
  mapped           JSONB NOT NULL,                -- the full mapped state
  raw_record_id    BIGINT NOT NULL REFERENCES raw_records(id),
  source_updated_at TIMESTAMPTZ,
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (permit_id, content_hash)
);

CREATE TABLE permit_status_history (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  permit_id     BIGINT NOT NULL REFERENCES permits(id),
  status_raw    TEXT,
  status_stage  TEXT NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_status_date DATE                        -- Austin statusdate, if present
);
```

**What counts as a duplicate, an update or a sibling:**

| Case | Detected by | Handling |
| --- | --- | --- |
| Same record fetched twice | Same `(source_id, source_key, payload_hash)` | Raw insert is a no-op |
| Updated record | Same `(source_id, source_permit_number)`, new `content_hash` | `permits` row updated, a `permit_versions` row added, status history appended if the status changed |
| Same permit in two datasets | Same jurisdiction and permit number across two `sources` | Linked in `permit_links` (added when a second overlapping source exists). Never merged |
| Different permits, same project | Master permit number, or parcel within 180 days | `project_permits`; permits stay separate |
| Same address only | Not a link | Nothing happens |

## Contractors and contacts

Built in `db/migrations/004_history_and_contractors.sql` (2026-11-13), in a
first cut that differs from the target below:
- `contractors.identity_key` holds the merge key.
- `permit_parties` holds only the `contractor` role (owner and applicant stay
  off, ADR-10).
- `contractor_relationships` holds derived GC-to-sub links.
- `resolver_runs` logs each rebuild.
- Migration 005 adds `job_key`, `is_building`, `trade` and `issued_on` to
  `permit_parties`, so a building job and its trade permits can be joined in
  SQL by date and ZIP. The pilot screens (`db/pilot_queries.js`) read these;
  `contractor_relationships` stays as the all-time rollup.

Permit history (`permit_versions`, `permit_status_history`) is kept by
triggers on the existing `permits` table. Missing valuation is `NULL` from 004
on. Rules: ADR-12.

```sql
CREATE TABLE contractors (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_name      TEXT NOT NULL,
  normalized_name   TEXT NOT NULL,
  primary_trade     TEXT,
  business_city     TEXT,
  business_state    CHAR(2),
  website_domain    TEXT,
  first_permit_on   DATE,
  last_permit_on    DATE,
  permit_count      INTEGER NOT NULL DEFAULT 0,
  enriched_at       TIMESTAMPTZ,
  resolver_version  TEXT NOT NULL
);
CREATE INDEX ON contractors (normalized_name);

CREATE TABLE contractor_aliases (
  contractor_id   BIGINT NOT NULL REFERENCES contractors(id),
  raw_name        TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  source_id       BIGINT NOT NULL REFERENCES sources(id),
  seen_count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (contractor_id, raw_name, source_id)
);

CREATE TABLE contractor_licenses (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contractor_id   BIGINT REFERENCES contractors(id),
  licence_state   CHAR(2) NOT NULL,
  licence_number  TEXT NOT NULL,
  licence_type    TEXT,
  status          TEXT,
  expires_on      DATE,
  source          TEXT NOT NULL,                  -- 'TX TDLR 7358-krk7', 'FL DBPR CONSTRUCTIONLICENSE_1.csv', 'permit'
  retrieved_at    TIMESTAMPTZ NOT NULL,
  UNIQUE (licence_state, licence_number)
);

CREATE TABLE contact_points (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contractor_id    BIGINT NOT NULL REFERENCES contractors(id),
  kind             TEXT NOT NULL CHECK (kind IN ('phone','email','website','address')),
  value            TEXT NOT NULL,                 -- E.164 for phones
  party_kind       TEXT NOT NULL DEFAULT 'unknown' CHECK (party_kind IN ('business','individual','unknown')),
  display_policy   TEXT NOT NULL DEFAULT 'review' CHECK (display_policy IN ('show','hide','review')),
  source           TEXT NOT NULL,                 -- e.g. 'permit:austin-tx', 'license:TX TDLR'
  source_ref       TEXT,                          -- permit number or licence number it came from
  retrieved_at     TIMESTAMPTZ NOT NULL,
  verification     TEXT NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified','corroborated','verified')),
  confidence       NUMERIC(3,2) NOT NULL,
  seen_on_permits  INTEGER NOT NULL DEFAULT 1,    -- how many permits list this value
  UNIQUE (contractor_id, kind, value)
);

CREATE TABLE permit_parties (
  permit_id      BIGINT NOT NULL REFERENCES permits(id),
  role           TEXT NOT NULL CHECK (role IN ('contractor','applicant','architect','owner')),
  contractor_id  BIGINT REFERENCES contractors(id),   -- NULL for owner, unresolved or owner-builder
  raw_name       TEXT,
  raw_trade      TEXT,                                 -- Austin contractor_trade
  match_rule     TEXT,                                 -- 'licence' | 'phone_name' | 'unresolved'
  match_confidence NUMERIC(3,2),
  PRIMARY KEY (permit_id, role, raw_name)
);

CREATE TABLE contractor_merges (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kept_id        BIGINT NOT NULL REFERENCES contractors(id),
  merged_id      BIGINT NOT NULL,
  decided_by     TEXT NOT NULL,                  -- 'auto:licence' or an admin email
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at      TIMESTAMPTZ
);
```

**"Verified" means corroborated by an independent source.** A permit-listed
phone is `unverified` from one permit, and `corroborated` when it matches a
licence file or appears on 3 or more permits for the same contractor.
`verified` is reserved for a human or a vendor check. This is what the "Verified
phone" label in the UI is allowed to mean, and nothing more.

## Properties and projects

```sql
CREATE TABLE properties (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jurisdiction_id   BIGINT NOT NULL REFERENCES jurisdictions(id),
  parcel_id         TEXT NOT NULL,
  address_std       TEXT,
  property_use_raw  TEXT,
  year_built        INTEGER,
  living_sqft       INTEGER,
  assessed_value_usd NUMERIC(14,2),
  source            TEXT,
  retrieved_at      TIMESTAMPTZ,
  UNIQUE (jurisdiction_id, parcel_id)
);
-- permits.property_id BIGINT REFERENCES properties(id) is added with this table.

CREATE TABLE projects (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jurisdiction_id   BIGINT NOT NULL REFERENCES jurisdictions(id),
  property_id       BIGINT REFERENCES properties(id),
  grouping_basis    TEXT NOT NULL CHECK (grouping_basis IN ('master_permit','parcel_window','single')),
  grouping_confidence NUMERIC(3,2) NOT NULL,
  primary_permit_id BIGINT REFERENCES permits(id),
  started_on        DATE,                          -- earliest member issued_on
  last_activity_on  DATE,
  grouper_version   TEXT NOT NULL
);

CREATE TABLE project_permits (
  project_id  BIGINT NOT NULL REFERENCES projects(id),
  permit_id   BIGINT NOT NULL REFERENCES permits(id) UNIQUE,   -- a permit is in one project
  PRIMARY KEY (project_id, permit_id)
);

CREATE TABLE project_trades (
  project_id      BIGINT NOT NULL REFERENCES projects(id),
  trade           TEXT NOT NULL,                  -- electrical | hvac | plumbing | roofing | ...
  relevance       SMALLINT NOT NULL,              -- 0-100 trade fit
  gap_state       TEXT NOT NULL CHECK (gap_state IN ('open','closed','not_applicable')),
  gap_opened_on   DATE,
  gap_closed_on   DATE,
  closed_by_contractor_id BIGINT REFERENCES contractors(id),
  rules_version   TEXT NOT NULL,
  reasons         JSONB NOT NULL,                 -- [{rule, evidence}]
  PRIMARY KEY (project_id, trade, rules_version)
);
```

## Leads, delivery and feedback

```sql
CREATE TABLE organizations (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('design_partner','customer','internal')),
  trade       TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE users (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  BIGINT NOT NULL REFERENCES organizations(id),
  email            CITEXT NOT NULL UNIQUE,
  role             TEXT NOT NULL CHECK (role IN ('admin','partner')),
  last_login_at    TIMESTAMPTZ
);

CREATE TABLE subscriptions (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  BIGINT NOT NULL REFERENCES organizations(id),
  name             TEXT NOT NULL,
  trades           TEXT[] NOT NULL,
  jurisdiction_ids BIGINT[] NOT NULL,
  zips             TEXT[],                         -- NULL = whole jurisdiction
  min_valuation_usd NUMERIC(14,2),
  residential_commercial TEXT[],
  audience         TEXT NOT NULL DEFAULT 'b2b' CHECK (audience IN ('b2b','homeowner')),  -- ADR-10
  cadence          TEXT NOT NULL DEFAULT 'weekly' CHECK (cadence IN ('daily','weekly')),
  max_items        SMALLINT NOT NULL DEFAULT 20,
  recipients       CITEXT[] NOT NULL,
  scoring_weights  JSONB,                          -- overrides; NULL = defaults
  active           BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE leads (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id       BIGINT NOT NULL REFERENCES projects(id),
  trade            TEXT NOT NULL,
  relevance        SMALLINT NOT NULL,
  data_quality     SMALLINT NOT NULL,
  reasons          JSONB NOT NULL,                  -- [{factor, value, points, evidence}]
  audience         TEXT NOT NULL DEFAULT 'b2b' CHECK (audience IN ('b2b','homeowner')),
  target_contractor_id BIGINT REFERENCES contractors(id),  -- b2b: usually the GC on the primary permit
  target_owner_party JSONB,                                 -- homeowner: owner name + permit ref (no contact until gated)
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  scorer_version   TEXT NOT NULL,
  UNIQUE (project_id, trade, audience, scorer_version)
);

CREATE TABLE digests (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id  BIGINT NOT NULL REFERENCES subscriptions(id),
  period_start     TIMESTAMPTZ NOT NULL,
  period_end       TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('built','reviewed','sent','failed','skipped')),
  reviewed_by      TEXT,                             -- pilot: a human checks before send
  provider_message_id TEXT,
  sent_at          TIMESTAMPTZ,
  UNIQUE (subscription_id, period_start)
);

CREATE TABLE digest_items (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  digest_id        BIGINT NOT NULL REFERENCES digests(id),
  subscription_id  BIGINT NOT NULL REFERENCES subscriptions(id),
  lead_id          BIGINT NOT NULL REFERENCES leads(id),
  lead_key         TEXT NOT NULL,                   -- project_id:trade, stable across rescoring
  rank             SMALLINT NOT NULL,
  snapshot         JSONB NOT NULL,                  -- exactly what the email showed
  UNIQUE (subscription_id, lead_key)                -- never send the same lead twice
);

CREATE TABLE feedback (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  digest_item_id   BIGINT NOT NULL REFERENCES digest_items(id),
  verdict          TEXT NOT NULL CHECK (verdict IN ('relevant','not_relevant','already_knew','wrong_contact','too_late','outside_area')),
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE outcome_reports (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  BIGINT NOT NULL REFERENCES organizations(id),
  digest_item_id   BIGINT REFERENCES digest_items(id),
  outcome          TEXT NOT NULL CHECK (outcome IN ('contacted','responded','quoted','won','lost')),
  value_usd        NUMERIC(14,2),
  self_reported    BOOLEAN NOT NULL DEFAULT true,
  reported_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE email_events (                         -- opens/clicks from the provider webhook
  provider_message_id TEXT NOT NULL,
  event            TEXT NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provider_message_id, event, occurred_at)
);
```

## Compliance and audit

```sql
CREATE TABLE suppressions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('phone','name','address','permit')),
  value        TEXT NOT NULL,
  reason       TEXT NOT NULL,       -- 'removal request', 'protected address (FL 119.071)', ...
  requested_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);

CREATE TABLE data_requests (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('correction','removal','access')),
  requester    TEXT NOT NULL,
  details      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','rejected')),
  resolved_at  TIMESTAMPTZ,
  resolution   TEXT
);

CREATE TABLE audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  details     JSONB,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Mapping from today's schema

| Today (`permits`) | Target |
| --- | --- |
| `source_area` | `sources.slug`, referenced via `source_id` |
| `permit_number` | `source_permit_number` |
| `filed_date` | `issued_on` for Austin and Miami-Dade (both map their issue date there today) |
| `valuation` (0 = missing) | `valuation_usd` (NULL = missing) |
| `status` (applied/issued) | Dropped once scoring v2 replaces `TIMING_BONUS`; `status_stage` stays |
| `contractor_*`, `applicant_*` columns | `permit_parties`, `contractors` and `contact_points` |
| `owner` | `permit_parties` with role `owner`; not displayed until the ADR-10 homeowner gate passes |
| `trade_scores` JSONB | `project_trades` and `leads` |
| `ingest_runs` | `sync_runs` (kept read-only for history) |
| `fees`, `inspections` (Accela only) | Kept as JSONB on `permits` until Accela returns |
