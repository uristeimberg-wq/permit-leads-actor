# Repository audit

Audited **2026-11-13** from the local copy `permit-leads-actor-main`. That
copy was a zip download with no git history; it is imported as this repo's
first commit. All 101 unit tests pass offline (`npm test`). The live ingest was
**not** run during the audit.

## What it is

A permit-search platform:

- **Scrapers and open-data adapters** (`src/adapters/`) feed an **ingest**
  step (`ingest/`).
- Ingest writes to **Postgres** (`db/`).
- An **Express API and a static vanilla-JS UI** (`web/`) read from it, with
  filters, a Leaflet map and contractor history.

It also still contains its original **Apify actor** entry point
(`src/main.js`, `.actor/`).

## Baseline: critical flows to protect

These are the behaviours a regression test must keep:

1. `npm run ingest --area=austin-tx` writes Austin permits with contractor
   name and phone. Mapping is covered by `src/adapters/socrata.test.js`.
2. `npm run ingest --area=miami-dade-fl` writes Miami-Dade permits. Stage is
   derived from dates, and no ZIP is invented. Covered by
   `src/adapters/arcgis.test.js`.
3. Re-running ingest over the same window does not duplicate permits (upsert
   on `(source_area, permit_number)`). There is no automated test for this
   yet; it is to be added as an integration test.
4. Search defaults to the pending and approved stages. An unknown status stays
   `unknown`. Covered by `src/status.test.js`.
5. `OWNER`, `SELF` and similar are not treated as contractors.
   Near-duplicate names are offered, never merged. There is no automated test
   yet.
6. All permit text is escaped before `innerHTML`. There is no automated test
   yet.

## Findings

| Area | Finding | Verdict |
| --- | --- | --- |
| Source registry (`src/sources.js`) | Config per source. Austin and Miami-Dade field maps were read off live metadata | **Preserve** (split per file later) |
| Socrata and ArcGIS adapters | Paged, newest-first, error-in-200 detection, refuse to run without a `fieldMap`. Tested | **Preserve**, then split fetch and map |
| Accela adapter | Playwright, about 7 s per permit, about 100 records per run, no contractor data, Oregon only | **Disable** in the pilot (ADR-5) |
| Portland CSV | Column map never verified, yet it is the actor's default input | **Remove** from the defaults |
| Status model (`src/status.js`) | Raw status plus stage; unknown statuses are reported, never guessed | **Preserve** |
| Address, date and phone helpers | Tested, with real edge cases (foreign ZIPs, unpadded dates) | **Preserve** |
| Schema (`db/schema.sql`) | One `permits` table, `ingest_runs`, tsvector, GIN on trade scores, `first_seen_at` | **Improve**: no raw records, versions, provenance, contractor or project tables, or geo. Migrations are `ADD COLUMN IF NOT EXISTS` in one file |
| Upsert (`db/index.js`) | `COALESCE(new, old)` on most fields | **Refactor**: a value cleared at the source never clears here. Missing values are stored as `0` and `''` |
| Ingest window | "Last N days by issue date" | **Refactor**: misses late publications and status changes on older permits |
| Scheduler (`ingest/schedule.js`) | `setInterval`, no overlap, records failures | **Refactor**: the default `INGEST_AREAS` covers only the two Oregon sources, so Austin and Miami-Dade are not refreshed by default |
| Trade scoring (`src/scoring.js`) | Regex rules for 6 trades, written for Portland prose | **Replace**: on a live Clackamas sample, every permit scored 0. `roof-only` is filtered out even for roofing. It does not use the sources' controlled vocabularies |
| Contractor history (`db/queries.js`) | Owner-builder exclusion; near-matches surfaced, never merged; value captioned with its denominator | **Preserve** the rules; move them to a `contractors` table |
| API (`web/server.js`) | Whitelisted filters, parameterized SQL, whitelisted sort, clamped page size | **Preserve**. Add auth, and stop echoing `err.message` on 500s |
| UI (`web/public/`) | Vanilla JS (1,479 lines), WCAG-checked colours, mobile layout, URL-synced filters, honest map (area centroids, labelled) | **Preserve** as the internal review tool; don't extend for v1 |
| Map | Pins are area centroids from a committed geocode cache, and say so | **Improve later** with source coordinates |
| Apify actor (`src/main.js`, `.actor/`) | Input schema lists only Portland and Oregon | **Remove**, or regenerate later |
| Secrets | None found. Default `postgres://permits:permits@localhost:5433` for local docker | **Improve**: refuse that default in production |
| Tests | 101 unit tests across 8 files; fixtures are real recorded rows | **Preserve**. Add integration tests (DB, idempotency) and CI |
| Docs | The README is detailed and candid about its limits | **Preserve**. One stale comment: `schema.sql` says Miami-Dade has no phone; it does |

## Technical debt, ranked by risk

1. The scheduler defaults leave the pilot markets stale.
2. The date-window sync loses late and updated records.
3. The `COALESCE` upsert plus `0`/`''` as "missing" corrupts freshness and
   value signals.
4. Trade scoring doesn't match real vocabularies, so the core product output is
   weak.
5. No raw payload storage, so a mapping fix needs a re-fetch.
6. No CI, so nothing stops a red test from merging.
7. No auth, which blocks giving anyone access.
