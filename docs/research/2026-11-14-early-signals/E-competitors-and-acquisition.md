# Worker E: competitors, lawful acquisition, source discovery (Austin pilot)

Research date 2026-11-14. Builds on `docs/DATA_SOURCES.md` "Competitor coverage" (2026-11-13) and does not repeat it.
Labels: **[Verified-live 2026-11-14]** = I fetched the API and saw the result. **[Read-from-page]** = the vendor's or agency's own page says it (fetched 2026-11-14), but I did not test it. **[Search-title]** = seen only as a search-result title or URL. **[Unverified]** = memory or inference.
Limits: the shared WebFetch budget ran out partway through. Several pages (Dodge pricing, Comptroller tax files, Legistar API page, Shovels/Sacra, Reonomy, Mercator) could not be read and are marked as such. The shell cannot reach any outside host.

---

## Part 1: Competitors

### 1.1 The finding that changes our positioning: Zabalist (Texas, deepest in Austin)

The repo only mentions Zabalist as "republishes TABS monthly". It is actually a **direct Austin competitor in our slice**.

- **What it covers** [Read-from-page zabalist.com, /compare/constructconnect, /permits/city/austin, /site-plans/10350716, /projects/EABPRJB5808075]:
  - Texas only, "deepest coverage in Austin/Travis County".
  - Austin **issued** permits: 166,039 rows, building plus electrical, mechanical and plumbing, re-synced "nightly".
  - **Austin site plans**: case number, status milestones, units, floor area, a `TCAD ID` and links to the ABC portal.
  - The full TDLR TABS archive (335K+ projects), ESBD bids, and a TCAD value history.
  - **Deed history with grantor and grantee names**.
  - A 153,881-company directory with "recorded projects, locations, and business relationships", and contractor-to-permit linking ("other permits linked from their directory profile").
- **Pricing** [Read-from-page]:
  - API: Free 500 calls; $49 (10k); $149 (100k); $399 (500k) per month. Contractor Verify costs $0.15 per lookup over the allowance.
  - "Opportunities" homeowner and trade lead tool: from $49/mo (one trade, 3 ZIPs, postcards included).
  - Territory Feed from $199/mo.
  - Free accounts get records 7 days late, starting 2026-12-01.
- **What I did not see**:
  - No Austin **plan-review cases** (`n8ck-xkda`), so nothing at building-application stage. Its permits page covers "issued building permits" and does not mention applications. This is [Unverified absence]: the pages do not mention it, and I did not test the product.
  - No trade-matched alerts at intake.
  - No GC-to-sub pair analytics.
- **Weak spots seen**:
  - The permit page says "Issued in the last 90 days: 0" next to "last updated Nov 11, 2026", which is self-contradictory.
  - Site area differs between the case and TCAD (4.33 vs 2.15 ac) with no explanation.
  - It **displays owner names and deed grantors**. Our COMPLIANCE rules forbid that, and we should not copy it. It is a legal risk for them, not a feature gap for us.

**Consequence.** The DATA_SOURCES claim "none of the pages read claims residential and light-commercial plan-review filings linked to issued permits and trade permits with GC-sub history" still holds, but the margin is thin:
- Site plans, TCAD joins, TDLR and contractor work-history pages are **already commodity in Austin, at $49/mo**.
- What is left is narrower. Plan-review intake (`n8ck-xkda`) linked to the issued BP through `masterpermitnum`, then to that BP's trade permits, gives:
  - observed GC-to-sub pairs, and
  - the "no trade permit yet" gap per trade, delivered as a trade-matched list.

### 1.2 Competitor answers for our slice

Columns:
- **Plan.** Monitors planning records.
- **Pre-app.** Captures applications before approval.
- **Pkts.** Analyses meeting packets.
- **Hist.** Links historical projects to companies.
- **Alert.** Alerts before the permit is issued.

