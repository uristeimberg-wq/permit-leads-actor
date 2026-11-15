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

## Lifecycle model (ADR-16, accepted 2026-11-13)

The model above is permit-centric: one `permits` row with a current status,
plus `permit_versions` and `permit_status_history` kept by trigger (migration
004). ADR-16 makes the unit of record the **filing** (anything a government
records about intended construction, from a zoning case to a final
inspection) and the unit of the product the **project** (one piece of
real-world work that may produce many filings). Nothing here replaces the
existing tables in one step; the migration order is at the end of this
section.

### What already covers part of this

| Need | Covered today by | Gap |
| --- | --- | --- |
| Status history with timestamps | `permit_status_history` (trigger, 004) | No `source_status_date`; no canonical lifecycle stage; `status_stage` has 5 values |
| Detect value, scope, participant changes | `permit_versions.mapped` (trigger, 004) | Changes are snapshots, not typed events, so "a contractor was added" needs a diff at read time |
| First observed date | `permits.first_seen_at` | Only per permit; nothing records when it became searchable or alerted |
| Official submission date | `permits.filed_date` (Austin `applieddate`) | Present only where the source publishes it; Austin trade permits copy it from the building permit (`docs/DATA_SOURCES.md`, plan-review timing) |
| Linking filings | `permit_parties.job_key` (005), Miami-Dade master permit | No planning cases; no link table with basis and confidence |
| Participants | `permit_parties` with role `contractor` only | Applicant, architect, engineer, expediter and owner-business roles are not stored as parties |

### Canonical lifecycle stage

Every source maps its own status words to one canonical stage through a
reviewed vocabulary table. An unmapped status becomes `unknown` and is
reported (rule 3); it is never guessed.

| Stage | Meaning | Examples of source words (to verify per source) |
| --- | --- | --- |
| `pre_application` | A planning, zoning, site-plan, subdivision or variance case, or an agenda item, before any building filing | Zoning case filed, site plan submitted, pre-application meeting |
| `submitted` | Building application received, not yet in review | Application accepted, intake, filed, pending |
| `in_review` | Plan review under way | Under review, in plan review, reviews in process |
| `corrections` | Returned to the applicant | Corrections required, revisions requested, on hold - applicant |
| `approved` | Approved, not yet issued (fees, conditions) | Approved, ready to issue |
| `issued` | Permit issued | Issued, active |
| `inspections` | Work under inspection | Inspection scheduled, partial approval |
| `completed` | Final or certificate of occupancy | Final, finaled, CO issued, closed |
| `expired`, `withdrawn`, `cancelled`, `denied` | Ended without completion | Expired, void, withdrawn |
| `unknown` | Not mapped yet | Anything new |

```sql
CREATE TABLE status_vocabulary (
  source_id     BIGINT NOT NULL REFERENCES sources(id),
  status_raw    TEXT NOT NULL,
  stage         TEXT NOT NULL,              -- one of the stages above
  mapped_by     TEXT NOT NULL,              -- reviewer, or 'seed:<fixture>'
  mapped_on     DATE NOT NULL,
  PRIMARY KEY (source_id, status_raw)
);
```

### Filings and their timestamps

`permits` stays the filing table for building, trade and site-development
filings (renaming it costs a migration of every query and buys nothing). New
columns carry the lifecycle and the timing:

```sql
ALTER TABLE permits ADD COLUMN filing_kind TEXT;          -- 'building' | 'trade' | 'site' | 'demolition' | ...
ALTER TABLE permits ADD COLUMN lifecycle_stage TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE permits ADD COLUMN stage_since DATE;          -- source status date when published, else NULL
ALTER TABLE permits ADD COLUMN submitted_on DATE;         -- official, from the source; NULL if not published
ALTER TABLE permits ADD COLUMN first_public_at TIMESTAMPTZ; -- only when the source states it (rare); never inferred
-- first_seen_at (exists) = first observed by us
ALTER TABLE permits ADD COLUMN searchable_at TIMESTAMPTZ; -- when normalize committed it (stage 2 done)
ALTER TABLE permits ADD COLUMN first_alerted_at TIMESTAMPTZ;
ALTER TABLE permits ADD COLUMN observed_stage_at_first_seen TEXT; -- the stage when we first saw it: the key early-discovery metric
```

