# Architecture

Status: **proposed**, 2026-11-13. Builds on the existing prototype (see
[REPOSITORY_AUDIT.md](REPOSITORY_AUDIT.md)) rather than replacing it. Decisions
referenced as `ADR-n` are in [DECISIONS.md](DECISIONS.md).

## 1. Goals and non-goals

**Goal for v1:** every week, deliver to each design partner a short list of
construction projects their trade can still win, with the business to contact
and the evidence behind each pick. B2B ships first. Homeowner leads are a
second track that the model supports from day one and that is delivered after
its compliance gate (ADR-10).

**Quality bar:**

- No invented data.
- No duplicates on re-runs.
- No silent ingestion failures.
- Every displayed value traceable to its source.

**Non-goals for v1:** billing, a public sign-up, a map-first UI, an AI
assistant, CRM integrations, homeowner contact delivery (gated, ADR-10), and
more than two jurisdictions. Each waits on evidence from the pilot (see
[ROADMAP.md](ROADMAP.md)).

## 2. System overview

```
                      +--------------------------------------------------+
  Government sources  |  Worker process (Node)                           |
  ------------------  |                                                  |
  Socrata API  -----> |  connectors --> raw_records --> normalize -----+ |
  ArcGIS REST  -----> |   (fetch)       (append-only)    (map + upsert) | |
  (later: CSV,        |                                                 v |
   licence files)     |  resolve contractors <-- permits/permit_versions  |
                      |  group projects      <--/                         |
                      |  classify + score    --> leads                    |
                      |  build digests       --> digest_items --> email   |
                      |                                                  |
                      |  pg-boss scheduler / queues (state in Postgres)  |
                      +-------------------------|------------------------+
                                                |
                                     +----------v-----------+
                                     |  PostgreSQL + PostGIS |
                                     +----------^-----------+
                                                |
                      +-------------------------|------------------------+
                      |  Web process (Express)                           |
                      |  /api/*    search, permit, contractor (exists)   |
                      |  /admin/*  sources, sync runs, data quality      |
                      |  /f/*      signed feedback links from emails     |
                      |  static UI (exists), behind auth                 |
                      +--------------------------------------------------+
```

There are two processes and one database. The worker and the web process share
code (`src/`, `db/`) but are deployed separately, so a long backfill can never
slow the UI and a web deploy never interrupts a sync (ADR-3). No Redis, no
search cluster and no microservices until a measured bottleneck asks for one
(ADR-2).

## 3. Repository layout (target)

```
src/
  connectors/          one module per connector KIND (socrata, arcgis, csv, accela)
    index.js           kind -> connector
    contract.js        the interface every connector satisfies + shared helpers
  sources/             one config file per SOURCE (austin-tx.js, miami-dade-fl.js, ...)
  pipeline/
    normalize.js       raw payload -> canonical permit draft (pure)
    status.js          (moved from src/status.js)
    address.js, dates.js, phone.js
    contractors.js     entity resolution
    projects.js        permit -> project grouping
    classify/          trade rules per source vocabulary, versioned
    score.js           relevance + data-quality scores with reasons
  digest/              selection, rendering, sending
  jobs/                pg-boss job handlers; thin wrappers over pipeline/
db/
  migrations/          numbered SQL files, applied in order, never edited after merge
  index.js, queries.js
web/                   Express API, admin, feedback endpoints, static UI
ingest/                CLI entry points (kept for manual runs and backfills)
docs/
test/
  fixtures/            recorded real API responses, marked as fixtures
  integration/         tests against a real Postgres
```

The current `src/adapters/` becomes `src/connectors/` and `src/sources.js` is
split per source. Both moves keep the existing tests passing (see section 15).

## 4. Connector contract

Every source is described by a **source config** and read by a **connector
kind**. Adding a jurisdiction on a known kind is a config file plus a recorded
fixture, not new code.