| Platform | Plan | Pre-app | Pkts | Hist | Alert | Contacts | Price | Weakest for Austin residential and small commercial |
|---|---|---|---|---|---|---|---|---|
| **Zabalist** | Yes: Austin site plans [RfP] | Site plan stage yes; building plan review not seen | No | Yes, company directory [RfP] | Weekly ZIP watch, saved searches [RfP] | Owner and design-firm contacts partly masked; "contact credits" on paid plans [RfP] | $0-399/mo API, $49+ leads [RfP] | No plan-review intake seen; data-quality slips; shows personal names |
| **ConstructConnect** | Yes, on Professional [RfP pricing page] | "Permit Filing" stage (existing table) | Uses "planning commission records" (existing) | 575k companies (existing) | Daily saved searches (Professional) [RfP] | Phone, email, LinkedIn on Professional and Premium [RfP] | Starter **$129/mo per market per seat** (bidding projects only); Professional **from $199/mo per market per seat**, annual; Premium **from $10,000/yr** [RfP constructconnect.com/pricing] | Page says only "public and private commercial"; no residential claim [RfP]. Takeoff product is separate |
| **Dodge** | Pre-design and design (existing) | "Permit" stage (existing) | Unknown | Company profiles | Yes | Not stated | Not published; third-party pricing pages exist but are unread [Search-title] | Pre-design records "updated every 8 months" (existing); no residential focus [Unverified] |
| **Shovels** | Paid plans include **"Decisions: zoning and development decisions made before a permit is filed"** [RfP shovels.ai/pricing] | No, as far as seen | Sacra says it is moving to planning-commission signals (unread, paywalled) | Contractor profiles, licences, work history, contacts [RfP] | Unknown | Contractor contacts; "Residents" (homeowner) contacts [RfP] | Free (500 credits, 10 results per query); **Basic $599/mo**, **Pro $999/mo**, Enterprise custom; 1 credit = 1 record; the page contradicts itself on credit counts [RfP] | National breadth, but Austin decision coverage and lag unverified. Records-based price makes per-metro use expensive |
| **BuildZoom** (also licenses to Cotality) | Not mentioned [RfP buildzoomdata.com] | No | No | "Review an individual contractor's work history"; 6M contractors [RfP] | No | "Contact information" [RfP] | Quote only; bulk weekly or monthly [RfP] | Issued permits only; weekly or monthly bulk |
| **Cotality (CoreLogic) permits** | No mention | No | No | Contractor details field; "sourced from BuildZoom" [RfP] | No | Not stated | Quote only [RfP] | Reseller of BuildZoom; no freshness claim |
| **Building Radar** | Yes, "planning application" stage [RfP pricing page] | Implied | Unknown | "Network mapping" (existing) | Yes | Fully Managed plan does the cold outreach for you [RfP] | Quote only; success-based pricing available [RfP] | Munich-based, "5M+ projects globally"; US residential depth unknown |
| **Construction Monitor** | No | No (issued permits) | No | Top Company and New Company reports [RfP, Dallas area page] | "Real-time leads" claimed, yet "All Areas are delivered weekly" [RfP] | Not stated | Quote only, 1-week trial [RfP] | Weekly cadence; Austin area page not read |
| **GatherGov** | Yes: council and planning-board meetings | Rezoning and entitlement items | **Yes**: Austin page says agents analysed "1,015 meetings, ~1,000 hours of audio/video, 1,606 documents" over 12 months [RfP gathergov.com/.../austin-tx/development-pipeline] | Lists active developers and consultants | Subscription report; alerts not stated | No | Not published | Large and public projects (FedEx, Austin Water, data-centre loads); "Updated 03-01-2026" on the page |
| Mercator.ai, CivicIQ, Newscatcher "zoning approvals database", FiscalNote PolicyNote local, Apify Legistar and zoning trackers | Meeting minutes and agendas as an "early signal" | n/a | **Yes** (product category exists) | n/a | Varies | n/a | Unread | [Search-title] only. The point is that agenda AI is already a crowded category |
| **Sinra.ai** | No | No | No | Contractor profiles with project counts (for example, KB Home, 44 projects) built from Austin permits [RfP] | No | None | Consumer marketplace | Consumer-facing; issued permits only |
| **Levelset (Procore)** | No | No | No | Per-contractor and per-owner "permits" pages for Austin firms [Search-title] | No | Unknown | Free SEO pages | Lien and payment angle; content unread |
| **Apify Austin actors**: `pairsoftwosocks/building-permits-feed`; `lowlanddata/building-permit-monitor` (Austin, Chicago, SF, Seattle, NYC); `plat/plat-permit-monitor` | No | lowlanddata emits applied date and status changes | No | No | Status-change alerts at $0.02 each [RfP] | None (applicant and owner excluded) | $1.50 per 1k records; ~$2-8/mo [RfP] | **1 user each, 0 to 1 monthly active** [RfP]. A plain Austin permit feed has no market value on its own |
| **Zonda (Metrostudy)** | Lot and subdivision supply surveys; New Home Lot Supply Index press releases [Search-title] | Subdivision pipeline | No | Builder-level | Unknown | Unknown | Unread | Homebuilders already buy lot intelligence; our `s7gx-9m54` covers a free subset |
| **Regrid** | No (parcels) | No | No | No | No | Owner and mailing (Texas fields unread) | Self-serve "from 2,000 parcel records/mo"; enterprise above 10k/mo; Data Store prices not shown [RfP] | **Travis: 435,820 parcels, refreshed 2026-11-11. Williamson 290,973 and Hays 122,519, both 2026-10-28** [RfP app.regrid.com/store/us/tx] |
| **ATTOM** | No | No | No | No | No | Ownership | **Basic Property API from $500/mo**; Premium is quote-only; permits are an add-on [RfP] | Texas is a non-disclosure state, so recorded sale prices are thin. ATTOM's page says nothing about Texas [RfP] |
| **TaxNetUSA** | No | No | No | No | No | Owner (appraisal roll) | Travis $2.99-12.49/mo; bulk by quote [RfP] | Resells TCAD; "up to date as of Sep 11, 2026" |
| Reonomy, Cherre, LandGlide, Land.Tech, CoStar | Commercial real estate ownership and pipeline. Cherre resells Shovels and BuildZoom (Cherre vendor pages, RfP). CoStar tracks multifamily and commercial construction pipelines (articles, Search-title) | No | No | Owner LLC "unmasking" (Reonomy) [Unverified] | No | Owner contacts | Unread | Not residential or small commercial; not lead tools for subs |
| Local trackers: **austintowers.net**, Downtown Austin Alliance "Emerging Projects", **GroundBreak Austin** daily newsletter (Buttondown), ABJ Book of Lists | Downtown towers; news-sourced items | Some | Human-read | No | Newsletter | No | Free | Downtown and high-rise only [Search-title] |

