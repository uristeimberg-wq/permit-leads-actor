# Roadmap

Status: **proposed**, 2026-11-13. Each milestone ends with checks that can be
answered yes or no. A milestone that fails its exit check means changing the
plan, not adding more features.

## M0: Foundation (this PR plus the next 2)

| Item | Priority | Depends on | Exit check |
| --- | --- | --- | --- |
| Import the prototype as a baseline commit | Must | none | Done: 101 tests pass |
| Docs and `CLAUDE.md` | Must | none | Reviewed and merged |
| CI: `npm test` on every PR | Must | none | A red test blocks the merge |
| Migration runner; `001` equals today's schema | Must | none | A fresh DB and an existing DB both reach the same schema |
| Scheduler defaults: Austin and Miami-Dade on, Oregon off | Must | none | Pinned by a test |

## M1: Data feasibility in Austin (about 1 week, starting after M0)

The purpose is to answer, with numbers, whether a lead worth calling exists.

| Item | Priority | Complexity | Risk | Exit check |
| --- | --- | --- | --- | --- |
| `sources`, `sync_runs` and `raw_records` tables; raw payloads stored | Must | M | Low | Re-running a sync writes 0 new raw rows |
| Socrata `updated_at` mode for Austin | Must | M | `:updated_at` behaviour unverified | Late-published and status-changed permits appear within one sync |
| Daily snapshot job for 14 days | Must | S | none | Publication lag p50 and p90 measured |
| Measure phone coverage, distinct contractors, and repeat-phone rate | Must | S | none | Numbers in `docs/DATA_SOURCES.md` |
| Trade-gap feasibility: can Austin trade permits be linked to building permits (parcel `tcad_id` plus window)? | Must | M | **The core assumption** | Link rate, and median days from building to trade permit, for electrical, HVAC and plumbing |
| Fixtures recorded from live responses | Must | S | none | Contract tests run offline |

**Go or no-go at the end of M1:**

- **Go:** at least 30% of residential remodel and new-build permits get a
  later trade permit in the same project, and the median gap is at least 7
  days.
- **Otherwise:** the "trade gap" pitch is dropped, and leads are ranked on
  recency, value and trade fit only.

**Result, 2026-11-13 (`docs/DATA_SOURCES.md`, M1 measurements): conditional go.**
The data passes both thresholds: 50-78% of primaries get a trade permit linked by
permit number, the medians are 25-63 days, and only 2-5% of trade permits are
pulled by the building permit's own company. What the data cannot show is
whether the sub is still unhired at that point. A trade permit is usually
pulled after the sub is hired, so the gap is an upper bound on the sales
window. Before the pitch is sold as "reach the sub before anyone else", 3 to 5
design partners must confirm when they are hired. The next measurement is
building-permit review time (`applieddate` to `issue_date`), because subs that
bid during plan review are gone before the permit is issued.

**Follow-up, 2026-11-13 (`docs/DATA_SOURCES.md`, plan-review timing): caution.**
Median residential BP review is 63 days (p90 300), and trade-permit application
dates are copied from the BP, so they cannot date the hire. The stronger finding
is stickiness: when a GC has an earlier job in a trade, 94% of trade permits go
to a sub it already used (98% for GCs with 20+ BPs, which file half of all
residential BPs). At most about a quarter of trade jobs look open to a new sub.
The pitch should move from "reach the job first" to GC and sub relationship
intelligence, and design-partner interviews should test that.

Still open from M1: the 14-day snapshot for real publication lag (the
`:created_at` field is a bulk reload) and Miami-Dade municipal coverage.

## M2: Reliable pipeline (about 2 weeks)

| Item | Priority | Complexity | Exit check |
| --- | --- | --- | --- |
| Split fetch and map; `permit_versions`; `NULL` instead of 0 and `''` | Must | M | Existing tests plus new versioning tests pass |
| pg-boss jobs replace `setInterval`; retries, dead letters | Must | M | Kill the worker mid-sync and it resumes from the cursor with no duplicates |
| Miami-Dade `snapshot` mode | Must | M | A full snapshot diff runs in under 15 min |
| Contractor resolution v1 (licence, then phone and name) | Must | M | Hand-checked sample of 100 contractors: 0 wrong auto-merges |
| `source_health` view and alerts (stale, failing, volume, schema drift) | Must | M | Each alert fires in a test with a simulated failure |
| Production deploy (ADR-7) with a daily schedule | Must | S | 7 consecutive days of on-time syncs |

