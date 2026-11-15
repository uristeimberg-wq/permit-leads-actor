# Data-engine brief: gap analysis (2026-11-15)

The owner's "Principal Data Engineer" brief (project thread "Harden the data
engine phase by phase") asks for four phases. Each item below was checked
against the code on `main` at a06f26e (after #97) and against the live
checks of 2026-11-15 (`docs/research/2026-11-15-external-audit-check.md`).
Only the gaps get built. Nothing here touches the UI.

Verdicts: **exists** (built and live), **partial** (built, with a named
hole), **missing**, **won't build** (with the reason).

## Phase 1: ingestion hardening, idempotency, provenance

| Brief item | Verdict | What is there / what is missing |
|---|---|---|
| Composite unique key per jurisdiction + source record | exists | `permits UNIQUE (source_area, permit_number)` (001), `planning_cases UNIQUE (source_area, case_number)` (025), `inspections UNIQUE (source_area, inspection_key)` (033), `raw_records UNIQUE (source_id, source_key, payload_hash)` (002). `source_area` is the source slug, one per jurisdiction feed, so it is the brief's `jurisdiction_id` at finer grain. Live: 0 duplicate keys in 139k permits |
| Raw payload preserved for every record | partial | `raw_records.payload` JSONB holds every row of every Socrata/ArcGIS source untouched, with `fetched_at` (= ingested_at) and `sync_run_id`; superseded versions kept 90 days, the latest forever (`ingest/prune.js`). **Missing:** a per-record `source_url` (a URL that re-fetches exactly that record); `source_updated_at` is NULL on every row (the Socrata key `:updated_at` is never requested, and no ArcGIS layer maps one). Enrichment sources keep their own filtered copy instead of raw_records (`parcels.payload` without owner fields; licence and Sunbiz rows as mapped), because their raw rows carry owner and officer fields we must not store (docs/COMPLIANCE.md) |
| `lifecycle_stage` enum beside the raw status | partial | `permits.lifecycle_stage` + `status_raw` (017), `planning_cases.lifecycle_stage` + `status_raw` (025). Vocabulary is `src/lifecycle.js` STAGES, finer than the brief's 8 values (it keeps `corrections`, `denied`, `cancelled` apart). **Missing:** a database CHECK, so a bad value can be written; and the brief's coarser 8-value view |
| Immutable `record_status_changelog` | partial | `permit_status_history` (004/017), `planning_case_status_history` (025), `inspection_result_history` (033), all written by triggers so no code path can skip them. **Missing:** one changelog in the brief's shape (`field_changed`, `old_value`, `new_value`), and immutability: nothing stops an UPDATE or DELETE of a history row today |
| Indexes on lifecycle_stage, ingested_at, source_updated_at, parcel_id, entity ids | partial | `(source_area, lifecycle_stage)` on permits and planning cases; `permit_parcels(parcel_id)`; `planning_cases(parcel_id)`; `permit_parties(contractor_id)`. **Missing:** `permits.first_seen_at`, `raw_records.source_updated_at`, `raw_records.fetched_at`, `permits.parcel_number`, `planning_cases.first_seen_at` (`contractor_registry_licences(licence_id)` exists since 014) |
| Full pagination until zero records | exists | Both adapters page to the end; the ArcGIS short-page edge was fixed in #93; hitting `maxPerRun` writes a `truncated` source event. Unit-tested (`src/adapters/*.test.js`) |
| Incremental watermark per connector | missing | Windows are fixed look-backs (14-30 days on the filed/issued/status/updated field, ADR-11). They re-read recently modified rows, but an outage longer than a window silently leaves a gap. `sources.cursor` exists and is unused. Note: Austin's `:updated_at` is useless (the publisher reloads all 2.4M rows daily), so a pure modified-since cursor would be a full rescan there |
| Exponential backoff with 429/503 handling | partial | `src/adapters/http.js`: 4 attempts, exponential, `Retry-After` seconds honoured, 429/5xx retried. **Missing:** jitter, `Retry-After` as an HTTP date, and any database record of retries or rate limits (they reach only the log) |
| Strict schema validation (Zod) | missing | Field-name drift is detected (`ingest/drift.js`), but response envelopes and row shapes are checked by hand-written `if`s and per-row type errors are invisible |
| `connector_health_logs` | partial | `source_events` (006/030: schema_change, truncated, retention, missing_at_source) plus `sync_runs.error_class` and the `source_health` view and alarm. **Missing:** events for validation failures, rate limits and watermark gaps, and one place to read them. A second table would duplicate `source_events`, so this becomes a view over it |

## Phase 2: early-stage signals

| Brief item | Verdict | What is there / what is missing |
|---|---|---|
| Ingest submitted / in-review / plan-check records | exists | Austin plan review (n8ck-xkda, 1,371 pre-issue live), Raleigh pre-issue rows (640). Miami-Dade and City of Miami layers publish issued permits only, at source |
| Planning / zoning / site-plan filings | exists | 12,268 planning cases: Austin site plans, Raleigh development plans and plan areas, Miami-Dade DERM sewer allocations, City of Miami tree reviews, Miami-Dade zoning hearings (025, 031, 032) |
| Demolition / asbestos / ROW / utility tap | won't build now | TCEQ construction NOIs are not in open data; no open demolition or asbestos notice feed for TX/FL/NC (thread "Inspections", PR #94). DERM sewer allocation is the utility-capacity signal we have |
| Unified `construction_signals` / `projects` model | missing | Signals live in three tables (permits, planning_cases, inspections) and two link tables (`permit_links`, `planning_case_links`). **Missing:** one model over them with a parcel key and the provenance of every link. A `projects` table that merges filings by parcel is not built: one parcel holds many projects over the years, so a parcel merge invents projects. Groups come only from explicit links |

## Phase 3: entity resolution and parcels

| Brief item | Verdict | What is there / what is missing |
|---|---|---|
| Address and parcel normalisation | exists | `src/address.js`; parcels for 87-99% of permits by the source's own parcel id (folio, TCAD id, Wake PIN) |
| Name normalisation + licence matching | exists | `src/contractors.js` (contractors-v6): legal forms stripped, punctuation and case folded, licence key beats name key, owner-builders excluded, near-misses never merged |
| Verified source data apart from inferred links, `match_confidence` and provenance on every entity link | partial | `permit_parties.match_rule/match_confidence`, `contractor_registry_licences.match_rule/match_confidence`, `contractor_registrations`. **Missing:** an explicit provenance class on each link; today it is implied by `match_rule` and applied only in `web/trust.js` |
| Portfolios from linked source records only | partial | Counts and job lists come from `permit_parties`. **Missing:** a portfolio that carries the provenance of each link, so a name-only link is never counted as verified |
| Florida split firms (1,436 names on 2+ entities) | partial, measure first | v5 rule 3 joins names one Sunbiz entity carries. The rest are split on purpose until measured; any new merge rule is measured on the live data before it changes a count anyone sees |

## Phase 4: tests and report

| Brief item | Verdict | What is there / what is missing |
|---|---|---|
| Idempotent re-ingest + changelog | partial | `test/integration/raw_records.test.js`, `lifecycle.test.js` test pieces. **Missing:** one test that runs the real `ingestArea` twice end to end and checks 0 duplicates and the changelog |
| Pagination completeness | exists (unit) | Adapter tests page across short and capped pages. Added: an end-to-end multi-page run |
| Pre-approval capture | partial | Added end to end with the changelog test |
| Entity matching accuracy | exists (unit) | `src/contractors.test.js`: near-misses stay apart, licences unify. Added: an integration check through the database |
| Verification report | missing | `docs/research/2026-11-15-engine-verification.md`, from `recon/engine_verify.js` against the live database |

## Provenance vocabulary

The brief's four values map onto the trust classes of ADR-26
(`docs/DATA_TRUST_AUDIT.md`), so no second system is introduced:

| Brief | Trust class | Examples |
|---|---|---|
| `verified_source` | A, recorded fact | a permit's own status, a licence number on the permit |
| `cross_source_verified` | B, deterministic join on an official key | plan-review case to permit by `masterpermitnum`, DERM case to permit by process number, contractor to DBPR licence by licence number |
| `parsed_inferred` | C, inference | name-and-state contractor key, parcel-window planning link, name or phone registry match |
| `missing` | NULL | not published, or not collected |