**As built (migration 017, 2026-11-13).** Four differences from the sketch above, each on purpose:

- **Vocabulary in code.** Each source's vocabulary lives in `src/sources.js` (`lifecycle.statuses`), not in a `status_vocabulary` table. Every mapping is reviewed in a pull request, and the contract test rejects a stage that isn't listed. `ingest/lifecycle.js` re-applies the vocabulary to held rows and their history after each sync.
- **Column name.** `observed_stage_at_first_seen` is named `first_seen_stage`. It is written on insert only, so rows from before 017 keep NULL.
- **Filing kind.** `filing_kind` is `'building_application'` for plan-review cases and NULL for permits. Building versus trade stays in `permit_parties`.
- **Submission dates.** `submitted_on` is backfilled from the source's own application date in the raw payload, never from `filed_date`. `filed_date` is the issue date in Austin, so copying it would be invented data (rule 1).
- **Not built yet.** `searchable_at`, `first_public_at` and `first_alerted_at`.

**The two dates the product promises to keep apart:**

- `submitted_on`: what the government recorded. Shown as "Submitted".
- `first_seen_at`: when we observed it. Shown as "Found by us".
- `first_seen_at - submitted_on` is **discovery latency**, measured per source.
  It includes the source's own publication delay, which we cannot see
  separately unless the source publishes a creation time (`first_public_at`).

### Planning cases (pre-application signals)

Zoning, site-plan, subdivision, variance and historic-review cases, and agenda
items, have a different shape from permits (hearings, votes, conditions), so
they get their own table. They are joined to projects, never merged into
permits.

```sql
CREATE TABLE planning_cases (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id         BIGINT NOT NULL REFERENCES sources(id),
  case_number       TEXT NOT NULL,
  case_type_raw     TEXT,                     -- 'Site Plan', 'Zoning', 'Rezoning', 'Variance', 'Subdivision'
  case_kind         TEXT,                     -- canonical: site_plan | zoning | subdivision | variance | other
  status_raw        TEXT,
  lifecycle_stage   TEXT NOT NULL DEFAULT 'pre_application',
  filed_on          DATE,
  next_hearing_on   DATE,
  decided_on        DATE,
  decision_raw      TEXT,
  address_raw       TEXT,
  parcel_id         TEXT,
  description       TEXT,
  units_proposed    INTEGER,                  -- only when the source states it
  floor_area_sqft   INTEGER,                  -- only when the source states it
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash      TEXT NOT NULL,
  latest_raw_record_id BIGINT REFERENCES raw_records(id),
  UNIQUE (source_id, case_number)
);
-- planning_case_versions and planning_case_parties mirror permit_versions and permit_parties.

CREATE TABLE agenda_items (                   -- from Legistar or published agendas
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id         BIGINT NOT NULL REFERENCES sources(id),
  body_name         TEXT NOT NULL,            -- 'Planning Commission'
  meeting_on        DATE NOT NULL,
  item_key          TEXT NOT NULL,            -- the source's matter or item id
  title             TEXT,
  case_number_cited TEXT,                     -- extracted only by an exact pattern per source
  document_url      TEXT,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, item_key)
);
```

### Inspections (migration 033)

Building inspections as a department publishes them, one row per
(source, inspection key), linked to the permit by the source's own permit
number when the house number also agrees (`permit_id`, NULL otherwise). The
two sources (Miami-Dade, Raleigh) publish a rolling window of days, so the
daily read is the record. `result_raw` is kept as published; `result_class`
(approved, partial, rejected, not_ready, not_inspected, cancelled,
scheduled, other, unknown) is a lookup of that wording in the source's
vocabulary (`src/sources.js`), never a guess: an unlisted wording is
`unknown` and reported. `inspection_result_history` gains a row (trigger)
whenever the result wording or the completed flag changes: the transition
log. A result is a fact about an inspection, not a claim about what anyone
needs. Nothing displays these tables yet.

### Lifecycle events

Versions say *what the record looked like*; events say *what happened*. A
diff of consecutive versions writes typed events, which drive alerts and the
timeline. Re-running the diff is idempotent on `(subject, event_type,
content_hash)`.