## M2b: Production data pipeline and enrichment (ADR-14, started 2026-11-13)

Pulled forward at the owner's request; runs alongside M3 and M4. TDLR licence
enrichment moves here from M5.

| Item | Exit check |
| --- | --- |
| Reliability: retry, `source_health`, schema drift, independent `health.yml` alarm, raw retention | Each alarm fires in a test (integration `health.test.js`); a deliberately broken source opens a `data-health` issue |
| Source recon: TDLR, TSBPE, Florida DBPR, Travis CAD, Miami-Dade PA, Census geocoder (fields, keys, volume, terms) | `docs/DATA_SOURCES.md` entries dated, terms read or marked unread |
| Contractor licence enrichment (TDLR first) | Match rate and phone corroboration rate reported per run; no merge on name alone |
| Parcel join to appraisal data (Austin first) | Share of permits with a parcel match reported; property fields carry source and date |
| Geocoding (permits without coordinates) | Share geocoded, by match quality; radius search works |
| Connector template for new markets | A new source is a config entry plus fixture plus test, no core change |
| Database plan | Storage and backup window fit the next 6 months; owner decides on a paid tier |

## E: Early discovery (ADR-16, accepted 2026-11-13; runs before M3)

The owner's strategy addition moves pre-approval discovery to the front.
M2b reliability work stays; M3's digest is rebuilt around stages. The first
milestone proves the foundation on **one** lawful pre-approval source before
any new UI.

