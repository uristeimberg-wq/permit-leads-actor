# External audit, claim by claim (2026-11-15)

An outside audit of the repo was pasted into the project. Each claim was checked
against the code and the live database (`recon/audit_claims.js`, workflow
`audit-claims`, run 2026-11-15 05:44 UTC, and `recon/data_audit.js` the same morning).

| Claim | Verdict | Evidence | Fixed |
|---|---|---|---|
| FastAPI backend; Chicago as a market | False | CommonJS Node + Express (`web/server.js`). Markets: Austin, Miami-Dade, City of Miami, Raleigh (`src/sources.js`) | n/a |
| Lack of ingestion idempotency (P0) | False | `UNIQUE (source_area, permit_number)` since `001_baseline.sql:64`, upserts in `db/index.js:178`; sync workflow has `concurrency: sync`. Live: 0 exact and 0 case/punctuation duplicate keys in 139k permits; 0 duplicate planning case numbers; 0 repeated raw payloads; no table without a primary or unique key | n/a |
| Pre-approval illusion: queries filter to issued/completed | False | Live pre-issue rows: Austin plan review 1,371 in review/corrections/submitted, Raleigh 640 in review/submitted. 12,268 planning cases across Austin site plans, Raleigh dev plans, DERM sewer, City of Miami tree reviews. Miami-Dade and City of Miami permit layers are issued-only at the source | n/a |
| Hardcoded / pseudo-random opportunity scores and "hiring probability" | Partly true | `src/scoring.js` is static regex weights (no randomness anywhere). Hidden from every API answer unless `SHOW_INFERENCES=1` (`web/trust.js`, ADR-26). "gcHiring" is a recorded count of subs on a GC's jobs, not a probability | Already handled (PR #78, #83) |
| Pagination truncates silently | False, one latent edge | Both adapters page to the end; the cap is recorded as a `truncated` source event (`ingest/run.js:130`). Live: 0 truncation events in 30 days. Latent: ArcGIS stopped on a short page even with `exceededTransferLimit`, which would cut a layer capped below 500. Live caps are 1000 to 2000 on all 8 layers | Yes, edge fixed |
| Naive text-string contractor matching | Partly true | Licence keys for 6,351 contractors, 17,232 raw-name aliases folded, Sunbiz/TDLR/DBPR/Comptroller links with measured accuracy (0/200 wrong merges). Still true: 1,436 Florida normalised names sit on more than one entity (the known 9% split rate) | No (open, measured) |
| Silent failures in background workers | False | Every attempt in `sync_runs` with an error class; failed area fails the strict sync job; `health` workflow opens a `data-health` issue on stale sources. Live 30 days: 4 failures (fl-sunbiz x3, miami-dade-pa x1), all recorded | n/a |
| Unsanitized payloads crash workers (P0) | Partly true | One out-of-range epoch cell threw `RangeError` in `src/dates.js:37` and failed the whole market's run (recorded, not silent). Reproduced on 11 sources | Yes |
| Missing indexes on issue date, status, contractor name | False at current scale | Indexes on `(status_stage, filed_date)`, `(source_area, lifecycle_stage)`, `contractor_name`, GIN search. Live plans: stage search 0.6 ms, contractor contains 11.9 ms, weekly-list join 64 ms | No (not needed yet) |
| No parcel normalisation | False | Parcel links: Austin 93%, Miami-Dade 96%, City of Miami 99%, Raleigh 96%, Austin plan review 87% | n/a |
| No provenance / verified-vs-inferred split | False | `raw_record_id` on every link, `provenanceFor` on job answers, trust classes in `web/trust.js` | n/a |
| Introduce a `lifecycle_stage` field | Already exists | Migration 017 | n/a |
