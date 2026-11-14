# Shovels (shovels.ai): technical and commercial analysis

Date checked: 2026-11-14. Researcher: competitive intelligence worker.

Builds on, and does not repeat:
- `docs/research/2026-11-14-early-signals/E-competitors-and-acquisition.md` (pricing first read)
- `docs/research/2026-11-14-early-signals/P1-competitor-check.md` (statuses, refresh cadence)
- `docs/DATA_STRATEGY.md` (row E)

Labels:
- **[V]**: read on the cited page on 2026-11-14.
- **[V-3p]**: read on a third-party page (press, Sacra) on 2026-11-14. It is that party's claim or estimate, not Shovels' own.
- **[I]**: my inference. Not stated anywhere.
- **[U]**: unknown or unread.

Method limits:
- 26 WebFetch calls and 9 web searches. The shell cannot reach outside hosts.
- The docs fetch tool would not return full text verbatim. Quotes below are short phrases it did return. Everything else is a close summary of the page.
- `shovels.ai/coverage` renders by JavaScript, and the fetch saw only placeholders. So the coverage of Austin, City of Miami and Raleigh is **unverified**.
- I signed up for nothing and called no Shovels API.

## 1. Bottom line

Shovels is a real, fast-moving national competitor. It is not a toy. In one year it has shipped:
- a CLI
- an AI agent (Charlie)
- a Properties API covering about 159M properties
- a zoning "Decisions" dataset (600+ cities)
- Miami-Dade coverage
- a first-party collection pipeline

It is weak in four places, and all four are measurable. Each is a place where a 2-4 jurisdiction specialist can beat it on a metric a subcontractor cares about:
1. **Cadence.** Data is refreshed twice a month, and the docs allow "up to a week" more before it reaches the API.
2. **One contractor per permit, with no role.** There is no GC-sub relationship model.
3. **Per-state contractor deduplication**, with IDs that can change.
4. **A low bar for "covered".** It counts permit volume, not field completeness.

One finding changes our plan: **Shovels' Terms forbid using the service "for the purpose of competing with Shovels' business"**. So a free-tier sign-up by us to benchmark is not clearly allowed (section 11).

## 2. Company, funding, team, traction

| Fact | Value | Label |
|---|---|---|
| Founded | 2022, by Ryan Buckley (CEO) and Luka Kacil (CTO) | [V-3p] Commercial Observer |
| HQ | Lafayette, California | [V-3p] Commercial Observer |
| Seed round | $5M led by Base10 Partners, announced 2025-06-10. Total raised about $6.5M | [V-3p] Commercial Observer |
| Earlier round | About $1.5M led by Coelius Capital, with Founders Network Fund and Mission One Capital | [V-3p] Sacra |
| Revenue (Sacra estimates) | About $500K ARR at end of 2024; crossed $1M ARR in May 2025; $1.5M ARR at end of 2025; **$250K MRR (about $3M ARR) in August 2026** | [V-3p] Sacra, estimates |
| Customers | Sacra says "numbering in the dozens", including unnamed Fortune 500 firms in telecom, technology and homebuilding. No named customers found | [V-3p] Sacra |
| Distribution partners | Esri, Precisely, Cherre, Regrid, Clay | [V-3p] Sacra; Cherre vendor page exists |
| Team size | Not found. CB Insights, Dealroom and LinkedIn pages showed up in search but were not read. A Notion "Software/Data Engineering at Shovels" job page exists | [U] |
| Positioning | CEO: "basically lead generation for companies who sell products and services to contractors". Targets include solar, home improvement, contractors and government economic-development staff | [V-3p] Commercial Observer |

Inference [I]: it is a small team, probably tens of people, with about $3M ARR spread across dozens of customers. Average revenue is then high per account, roughly $50K+ a year. That fits enterprise data licences more than $599 self-serve seats. It also means sub-contractor lead lists for a single metro are not their core buyer.

## 3. Datasets

Endpoints are from the docs index (`docs.shovels.ai/llms.txt`) [V].