| # | Item | Exit check (yes or no) |
| --- | --- | --- |
| E0 | 14-day metadata snapshot: every enabled source plus Austin `n8ck-xkda`, probed every 15 min (Actions, read-only) | Measured publish cadence per source; tier chosen per ARCHITECTURE 19.2 |
| E1 | Austin plan-review connector (`n8ck-xkda`, window on `applied_date` and `status_date`), fixture, `DATA_SOURCES` entry | Re-runs add 0 rows; new applications appear the same day |
| E2 | Raleigh connector windows on application and update dates, not `issueddate`; `filedDate` mapped to `applieddate` | Raleigh pre-issue rows (72% of new building filings) appear in search |
| E3 | Lifecycle: `status_vocabulary`, `lifecycle_stage`, `submitted_on`, `searchable_at`, `observed_stage_at_first_seen`; `lifecycle_events` from `permit_versions` | Every Austin and Raleigh status is mapped or reported as `unknown`; stage changes produce one event each |
| E4 | Application-to-permit link: Austin `masterpermitnum` = `folderrsn`; Raleigh same record | Link rate measured on 6 months of issued BPs; 90% or more, or the gap explained |
| E5 | Applicant vs. contractor and expediter detection on Austin applications | Share of applicant orgs that become the BP contractor reported; expediters flagged |
| E6 | Business portfolios for applicant, contractor, sub roles from existing history (storage: Neon Launch, approved 2026-11-13) | A named business's profile lists its past projects with co-participants and labels (confirmed / historical) |
| E7 | Early-capture and latency metrics on the admin page | Discovery latency p50/p90 and early-capture rate shown per source |
| E8 | Design-partner test: 3-5 Austin **GCs, builders or suppliers** (owner's choice) get a daily list of application-stage projects for 4 weeks | 3 of 5 say "new and early enough" at least once a week; otherwise stop and rethink E |

**Go or no-go at the end of E:** go if early-capture is 80% or more, the link
rate is 90% or more, and E8 passes.

**Amendment (ADR-18, accepted 2026-11-14):** the 80% gate
measures *application capture* (seen at plan review before issue), which is
close to automatic in Austin because every BP has a plan-review case. Report
*pre-application capture* (an earlier planning or demolition signal, lead over
the application date, by segment) beside it. The early-signal pilot (P0
backtest, P1 competitive check, P2 forward test merged with E8) and its pass
criteria are in `docs/DATA_STRATEGY.md` section 8. If partners say application-stage
projects are no more winnable (stickiness), the product leans to GCs and
suppliers, not subs.

### E-later (only after E passes)

| Item | Depends on |
| --- | --- |
| Austin site plan, subdivision, zoning cases as `planning_cases` | E3 |
| Legistar agendas (Austin) | planning_cases |
| TABC pending applications (statewide, restaurant build-outs) | Terms read |
| TDLR TABS registrations | Written decision on automated access; terms |
| Miami-Dade Notices of Commencement via the clerk's paid bulk feed | **On hold (owner, 2026-11-13)** until E passes in Austin; then spend approval and the registration agreement |
| Sub-hourly polling (always-on worker) | E0 shows intra-day change; owner's cost approval |
| Orlando or New Orleans as the third market (both PADAS 87-89) | Terms read (Orlando) |
| NYC DOB NOW filings | Terms read; a reason to enter a crowded market |

## D: Data engine (ADR-23, accepted 2026-11-14)

The owner made the dataset the product. Order of work, exit checks and the
scorecard targets are in `docs/DATA_ENGINE_PLAN.md` sections 7 and 10:
sprint 1 maps dropped fields and official links, adds Wake parcels and
field-level provenance, and starts the weekly scorecard; sprint 2 adds
Raleigh development plans, Miami-Dade sewer allocation and Austin planning
cases; sprint 3 builds properties and projects; sprint 4 validates. E8 / P2
(the 4-week builder/supplier list) runs from sprint 1 in parallel. UI work is
limited to data inspection until the scorecard and the pilot show value.

## M3: Pilot delivery (about 2 weeks)

| Item | Priority | Complexity | Exit check |
| --- | --- | --- | --- |
| Projects and classification v2 (per-source vocabulary), labelled sample of 500 | Must | L | Precision of at least 80% at the top 20 for each pilot trade |
| Leads with reasons; relevance kept separate from data quality | Must | M | Every lead shows at least one reason |
| Subscriptions, digest build, human review, then send | Must | M | A digest never repeats a lead (test) |
| Signed one-click feedback and the weekly outcome check-in | Must | S | A verdict is recorded without login |
| Admin auth (magic link) on the existing UI | Must | S | Unauthenticated requests get 401 |

Homeowner-track groundwork that costs little runs in parallel with M3: price
2 or 3 skip-trace vendors, book the counsel consult (COMPLIANCE.md questions
1 to 9), and talk to 3 roofing or solar sellers about what they pay for leads
today.

## M4: Validation (4 weekly sends)

These are mostly the founders' tasks; the system records the outcomes.

- Recruit 3 to 5 design partners (Austin first). Use the old design partners
  if they can be reached.
- Exit check: 4 consecutive weekly sends with no missed sync, and feedback on
  at least 60% of delivered leads.
- **Stop signal:** after 4 sends, fewer than 2 partners report calling anyone.
- **Pay signal:** at least 2 partners agree to a paid pre-commitment.

## M5: Expansion (only after M4 passes)

Ranked by expected value:

| Item | User value | Complexity | Depends on |
| --- | --- | --- | --- |
| Miami-Dade digests (if not already in M3) | High | S | M2 snapshot mode |
| Texas TDLR licence enrichment (business phone) | Medium | M | Contractor resolution |
| Partner-facing web login: saved leads, pipeline statuses, notes | Medium | M | Auth |
| Third market (Dallas or Orlando) | Medium | M | Connector config |
| Contractor activity profiles ("who is ramping up") | Medium, for suppliers | M | Contractors, history |
| Homeowner track (ADR-10): counsel answers, contact vendor choice, Do Not Call scrubbing, then a homeowner pilot with 2 or 3 roofing or solar sellers in Miami-Dade (owner names exist there) | High if the gate passes | L | Compliance gate, vendor contract |
| Billing | Only with the pay signal | M | M4 |
| Map-first discovery, AI research assistant, CRM integrations | Unproven | L | Evidence of demand |