### 1.3 Gap matrix

● = has it (page states it), ◐ = partial, ○ = not seen, ? = unread.

| Capability | Zabalist | ConstructConnect | Dodge | Shovels | BuildZoom | GatherGov | Us today | Us feasible |
|---|---|---|---|---|---|---|---|---|
| Commercial planning stage, researched by phone | ○ | ● | ● | ○ | ○ | ◐ | ○ | **No.** We cannot match 400 researchers and 1M verification calls a year |
| Austin site, subdivision and zoning cases | ● | ◐ | ? | ◐ | ○ | ◐ | ○ | Yes, but commodity |
| Austin **building plan-review intake** (residential and small commercial) | ○? | ○ | ○ | ○? | ○ | ○ | ● (in pipeline) | **Yes. Our edge**, unverified until side-by-side |
| Plan review linked to issued BP to trade permits (official `masterpermitnum`) | ○ | ○ | ○ | ○ | ○ | ○ | ◐ | **Yes** |
| GC-to-sub pair history ("who works with whom") | ◐ (relationships) | ○ | ○ | ○ | ○ | ○ | ◐ | **Yes**, needs counsel Q10 |
| Trade-matched "no trade permit yet" lists | ○ | ○ | ○ | ○ | ○ | ○ | ● | Yes |
| Meeting-packet AI | ○ | ? | ? | ◐ | ○ | ● | ○ | Not worth it (crowded; Austin cases are already structured) |
| TDLR TABS, TCAD, deeds | ● | ○ | ○ | ◐ | ○ | ○ | ◐ (TCAD facts) | Commodity; we must hide owner and deed names |
| National breadth | ○ | ● | ● | ● | ● | ◐ | ○ | No |
| Verified phone and email | ◐ | ● | ? | ● | ● | ○ | ◐ (permit phones) | Permit-listed phones only (Austin 91% company) |

### 1.4 Blunt verdict

- **We cannot win** on:
  - commercial planning-stage leads (ConstructConnect, Dodge),
  - national permit breadth (Shovels, BuildZoom),
  - meeting-agenda intelligence (GatherGov, Mercator and others),
  - price for Austin site plans, TDLR and TCAD pages (Zabalist at $49).
- **We can win** on one narrow, measurable claim for one metro: *"the residential and light-commercial building applications filed in Austin this week, the builder behind each, which subs that builder used on its last N jobs by trade, and which trades have not been permitted yet."*
  - The intake feed is public domain and published the same day.
  - The link key is official (`masterpermitnum`).
  - None of the pages read claims it.
  - That is a workflow advantage, not a data monopoly: Zabalist could add `n8ck-xkda` in a week. Speed of execution and precision (expediter filtering, trade gap) are the moat, not exclusive access.
