# Data-engine verification report (2026-11-15)

The owner's data-engine brief, phases 1 to 4. Gap analysis first
(`docs/research/2026-11-15-engine-gap-analysis.md`), then only the gaps were
built: #99 (migration 035, ADR-30) and #101 (migration 036, ADR-31). Nothing
in the UI changed. Live numbers come from `recon/engine_verify.js`
(workflow `engine-verify`, read-only) and from the sync run of 2026-11-15
14:11 UTC, the first with 035 and 036 live.

## 1. Schema changes applied

All additive. No table or column the app reads was renamed or dropped.

**035 `engine_hardening`** (live since #99, confirmed by engine-verify run
43722502973)

| Object | What it does |
|---|---|
| `raw_records.source_url` | A URL that re-fetches exactly this record from the source (Socrata `resource/<id>.json?<key>=<v>`, ArcGIS `query?where=<key>='<v>'`) |
| `raw_records.source_updated_at` (filling rule) | Filled only from a column the source keeps as a record-modification time (Raleigh `recordupdatedate`). Austin's `:updated_at` is not one: the publisher reloads all 2.4M rows daily |
| table `source_watermarks` | Last successful untruncated sync per source and date window, and the newest source date seen. A run widens its window back past the last success (cap 120 days; beyond it a `watermark_gap` error event) |
| `source_events.kind` | adds `validation`, `rate_limited`, `watermark_gap` |
| view `connector_health_logs` | every connector alert and every failed sync run in one place |
| CHECK `permits_lifecycle_stage_check`, `planning_cases_lifecycle_stage_check` | `lifecycle_stage` must be one of the 13 stages of `src/lifecycle.js` |
| function `lifecycle_phase(stage)` | the brief's 8 phases as a read-side grouping, never stored |
| view `record_status_changelog` | one changelog over the permit, planning-case and inspection history tables: `record_type, record_id, field_changed, old_value, new_value, detected_at` |
| trigger `history_append_only` on the 3 history tables | an observed value cannot be updated or deleted; a row goes only with its record; only the derived `lifecycle_stage` may be restaged |
| indexes | `permits_first_seen`, `permits_parcel_number`, `raw_records_fetched`, `raw_records_source_updated`, `planning_cases_first_seen` |

**036 `signals_and_entity_provenance`** (views only, nothing copied)

| Object | What it does |
|---|---|
| function `link_provenance(basis)` | official keys and licences → `cross_source_verified`; NULL → `missing`; anything else → `parsed_inferred` |
| view `construction_signals` | applications, permits, planning cases and inspections in one shape, with raw status, stage, phase, filed date, parcel ref and the provenance of the parcel ref and parcel id |
| view `signal_links` | application → permit, planning case → permit, inspection → permit, each with basis, confidence and provenance |
| view `entity_links` | permit → contractor, contractor → licence, contractor → business registration, permit → parcel, each with match rule, confidence and provenance |
| view `contractor_portfolio` | per contractor, licence-linked and name-linked permits counted apart |
| `VALIDATE CONSTRAINT` | both lifecycle CHECKs now hold for every row (0 rows were outside the vocabulary) |

Not built, on purpose: a `projects` table. One parcel carries many projects
over the years, so grouping filings by parcel invents projects. Filings are
connected only by the explicit links in `signal_links`.

Code: jittered backoff with `Retry-After` as seconds or HTTP date, and a
retry tally written as a `rate_limited` event (`src/adapters/http.js`); Zod
checks of every response envelope and of each row's key and date columns
(`src/adapters/validate.js`); watermark windows (`ingest/watermark.js`).

## 2. Tests

| Suite | Result |
|---|---|
| `npm test` (unit, offline) | 490 passed, 0 failed |
| `test/integration/engine.test.js` | 14 of 14: 2,500 rows over 3 pages read completely; pre-approval stages captured and none counted as issued; raw payload, fetch time and source URL kept; watermark advances; a re-run adds 0 permits, 0 raw rows, 0 history rows; a status change is one raw version and one old → new changelog entry; history cannot be edited or deleted; a bad stage is refused; an outage widens the window (40-day gap → 42-day window); a truncated run keeps the watermark; bad keys and dates land in one validation event; a 429 is retried and recorded; a failed run shows in `connector_health_logs` and does not advance the watermark |
| `test/integration/signals.test.js` | 7 of 7: one licence unifies two spellings of a firm; four similar names stay four firms; the owner-builder links to no entity; every entity link has a class and only licence links are verified; a name-only link counts as name-linked, never verified; every signal kind is in `construction_signals`; official-key links are verified, parcel-window links inferred |

Both integration suites also ran green in CI on #99 and #101.

## 3. Connector results (live sync, 2026-11-15 14:11 UTC)

Permit feeds, rows fetched in the daily windows:

| Source | Window | Fetched | New | Changed |
|---|---|---|---|---|
| austin-tx | issued 30d + status 14d | 15,755 | 39 | 111 |
| austin-plan-review-tx | applied 30d + status 14d | 1,866 | 0 | 0 |
| miami-dade-fl | issued 14d | 1,083 | 0 | 0 |
| miami-city-fl | issued 14d + status 14d | 2,813 | 10 | 2,799 |
| raleigh-nc | applied, created, issued 30d + updated 14d | 7,058 | 196 | 659 |

