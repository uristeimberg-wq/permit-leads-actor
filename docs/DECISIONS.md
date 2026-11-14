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

- **Date:** 2026-11-13. **Status:** open (Postmark or Resend). *Amended
  2026-11-14 by ADR-20:* both are built behind one interface; Resend is the
  recommended first account. The final pick still waits on deliverability
  measured on real sends.
- **Criteria:**
  - deliverability to small-business inboxes (Gmail and Outlook)
  - open and click webhooks
  - a free tier above 1,000 emails a month
- **Decide by:** M3.

## ADR-9: Pilot markets: Austin, then Miami-Dade

- **Date:** 2026-11-13. **Status:** proposed; superseded for the
  early-discovery track by ADR-16 item 3 (Austin, then Raleigh), accepted
  2026-11-13.
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
- **Amended 2026-11-14 (`contractors-v2`, ADR-18):** place words ("of
  Texas", "TX", "Florida", "FL", trailing "of") are no longer stripped from the
  name key. v1 merged different legal entities with generic or brand names
  ("Pool Builders of Texas" with "Pool Builders Inc"; "Meritage Homes of Texas
  LLC" with "Meritage Homes Corporation"). Under this ADR a missed merge is the
  cheaper error, so variants that differ only by a place word now stay
  separate until a reviewed merge or a licence key joins them. Brand grouping
  (all Meritage entities) is a separate, reviewed level (DATA_STRATEGY
  section 6), never the merge key. The same key is used for licence name
  matching, so a licence filed as "X of Texas" no longer attaches to "X Inc".


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

## ADR-16: Early discovery and the full lifecycle become the core of the product

- **Date:** 2026-11-13. **Status:** accepted 2026-11-13 (owner: "Do what you
  recommend"). Supersedes the "weekly digest of issued permits" framing of the
  v1 PRD and, for the early-discovery track, ADR-9's market order.
- **Context:** The owner wants the platform to find construction before a
  permit is approved, track every filing through its lifecycle, build
  historical portfolios and relationships for every business role, and
  measure its own speed. Facts that bear on it: Austin's open dataset holds
  issued permits; Austin plan review takes a median of 63 days; 94% of trade
  permits go to a sub the GC already used; Dodge and ConstructConnect already
  sell planning-stage commercial projects researched by hundreds of staff
  (`docs/DATA_SOURCES.md`, "Competitor coverage").
- **Decision:**
  1. The unit of record is the filing, the unit of product is the project,
     and a project keeps one id from its first signal to completion
     (`docs/DATA_MODEL.md`, "Lifecycle model"). A status change is an event,
     never a new lead.
  2. Every filing stores the official submission date and our first-observed
     time separately, plus the stage it was in when first seen.
  3. Market selection weights the Pre-Approval Data Availability Score
     (`docs/DATA_SOURCES.md`) heavily, alongside volume, contacts, terms and
     demand. Measured 2026-11-13: Austin 89, Raleigh 85, City of Miami 41,
     Miami-Dade 25. Early-discovery pilot order: **Austin, then Raleigh**.
     Miami stays live for issued permits and the GC-sub view; its early track
     is the Notice of Commencement experiment (paid clerk feed, owner's call).
  4. Polling cadence per source is measured first (14-day metadata probe),
     then set; no source is polled faster than it changes or than its terms
     allow. Sub-hourly tiers require the always-on worker and the owner's cost
     approval.
  5. Search visibility does not wait for enrichment.
  6. Historical associations are never presented as participants in a new
     project; four labels are kept apart (confirmed, historical, potentially
     relevant, unverified).
  7. Early discovery adds sources and stages; it does not relax rules 1 to 10.
     Portal-only application data (Accela, AMANDA, EnerGov, Tyler) stays off
     until its terms are read and a written decision allows automated access;
     public-records requests are the lawful route where a portal is the only
     window.
  8. **Owner's choices, 2026-11-13:** (a) early track in Austin, then
     Raleigh; Miami stays live for issued permits and the GC-sub view;
     (b) the first customers for application-stage leads are **GCs, builders
     and suppliers**, not subcontractors (the 94% stickiness finding); subs
     keep the issued-permit and GC-relationship product; (c) the database
     moves from Neon Free to **Neon Launch** (usage-based, roughly $3-15 a
     month at current size; the owner upgrades it in the Neon console),
     replacing the earlier same-day choice to stay on Free (ADR-7 hosting,
     ROADMAP M2b "Database plan"); (d) the Miami-Dade
     Notice of Commencement feed waits until Austin proves the model
     (ROADMAP E go/no-go).
- **Revisit when:** the early-capture rate in the first pre-approval source is
  under 50% (most permits are first seen only when issued), or design
  partners report that projects found at application stage were no more
  winnable than issued ones.

## ADR-17: Trade scores for electrical, plumbing and HVAC read the permit type first

- **Date:** 2026-11-14. **Status:** accepted (owner approved the proposal's recommendations).
- **Context:** the prototype's rules were written for Portland prose. On 95
  recorded permits from the four pilot markets they gave 8 non-jobs (a
  City of Miami parking lot, driveway, trusses, garage door) 95 points for
  every trade and missed 5 of the 6 new homes. Evidence and before/after:
  `docs/TRADE_SCORING.md`.
- **Decision:** electrical, plumbing and HVAC are scored by ordered rules in
  `src/scoring.js`: (1) a trade permit is never a lead, because its sub is
  already on the job; (2) permit types that are not building work score 0;
  (3) new homes and units score 90 for all three; (4) site and envelope work
  scores 0, pools included; (5) additions and build-outs 65, or 85 when they
  name the trade; remodels naming the trade 75; other mentions 50; City of
  Miami itemized trade lines 50, labelled as likely the sub's own permit.
  Commercial work is scored like residential for now. Flooring, painting and
  roofing keep the prototype rules. Stored rows are re-scored once with the
  sync workflow's `rescore` input (`ingest/rescore.js`).
- **Revisit when:** a production sample of 30 hits and 30 misses per market
  shows more than 5 wrong in either set, or a customer asks for commercial
  work separated.

## ADR-18: Early-signal data strategy: link official keys and keep history, prove before adding sources

- **Date:** 2026-11-14. **Status:** accepted 2026-11-14 (owner: "Approve,
  start the pilot"). Builds on
  ADR-16; does not relax rules 1 to 10.
- **Context:** The owner asked for a proprietary data advantage from
  overlooked, lawful sources (brief of 2026-11-14). Five research workers
  checked Austin, Texas and competitor sources (`docs/DATA_STRATEGY.md`,
  `docs/research/2026-11-14-early-signals/`). Facts that bear on it: no
  exclusive Austin dataset exists; Zabalist already sells Austin site plans,
  TCAD and TDLR data from $49 a month; Austin's planning datasets keep only the
  current status; AMANDA keys (`folderrsn`, `propertyrsn`) and case numbers
  cited in permit descriptions give official links; the current resolver
  merges unrelated firms with generic names; Legistar's PDF host disallows all
  robots.
- **Decision:**
  1. The advantage is built from official links, history we snapshot from now
     on, entity precision and the GC-sub relationship layer, not from
     exclusive access. Sales copy never claims exclusive data.
  2. Every new source enters `docs/research/source_registry.json` (later the
     `source_registry` table) with the nine-criterion score; legal
     feasibility is a gate. After the backtest, measured marginal
     pre-application capture replaces estimated uniqueness and coverage.
  3. Project existence is labelled on the L1-L4 evidence ladder, separately
     from the four participant labels. Only official evidence promotes;
     terminal statuses demote.
  4. Pilot scope: Austin plan review and permits (live) plus site plans,
     subdivisions, affordable housing and the demolition signal; proven by
     the P0 backtest, P1 competitive check and P2 forward test before any
     other connector.
  5. ROADMAP E reports application capture and pre-application capture
     separately; the 80% gate applies to the first only.
  6. No automated source-discovery engine, general document AI pipeline or
     graph database now; the minimum versions in `DATA_STRATEGY.md`
     section 9 instead.
  7. Owner names stay hidden; showing a business buyer of land needs its own
     ADR and counsel.
- **Owner's choice, 2026-11-14 (after P0 and P1):** "Homes first, apartments
  as context". The Austin early list leads with single-family and small
  residential building applications (plan review), the builder behind each and
  its subs; multifamily and commercial site plans are shown as context with
  their measured rate (22% reach a new main building within 24 months), never
  as upcoming construction.
- **Revisit when:** the backtest shows pre-application capture under 10% in
  every segment (drop the planning feeds), or the competitive check shows a
  competitor already delivers the same plan-review intake with GC-sub history.

## ADR-19: Show the business that filed an Austin application, with its role and evidence

- **Date:** 2026-11-14. **Status:** accepted (implements the owner's
  "Homes first, apartments as context" choice under ADR-18; pilot P2).
- **Context:** Austin's plan-review cases (`n8ck-xkda`) name no contractor.
  They do name organisations in `applicant_organization_name` (62% filled)
  and `other_organization_name`: builders, owners' companies and permit
  expediters. A list that shows only the address is not actionable for a
  supplier or sub; one that calls an expediter "the builder" is wrong.
- **Decision:**
  1. Read only the two organisation fields. `*_full_name`, phones,
     addresses and every owner field stay unread for display (rule 5). An
     organisation equal to `owner_organization_name` is the owner and is not
     stored as a filer.
  2. Classify each organisation on evidence, never by field
     (`src/filers.js`, `filers-v1`): *expediter* when its name says so, or
     when 5+ linked building permits were pulled by 3+ other contractors and
     under 20% by itself; *builder* when it pulled at least half of 2+ linked
     building permits, or its name equals a contractor on Austin building
     permits we hold (unless its linked permits say otherwise); otherwise
     *unknown*, shown as "filed by" with no role. The basis is stored and
     shown on hover; the raw record id goes with it (rule 6).
  3. Show a filer only when its name reads as a business, or equals a
     business-kind building contractor. Person-looking names are withheld.
  4. For a builder, show its top three past subs per trade from
     `contractor_relationships`, labelled as history from issued permits,
     never as this job's subs.
  5. The Early screen defaults to new homes (census classes 101-104) in
     Austin; apartments (105) and commercial (213-214, 318-328) are separate
     views with the backtest's site-plan rate as context. Site plans are not
     ingested yet (rule 10 first).
- **Consequences:** `filing_filers` and `filer_orgs` (migration 018), rebuilt
  daily by `ingest/filers.js` after resolve and lifecycle. With only weeks of
  plan-review history, behavioural evidence is thin at first; most builders
  are found by name match until linked permits accumulate (a 12-month
  plan-review backfill would fix that).
- **Revisit when:** a design partner reports a wrong role, or the measured
  agreement between filer and later building contractor falls under 50% for
  orgs we call builders.

## ADR-20: Customer email digests: dry run by default, one provider interface, signed links

- **Date:** 2026-11-14. **Status:** accepted (owner approved building
  customer email reports, digest first; saved searches with alerts and CSV
  export follow).
- **Context:** customers could only open the app or a shared demo password.
  Nothing reached them. The owner has no sending domain yet, so nothing can
  be sent today, but the digest can be built, checked and previewed now.
- **Decision:**
  1. A subscription (`digest_subscriptions`, migration 019) is one address,
     one market, its trades and an optional early-filings segment (homes,
     apartments, commercial or all), daily or weekly. Set with
     `npm run digest:subscribe` until there is a sign-up screen.
  2. `ingest/digest.js` runs as the last step of the daily sync. Each email
     carries only records first seen since that subscription's last email and
     never sent to it before (`digest_items` primary key), at most 25 per
     section with a count of the rest. Old records a backfill marks as new are
     kept out (issued, or submitted, in the last 30 days). An empty digest is
     not sent. One `digest_sends` row per subscription, mode and day: a re-run
     sends nothing new; a failed send is retried by the next run that day,
     one left `started` is not (the provider may have accepted it).
  3. Content: early filings first (Austin new homes by default, ADR-19) with
     the filer and its role, an expediter flagged as not the builder, the
     builder's tap-to-call phone and its past subs for the subscriber's
     trades; then, per trade, new building permits with no permit for that
     trade on the job yet, with the contractor and phone. Same privacy and
     suppression rules as the screens (it reads `db/pilot_queries.js`). Each
     item names its permit number with the city's link; the header states the
     last sync, the publication lag and a failed or stale sync.
  4. Every email has a one-click unsubscribe (footer link plus RFC 8058
     `List-Unsubscribe` and `List-Unsubscribe-Post` headers) and the postal
     address from `MAILING_ADDRESS`. Unsubscribing suppresses the address for
     every Contractos email (`email_suppressions`), not one list. A GET only
     shows a confirm button, because mail scanners open links.
  5. Job links are signed (`/l/<token>`, HMAC-SHA256 with `LINK_SECRET`,
     60-day expiry). A token opens one permit's page for one subscription and
     nothing else; it is not a login. The full app stays behind the password.
  6. Providers sit behind `send(msg)` in `src/email/providers.js`: `dryrun`
     (default, writes files), `resend` and `postmark`. A real send needs
     `EMAIL_SEND_ENABLED=yes` and every setting a lawful send needs; anything
     missing makes the run refuse and list it. `EMAIL_ALLOWLIST` restricts
     real sends to named addresses for a first test. No open or click
     tracking.
- **Consequences:** previews at `/digest/preview` (behind the password) and a
  `digest-preview` artifact on every sync run. Setup steps for real sends are
  in `docs/EMAIL.md`. SES is not built (it needs request signing); add it
  behind the same interface if cost requires. Bounce and complaint webhooks
  are not wired yet: until they are, check the provider dashboard and add
  bounced addresses to `email_suppressions` by hand.
- **Revisit when:** the first real sends show deliverability problems, a
  customer asks for a different time of day (sends follow the 17:15 UTC
  sync), or saved searches replace the fixed subscription fields.

## ADR-21: Three estimates from our own history: issue window, trade timing, builder momentum

- **Date:** 2026-11-14. **Status:** accepted (the owner asked for features
  competitors lack, built on ADR-17/18 edges; the email digest, ADR-20, is
  parked).
- **Context:** our edges are official links, history we snapshot, entity
  precision and GC-sub history (DATA_STRATEGY section 1). Lists of permits are
  commodity; what a builder, supplier or sub plans around is *when* work
  arrives and *who is busy*. Every input below is already in our tables.
- **Decision:** three features, each labelled an estimate with its basis on
  hover/tap (a dashed "estimate" tag; facts carry none):
  1. **Likely issue window on Early filings** (`src/forecast.js`
     `issueForecast`, `db/insight_queries.js`). Comparables: building permits
     issued in the market in the last 12 months, from the city's application
     date to its issue date; the same census class when 20+ exist (Austin's
     `permit_class` read from the permit's raw record), else the segment, else
     all building permits. Conditional on the filing's age: only comparables
     still open at that age count. The range is their middle 60%. Fewer than
     20: "not enough history". Too few still open: "longer than X% of similar
     cases", no range. It assumes the filing is issued and ignores its stage.
  2. **Trade timing on the job page** (`tradeTiming`). For each trade with
     no permit yet: of comparable jobs still without one at this job's age,
     the share that got one within 180 days, and when. Comparables are jobs
     whose BP was issued 6 to 18 months ago (fully observed): the builder's
     own when it has 8+, else the same census class, else the market. A
     permit is not a hire; the note says so.
  3. **Builder momentum screen** (`/pilot/live/momentum.html`,
     `listMomentum`). Building jobs per business in the last N days against
     the N before (60/90/180), plus applications filed where the builder is
     the classified filer (ADR-19) and how many are still in review, and its
     usual sub per trade. Labels: rising (3+ jobs, +3, 1.5x), new to market,
     slowing (-3, half or less), steady. Withheld when our history starts
     after the earlier window. Individuals are never listed.
- **Why these three (value to effort):** each reuses tables we already fill
  and needs no new source or migration. Rejected for now: sub churn (the GC
  screen's "changed" segment already flags a GC leaving its usual sub) and a
  builder timeline (low marginal value over the contractor page).
- **Uniqueness, and how it was checked:** the issue window and trade timing
  apply to filings and jobs competitors do not list in this form: the P1
  check (2026-11-14) found no Austin plan-review records on Zabalist, and
  Shovels documents a twice-monthly refresh; the E-matrix found no
  competitor with trade-matched "no trade permit yet" lists. Cities (SF,
  Denver, Portland) publish average review times by type, not a per-filing
  window; a web search found no lead tool offering one (search-level check,
  not exhaustive). Momentum on issued permits alone is **not** unique
  (Zabalist and Shovels show contractor permit history); the part that is
  ours is the pending-application count beside it.
- **Measurement:** `recon/insights_check.js` (workflow `insights-check`,
  read-only) reports coverage on today's Early list and calibration on
  permits with known outcomes (target: about 60% inside the range). Re-run
  after the 12-month plan-review backfill.
- **Revisit when:** calibration falls outside 50-70% for a market, or a
  design partner says the windows are too wide to plan with.

## ADR-22: Business names the person-name filter hid are shown (contractors-v3)

- **Date:** 2026-11-14. **Status:** accepted (owner: "Go for it", 2026-11-14).
- **Context:** `partyKind` (ADR-12) withholds any two-to-four-word name with
  no business word, to keep people's names off screens (rule 5). The Builder
  spot-check (ADR-19) showed it also hides plain businesses: "Bluebonnet
  Foundation Repair", "GL Hunt Foundation Repair", "Aqua Permits".
- **Decision:** add trade and firm words that are not common first names or
  surnames (repair, foundation, interiors, projects, architecture, permits,
  improvements, maintenance, consulting and similar) and treat "by" or "of"
  inside a name as a business marker. A plain first and last name stays
  `individual`. Resolver version `contractors-v3`; the next nightly resolve
  re-classifies every contractor and contact. The filers' private word list
  (ADR-19) is folded into this one.
- **Consequences:** more contractor names and their phones are shown. A sole
  proprietor trading under their own name plus a trade word ("Martha Nolan
  Interiors") is shown, as "Smith Electric" already was (COMPLIANCE 2.2, 2.3).
  `recon/party_kind_diff.js` measures what a change makes visible before the
  data is re-resolved.