```sql
CREATE TABLE lifecycle_events (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_kind    TEXT NOT NULL CHECK (subject_kind IN ('permit','planning_case')),
  subject_id      BIGINT NOT NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'first_observed','stage_changed','participant_added','participant_removed',
                    'value_changed','scope_changed','linked','hearing_scheduled','decided')),
  from_value      JSONB,
  to_value        JSONB,
  official_date   DATE,                       -- the source's date for this event, if any
  observed_at     TIMESTAMPTZ NOT NULL,       -- when our sync saw it
  raw_record_id   BIGINT REFERENCES raw_records(id),
  content_hash    TEXT NOT NULL,
  UNIQUE (subject_kind, subject_id, event_type, content_hash)
);
CREATE INDEX ON lifecycle_events (observed_at DESC);
```

"Meaningful" for alerts is a per-subscription filter over `event_type`
(default: `first_observed`, `stage_changed` into `approved` or `issued`,
`participant_added`, `value_changed` by 25% or more).

### Projects as the lifecycle umbrella

A project is discovered once and keeps its id while its filings move through
stages, so a status change never creates a second lead (requirement 2). The
current `projects` / `project_permits` design is widened to any member:

```sql
CREATE TABLE project_members (
  project_id    BIGINT NOT NULL REFERENCES projects(id),
  member_kind   TEXT NOT NULL CHECK (member_kind IN ('permit','planning_case','agenda_item')),
  member_id     BIGINT NOT NULL,
  link_basis    TEXT NOT NULL CHECK (link_basis IN (
                  'same_record',          -- application and permit are one record (Raleigh, Seattle, NYC)
                  'official_reference',   -- Austin masterpermitnum = folderrsn, master permit, case number cited
                  'parcel_window',        -- same parcel within the window: inferred
                  'address_window')),     -- candidate only, never auto-joined (requirement 6.3)
  confidence    NUMERIC(3,2) NOT NULL,
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  grouper_version TEXT NOT NULL,
  PRIMARY KEY (member_kind, member_id)      -- a member is in one project
);
ALTER TABLE projects ADD COLUMN first_seen_at TIMESTAMPTZ;   -- min over members
ALTER TABLE projects ADD COLUMN first_seen_stage TEXT;       -- stage of the earliest member when found
ALTER TABLE projects ADD COLUMN current_stage TEXT;          -- most advanced active member
```

**Key fact for linking (verified 2026-11-13):** in Raleigh, Seattle, Orlando,
New Orleans and NYC DOB NOW the application and the permit are the same
record, so "application to permit" is `same_record` and costs nothing.
**Austin is different:** the plan-review case (`2026-085921 PR` in
`n8ck-xkda`) and the building permit (`2026-127960 BP` in `3syk-w9eu`) have
different numbers; the BP's `masterpermitnum` equals the case's `folderrsn`
(an `official_reference` link, checked on 4 samples, rate unmeasured). The
other hard links are planning case to building filing (usually
parcel and time only) and building filing to trade filings (permit-number base
in Austin, master permit in Miami-Dade, application number in the City of
Miami, `pin` in Raleigh).

### Businesses, roles and relationships

`contractors` becomes the table for every business that appears in any role.
It keeps its name in the database for now (a view `businesses` is added), so
existing queries keep working.

```sql
ALTER TABLE permit_parties DROP CONSTRAINT permit_parties_role_check;
ALTER TABLE permit_parties ADD CONSTRAINT permit_parties_role_check CHECK (role IN (
  'contractor','sub_contractor','applicant','architect','engineer','expediter',
  'developer','owner_business','owner_individual'));
-- owner_individual rows hold no contractor_id and are never displayed (rule 5).

CREATE TABLE business_identifiers (          -- strong keys for entity resolution
  contractor_id   BIGINT NOT NULL REFERENCES contractors(id),
  id_kind         TEXT NOT NULL,             -- 'tdlr','tbae','tbpels','fl_dbpr','nc_lbgc','nyc_dob_license','sos_filing','cslb'
  id_value        TEXT NOT NULL,
  source          TEXT NOT NULL,
  retrieved_at    TIMESTAMPTZ NOT NULL,
  UNIQUE (id_kind, id_value)
);

CREATE TABLE business_relationships (        -- derived, rebuilt by the resolver; generalizes contractor_relationships
  from_id         BIGINT NOT NULL REFERENCES contractors(id),
  to_id           BIGINT NOT NULL REFERENCES contractors(id),
  from_role       TEXT NOT NULL,             -- 'architect'
  to_role         TEXT NOT NULL,             -- 'contractor'
  shared_projects INTEGER NOT NULL,
  first_on        DATE,
  last_on         DATE,
  link_bases      TEXT[] NOT NULL,           -- which project link bases produced the evidence
  min_confidence  NUMERIC(3,2) NOT NULL,
  resolver_version TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, from_role, to_role, resolver_version)
);
```