- **Run the proof first.** Do ROADMAP E1 now, with Zabalist (free or $49) and Shovels free added: take 50 recent Austin plan-review folders and record whether each competitor shows the filing, when, with which company, and linked to which trade permits.
  - If Zabalist already shows plan-review intake, the slice shrinks to GC-to-sub analytics plus trade-gap lists.

---

## Part 2: Lawful acquisition, Austin and Texas specifics

| Method | What it gets, and the facts | Cost and turnaround | Earliest stage | Lawyer? | Recommendation |
|---|---|---|---|---|---|
| **City of Austin PIR** (DSD, Austin Water and Austin Energy all go through one portal, `austintx.govqa.us`; you pick the department) [RfP austintexas.gov/services/submit-public-information-request] | Ask for: (1) the AMANDA people or role table for plan-review folders in `n8ck-xkda` (agent, engineer, contractor-of-record if captured) over the last 90 days, by `folderrsn`; (2) Austin Water tap and service applications with the engineer firm, address and date; (3) ROW, driveway and sidewalk permit applications (the AMANDA ROW layer needs a token, HTTP 499, per DATA_SOURCES); (4) DSD pre-application and "development assessment" meeting requests | No fee to file. $0.10/page; personnel $15/hr (none under 50 pages); **programming $28.50/hr + 20% overhead**; $45 off-site retrieval. Over **$40** you get an itemised estimate, and the request closes if you don't answer within 10 days. Release target 10 business days, status on day 8 [RfP]. The requester's purpose cannot be asked (§552.222) [Unverified, statute from memory] | Application or pre-application | Yes for item 2b below | **Do one.** A 90-day query costs roughly $50-150 [Unverified estimate]; the response proves which hidden fields exist |
| Recurring exports by PIR | The Act does not oblige a body to honour **standing requests** for future records (OAG handbook, citing ORD 465/476) [Unverified, from memory] and does not oblige it to create new information (§552.231 governs programming estimates) [Search-title on statute] | Re-file monthly, or ask the open-data team to **publish the columns** in `n8ck-xkda` | | No | Ask DSD open data to add plan-review contact roles to the dataset. That is cheaper, permanent and public domain |
| **Austin Energy** service and load applications | Not public (DATA_SOURCES) | Via PIR | Site plan or design | **Yes**: §552.133 (public power competitive matters) and Utilities Code §182.052 (customer data) likely allow withholding [Unverified] | Do not pursue before counsel |
| **Travis County Clerk** official records (deeds, plats, liens) | `tccsearch.org` index and redacted images from the mid-1980s. Free watermarked prints; $1/page emailed; $5 + $1/page certified; new images appear online in about 72 h [RfP countyclerk.traviscountytx.gov "Recording Search + Copies"]. **No bulk or subscription product on the page**; a fee schedule PDF exists (unread). Title plants (TitleData, CourthouseDirect) resell [Search-title]. tccsearch.org terms: unread (budget) | Unknown for bulk; ask by PIR or the Recording division | Land/ownership (deeds, plats); construction activity and after (mechanic's liens, Property Code ch. 53, which name the claimant sub, the original contractor and the owner) [Unverified] | Yes: reuse of the index and any automation of tccsearch | **Investigate only.** Lien affidavits are a unique sub-to-GC relationship signal, but they are late and adversarial. Ask the clerk whether a bulk index exists and its price |
| **Travis CAD** (already used) | New facts only: Regrid has Travis refreshed 2026-11-11 and TaxNetUSA's appraisal data is dated Sep 11, 2026 [RfP]. Nothing changes the existing TCAD rules | Free | Land | Q9 already open | Keep |
| **Texas SOS bulk** [RfP direct.sos.state.tx.us/help/help-corp.asp?pg=bulk] | Master Unload **$1,750** (new) or $1,350 (previous). Daily update subscription **$60/mo**, weekly $20/mo, weekly new-filings CSV **$20/mo**, list by entity type $200. Fields: legal name, type, formation date, registered agent, initial managers or directors. **No phones.** Fixed-width files; needs a SOSDirect account. Use terms are not on the page | As listed; daily files arrive the next business day | Land (a new builder LLC or SPE formed) | Yes: reuse terms; ch. 509 data-broker exposure from officer names | **Not now.** Permits carry no SOS file number, so the match would be name-only, a weak key under ADR-12 |
| **Comptroller** | "Active Franchise Tax Permit Holders" and "Active Sales Tax Permit Holders" on data.texas.gov via data.gov [Search-title]; tax-files request page unread | Free (open data) | n/a (entity enrichment) | Low | Use later for entity normalisation (taxpayer number, address) if ADR-12 needs a tie-breaker |
| **Licensed parcel and deed vendors** | Regrid (prices hidden; self-serve from 2,000 records/mo); ATTOM Basic from $500/mo [RfP]. **Texas non-disclosure**: sale prices are not public, and TCAD §22.27 makes confidential sale prices a misdemeanour to disclose (COMPLIANCE 1.11) | $500+/mo | Land | Yes, for any vendor sale-price field | **Not worth it**: TCAD gives us the parcel facts free |
| **Direct data agreements with cities** | No precedent verified this session. Austin data is already public domain, so an agreement would only buy fields that aren't published | Staff time | | Yes (contract) | Use an open-data request, not a contract |
| **Legistar API** | `austintexas` is open with no token (verified 2026-11-13, DATA_SOURCES). Some clients require tokens (NYC Council API page) [Search-title]. Granicus publishes no public API terms (existing finding); Granicus product terms bind the city, not us [Unverified] | Free | Entitlement | Low | Already known; parse case numbers only |
| **Socrata and Tyler** | Tyler's "Data & Insights SaaS License Agreement" binds the customer government [Search-title]; reuse is governed by the city's own terms (Austin: public domain). **Live check**: licence metadata is missing on 4 of the 10 newest Austin datasets, and one says "See Terms of Use" (below) | Free | | Read the Socrata API terms once (COMPLIANCE 1.3 is still open) | |
| **ArcGIS Hub and Online** | Licence is a per-item field and often only a disclaimer (Miami-Dade, COMPLIANCE 1.2) | Free | | Per item | |

**Needs counsel:** the Austin Energy and Austin Water customer-data exceptions; reuse of the Travis Clerk index and any automated read of tccsearch.org; SOS bulk reuse plus ch. 509; any vendor sale-price data. Existing Q2, Q9 and Q10 also apply.

---

## Part 3: The owner's "Automated Source Discovery Engine"

### 3.1 Discovery APIs that exist

| Catalog | Machine search? | Notes |
|---|---|---|
| Socrata Discovery API `api.us.socrata.com/api/catalog/v1` | **Yes.** [Verified-live 2026-11-14: `?domains=datahub.austintexas.gov&only=dataset&order=createdAt&limit=10` returned `resultSetSize` **680** with `createdAt`, `updatedAt`, `data_updated_at` and `metadata.license`] | Already used by `recon/preapproval_scan.js`. The 10 newest Austin datasets (created 2026-10-02 to 11-07) include **no** new construction signal; the closest is `fbg7-9ebg` "Austin Facilities Management Current Projects" (the city's own projects). Licence missing on 4 of 10; "See Terms of Use" on `q2xm-giab` |
| ArcGIS Online `sharing/rest/search` | Yes (used in the repo) | ArcGIS Hub also has a Search API (OGC API Records) at developers.arcgis.com/hub/services/search [Search-title] |
| CKAN (catalog.data.gov `package_search`) | Yes [Unverified for parameters] | Mostly harvests the same Socrata and ArcGIS items, so it adds little for Austin |
| Legistar | Per-client API only; **no public client-list endpoint** (people ask on open-civic-data how to find their city's client name) [Search-title] | Discovery means guessing slugs |
| eScribe (Raleigh since 2025-07-01), Granicus/Swagit (Georgetown video), CivicPlus Agenda Center (`/AgendaCenter` and `Rss.aspx` URL patterns on many small Texas cities), Round Rock's own events and "Replay" pages [Search-title] | **No catalog.** Each city is a different HTML or PDF system | The Austin suburbs are heterogeneous, so every agenda source is a hand-built adapter |
| OpenGov, Accela, Tyler EnerGov portals | No catalog; portals often forbid automation (COMPLIANCE 1.8) | |

### 3.2 What can and cannot be automated

| Step | Automatable? | Evidence from this repo |
|---|---|---|
| Enumerate datasets and services, diff new, changed and removed | **Yes**, cheap | A catalog-diff call works (above) |
| Column heuristics, status vocabulary, fill rates, pre-issue share, rows-per-day lag proxy | **Yes**: `preapproval_scan.js` already does this | 117 + 55 + 22 datasets probed on 2026-11-13 |
| PADAS sub-scores for stage, speed, participants, access | Mostly yes | The terms score must stay a human input |
| **Reading terms** | **No.** Licence metadata is blank or "See Terms of Use" on 5 of 10 new Austin datasets; Philadelphia's ban was on a site page, not in metadata | Rule 4 and COMPLIANCE |
| **Field mapping** | **No** (hard rule 1 forbids guessed `fieldMap`s) | Raleigh `filedDate` was mis-mapped; `tcad_id` matches only 90.8%; "applicant" is often an expediter; `masterpermitnum` was found by hand |
| Quality testing against a fixture | Semi: scripted once a human picks the fields (rule 10) | |
| Link-key discovery across systems | No. It needs domain judgement | |

### 3.3 Verdict and minimum viable version

**The full engine is premature.**
- In Austin, discovery is not the bottleneck. The 2026-11-13 sweep already found the pre-approval datasets that matter.
- The live diff shows that 10 new Austin datasets in six weeks contained nothing useful.
- The cost is all in evaluation: terms, field semantics, linking, fixtures. That work is human by rule.
- A national engine also feeds a multi-market strategy that ADR-16 and the roadmap have not yet earned.

**What to build instead**, effort S, after M1, one workflow:
1. **Weekly catalog diff.** Add an `--only=diff` mode to `preapproval_scan.js`. It covers `datahub.austintexas.gov`, `data.texas.gov`, and the ArcGIS orgs of Travis, Williamson and Hays plus Round Rock, Georgetown, Cedar Park, Pflugerville and San Marcos. Store a small snapshot of ids, names, column hashes and `data_updated_at`; this is KB-scale and safe on Neon.
2. **Schema-drift and staleness alarms for the sources we already ingest.** This is the most valuable part, because it enforces rule 3: a renamed column or a stale `data_updated_at` becomes a recorded failure, not a silent one.
3. **Human-reviewed `source_candidates` registry** with the PADAS rubric. The automatic parts are filled in; terms default to "unread = 4". A candidate becomes a connector only after a human reads the terms, a fixture is recorded and the DATA_SOURCES entry is dated.

**Not now:**
- LLM-read terms used as decisions.
- Auto-generated connectors.
- Crawling city sites for Agenda Centers.
- Meeting-packet PDF parsing. GatherGov already sells this for Austin, and Austin's zoning and site-plan cases are already structured in `edir-dcnf` and `mavg-96ck`.

---

## Top recommendations for the Austin pilot

1. **Side-by-side proof (E1) against Zabalist and Shovels free tiers** on 50 Austin plan-review folders. Cost $0-49 and about a day. It decides whether our slice exists.
2. **Narrow the pitch** to plan-review intake, linked to the issued BP and its trade permits, with GC-to-sub history and trade-gap lists. Stop presenting site plans, TCAD or TDLR as differentiators; they are $49 commodities.
3. **One City of Austin PIR**, plus an open-data request to publish plan-review participant roles in `n8ck-xkda`. It tests what is hidden (contractor-of-record or agent at intake) cheaply and lawfully.
4. **Weekly catalog-diff and schema-drift job** with a human-reviewed registry (3.3). Effort S, protects rule 3.
5. **Expediter filter as a product feature.** Competitors list the raw "applicant". Mapping expediters (Austin Permit Service and others) to the real builder through the BP's contractor is precision work nobody advertises.
6. **Ask the Travis County Clerk about bulk index access.** Mechanic's-lien affidavits are a unique sub-to-GC signal. Counsel reviews reuse first.

## Things that look valuable but are not worth it now

- **Meeting-packet and agenda AI.** Crowded (GatherGov, Mercator, CivicIQ, FiscalNote), mostly large commercial projects, and Austin's cases are already structured.
- **Competing on commercial planning-stage leads.** ConstructConnect's research staff and $199/mo Professional tier, and Dodge.
- **SOS Master Unload ($1,750) and daily feed ($60/mo).** Name-only matching is a weak key.
- **Regrid or ATTOM ($500+/mo).** TCAD covers parcel facts for free; Texas sale prices are non-disclosure and §22.27-sensitive.
- **Austin Energy load data by PIR.** Likely withheld under §552.133; counsel first.
- **Homeowner lead tools.** Zabalist sells one at $49/mo, Shovels sells "Residents", and Apify feeds have no users. ADR-10 gate anyway.
- **A national discovery engine.** Discovery isn't the bottleneck; evaluation is human by rule.
