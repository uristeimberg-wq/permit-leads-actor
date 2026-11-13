# Decisions

Each decision gets a number, a date, a status, the context, the decision, and
what would make us revisit it. Never delete an entry; supersede it.

---

## ADR-1: B2B only for v1

- **Date:** 2026-11-13. **Status:** amended by ADR-10 (homeowner leads are in scope as a second track).
- **Context:** Permit records name both businesses (contractors) and
  individuals (owners, owner-builders). Historically, outreach to homeowners
  has been the biggest market for permit leads. It also carries the most risk:
  TCPA, Do Not Call, state mini-TCPAs, and state data-broker laws.
- **Decision:** v1 serves contractors and suppliers selling to contractors.
  Owner names are stored for grouping and analysis. They are never displayed or
  exported. Individual-looking contact points default to hidden.
- **Revisit when:** counsel has reviewed homeowner use, and a paying segment
  asks for it.

## ADR-2: One Postgres, no extra infrastructure until measured

- **Date:** 2026-11-13. **Status:** proposed.
- **Context:** The prototype already runs on Postgres. Pilot scale is two
  jurisdictions, roughly 1 to 3M permits including history.
- **Decision:** PostgreSQL holds the data, the job queue (pg-boss), full-text
  search (existing tsvector) and geo (PostGIS). No Redis, Elasticsearch or
  message broker.
- **Revisit when:** search p95 exceeds 300 ms at the default filters, or the
  queue's throughput limits the daily sync.

## ADR-3: Separate worker and web processes from one codebase

- **Date:** 2026-11-13. **Status:** proposed.
- **Context:** Today the scheduler runs as a `setInterval` in a long-lived
  process. A backfill or a slow portal can block it, and a web deploy would
  restart it mid-sync.
- **Decision:** One Docker image, two entry points (`worker`, `web`), deployed
  as two services.

## ADR-4: Stages are independent, idempotent jobs; raw data is stored first

- **Date:** 2026-11-13. **Status:** proposed.
- **Context:** The prototype maps records during fetch and upserts with
  `COALESCE`. So a mapping bug needs a re-fetch, and a value cleared at the
  source is never cleared here.
- **Decision:**
  - Append-only `raw_records` keyed by content hash.
  - Mapping is a pure function over the raw records.
  - Permits keep their latest source state, plus `permit_versions`.
  - Every stage has an idempotency key (ARCHITECTURE.md section 6).

## ADR-5: Accela browser scraping is out of the pilot

- **Date:** 2026-11-13. **Status:** proposed.
- **Context:** The Accela connector drives a real browser (Playwright) against
  Oregon ACA portals. It runs at about 7 s per permit and caps at about 100
  records per run. It yields no contractor contact. Oregon is not a target
  market. Browser automation of a citizen portal also has unclear
  terms-of-use status.
- **Decision:** Keep the code and its tests, disable the sources, and remove
  Playwright from the default production image. Re-enable only for a target
  market whose terms allow automation or that gives written permission.
- **Revisit when:** a target market's only source is an Accela portal.

## ADR-6: Deterministic classification first

