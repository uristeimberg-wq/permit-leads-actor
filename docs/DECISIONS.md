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

- **Date:** 2026-11-13. **Status:** open (recommendation: Railway).
- **Options:**
  - **Railway:** Postgres, two services and cron in one project.
  - **Fly.io:** cheaper at idle, but more manual setup.
  - **Supabase:** Postgres only, plus auth we don't need yet.
- **Decide by:** M2, when the first scheduled production sync is needed.

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

