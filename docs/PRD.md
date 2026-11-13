# Product requirements

Status: **v2 accepted**, 2026-11-13 (owner's strategy addition: pre-approval
intelligence, lifecycle tracking, historical relationships, speed). Decision
record: ADR-16. v1 is kept below for history.

## v2: early-stage construction opportunity intelligence

### What changes from v1, and where the owner's plan is wrong

| v1 said | v2 says | Why, and the pushback |
| --- | --- | --- |
| Weekly digest of issued permits | Daily (then faster) feed of **filings at every stage**, issued permits included | Austin publishes plan-review applications the same day (`docs/DATA_SOURCES.md`, "Pre-approval scan"). A weekly email wastes that. **But** "faster" only helps where the source is faster: the Miami-Dade county layer is weekly and City of Miami has no pre-approval data at all |
| Austin, then Miami-Dade | **Austin, then Raleigh**; Miami stays for issued permits and the NOC experiment | Measured PADAS: Austin 89, Raleigh 85, City of Miami 41, Miami-Dade 25. Miami was not chosen "automatically": it loses on the data |
| Trade gap after the building permit | Lifecycle from planning case to final, with the trade gap as one stage | |
| GC-sub relationship intelligence (from the 94% finding) | **Kept, and it becomes the bridge** between early filings and leads | The 94% stickiness finding cuts against the owner's "earlier is always better" premise for subs. Seeing a residential remodel 63 days early does not help an electrician whose GC already has an electrician. Early discovery is worth most to (a) GCs and builders selling to owners and architects, (b) suppliers, and (c) subs targeting the ~25% of jobs where the GC has no habit in that trade. The product must say which case a lead is |
| "First to the job" is a claim sales must not make | Still must not be made | We can measure *our* latency against the source. We cannot claim to beat Dodge, ConstructConnect or Shovels without a recorded side-by-side |
| Early discovery is the moat | **Early discovery of small and mid-size work, linked to history, is the moat** | Commercial planning-stage leads are Dodge's and ConstructConnect's core business (400+ researchers, a million verification calls a year, per their pages). Competing on "earliest commercial project" is competing with their staff. Residential and light-commercial plan review in a metro, joined to who-worked-with-whom, is not what their pages describe |

### Target users (v2)

**Decided 2026-11-13 (ADR-16 item 8):** application-stage leads are sold
first to GCs, builders and suppliers. Subcontractors keep the issued-permit
and GC-relationship product until design partners show early leads change
who wins.

| Segment | Most valuable stage | Why |
| --- | --- | --- |
| Specialty subcontractors | Submitted / in review, **when the GC or builder has no repeat sub in this trade** | 94% stickiness: open only where the history says so |
| GCs and builders | Pre-application and submitted, when the applicant is an owner, architect or expediter | The GC is not yet chosen |
| Suppliers and distributors | Any stage, in volume | They sell to whoever wins |
| Homeowner sellers (ADR-10) | Unchanged: gated second track | |

### Functional requirements (added to v1 F1-F11)

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| E1 | Ingest pre-approval filings from at least one lawful source | Austin plan-review cases in `permits` with lifecycle stage, daily at minimum |
| E2 | One project per real job across stages | A filing that moves from `in_review` to `issued` keeps one project id; 30 re-runs add 0 projects and 0 leads |
| E3 | Official vs. observed dates | Every filing shows "Submitted" (source) and "Found by us" (ours); neither is ever filled from the other |
| E4 | Lifecycle events | Stage changes, added participants, value changes of 25% or more are events with the source date and our observation time |
| E5 | Application-to-permit link | Austin `masterpermitnum` = plan-review `folderrsn` link rate measured and shown per source |
| E6 | Search before enrichment | A new filing is searchable within 5 minutes of its sync (target, measured), before property, licence and history enrichment finish |
| E7 | Business profiles for every role | Applicant org, architect, engineer, expediter, GC and sub each get a portfolio: filings by year, area, type, value, status, co-participants |
| E8 | Four participant labels | Confirmed, historically associated, potentially relevant, unverified: never mixed, never shown as "the GC" unless named on the filing |
| E9 | Early Opportunity Score | Separate from relevance and data quality; stage label shown beside it; per-trade stage windows labelled as hypotheses until calibrated |
| E10 | Freshness metrics | Discovery, processing, alert latency and early-capture rate per source on the admin page |
| E11 | Source health for silent staleness | A source that answers but stops changing for 2x its measured cadence raises an alert |
| E12 | Expediters are not clients | Applicant orgs that file for many unrelated owners are flagged "permit service" and never presented as the builder |

### Answers to the owner's 10 research questions

Sources and verification status are in `docs/DATA_SOURCES.md`, "Pre-approval
scan". "Verified" means read from the live API on 2026-11-13.

1. **Which cities or counties publish applications before approval?**
   Verified: Austin (plan review, site plan, subdivision, zoning cases), Raleigh
   (building, trade and ROW layers), New York City (DOB NOW filings), Orlando,
   New Orleans, Seattle, Norfolk. Verified **not**: City of Miami, Miami-Dade
   county layer, Los Angeles, Chicago, Montgomery County MD. Unverified: San
   Francisco (API asked for a token), Nashville (date field unreadable).