| Dataset | Endpoints | Notes |
|---|---|---|
| Permits | `search-permits`, `get-permits-by-id` | See field list below |
| Contractors | search, by id, permits by contractor, employees, filtered metrics | Employees endpoint gives names and job titles, for example Owner, Project Manager [V] |
| Addresses | search, monthly and current metrics, **Residents** | Residents: name, personal emails, phone, LinkedIn, net worth, income range, is_homeowner [V data dictionary] |
| Properties | search, by id | Beta since 2026-08. About 159M US properties with permit-history summaries and assessor fields [V release notes] |
| Decisions | search, by id | Beta since 2026-06. "600+ cities and nearly 200,000 decision records" at launch [V] |
| Geo metrics | cities, counties, jurisdictions (monthly and current metrics, details), zipcodes, states | Market-level aggregates |
| Meta | data release date, `/v2/meta/coverage` (added 2026-06) | Coverage can be queried by API with a key [V] |
| Lists, usage | zip codes, tags, credit usage | |

Interfaces [V]:
- Shovels Online (web app)
- REST API v2 (OpenAPI spec at `api.shovels.ai/spec/v2/openapi.production.yaml`)
- CLI (launched 2026-03)
- Google Sheets add-on
- Charlie, an AI assistant. Since 2026-10 it builds searches instead of querying data directly.
- Enterprise Data License (EDL)

### 3.1 Permit fields [V data-dictionary-api]

| Group | Fields |
|---|---|
| Identity | `id`, `number`, `jurisdiction` |
| Work | `description`, `job_value` (in cents), `type`, `subtype`, `fees`, `tags`, `status` |
| Dates | `file_date`, `issue_date`, `final_date`, `start_date`, `end_date` |
| Durations | `total_duration`, `construction_duration`, `approval_duration`, `inspection_pass_rate` |
| Contractor | **one `contractor_id`** |
| Location | `address`, `geo_ids`, census tract, congressional district |
| Property (from the assessor) | `property_type`, `property_type_detail`, `property_legal_owner`, `property_owner_type`, `property_lot_size`, `property_building_area`, `property_story_count`, `property_unit_count`, `property_year_built`, `property_assess_market_value` |

Statuses are `in_review`, `active`, `final`, `inactive`. Status is current only, as of the latest refresh. No status history is described [V, from P1].

Other permit facts:
- AI classification into tags is claimed at "98% accuracy", "validated by construction industry experts" [V key-differentiators].
- No sample size or method is published [U].
- `description_derived` was added to 81M permits [V release notes].

### 3.2 Property enrichment [V]

Fields:
- APN
- year built, lot size, building area, stories, units
- assessed market value
- legal owner and owner type

Absent:
- Beds and baths are not documented.
- No sale price, mortgage or deed history is documented.

Unusual for this market, there is a per-property `trust` block: `coverage_tier`, `unresolved_rate`, `data_horizon`, `horizon_basis`, `footprint_basis`, `flags`. This is a public statement of how complete the data is, and is good practice. It also supports "absence" queries (properties with no permit of a type) and "unfinaled permit" queries [V docs index].

### 3.3 Contractor profiles [V data dictionary, contact-information, contractor-deduplication]