- **Date:** 2026-11-13. **Status:** proposed.
- **Context:** Trade relevance must be explainable to a sub ("why is this in my
  list?") and testable.
- **Decision:**
  - Versioned rules over each source's controlled vocabulary first, then
    description regexes.
  - Each version is measured against a labelled sample of 500 permits per
    source.
  - An LLM classifier is considered only if it beats the rules on that sample,
    and it would still emit stored, reviewable labels.

## ADR-7: Hosting

- **Date:** 2026-11-13. **Status:** accepted for the data phase (decided by
  Yuval).
- **Options considered:**
  - **GitHub Actions cron plus Neon Postgres (free tier):** about $0/month.
  - **Railway:** Postgres, two services and cron in one project. About
    $5-20/month.
  - **Fly.io:** cheaper at idle, but more manual setup.
  - **Supabase:** Postgres only, plus auth we don't need yet.
- **Decision:** The daily sync runs as `.github/workflows/sync.yml` against
  Neon, with the connection string in the `DATABASE_URL` repo secret. A
  sync is about 20 requests for Austin and a few for Miami-Dade, so it uses
  well under the private-repo Actions allowance. Vercel builds previews of
  the repo, but serverless functions don't fit a scheduled worker, so it isn't
  used for sync.
- **Revisit when:** the web app has to be live for pilot users (likely Railway
  then), or the Neon free tier's storage gets tight.

## ADR-8: Email provider

- **Date:** 2026-11-13. **Status:** open (Postmark or Resend).
- **Criteria:**
  - deliverability to small-business inboxes (Gmail and Outlook)
  - open and click webhooks
  - a free tier above 1,000 emails a month
- **Decide by:** M3.

## ADR-9: Pilot markets: Austin, then Miami-Dade

- **Date:** 2026-11-13. **Status:** proposed.
- **Context:** Both already work in the prototype. Austin publishes daily, with
  the contractor's company and phone on the permit. Miami-Dade's county layer
  has phone (82% coverage per the prototype), owner and master permit number,
  but updates about weekly, and its municipal coverage is unverified.
- **Decision:** Pilot in Austin first, add Miami-Dade second, and consider
  Dallas or Orlando third. See DATA_SOURCES.md.
- **Revisit when:** M1 measurements (phone coverage, publication lag, trade-gap
  link rate) come back.

## ADR-10: Homeowner leads are in scope, as a second track

- **Date:** 2026-11-13. **Status:** accepted (decided by Yuval: in scope,
  B2B ships first).
- **Context:** Selling to homeowners (roofing, solar, pools, windows) is the
  largest historical market for permit leads. It is also the most crowded: most
  of the Apify permit scrapers target it. And the official data rarely
  supports it:
  - Austin publishes no owner field.
  - Miami-Dade publishes `OwnerName` but no owner phone.

  A usable homeowner lead therefore needs a paid phone or address append (skip
  tracing). That brings vendor cost, plus TCPA, Do Not Call, Florida
  s. 501.059 and data-broker obligations.
- **Decision:**
  - The data model and pipeline support both audiences from the start.
  - Every subscription has an `audience` (`b2b` or `homeowner`), and every
    contact point a `party_kind`.
  - The pilot ships B2B first.
  - Homeowner delivery is enabled per market only after three things: counsel
    has answered the homeowner questions in COMPLIANCE.md, a contact vendor is
    chosen with documented permitted use, and suppression and Do Not Call
    scrubbing exist.
  - Until then, owner names are stored but never displayed or exported.
- **Revisit when:** Yuval chooses a different sequencing.

## ADR-11: Austin syncs by date windows, not `:updated_at`

- **Date:** 2026-11-13. **Status:** accepted. It supersedes the Austin row of
  the sync-mode table in ARCHITECTURE.md, which assumed `updated_at`.
- **Context:** A live probe (`recon/feasibility.js --only=austinUpdatedAt`,
  2026-11-13) found the following:
  - **`:updated_at`:** all 2,385,068 rows have it between 15:18 and 15:47 UTC
    on 2026-11-12.
  - **`:created_at`:** every row has the same value, 12:40 that day.
  - **`statusdate`:** it is populated on every row. 5,614 rows changed status
    in the last 7 days, and 4,141 of those were issued more than 30 days ago.

  The publisher reloads the whole dataset daily. An `updated_at` cursor would
  therefore re-pull 2.4M rows a day.
- **Decision:** Austin uses `date_window` with two overlapping windows:
  - `issue_date` in the last 30 days. This covers the 2-3 day arrival lag
    with a wide margin.
  - `statusdate` in the last 14 days. An issue-date window would miss status
    changes on old permits.

  Raw-record hashes make the overlap free: unchanged rows are no-ops. The
  source's update time is not used for freshness. Freshness is measured from
  our own first-seen time (snapshots).
- **Revisit when:** the probe shows `:updated_at` moving per row (re-run it
  monthly), or Austin publishes a change feed.

## ADR-12: Contractor resolution is deterministic and merges only on strong keys

- **Date:** 2026-11-13. **Status:** accepted. It refines the resolution order
  in ARCHITECTURE.md ("licence, then phone and name, then name and city as a
  candidate").
- **Context:**
  - A wrong merge invents a company and corrupts every count built on it: GC
    relationships, permit counts, contact phones. A missed merge only splits
    one firm into two rows.
  - Phones are not identities: 49 Austin phones appear under 2+ company names,
    including permit expediters and shared office lines.
  - Austin publishes no contractor licence number. Miami-Dade does
    (`ContractorNumber`).
- **Decision:** `src/contractors.js` (`contractors-v1`), run as
  `ingest/resolve.js` after every sync, rebuilds from the latest raw record of
  each permit.
  - **Merge rules:**
    1. Licence number within a state (confidence 0.95).
    2. Otherwise the exact normalized business name within a state, with
       legal forms and punctuation removed and trade words kept
       (confidence 0.80).
  - **Near misses are not merged:** "Radiant Plumbing & AC" and "Radiant
    Plumbing and Air Conditioning" stay two rows until a reviewed merge
    (`contractor_merges`, later).
  - **Phones are evidence, not keys:**
    - A phone is `corroborated` only when it is on 3+ permits for that
      contractor and on no other contractor.
    - A person-like name ("John Smith") is `individual`, and its phone is
      hidden.
    - An unclear name is held for `review`. Only `show` reaches a client
      (rule 5).
  - **Owner-builders** (`OWNER`, `HOMEOWNER`, ...) are never contractors.
  - **GC to sub:** within one job (Austin permit-number base, Miami-Dade
    master permit), the building permit's contractor is the GC and each
    trade permit's contractor is a sub. A job with two different GCs is
    skipped as ambiguous.
- **Revisit when:** licence files (TX TDLR, FL DBPR) are loaded. They give
  Austin firms a licence key and allow corroboration against an independent
  source.


## ADR-13: Live demo on Railway, behind a shared password

- **Status:** accepted, 2026-11-13 (owner chose Railway)
- **Context:** the sales team needs a URL showing real data. The sync already
  runs in GitHub Actions against Neon (ADR-7); only the read-only web app needs
  a host.
- **Decision:** Railway runs `node web/server.js` from `main`, with
  `DATABASE_URL` (Neon) and `DEMO_PASSWORD` set in Railway's variables. The
  whole site needs HTTP Basic auth while `DEMO_PASSWORD` is set.
  *Amended 2026-11-13:* the browser's Basic-auth popup was the first thing a
  prospect saw, so browsers now get a branded sign-in page (`/login`) that
  sets a signed, HttpOnly, SameSite=Lax, Secure session cookie for 7 days,
  with failed sign-ins rate limited per IP. Basic auth is still accepted (never
  requested) for scripts such as `smoke.yml`. Same `DEMO_PASSWORD`; changing
  it signs everyone out. See `web/access.js`.
- **Consequences:** about $5/month after the trial. A shared password is a
  demo control, not customer auth: per-subscriber signed links (PILOT_UX) are
  still to build before a paying pilot. The live screens show only
  `display_policy = 'show'` phones and withhold names that look like people
  (rule 5).

## ADR-14: Production data pipeline: keep the Actions scheduler, add an independent alarm, then enrich by official keys

- **Status:** accepted, 2026-11-13 (owner asked for production-grade daily
  sync plus enrichment; approved the six-step plan)
- **Context:** volume is small (Austin about 160 permits a day; the daily sync
  takes about a minute), so scale is not the risk. The risk is silent failure:
  a sync that never starts records nothing, a renamed column quietly empties a
  field, and storage runs out. The owner also wants permits cross-referenced
  with addresses, property details and contractor phones.
- **Decision:**
  1. Keep GitHub Actions as the scheduler (ADR-7). Add a retry (one re-run
     after 10 minutes), a `source_health` view, `source_events` (schema drift,
     truncation), and `health.yml`: an independent check every 6 hours that
     fails, and opens or updates one `data-health` issue, when a source is
     stale, its newest permit is older than `maxDataAgeDays`, a mapped field
     vanished, the resolver failed, or storage passes 80%. Schema drift is
     recorded and alarmed, not auto-paused: pausing a source on a cosmetic
     column change costs a day of data.
  2. Superseded raw payloads are deleted after `raw_retention_days`
     (default 90); the latest payload per permit is kept forever.
  3. Enrichment joins only on official keys, never on fuzzy matches: licence
     number (TDLR, Florida DBPR), parcel ID (`tcad_id` to Travis CAD,
     `FolioNumber` to the Miami-Dade Property Appraiser), and geocoding from
     the US Census geocoder. Every enriched value keeps its source, fetch time
     and key (rule 6). Owner names in appraisal data are stored only if needed
     for the join and are never displayed (rule 5, ADR-10).
  4. New markets plug in through one connector contract (ARCHITECTURE §4) with
     a verified field map, a recorded fixture, health thresholds and terms.
- **When to revisit:** move scheduling to a dedicated worker (Railway cron or
  pg-boss) when a source needs syncing more than daily, a run approaches the
  Actions time limit, or there are more than about five markets.
- **Known gaps:** Texas has no state general-contractor licence, so GC phones
  can be corroborated only across permits, never against a registry. Florida's
  licence files carry no phone.

## ADR-15: Enrichment, measured: what each source is used for, and its limits

- **Status:** accepted, 2026-11-13. Refines ADR-14 item 3 with the live
  measurements in `docs/DATA_SOURCES.md` ("Enrichment sources", PR #27) and
  the compliance review (PR #28).
- **Context:** ADR-14 assumed licence files would supply contractor phones.
  Measured, they mostly don't: permits already carry a phone on 91% (Austin)
  and 82% (Miami-Dade) of rows; TDLR adds a phone for about 60% of electrical
  and about 10% of HVAC permits; Florida DBPR has no phones.
- **Decision:**
  1. **Licences verify, they don't supply phones.** TDLR, TSBPE and DBPR give
     licence status and confirm the business (DBPR matches 95.9% of Miami-Dade
     permits after dropping leading zeros). A TSBPE phone is treated as a
     person's contact (rule 5). Show a TDLR credit wherever its data appears.
  2. **Parcels by the appraiser's own id.** `parcels` and `permit_parcels`
     (migration 012) join on the folio from each permit's latest raw payload.
     Only non-owner fields are requested (`outFields` is an explicit list).
     Zeros become NULL. A parcel the appraiser lacks is stored as
     `found = false` so it is not asked for daily. Parcels are re-read after
     the provider's `refreshDays` (Miami-Dade: weekly). Enrichment providers
     are `sources` rows with `role = 'enrichment'`, so their runs are in
     `sync_runs` and the health alarm watches them.
  3. **Travis CAD is internal only** until its terms are checked: nothing derived
     from it is displayed. *Superseded 2026-11-13:* the compliance review
     (PR #38) cleared the property facts under its use rules (docs/COMPLIANCE.md,
     "Travis CAD use rules"). `ingest/enrich_tcad.js` reads an allowlist of
     positions, skips confidential and address-suppressed parcels, sums
     homestead splits, and the API labels values "Appraisal estimate, <year> roll".
  4. **Census geocoder: job-site addresses only.** Its terms forbid using its
     data to identify a business, so contractor business addresses are never
     sent to it. Geocode only where the source has no coordinates (Austin has
     them on about 61% of recent permits; City of Miami on all; the Miami-Dade
     county layer gets them from the appraiser).
  5. **Attribution is data.** Each source's credit line is its
     `sources.attribution_text` and is shown with its data (City of Miami
     CC BY 4.0; Property Appraiser "as is, for illustration only").
- **Consequences:** City of Miami permits have no phones; they can be filled
  only by matching the same business in the county layer or a licence file
  (step 4).