2. **Which provide official APIs or datasets?** All the verified ones above,
   through Socrata or ArcGIS REST. None needed a portal or a login.
3. **How quickly do applications become public?** Austin plan review:
   same day (cases applied 2026-11-13 were published that afternoon). Raleigh,
   Orlando, New Orleans, NYC, Seattle: next day or better by the rows-per-day
   proxy. A measured lag needs the 14-day snapshot (not run yet).
4. **Which expose contractor or applicant details pre-approval?** Raleigh
   (contractor 74% building, 96% trade), Orlando (85%), New Orleans (70%),
   NYC (licensed applicant 100%, owner business 95%). Austin names the
   **applicant** (org 62%), which is often a builder and often an expediter,
   never the contractor. Seattle names nobody.
5. **Identifying the same company across projects and jurisdictions:**
   strong keys first (state licence numbers: TDLR, Florida DBPR, NC licensing
   board, NYC DOB licence; Texas and Florida Secretary of State filings), then
   phone plus name, never name alone (ADR-12). Expediters must be detected and
   kept apart. Cross-jurisdiction identity rests on licence and SOS numbers;
   names alone will produce false merges.
6. **Reconstructing a contractor's portfolio:** the history is already in the
   permit datasets (Austin to 1921, Raleigh to 2000, NYC to 2016). A portfolio
   is the resolved business's filings in every role, grouped into projects.
   Today we resolve only the contractor role and only recent windows; a
   backfill of 5+ years per market is needed (storage: see risks).
7. **Fastest lawful collection:** official APIs, probed cheaply for change
   (Socrata `rowsUpdatedAt`, ArcGIS `lastEditDate`) and fetched incrementally.
   Portals only after their terms allow it; public-records requests where data
   is hidden.