Fields:
- Licence number, classification (raw and derived), and licence issue, expiry, active and inactive dates. Matched "against public state license files and business registration records".
- `primary_phone` (the most frequent number across the contractor's permits)
- `phone` (all numbers seen, ordered by frequency)
- `primary_email`, `email`, `website`, `linkedin_url`, `dba`
- SIC, NAICS
- **`revenue` and `employee_count` as ranges**
- `rating` and `review_count` (source not documented [U])
- `permit_count`, average and total job value, average construction duration, average inspection pass rate, `first_seen_date`, status and tag tallies

Contacts come mostly from the permits themselves:
- The primary phone and email are picked by frequency across permits.
- The page gives **no coverage rates** for phone or email. It says contacts are provided "when available".

Entity resolution:
- Each contractor gets a `contractor_ID`. Branches are grouped under a `group_ID`, and in EDL `is_representative` marks the group's preferred record.
- **Deduplication is per state.** A firm working in two states has two IDs. A national contractor ID is "in progress".
- The docs give no precision or recall figures.
- IDs are hashes of key attributes and "can occasionally change" [V refresh-frequency].
- After the 2026-04 pipeline rebuild, contractors fell to 2.5M [V release notes].

### 3.4 Historical relationships

Contractor to property: available through permit history by address and by contractor [V].

**GC to sub: not modelled.**
- The permit object carries one `contractor_id`.
- There is no role field (general contractor or subcontractor).
- There is no link between a building permit and its trade permits.
- I found no endpoint that returns "the subs this GC uses" [V data dictionary; absence of such an endpoint is V for the docs index].

Inference [I]: you could rebuild GC-sub pairs yourself by joining permits at the same address. But Shovels does not ship that, and its one-contractor-per-permit model loses co-listed contractors where a jurisdiction records several.

### 3.5 Residents (homeowner data)

The docs say:
- Sources are "multiple non-LinkedIn sources".
- The data mixes observed and modelled or probabilistic attributes: net worth, income, age range, kids.
- A record needs "3+ corroborating signals".
- No DNC, CCPA or TCPA guidance appears on the page [V resident-data].
- Resident records fell from 45.9M to 27.6M at the 2026-04 rebuild [V release notes].

For us, this is the class of data that ADR-10 gates. We should not copy it.

### 3.6 Decisions (pre-permit, entitlement stage)

- **Origin:** the product came from Shovels' acquisition of ReZone, "an AI company that tracked city and local government meeting decisions" [V decisions overview]. I found no date or terms for the acquisition [U].
- **Fields** [V data-fields]:
  - title, date (`when`), category and subcategory (12 categories, for example Spot Rezoning)
  - `link` to the official source document
  - up to 3 addresses, lat and long
  - zoning before and after, with descriptions
  - acreage and square feet, asset class
  - allowed uses, density, minimum lot size, height, setbacks, lot coverage, parking
  - applicant (organisation and person, with email, LinkedIn, website), owner, developer, engineer, architect, council representative
  - `summary`, `why_it_matters`, a `newsworthiness` score from 0 to 1
- **Coverage:** 600+ cities, "roughly half" of permit-covered jurisdictions. No list is published [V decisions-availability].
- **Not stated:**
  - cadence
  - meeting-to-availability lag
  - the method that links a decision to a later permit [U]

Scope note: Decisions are council and planning-commission outcomes, such as rezonings. That is not the same as building plan-review intake, the `n8ck-xkda`-style "application filed" record we care about in Austin. Shovels' `in_review` permit status could cover intake where a jurisdiction publishes it. Whether it does so for Austin is [U].

## 4. Geographic coverage

| Claim | Value | Label |
|---|---|---|
| Jurisdictions | "About 2,000 US jurisdictions", about 85% of the US population. The US has about 20,000 | [V coverage-areas] |
| Contradicting press claim | "More than 20,000 jurisdictions" | [V-3p] Commercial Observer, 2025-06. Likely a confusion with the national total [I] |
| Growth | 10-30 new jurisdictions a month | [V] |
| County coverage | 87.1% (release V2.1.10, 2026-07-01). The basis (population or count) is not stated | [V] |
| Definition of "covered" | Holds at least as many permits as the Census count of new buildings, and received permits in 4 of the last 6 months | [V coverage page methodology note] |
| Backfill | "At least 2010" for all jurisdictions | [V historical-data] |
| Free plan history | 1 year | [V pricing] |
| Permit volume | 174M (2025-09). Fell to 130M at the 2026-04 first-party rebuild. Sacra says over 200M fell to about 178M. **The figures disagree** | [V release notes]; [V-3p] Sacra |

Our pilot markets:

| Market | Shovels coverage | Label |
|---|---|---|
| Miami-Dade County | **Added in V2.1.12 (2026-09-01)**: "Miami-Dade and Cook County … 3.8M permits" | [V] |
| City of Miami | Not stated. The county addition may or may not include the City's own permits | [U] |
| Austin, TX | Not stated anywhere read. The coverage dashboard did not render | [U] |
| Raleigh, NC | Not stated anywhere read | [U] |

How to settle the [U] rows without an account: open `shovels.ai/coverage` in a real browser and read the treemap. That is public, needs no sign-up, and is ordinary page viewing. Owner's call whether a person does this. It costs nothing.

The "covered" bar is about volume. A jurisdiction can count as covered with no contractor phone, no trade permits, and no applications.

## 5. Freshness and lag

Documented cadence [V refresh-frequency]:
- "refreshed twice a month"
- the database updates first, then up to a week more before the API and Shovels Online have it
- each cycle adds 5-10M new permits and 1-5M status updates
- EDL delivery is twice a month, a full overwrite ("fresh table"). Custom cadences are available under enterprise SLAs [V monthly-deliveries].

Observed release cadence [V release notes]:
- **Numbered releases are monthly, on or near the 1st**, from V2.1.1 on 2025-10-01 to V2.1.13 on 2026-10-01.
- Whether a second, unnumbered mid-month refresh also happens is [U].

Worst-case lag [I], computed from the documented cadence:
- A permit issued the day after a refresh waits up to about 15 days for the next one, then up to 7 days more.
- That is about 0-22 days after the jurisdiction publishes. This matches P1.
- If refreshes are in practice monthly, the worst case is about 37 days.

For comparison, from our own `docs/DATA_SOURCES.md`:
- Austin `3syk-w9eu` reloads daily.
- City of Miami `Building_Permits_Since_2014` is daily.
- Raleigh is daily.

So the cadence gap is structural and in our favour by 1-3 weeks. It holds only if our pipeline actually syncs daily and we show last-sync time (Hard rule 7).

Status history: Shovels reports current status only. Sacra and the docs mention no status-change log. EDL customers are told to diff deliveries themselves [V record-tracking advice].

## 6. API and delivery

| Item | Value | Label |
|---|---|---|
| Auth | API key. The CLI and Sheets use the same key | [V] |
| Rate limits | **No number published.** Enforced "on an individual basis as needed". 429 on throttle | [V rate-limits] |
| Paging | `size` parameter. Result counts on paged endpoints since 2026-03 | [V] |
| Metering | 1 credit = 1 record returned, shared across Online, API, CLI and Charlie. Resets monthly | [V] |
| Bulk | EDL: full dataset as Parquet, or table shares in **Snowflake, Databricks, BigQuery**. Includes fields the API does not expose. About 15-20 GB of Parquet (Sacra) | [V pricing]; [V-3p] Sacra |
| S3 or AWS Marketplace | Not mentioned on the pricing page. Search returned AWS Marketplace listings but none was confirmed as Shovels | [U] |
| Webhooks or streaming | None found in the docs index | [V absence in index] |
| MCP server | None in the release notes. CLI and Charlie are the agent-facing tools | [V] |
| Samples | EDL "Requesting Sample Records" page exists (not read) | [V index]; contents [U] |

## 7. Pricing and business model

Read live 2026-11-14 [V shovels.ai/pricing]:

| Plan | Price | Credits/mo | Notes |
|---|---|---|---|
| Free | $0, no card | 500 | 1 seat, 1 year of history, **10 results per query**, no downloads |
| Basic | $599/mo | 25,000 (card) or 500 (table) | The page contradicts itself |
| Pro | $999/mo | 50,000 (card) or 25,000 (table) | Up to 2 seats (card) or 1 (table). Employees dataset |
| Enterprise | Custom | Custom | Employees and Decisions |
| EDL | Custom | Not applicable | Full dataset to warehouse, twice monthly |

- No annual price is listed.
- The page has at least 8 internal contradictions (credits, seats, history, downloads). E-worker saw the same.

Price per record [I]:
- Basic: $599 / 25,000 = about $0.024.
- Pro: about $0.020.

A subcontractor wanting one metro's weekly trade permits would spend few credits. The cost is the $599 floor, not volume.

Model [V-3p Sacra]:
- Data-as-a-service: self-serve subscriptions plus enterprise licences.
- Gross margin improved after first-party collection removed licence fees.
- The partner channel (Esri, Precisely, Cherre, Regrid, Clay) resells to real-estate, GIS and GTM-tool buyers.

## 8. Data acquisition strategy

Shovels' own statement [V data-sources]: "We get data straight from the source". It names these channels:
- relationships with local governments
- online portal integrations
- public records requests
- website scraping
- open-data portals
- building-department APIs
- phoning offices

Enrichment sources:
- addresses: Census National Address Dataset, OpenAddresses, SimpleMaps, ESRI
- contractors: state licence files and business registrations
- property: assessor records

Timeline:
- **2026-04-02 (V2.1.7):** "Pipeline became fully Shovels-owned, third-party data was removed". Permits fell to 130M and contractors to 2.5M, and `first_seen_date` was reset [V release notes].
- **2025-10-01:** "First-ever offline permit data" from Cook County, IL and Oak Ridge North, TX. This suggests they now also digitise records that are not online [V].

LLMs are used for classification and entity resolution [V-3p Sacra; the 98% tag-accuracy claim is V].

Direction [V-3p Sacra, AI-generated summary]:
- earlier signals (rezoning and planning votes)
- a "construction intent graph" linking entitlements to later permits

This overlaps our ADR-18 early-signal strategy at the entitlement stage. It does not overlap plan-review intake.

## 9. Strengths (honest)

1. **Breadth.** About 2,000 jurisdictions and about 85% of population, from 2010. We cannot match this, and should not try.
2. **Shipping speed.** 13 numbered releases in 13 months. Five new surfaces in a year: CLI, Charlie, Decisions, Properties, a new app.
3. **Normalisation.** Uniform tags, AI-derived descriptions, USPS addresses checked against four address datasets, geocoding on about 144M permits, and APN on 40M+.
4. **Property layer.** About 159M properties, with assessor fields and explicit `trust` and coverage metadata, plus absence queries ("no roof permit since 2010").
5. **Contractor profile breadth.** Licence, contacts, firmographics (ranges), ratings, performance metrics, employees.
6. **Delivery options.** Warehouse shares in Snowflake, Databricks and BigQuery, and a reseller network.
7. **Entitlement data.** 600+ cities of AI-extracted zoning decisions with role contacts. GatherGov and Zabalist compete here. We do not, yet.
8. **Unit cost at scale.** About $0.02 per record. National buyers get far more per dollar from Shovels than from any metro specialist.

## 10. Weaknesses, and where a focused competitor can beat them

Each line names a metric to measure, and the claim we would have to prove.

| # | Dimension | Shovels (documented) | Our opportunity in Austin, Miami-Dade, City of Miami, Raleigh | Metric |
|---|---|---|---|---|
| 1 | Update frequency | Twice monthly, plus up to 7 days. Releases look monthly | Daily sync from daily-published sources | Median and p90 of (time visible to customer minus time the source published), per permit |
| 2 | Earlier discovery (intake) | `in_review` exists. Austin intake unverified. Decisions are council-stage | Austin plan-review applications (`n8ck-xkda`) before issuance; Orlando and Raleigh application layers | Share of issued permits seen before issue, and median days of lead time |
| 3 | GC-sub relationships | One `contractor_id` per permit, no role, no linked trade permits | Raleigh `Sub Permit` rows and `contractortype`. Austin trade-gap links by folder | Share of building permits with linked trade permits and a named sub. Pair precision on a hand-checked sample |
| 4 | Contractor accuracy | Per-state dedup. IDs can change. No published precision | Licence-anchored resolution (TDLR, Florida DBPR, NC boards) on a small universe that can be hand-checked | Duplicate rate and wrong-merge rate on a 200-firm audit; ID stability across 8 weekly syncs |
| 5 | Contacts | Phone and email by frequency on permits. No coverage figure | Raleigh phone 76-86%, email 85-91% (measured); TDLR and DBPR licence phones | Share of leads with a business phone that answers, verified on a sample. Share with a licence-verified phone |
| 6 | Status history | Current status only | Keep every status change we see (our sync is an upsert with history) | Share of permits with a full dated status trail |
| 7 | Provenance | Links per decision. Permits carry no source-record link | Rule 6: raw record id and source URL on every value | Share of displayed values traceable to a raw record |
| 8 | Freshness honesty | "Data Pulled" on the dashboard. No per-jurisdiction lag in docs | Last sync and publication lag shown per source (rule 7) | Customer can see lag per jurisdiction: yes or no |
| 9 | Trade-matched weekly lists | Generic search and export. The buyer builds the list | Weekly trade-matched lead list with evidence | Time-to-first-lead for a sub; precision of trade match |
| 10 | Price for one-metro subs | $599/mo floor for history and downloads | Metro-priced plan | Price per qualified lead |

Where we should **not** try to compete:
- national breadth
- property-wide analytics
- homeowner Residents data (ADR-10 gate)
- warehouse delivery to enterprises

Risks [I]:
- If Shovels moves to a daily cadence for big metros, rows 1 and 8 shrink. Their first-party pipeline makes that technically possible, and custom SLA cadences already exist for EDL.
- Rows 3, 4, 6 and 9 are model and product choices, and harder for them to change quickly.

## 11. Legal benchmark methodology

### 11.1 What the terms say

Shovels Terms, "Last revised on: May 19, 2026" [V shovels.ai/terms]:
- **§3(b)(v):** you may not use the Services "for the purpose of competing with Shovels' business". The section also bars gathering information for a competitor or potential competitor.
- **§3(a):** data is for "internal business purposes". On termination you must delete all copies, including from "storage devices, databases, or models".
- **§3(b):** no publishing or distributing the Services or Data. No derivative works. No datasets or models "based on or trained on the Data" without a separate written agreement.
- **The data-usage FAQ:** you may not "use the data to build a competing data product" [V data-usage-terms].
- **Disputes:** California law, AAA individual arbitration, Contra Costa County courts.

### 11.2 Consequences

These are my reading, not legal advice [I]:
- An account opened by us, even the free one, to compare our data with theirs is plausibly "for the purpose of competing". So is storing their records next to ours. This is not a cleared use.
- The earlier plan in E and P1 to "add Shovels free" to the side-by-side test should be **paused until counsel or Shovels clears it**.
- Do not use a personal or customer account as a workaround, do not create accounts under other names, and do not ask a Shovels customer to share exports. Sharing would breach their licence.

### 11.3 Allowed now, at no cost and with no account

1. **Public-claims benchmark.** Compare our measured numbers with Shovels' published claims on cadence, coverage, fields, dedup scope and backfill. Cite each claim's URL and date. This report is the start of that.
2. **Our own lag measurement.** For each pilot source, measure (our first_seen minus the source's publication time). Report it against Shovels' documented window of 0-22 days. This needs no Shovels data.
3. **Public coverage dashboard.** A person views `shovels.ai/coverage` in a browser and notes whether Austin, City of Miami, Miami-Dade and Raleigh appear, with their date ranges. Record it by hand, with no scraping, and keep only the yes or no plus the date. The dashboard is public marketing material. Still [I], so counsel can confirm.
4. **Field-model comparison.** Compare their documented schema with our capability: GC-sub, status history, provenance. Docs are public.

### 11.4 Needs owner approval, and probably counsel

5. **Ask Shovels in writing** for an evaluation licence that allows a comparative benchmark. Be open about who we are. Or request "sample records" (their EDL docs offer this) with written terms allowing comparison. Cost $0. Needs owner approval.
6. **Have counsel read the full Terms** for whether a free account for competitive evaluation is allowed if no data is kept. Cost is counsel time. Needs owner approval.
7. Only if 5 or 6 clears it, run a **sealed sample protocol**:
   - Fix 50 permits per market in advance from our own sources: issued in a 7-day window, plus 50 Austin plan-review applications.
   - On days D+1, D+7, D+14 and D+21, look each up in Shovels by permit number or address.
   - Record only these comparison facts:
     - present (yes or no) and first date seen
     - status
     - contractor named (yes or no, and whether it matches the licence)
     - phone present (yes or no)
     - trade permits linked (yes or no)
   - Do not store their records or field values beyond what the written permission allows. Delete per §3(a) at the end.
   - Free plan limits: 500 credits a month and 10 results per query. About 400 point lookups fit in one month [I].
   - Paid plans cost $599/mo. **Needs owner approval** for spend.

Until step 5 or 6 clears, any customer-facing claim must be worded against Shovels' **published** documentation ("Shovels documents a twice-monthly refresh"). Never claim a measured head-to-head we have not lawfully run.

## 12. Open questions

- Austin, City of Miami and Raleigh coverage, and their date ranges (dashboard).
- Whether Austin permits carry `in_review` (intake) or only issued permits.
- The real refresh cadence (monthly releases against the documented twice monthly). The `get-data-release-date` endpoint would answer this, but needs a key.
- Phone and email fill rates per jurisdiction. Undocumented.
- Decisions: Austin coverage, meeting-to-availability lag, and the linking method.
- Team size. ReZone acquisition date and terms.
- The source of contractor `rating` and `review_count`.

## Sources

All checked 2026-11-14.

Shovels docs and site:
- https://docs.shovels.ai/llms.txt (docs index)
- https://docs.shovels.ai/docs/knowledge-base/data/geographic/coverage-areas.md
- https://docs.shovels.ai/docs/knowledge-base/data/quality/refresh-frequency.md
- https://docs.shovels.ai/docs/knowledge-base/data/quality/data-sources.md
- https://docs.shovels.ai/docs/knowledge-base/data/quality/historical-data.md
- https://docs.shovels.ai/docs/knowledge-base/data/contractors/contact-information.md
- https://docs.shovels.ai/docs/knowledge-base/company/data-usage-terms.md
- https://docs.shovels.ai/docs/knowledge-base/getting-started/pricing-structure.md
- https://docs.shovels.ai/docs/knowledge-base/getting-started/key-differentiators.md
- https://docs.shovels.ai/docs/knowledge-base/api/basics/rate-limits.md
- https://docs.shovels.ai/docs/knowledge-base/api/decisions/decisions-availability.md
- https://docs.shovels.ai/docs/knowledge-base/data/decisions/data-fields.md
- https://docs.shovels.ai/docs/knowledge-base/data/decisions/overview.md
- https://docs.shovels.ai/docs/knowledge-base/data/residents/resident-data.md
- https://docs.shovels.ai/docs/knowledge-base/edl/contractor-deduplication.md
- https://docs.shovels.ai/docs/knowledge-base/edl/monthly-deliveries.md
- https://docs.shovels.ai/docs/data-dictionary-api.md
- https://docs.shovels.ai/release-notes/release-notes.md
- https://www.shovels.ai/pricing
- https://www.shovels.ai/coverage (JavaScript only; methodology note read, figures not rendered)
- https://www.shovels.ai/terms (last revised 2026-05-19)

Third parties:
- https://commercialobserver.com/?p=523692 (seed round, 2025-06-10)
- https://sacra.com/c/shovels/ (revenue estimates, model, partners)
- https://sacra.com/chat/h/7f1d47bc-6c87-45fb-894a-afce94a4ad55/ ("Shovels Cuts Licenses and Improves Margins", AI-generated)
- https://sacra.com/chat/h/96f905c2-8f98-48ac-b8e3-237f00e40465/ ("Shovels shifting to early development signals", AI-generated)
- https://cherre.com/vendors/shovels/ (search result only; not read)
- Search-result titles only, not read: CB Insights, Dealroom, LinkedIn company page, ZoomInfo, AWS Marketplace listings (none confirmed as Shovels).

Internal:
- `docs/DATA_SOURCES.md`: our measured cadence and contact rates for Austin, City of Miami and Raleigh.
- `docs/research/2026-11-14-early-signals/E-competitors-and-acquisition.md`
- `docs/research/2026-11-14-early-signals/P1-competitor-check.md`
