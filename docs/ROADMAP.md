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

## M2: Reliable pipeline (about 2 weeks)

| Item | Priority | Complexity | Exit check |
| --- | --- | --- | --- |
| Split fetch and map; `permit_versions`; `NULL` instead of 0 and `''` | Must | M | Existing tests plus new versioning tests pass |
| pg-boss jobs replace `setInterval`; retries, dead letters | Must | M | Kill the worker mid-sync and it resumes from the cursor with no duplicates |
| Miami-Dade `snapshot` mode | Must | M | A full snapshot diff runs in under 15 min |
| Contractor resolution v1 (licence, then phone and name) | Must | M | Hand-checked sample of 100 contractors: 0 wrong auto-merges |
| `source_health` view and alerts (stale, failing, volume, schema drift) | Must | M | Each alert fires in a test with a simulated failure |
| Production deploy (ADR-7) with a daily schedule | Must | S | 7 consecutive days of on-time syncs |

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