8. **Bottlenecks to near-real-time:** the source's own refresh (daily reloads,
   Miami-Dade weekly); GitHub Actions' best-effort cron; Neon Free's 1 GB
   (542 MB used) once history and planning data land; enrichment providers
   with batch-only APIs (Census, TCAD's 510 MB export); entity resolution
   needing human review for merges.
9. **Competitors with pre-approval intelligence:** Dodge, ConstructConnect
   and Building Radar (planning and design stages, mostly commercial); Shovels
   is moving there. BuildZoom and Construction Monitor are permit-based by
   their own pages. Their latency and completeness are **unverified**.
10. **Best initial market:** **Austin**, on measured data: PADAS 89, public
   domain, same-day applications, an official link to the issued permit, our
   existing pipeline and TCAD property data, Texas statewide signals (TABC,
   TABS). Weakness: no contractor at application stage. **Raleigh second**: the
   contractor is named at application, and we already ingest the layers. Demand
   is unverified in both; no design partner has confirmed that application-stage
   leads win more work.

### MVP (replaces v1 core workflow)

The first milestone proves the pipeline on **Austin plan-review cases plus
Raleigh pre-issue rows**, and nothing else:

1. Daily (then 3-6 hourly) sync of `n8ck-xkda` and Raleigh's layers by
   application/update date, raw stored first.
2. Lifecycle stage and events; one project per job; `submitted_on` and
   `first_seen_at` kept apart.
3. Searchable within minutes of sync, before enrichment.
4. Property by `appraisal_id` / `tcad_id` (Austin) and `pin` (Raleigh).
5. Confirmed participants as published; expediters flagged.
6. Portfolio of each named business from existing history.
7. Contacts only where verified and usable (ADR-15 rules).
8. A daily list to 3-5 design partners, with the stage and the
   "historically associated" label kept separate.
9. Measured: discovery latency, early-capture rate, link rate, partner
   verdicts.

Not in the MVP: planning agendas, TABS, NOCs, dashboards beyond the list,
AI agents, billing, sub-hourly polling.

### UX (v2)

Main screen sections, in order: **New applications** (submitted in the last
7 days), **Under review**, **Recently approved / issued**, **Contractor
activity**, **Saved**. Every row has a stage pill (`Submitted`, `In review`,
`Corrections`, `Approved`, `Issued`, `Completed`) and both dates. The project
page follows the owner's 10-part order, with "Historically associated" in its
own panel under "Confirmed participants", never merged into it. Design work
belongs to the demo-redesign thread.

### Success metrics (v2 additions)

| Metric | Target | Type |
| --- | --- | --- |
| Early-capture rate (issued Austin BPs first seen at application stage) | 80% or more | Measured |
| Discovery latency p50 (Austin plan review) | Under 24 h, then under 6 h | Measured |
| Application-to-permit link rate (Austin) | 90% or more | Measured |
| Partners saying an application-stage lead was "new and early enough" | 3 of 5 | Self-reported |
| Partners reporting a win from an application-stage lead within 8 weeks | 1 or more | Self-reported |

### Biggest risks

**Technical**

1. **Austin applications name the applicant, not the contractor.** The lead
   is "someone filed for a remodel at X", and often the someone is an
   expediter. Without the GC, a sub has no one to call except through
   history. Measure the share of applicant orgs that become the BP contractor.
2. **Linking at scale is unproven.** The `masterpermitnum` = `folderrsn`
   link held on 4 of 4 samples; the rate over months is unmeasured.
3. **Storage.** Lifecycle history, 5-year backfills, planning cases and
   events will not fit Neon Free (542 MB of 1 GB used). A paid tier is the
   owner's call.
4. **Sub-hourly polling needs an always-on worker** (Actions cron is
   best-effort). Cost and operations rise before any customer pays.
5. **Status vocabularies drift.** Austin alone uses 18+ plan-review statuses;
   each market needs a reviewed map, and unmapped values stay `unknown`.
6. **Entity resolution across roles.** Architects and expediters have no
   licence number in Austin's data; false merges would poison portfolios.

**Commercial**

1. **Stickiness beats speed for subs.** 94% of trade permits go to a GC's
   existing sub. Early visibility may not change who wins.
2. **Incumbents own "early" for commercial.** Dodge and ConstructConnect
   have decades of researcher-verified planning data; Shovels is adding
   planning signals with 2,770+ jurisdictions.
3. **The data is open.** Anyone, including small scrapers already selling
   NYC and SF filings, can read the same APIs. The moat must be the linking,
   history and trade matching, and the speed at which those are done.
4. **No validated demand.** Zero design partners have tested application-stage
   leads; the old partners can't be reached.
5. **Compliance load grows with each role.** Applicants and owners are often
   individuals (rule 5); Texas ch. 302 still blocks scaled calling; Raleigh can
   order us to stop.

---

## v1 pilot (superseded by v2 above where they conflict)

Status: proposed 2026-11-13, superseded in part by v2 the same day.

### Vision

Turn public permit records into a short weekly list of construction jobs a
specific trade business can still win, with the right business to contact and
the evidence behind each pick.

### Target users (v1)

| Segment | Sells to | v1? |
| --- | --- | --- |
| Specialty subcontractors (electrical, HVAC, plumbing, roofing, drywall, insulation, low-voltage) | GCs named on permits | **Primary** |
| Suppliers and distributors | Contractors | Secondary: 3 to 5 discovery conversations |
| Home-service sellers to homeowners (roofing, solar, pools, windows) | Homeowners | **Second track** (ADR-10): built into the data model, delivered after the compliance gate |

### Problems

1. Finding new jobs means checking several government portals by hand. Those
   portals weren't built for this.
2. By the time a sub hears about a job, the trade is often already chosen.
3. Raw permits are noisy: most are irrelevant to any one trade, and many name
   the owner rather than a business.

### Core workflow (v1)

**Weekly email**, then **open the lead**, then **call the GC**, then **click
feedback**, then **answer the check-in.**

### Functional requirements

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| F1 | Daily sync of each enabled source | Every enabled source has a successful `sync_run` each day by 08:00 local time, or an alert has fired |
| F2 | Late and updated records are captured | A permit first published 10 days after issue appears in the next digest as new |
| F3 | No duplicates | 30 re-runs of the same window add 0 permits, 0 versions and 0 digest items |
| F4 | Trade classification with reasons | Every lead lists at least one rule and the evidence that matched |
| F5 | Personalized digest | Filters by trade, area and minimum value. 10 to 25 leads. Never repeats a lead to the same subscription |
| F6 | Contact shown with provenance | Each phone shows its source permit and date. Unverified is labelled. A missing contact says "no contact on record" |
| F7 | One-click feedback | Six verdicts, recorded without login, through a signed link valid for 30 days |
| F8 | Outcome check-in | Weekly 2-question email. Answers stored as self-reported |
| F9 | Human review before send (pilot) | A digest cannot be sent until an admin marks it reviewed |
| F10 | Admin source health | Per source: last attempt, last success, counts, lag, coverage, alerts |
| F11 | Suppression | A suppressed phone or name never appears in a digest, the API or an export |

### Non-functional requirements

These are the performance and security targets in ARCHITECTURE.md sections
13 and 16, plus:

- No secrets in the client.
- No individual contact shown by default.
- Every displayed value traceable to a raw record.

### Success metrics (pilot)

| Metric | Target | Type |
| --- | --- | --- |
| Feedback rate on delivered leads | 60% or more | Measured |
| Share of leads marked "relevant" | 40% or more | Measured |
| Partners reporting at least one call per week | 2 or more of 5 | Self-reported |
| Partners reporting a quote or win within 4 weeks | 1 or more | Self-reported |
| Agreement to a paid pre-commitment | 2 or more | Measured |

### Out of scope for v1

Billing, public sign-up, the partner-facing pipeline/CRM, the map-first UI,
the AI assistant, CRM integrations, homeowner contact delivery (until the
ADR-10 gate passes), and more than two markets.