**Four participant labels, never mixed** (requirement 4). They are computed at
read time from the tables above and shown with different words:

| Label | Source | Allowed wording |
| --- | --- | --- |
| Confirmed participant | A `permit_parties` / `planning_case_parties` row on a member of this project | "Named on the application" |
| Historically associated | `business_relationships` with a confirmed participant | "Worked with <architect> on 12 earlier projects" |
| Potentially relevant | A ranked suggestion from the above plus trade and area | "May be relevant: often follows this architect" |
| Unverified inferred | Any link built on `parcel_window` or a name-only match | "Possible link, not confirmed" |

A suggestion is never written into `permit_parties`, never shown as "the GC",
and never alerted as a participant.

### Migration order

1. `status_vocabulary`, `lifecycle_stage`, `submitted_on`, `searchable_at`
   (additive; backfill `submitted_on` from `filed_date`).
2. `lifecycle_events` written by a diff job over existing `permit_versions`.
3. Wider `permit_parties` roles for sources that publish them (Raleigh,
   NYC, San Francisco), with `owner_individual` hidden.
4. `planning_cases` and `agenda_items` with the first pre-application source.
5. `project_members` replaces `project_permits` once a second member kind
   exists; `business_relationships` replaces `contractor_relationships` once a
   second role pair exists.

## Building facts (migration 020, ADR-23)

`permit_facts` holds one row per permit with the building facts its source
publishes but `permits` never mapped: units, floors, building / new / remodel
square feet, residential or commercial class, proposed use, construction
type, zoning, plan-review days, completion and last-inspection dates, the
source's own planning, property and project keys (Raleigh `devplanid`,
Austin `propertyrsn` and `project_id`), and `record_url`, the record on the
source's own ArcGIS service where the portal has no stable permit page.

It is rebuilt incrementally by `ingest/facts.js` from the latest raw record
(`raw_record_id` is the evidence) using the field maps in `src/facts.js`.
Placeholders (0 or 1 sq ft, 0 floors) are NULL, and a class word no
vocabulary maps is NULL and reported. Single-source filing facts keep this
row-level provenance; field-level observations are for attributes several
sources supply (`docs/DATA_ENGINE_PLAN.md` section 6.3).

Contractor emails (contractors-v4) are `contact_points` rows of kind
`email`, under the same display policy and corroboration rules as phones.
Raleigh is the only source that publishes them today.


## Field observations and conflicts (migration 023, ADR-23)

Field-level provenance where more than one source can supply the same
attribute (DATA_ENGINE_PLAN 6.3). Single-source permit fields keep row-level
provenance through `raw_record_id`.

- `properties`: one row per official parcel key in a county
  (`county`, `parcel_key`), stable across appraiser re-loads.
- `field_observations`: every value a source gave for a property field,
  with the source, the source record (`source_ref`: parcel key or permit
  number), `raw_record_id` when there is one, method, confidence tier,
  the source's own date and when we retrieved it. Unique per entity, field,
  source, source record and value, so a repeat writes nothing and a change
  adds a row; the old value stays as history. The current observation of a
  source record is its newest `last_seen_at`. A NULL value means the source
  publishes the field and says unknown; no row means it does not publish it.
- `field_conflicts`: one row per entity and field whose current
  observations disagree beyond tolerance. `auto_resolved` when precedence
  settles it (the losing value is named in `resolution`), `open` when two
  sources of the same precedence disagree (the resolved value is then NULL).
  A `reviewed` status survives re-runs while the same observations are in
  conflict.

Vocabulary, precedence and tolerances are in `src/fields.js`
(`fields-v1`): appraiser beats permit; sq ft within 10%; units, floors,
year and values exact. Sources today: Miami-Dade PA, Travis CAD and Wake
parcels (confidence high: joined by the permit's own parcel key) and the
units and floors of the permits linked to the parcel (medium). Businesses
and projects use the same tables later.