```js
// src/connectors/contract.js (shape, not final code)
/**
 * @typedef {Object} SourceConfig
 * @property {string} id                 'austin-tx'
 * @property {string} kind               'socrata' | 'arcgis' | 'csv' | 'accela'
 * @property {string} jurisdictionId     FK to jurisdictions
 * @property {'updated_at'|'snapshot'|'date_window'} syncMode
 * @property {string} schedule           cron, e.g. '0 6 * * *' (source local time)
 * @property {number} pageSize
 * @property {number} maxRequestsPerMinute
 * @property {Object} fieldMap           canonical field -> source field(s)
 * @property {Object} [statusMap]
 * @property {Function} [deriveStatus]
 * @property {Object} compliance         see section 12
 */

/**
 * @typedef {Object} Connector
 * @property {(cfg, ctx) => Promise<SourceProbe>} probe
 *   Cheap call: dataset last-modified time, row count, field list hash.
 * @property {(cfg, cursor, ctx) => AsyncIterable<Page>} fetch
 *   Yields pages of { records: RawRecord[], nextCursor } until exhausted.
 *   Never maps fields. Never writes to the DB.
 * @property {(cfg, payload) => PermitDraft} map
 *   Pure: raw payload -> canonical draft. Re-runnable from stored raw data.
 */
```

Why fetch and map are split: raw payloads are stored before mapping. That
means a mapping bug is fixed by re-running `normalize` over stored rows, with no
re-fetch from someone else's server. Today's adapters fetch and map in one
step, so that isn't possible.

**Shared behaviour (in `contract.js`, not per connector):**

| Concern | Rule |
| --- | --- |
| Rate limiting | Token bucket per source host, from `maxRequestsPerMinute` (default 30) |
| Retries | Retry on 429, 5xx, timeouts and network errors: exponential backoff from 2 s, x2, jitter, max 5 attempts. Never retry 4xx other than 429 |
| Errors | Classified as `transient`, `rate_limited`, `auth`, `schema`, `bad_data` or `bug`, and stored on the sync run |
| Error in a 200 body | ArcGIS returns errors inside HTTP 200; treated as a failure (the prototype already does this) |
| Identification | A `User-Agent` naming the product and a contact address, set in config |
| Cancellation | An `AbortSignal` is passed through; a stopped job stops fetching mid-page |

## 5. Sync modes and freshness

The prototype pulls "permits issued in the last N days". That misses two real
cases:

- a permit issued 20 days ago but published today
- a status change on an old permit

Both matter for leads. Each source gets the best mode it supports:

| Mode | How it works | Used for |
| --- | --- | --- |
| `updated_at` | Cursor = max source update time seen (plus id as a tiebreak). Query `WHERE updated > cursor ORDER BY updated, id` | Only datasets whose update field moves per row. **Not Austin**: every row's `:updated_at` moves on each daily reload (ADR-11) |
| `snapshot` | `probe` reads the layer's last-edit time. If it changed, page through the full layer, hash each record, and write only new or changed hashes | Miami-Dade ArcGIS (489,896 rows; `hasStaticData: true`, last edited 2026-11-07) |
| `date_window` | One or more overlapping windows on source date fields (for example issue date and status date), deduplicated by raw-record hash | Austin (ADR-11): `issue_date` in the last 30 days plus `statusdate` in the last 14 days |

**Four timestamps, never interchangeable:**

| Timestamp | Column | Meaning |
| --- | --- | --- |
| Issue date | `permits.issued_on` (plus `applied_on`, `finaled_on`) | What the government says happened |
| Source update | `permit_versions.source_updated_at` | When the source last changed this record, if it says |
| First and last seen | `permits.first_seen_at`, `last_seen_at` | When we first and last observed it |
| Last sync | `sync_runs.finished_at` where `status = 'succeeded'` | When we last successfully read the source |
| Enrichment | `contractors.enriched_at`, `contact_points.retrieved_at` | When derived data was last refreshed |