Other sources in the same run: Miami-Dade inspections 8,356 (5,074 new),
Raleigh inspections 2,013 (all new), Austin site plans 317, Miami-Dade
zoning hearings 951, DERM sewer allocations 597, City of Miami tree reviews
101, Raleigh development plans 83 and plan areas 240, Travis CAD 493,463,
FL DBPR 283,557, TX TDLR 35,206, Sunbiz 23,622. Every source succeeded; no
validation or rate-limit events were logged and no window needed widening.

Lifecycle, pre-approval vs issued (engine-verify on main at 15:40 UTC, after
this sync):

| Market | Permits | Pre-approval | Issued | Finaled | Pre-approval share |
|---|---|---|---|---|---|
| Austin plan review | 10,598 | 39 submitted, 1,332 plan review, 8,902 approved | 0 | 0 | 96.9% |
| Austin permits | 58,780 | 57 plan review, 6 approved | 23,789 | 32,108 | 0.1% |
| Raleigh | 31,278 | 193 submitted, 452 review, 1,157 approved | 14,473 | 14,429 | 5.8% |
| Miami-Dade | 34,229 | 0 | 33,662 | 567 | 0% |
| City of Miami | 4,335 | 0 | 2,707 | 1,321 | 0% |

Austin's permit feed publishes issued permits; its pre-issue work is the
plan-review feed. Both Miami feeds publish issued permits only, at source.

Integrity on the live data: 0 duplicate natural keys (permits, planning
cases, inspections, raw records), 0 permits without a raw record, 0
lifecycle values outside the vocabulary, 3 of 3 append-only triggers
installed, 871 permit status transitions in the changelog over 7 days.

Entity resolution, from the same sync: 15,808 contractors over 128,622
permits. Links by rule: 26,607 licence (`cross_source_verified`), 85,249
name-and-state and 3,160 one-Sunbiz-entity (`parsed_inferred`), 13,600
owner-builders and 6 unresolved (no business entity).

Florida names split across entities: the 1,436 in earlier notes counted
rows the resolver had left with 0 permits. The real figure is 294 names over
650 entities; Sunbiz holds 2+ candidates for 218 of them, so no safe merge
remains and nothing was merged.

After the sync (same engine-verify run):

- **Watermarks:** 24 windows across 13 sources hold their last successful
  sync and the newest source date seen. Miami-Dade's newest issue date is
  2026-11-05, ten days behind the sync: that is the county's publication lag,
  now visible per window.
- **source_url:** every record fetched since 035 has one (Austin 15,755,
  Raleigh 7,058, City of Miami 2,813, Miami-Dade 1,083, all inspection rows).
  Older raw versions stay NULL until the source serves them again; nothing is
  backfilled by guess.
- **source_updated_at:** 855 Raleigh rows (from `recordupdatedate`), 0
  elsewhere, by design.
- **Signals:** 158,957 rows in `construction_signals`; 10,273 Austin
  applications and 1,802 Raleigh permits are before issue. 87-100% of
  permits and applications carry a parcel ref, except inspections and
  Raleigh development plans (0%: their sources publish no parcel id).
- **Links:** 9,964 application → permit, 2,139 planning case → permit and
  4,585 inspection → permit links on official keys (`cross_source_verified`);
  252 parcel-window planning links (`parsed_inferred`). 78% of Austin
  applications reach their permit by an official key.
- **Entity links:** permit → parcel 180,547 links, all on the source's own
  parcel id. Contractor → licence 5,802 by licence number, 2,749 by name or
  phone. Portfolios: Florida 26,275 licence-linked permits vs 5,776
  name-linked; Texas and North Carolina are name-linked only (50,646 and
  26,794), because their permits carry no licence number.
- **Health:** in the last 7 days, 3 failed Sunbiz runs and 1 failed
  Miami-Dade parcel run (both earlier, both since succeeded), 2 schema-change
  notices; no validation, rate-limit or watermark-gap events.

## 4. What is still needed to scale

| Need | Unlocks | Status |
|---|---|---|
| TX Comptroller API key | franchise-tax entity checks at volume (46% of Texas names verified today) | owner registration, free |
| NC licence roster | licence-keyed Raleigh contractors | $50, waiting on the owner's OK |
| Miami-Dade Clerk notice-of-commencement feed | the earliest Miami-Dade signal before a permit | $110 per folder per month, not bought |
| TCEQ construction stormwater NOIs | Texas site-work signal | not published as open data |
| Demolition, asbestos, right-of-way notices | early teardown and site-work signals in TX, FL, NC | no open feed found |
| Miami-Dade and City of Miami pre-issue status | pre-approval capture in Florida | the public layers publish issued permits only; needs the jurisdictions' own plan-review data |

Engineering follow-ups, not blocking: the resolver leaves merged-away
contractors with `permit_count = 0` instead of removing them, which inflates
any count over `contractors`; and Austin has no real record-modification
time, so its freshness rests on the fixed look-back windows.