**Publication lag** = `first_seen_at - issued_on`, measured per source and
shown on the admin page. "New" in a digest means *first seen since the last
digest*, not *issued since the last digest*. This is exactly what lets late
publications reach users.

## 6. Pipeline

Each stage is a pg-boss job with an idempotency key. Any stage can be re-run on
its own (ADR-4).

| # | Stage | Input | Output | Idempotency key | Re-run safe because |
| --- | --- | --- | --- | --- | --- |
| 1 | `sync.source` | source id | `raw_records`, `sync_runs` row | `source_id + scheduled_for` (singleton) | Raw rows are keyed by `(source_id, source_key, payload_hash)`, so a duplicate insert is a no-op |
| 2 | `normalize.batch` | raw record ids | `permits`, `permit_versions`, `permit_status_history` | `raw_record_id` | Upsert on `(source_id, source_permit_number)`. A version is written only when the mapped content hash changes |
| 3 | `resolve.contractors` | permit ids | `contractors`, `contractor_aliases`, `permit_parties` | `permit_id + resolver_version` | Deterministic keys, see section 8 |
| 4 | `group.projects` | permit ids | `projects`, `project_permits` | `permit_id + grouper_version` | Rules are deterministic. Membership is replaced per permit |
| 5 | `classify.score` | project ids | `project_trades`, `leads` | `project_id + rules_version` | A pure function of current data. Writes replace the prior row for that version |
| 6 | `digest.build` | subscription id, period | `digests`, `digest_items` | `subscription_id + period_start` | Unique `(subscription_id, lead_key)` means a lead is never sent twice |
| 7 | `digest.send` | digest id | provider message id | `digest_id` | The send is recorded before the provider call. A retry checks the provider by message id |

Stage 1 enqueues stage 2 for the raw ids it wrote; stage 2 enqueues 3 and 4;
4 enqueues 5. A failure stops that record's chain only. The admin page lists
failed jobs with their error and a retry button.

**Backfills** are stage 1 with an explicit historical cursor, on a separate
queue with concurrency 1 and lower priority. A backfill can therefore never
delay the daily sync (requirement 5.4).

**Dead letters:** a job that fails 5 times moves to `failed`. It is shown on
the admin page and counted in alerts, and never retried silently forever.

## 7. Normalization rules

- **Missing is explicit.** A field the source did not provide is `NULL`, never
  `''` or `0`. The prototype stores `valuation = 0` and `work_description = ''`
  for missing values; the migration converts these to `NULL` (M1).
- **The latest source value wins, and history is kept.** The prototype's
  `COALESCE(new, old)` upsert means a value cleared at the source stays forever.
  The new rule overwrites the current row with the source's latest mapped state
  and keeps every previous state in `permit_versions`. The exception is the
  prototype's protection for Accela, whose incremental runs deliberately omit
  detail fields. It survives as a per-source `partialFields` list, not as a
  global rule.
- **Status:** `status_raw` is kept verbatim. `status_stage` comes from
  `src/status.js` (kept as is). An unknown status is reported, never guessed.
- **Phones:** E.164 (`+15125550123`) in storage, formatted only for display.
- **Addresses:** stored raw plus parsed parts. Lat/lng comes from the source
  where it publishes coordinates (to verify per source), never from geocoding
  at request time.
- **Owner-builder detection:** contractor values like `OWNER`, `SELF`,
  `HOMEOWNER` or `N/A` (the prototype's list) set `permits.owner_builder = true`
  and create no contractor.

## 8. Contractor entity resolution

Portals issue no stable contractor id. Matching runs in strict order, and the
first rule that matches wins:

| Rank | Rule | Confidence | Auto-merge? |
| --- | --- | --- | --- |
| 1 | Same `(licence_state, licence_number)` | 0.99 | Yes |
| 2 | Same E.164 phone **and** normalized name similarity of 0.85 or more | 0.9 | Yes |
| 3 | Same normalized name **and** same business city | 0.75 | No, stored as a candidate |
| 4 | Name similarity only | below 0.75 | No, never stored as a match |

Name normalization:

- lowercase
- strip punctuation
- strip legal suffixes (`llc`, `inc`, `corp`, `co`)
- expand `const` to `construction` and `&` to `and`

Candidates (rule 3) appear in the UI as "possibly the same firm", which is the
prototype's current behaviour, and an admin can confirm or reject them. A
confirmed merge is recorded in `contractor_merges` and can be undone.

Licence enrichment joins on licence number where a state file exists:

- Texas TDLR "All Licenses" has a business phone for electrical contractors
  only (A/C contractors have none); it does not cover general contractors.
  Austin permits carry no licence number, so Texas joins use phone or name
  (rules 2 and 3), not rule 1.
- Texas TSBPE (plumbing) lists one person per row with the company name.
- Florida DBPR construction and electrical CSVs have no phone. Miami-Dade
  `ContractorNumber` matches the DBPR alternate licence number for 95.9% of
  permits once leading zeros are normalized.
- Measured 2026-11-13; see `docs/DATA_SOURCES.md`, "Enrichment sources".

## 9. Projects and the "trade gap" signal

A **project** groups permits that belong to one piece of work:

1. Same source and same `master_permit_number` (Miami-Dade publishes
   `MasterPermitNumber`). This is an official link, confidence 1.0.
2. Otherwise, same parcel (Austin `tcad_id`, Miami-Dade `FolioNumber`) and
   permits issued within 180 days of the project's first permit. This is
   inferred, confidence 0.7, and labelled "inferred" in the UI.
3. An address alone never groups permits (requirement 6.3).

**Trade gap**, the core lead signal: for each project with a primary
building permit (new construction, addition or remodel) and each trade T, the
gap is *open* if no permit for trade T exists in the project yet. It *closes*
when one appears, and the contractor who pulled it is recorded. That record is
competitive intelligence later.

**Unverified assumption:** Austin's trade permits can be linked to building
permits. M1 measures it (see [ROADMAP.md](ROADMAP.md)), and the signal ships
only if the link rate and the gap length make it useful.

## 10. Classification and scoring

**Classification** is deterministic first (ADR-6). Each source has a rule set
over its controlled vocabulary:

- Austin: `permit_type_desc`, `work_class`, `permit_class_mapped`
- Miami-Dade: `ApplicationTypeDescription`, `Category1..10`

Rules fall back to description regexes. Each rule set has a version, and every
`project_trades` row records the version that produced it. Changing rules means
a new version plus a re-run of stage 5, measured against a labelled sample of
500 permits per source. The current `src/scoring.js` rules are kept as the
description fallback, minus `roof-only` filtering for roofing.

**Two scores, never blended** (requirement 9.2):

```
relevance (0-100) = trade_fit x 40 + recency x 20 + value x 15 + stage x 10 + gap_open x 15
data_quality (0-100) = contact_present x 50 + contact_confidence x 30 + identity_confidence x 20
```

Weights live in config, per subscription. Each lead stores
`reasons: [{factor, value, points, evidence}]`, so a digest can say *why*. A
lead with poor data quality but high relevance is still shown, with "no
verified contact" stated.

**Timing** is labelled an estimate, always. For example: "Building permit
issued 12 days ago; in Austin, the median electrical permit for similar
projects follows at 21 days (estimated from N projects)." This appears only
once M1 has measured it.

## 11. Delivery: digests and feedback

- **Subscriptions** hold trade, ZIP or city list, minimum value, cadence
  (weekly by default) and the delivery address.
- `digest.build` picks the top 10 to 25 leads by relevance among those first
  seen since the last digest that were never sent to this subscription.
- **Email** goes through a transactional provider (Postmark or Resend, ADR-8)
  and carries a CSV attachment. *Built 2026-11-14 (ADR-20):* daily or weekly
  digests without the CSV yet, behind `src/email/providers.js`, dry run by
  default; signed job links are `/l/:token` and the unsubscribe `/u/:token`.
  Setup for real sends: `docs/EMAIL.md`.
- **Feedback links** on each lead are signed URLs, `/f/:token`. The token is
  an HMAC of `(digest_item_id, verdict)` and expires after 30 days, so one
  click records a verdict without a login. Verdicts:
  - relevant
  - not relevant
  - already knew
  - wrong contact
  - too late
  - outside my area
- A weekly check-in email asks two questions: did you call anyone, and did
  anything come of it. Answers are stored as `outcome_reports` with
  `self_reported = true`.

## 12. Compliance by design

See [COMPLIANCE.md](COMPLIANCE.md) for the reasoning. Mechanisms:

- `sources.compliance` records:
  - terms URL
  - terms reviewed on and by whom
  - whether automated access is allowed (`yes`, `no` or `unknown`)
  - whether redistribution is allowed
  - attribution text
  - retention days for raw payloads

  A source with `allowed = no` cannot be scheduled. With `unknown` it can run
  only in `dev`.
- `contact_points.party_kind` is `business`, `individual` or `unknown`, and
  `display_policy` is `show`, `hide` or `review`. The default for `individual`
  and `unknown` is `hide`. Owner names are stored but never shown or exported
  until the homeowner gate passes.
- `subscriptions.audience` is `b2b` or `homeowner`. A `homeowner` subscription
  can only be activated for a market whose `sources.homeowner_use` is
  `approved`, which is set by an admin after the ADR-10 gate. Its leads target
  the owner party and its vendor-appended contacts. B2B leads target the
  contractor.
- A `suppressions` table holds a phone, name or address pattern, the reason,
  the requester and the date. It is checked at digest build and at API read.
- Correction and removal requests: a form writes a `data_requests` row. An
  admin actioning it updates the suppression list and logs it to `audit_log`.
- The product never dials, texts or emails a contractor on a user's behalf.
  That removes us from autodialer and Do Not Call liability for user outreach
  (counsel to confirm).

## 13. Security model

| Area | v1 rule |
| --- | --- |
| Authentication | Admin and partner UI behind email magic-link login with a session cookie (`httpOnly`, `secure`, `SameSite=Lax`). No passwords stored. Feedback links use signed tokens, not login |
| Authorization | Roles: `admin`, `partner`. Every partner-visible row is filtered by `organization_id`. The admin routes check the role server-side |
| Secrets | Environment variables only (`DATABASE_URL`, `EMAIL_API_KEY`, `SESSION_SECRET`, `FEEDBACK_HMAC_KEY`). The `permits:permits` default stays for local docker only, and the app refuses to start in production without `DATABASE_URL` |
| Input | Existing whitelist of filter params and parameterized SQL (kept). Request bodies validated against a schema |
| Output | Existing `esc()` for all `innerHTML` (kept). 500 responses stop echoing `err.message` outside dev |
| Rate limits | 60 requests per minute per session on `/api`, 10 per minute per IP on login |
| Audit | `audit_log` for logins, exports, merges, suppressions and source enable/disable |
| Personal data | Individual contacts hidden by default (section 12). Raw payloads purged per source retention |

## 14. Monitoring and alerting

The `source_health` view per source shows:

- last attempted sync
- last successful sync
- records fetched, new and updated
- failed records
- publication lag (p50, p90)
- duplicate rate
- contractor match rate
- phone coverage

**Built (ADR-14, 2026-11-13):** `source_health` (last success, last attempt,
failures since, new rows in 7 days, warnings), `source_events` (schema drift,
truncation), and `health.yml`, an independent 6-hourly check that fails and
opens one `data-health` GitHub issue (emailed to watchers) when a source is
stale (no success in 1.5x its interval), its newest permit is older than
`maxDataAgeDays`, a mapped field vanished, the resolver failed, or storage
passes 80%. Volume anomaly, digest and enrichment alerts below are still to
build. Schema drift alarms but does not pause the source.

Target alerts (email first, Slack later; the admin page also shows them):

| Alert | Condition |
| --- | --- |
| Source stale | No successful sync in 2x the source's expected interval |
| Failing | 3 consecutive failed sync runs |
| Volume anomaly | New records per day outside 50% to 200% of the trailing 28-day median, for 2 days running |
| Schema drift | `probe` field-list hash differs from the stored one. Sync pauses for that source until an admin accepts the change |
| Enrichment drop | Contractor match rate falls 10 points below its trailing average |
| Digest failure | Any `digest.send` reaches dead-letter |

## 15. Migration from the prototype

Each step is one pull request that keeps `npm test` green:

1. Add docs, `CLAUDE.md` and CI (GitHub Actions running `npm test`). No code
   change.
2. Add the `db/migrations/` runner. Migration `001` equals today's
   `schema.sql`, so existing databases are unchanged.
3. Fix the scheduler defaults: Austin and Miami-Dade are on, Oregon is off.
   Pin these with a test.
4. Add `jurisdictions`, `sources`, `sync_runs` and `raw_records`, and write
   raw payloads alongside today's flow. Backfill `sources` from `src/sources.js`.
5. Split fetch from map in the Socrata and ArcGIS connectors, and record
   fixtures from live responses. The existing tests move over unchanged.
6. Add `updated_at` mode for Austin and `snapshot` mode for Miami-Dade.
7. Add `permit_versions` and switch the upsert from `COALESCE` to
   latest-plus-history. Convert `0` and `''` to `NULL`.
8. Add contractors, then projects, then classification v2, then leads.
9. Add pg-boss to replace the `setInterval` scheduler.
10. Add digests and feedback, then admin pages.

The Accela connector and the Oregon sources stay in the code, disabled
(ADR-5).

## 16. Performance targets

Measured, not claimed:

| Target | Value | How measured |
| --- | --- | --- |
| Daily sync complete | By 08:00 local time for every enabled source | `sync_runs.finished_at` |
| Austin incremental sync | Under 5 min | `sync_runs` duration |
| Miami-Dade snapshot sync | Under 15 min for ~140k rows | `sync_runs` duration |
| Permit search API | p95 under 300 ms at 2M permits, default filters | Load test in CI on a seeded DB |
| Re-run idempotency | 0 new permits, versions or digest items on 30 consecutive re-runs of the same window | Integration test |
| Digest build | Under 10 s per subscription | Job duration |

## 17. Deployment

- **Local:** `docker compose up` (Postgres 17 on :5433, as today; the image
  moves to `postgis/postgis:17-3.5` when the first geometry column lands),
  `npm run worker`, `npm run web`.
- **Production (proposed, ADR-7):** one managed Postgres with PostGIS, plus
  two services from one Docker image (`worker`, `web`). Railway is the
  recommendation, because it runs both from one repo with cron and Postgres.
  Fly.io is the alternative. Supabase works only for the database; it adds
  auth we don't need yet.
- **Production (as built, ADR-13):** the daily sync and resolver run in
  GitHub Actions (`sync.yml`) against Neon Postgres (ADR-7). The web app runs
  on Railway from `main` (`railway.json`, `node web/server.js`), reading the
  same Neon database. `DEMO_PASSWORD` puts the whole site behind a sign-in
  page with a signed session cookie (HTTP Basic also accepted, for scripts);
  `/healthz` stays open for the health check and touches no data.
  The app never writes to the database, so the web tier holds no ingest state.
- **CI:** GitHub Actions runs unit tests and, with a Postgres service,
  integration tests on every PR. Deploys go from `main` only.
- **Environments:** `dev` (local) and `prod`. A `staging` environment waits
  until there are paying users.

## 18. Cost estimate (hypothesis, to replace with measured numbers)

| Item | Monthly |
| --- | --- |
| Managed Postgres (small, ~10 GB) | $10 to $25 |
| Worker and web services | $10 to $30 |
| Transactional email (under 10k emails) | $0 to $15 |
| Government data (Socrata, ArcGIS, licence files) | $0 |
| Phone enrichment vendor | $0 in v1 (not used) |
| **Total at pilot scale** | **about $20 to $70** |

The first real variable cost would be paid contact enrichment for markets with
no phone in the record (Chicago, the City of Miami's own feed). That is
deliberately out of v1.

## 19. Early discovery, lifecycle and freshness (ADR-16, accepted 2026-11-13)

This section revises sections 1, 5, 6, 9 and 14 for the owner's
pre-approval strategy (`docs/PRD.md` v2). Where it conflicts with them, this
section wins (ADR-16 accepted 2026-11-13). The data model is in
`docs/DATA_MODEL.md`, "Lifecycle model".

### 19.1 Three levels of intelligence

| Level | What it is | Typical lead time before the building permit is issued | Example sources (verification status in `docs/DATA_SOURCES.md`, "Pre-approval scan") |
| --- | --- | --- | --- |
| 1. Pre-application signals | Zoning, site-plan, subdivision, variance cases; planning agendas; indirect filings (TABS registrations, TABC applications, ROW, tree permits, Florida Notices of Commencement) | Months to years; mostly commercial and multifamily | Austin site plan, subdivision and zoning cases; Austin Legistar; TDLR TABS; TABC `mxm5-tdpj` |
| 2. Submitted applications | Building filings visible before approval, with a lifecycle status | The plan-review time: Austin residential median 63 days (p90 300) | Austin Plan Review Cases (`n8ck-xkda`, same-day), Raleigh building and trade layers (pre-issue rows we currently drop), NYC DOB NOW filings, Orlando, New Orleans, Seattle |
| 3. Issued permits and trade permits | What we ingest today | 0 | All four live markets |

Historical relationships connect all three: the architect on a site plan is
also on earlier building permits, whose GCs pulled permits with known subs.

### 19.2 Ingestion cadence: measured, not wished

The polling interval for each source is the **shorter of** its measured
publication cadence and what its terms and rate limits allow, never shorter.
Polling a daily-reloaded dataset every 5 minutes buys nothing and costs
goodwill.

| Cadence tier | When a source qualifies | Mechanism |
| --- | --- | --- |
| 5-15 min | The source changes intra-day (measured: two metadata probes in one day show different `rowsUpdatedAt` / `lastEditDate`, or row counts move) **and** its terms allow it | Cheap metadata probe every 5-15 min; full incremental fetch only when the probe changes |
| Hourly | Intra-day changes a few times a day | Same probe-then-fetch |
| 3-6 h | Daily publish at an unknown hour | Probe every 3-6 h so the daily drop is caught within hours, not a day |
| Daily | Daily or slower publish, or terms that ask for restraint | Current `sync.yml` |
| Weekly | Weekly refresh (Miami-Dade county layer) | Snapshot diff |

Each source's registry entry gets `publishCadence` (measured), `pollInterval`
(chosen) and `probe` (the metadata call). A 14-day snapshot job records
`rowsUpdatedAt` / `lastEditDate` every 15 minutes for every enabled source;
its output decides the tier. Until that runs, every source stays daily.

**Infrastructure consequence.** GitHub Actions cron is fine for daily and
6-hourly jobs, but its schedule is best-effort (runs start minutes to an hour
late under load) and the minimum interval is 5 minutes, so it cannot honestly
promise 15-minute discovery. Sub-hourly tiers need the always-on worker
(ADR-3) with pg-boss, on Railway beside the web process. That is a cost
decision for the owner, taken only after the snapshot job shows a source that
actually changes intra-day.

### 19.3 Event-driven pipeline with progressive enrichment

The stage chain in section 6 is kept; what changes is that **search
visibility no longer waits for enrichment**.

```
probe (cheap) --changed--> fetch --> raw_records --> normalize --> SEARCHABLE (searchable_at)
                                                         |
                                                         +--> lifecycle diff --> lifecycle_events --> alert match --> alert queue
                                                         |
                                                         +--> enrich (async, each provider its own job, may fail alone):
                                                                parcel / property, geocode, licence, entity resolution,
                                                                history lookup, relationship rollup, early-opportunity score
                                                                     |
                                                                     +--> re-score --> second alert only if the score crosses the subscriber's threshold
```

- **Immediately (stage 2):** filing number, stage, address, description,
  submitted date, named participants as written.
- **After enrichment (minutes):** resolved businesses, property facts,
  location, historical portfolios, relationships, score.
- **After verification (hours to days):** licence corroboration, confirmed
  entity merges, admin review.

Each enrichment job writes its own `*_at` timestamp and failure; a slow or
failing provider leaves the filing searchable with that section marked
"pending" or "unavailable", never blank-as-missing (rule 1).

Alerts carry what is known at send time and say what is still pending. One
alert per project per meaningful event; a later enrichment does not resend
unless the score crosses the threshold.

### 19.4 Freshness and latency metrics

All timestamps are UTC `TIMESTAMPTZ`, recorded by the stage that completes.

| Metric | Formula | Notes |
| --- | --- | --- |
| Discovery latency | `first_seen_at - submitted_on` | Includes the source's own publication delay. Only for sources that publish a submission date |
| Source publication delay | `first_seen_at - first_public_at` | Only where the source states a creation time; otherwise "unknown" and never estimated as zero |
| Processing latency | `searchable_at - first_seen_at` | Target p95 under 5 min once the worker exists |
| Enrichment latency | `enriched_at - searchable_at`, per provider | |
| Alert latency | `alert_deliveries.sent_at - lifecycle_events.observed_at` | |
| Source staleness | `now() - last successful sync` and `now() - newest record date` | Already in `source_health` |
| Early-capture rate | Share of eventually issued permits first seen at `submitted` / `in_review` / earlier | The headline metric for the strategy. Requires `observed_stage_at_first_seen` |
| On-target rate | Share of filings found within the source's target window (for example 24 h after first availability) | |

**No competitor comparisons** are shown or claimed until a recorded
side-by-side (the same filings, timestamps from both systems) exists.

### 19.5 Source health additions

`source_health` (ADR-14) gains: zero-record runs on a source that normally
returns rows; volume outside 50-200% of the same weekday's trailing 28-day
median; a probe that says "unchanged" for longer than 2x the measured publish
cadence (a successful call on stale data); and polls that fall behind their
tier. Each raises a `source_events` row and the `data-health` issue.

### 19.6 Early Opportunity Score

A separate score, never blended with relevance or data quality (section 10).

```
early_opportunity (0-100) =
    stage_window(trade, stage)      x 35   -- per-trade prior: how open this stage usually is for this trade
  + recency(first_seen_at)          x 15
  + participant_gap                 x 15   -- the role this subscriber sells to is not yet named
  + project_size(value or units)    x 10
  + area_fit                        x 10
  + history_signal                  x 10   -- the named participants' past projects in this trade and area
  + contact_available               x  5
```

- `stage_window` is a table per trade, not a constant. For a sub selling to
  GCs, a residential remodel is most open between GC naming and the trade
  permit; for a GC selling to owners and architects, the planning stage is the
  window. The starting values are hypotheses and are labelled so until
  design-partner outcomes calibrate them.
- Each project is labelled **Early opportunity** (pre-application or
  submitted), **Active opportunity** (in review, corrections, approved),
  **Issued**, or **Historical**. The label is the stage, not the score: an
  early project can score low for a trade that is hired late.
- Data confidence is shown beside the score, never inside it.

### 19.7 What does not change

Rules 1 to 10 in `CLAUDE.md`: no guessed field maps, no scraping behind logins
or CAPTCHAs (ADR-5 stands; a portal-only source needs its terms read and a
written decision before any automated access), owner individuals hidden
(ADR-10), provenance on every value.
