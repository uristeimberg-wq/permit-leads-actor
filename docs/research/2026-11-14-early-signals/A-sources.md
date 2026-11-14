# Worker A: unconventional early-signal sources for the Austin pilot

Date: 2026-11-14. Scope: sources beyond `n8ck-xkda`, `mavg-96ck`, `s7gx-9m54`,
`edir-dcnf`, `ykxk-t5y9`, `mxm5-tdpj`, TDLR TABS and the TCEQ construction-NOI
negative, which are already in `docs/DATA_SOURCES.md`.

**Method and limits (read this first).** Live checks used WebFetch against
Socrata (`api.us.socrata.com` catalog and `datahub.austintexas.gov/resource/...`).
The container shell cannot reach these hosts (`curl` gets `CONNECT tunnel
failed, response 403`, checked 2026-11-14). After about 20 fetches the
**shared WebFetch budget (100/hour across all agents) ran out**, and most later
attempts were refused. So the City of Austin datasets below are verified live.
Most state, county and procurement items are **[Read-from-page]** only to the
extent a search result title or URL shows the page exists, and otherwise
**[Unverified]**. I did not open those pages. Treat their access terms, fields
and prices as open questions, not findings.

Labels: **[V 2026-11-14]** means fetched live (URL given). **[Exists]** means
the URL appeared in a search result but I did not open it. **[Unverified]**
means memory or inference.

Stage ladder: land → entitlement → site plan/design → building application →
issued permit → construction activity → completion.

---

## 1. City of Austin open data: new finds

### 1.1 Roadway Work Zones `qyfh-gwei` (AMANDA ROW permits, WZDx). New and open

- **URL:** `https://datahub.austintexas.gov/resource/qyfh-gwei.json` **[V 2026-11-14]**.
  `data_updated_at` 2026-11-14T07:01. 3,288 rows. `start_date` runs from 2026-01-17
  to 2028-04-03, so it holds current and future closures, not history. A JSON
  WZDx feed `d9mm-cjw9` and a GitHub repo `cityofaustin/dts-work-zone-data-feed`
  exist **[Exists]**.
- **Fields:** `name`, `description`, `road_names`, `direction`, `start_date`,
  `end_date`, `vehicle_impact`, `work_zone_type`, **`folderrsn`** (the AMANDA
  folder id, the same key family as the plan-review `folderrsn`), `geometry`
  (LineString), `critical_corridor`.
- **Example (abbreviated):** `name` "JE Dunn Construction - Colorado St Lane
  Closures- CapComp Phase 2", folderrsn 13167300, 2026-07-05 to 2026-12-25,
  all-lanes-closed. Another: "AE/Mastec/Primoris - W OLTORF ST 1400 BLK -
  Replace Wiring". A third: "CIP - WPD/SCC - Delcrest Dr 2200 BLK - Del Curto
  Storm Drain Improvements".
- **Catch:** of 39 closures starting 2026-11-10 to 11-11, **27 were named only
  "WorkZone Event"**, with the description "Excavation Permit has been issued
  for this location." The rest were CIP jobs. So the contractor appears as
  free text in `name` on a minority of rows, mostly large or public jobs. Most
  private excavation closures carry no company.
- **Why it matters:** the earlier scan recorded the AMANDA ROW layer as token
  gated (HTTP 499). This is an **open path to part of the same ROW permit
  data**, keyed by `folderrsn`, with future start dates.
- **Earliest stage:** construction activity (ROW work), sometimes weeks before
  vertical work. Rarely earlier than the building permit.
- **Combination:** a spatial join of `geometry` to parcels or the issued-BP
  address within about 50 m and ±60 days. Test whether `folderrsn` matches
  plan-review or BP folder ids (unverified). Company text in `name` goes to
  `business_identifiers` only after the ADR-12 strong-key rules.
- **Complexity:** S (Socrata, small). **Freshness:** daily or better.
- **Pilot:** **yes, cheap add.** Value is construction-start confirmation and
  some GC naming on large jobs, not early discovery.

### 1.2 Active Right of Way Contractor License Holders `8d92-wsiw`

- **URL:** `https://datahub.austintexas.gov/resource/8d92-wsiw.json` **[V 2026-11-14]**,
  updated 2026-11-13. Fields: `contractor_name`, `license_number`
  (e.g. `2013-000550LC`), `issue_date`, `expiration_date`, `insurance_expiration`.
- **Example:** "Kent Companies Texas, LLC", 2013-000550LC; "Shamrock Concrete,
  LLC([individual])". Names carry staff prefixes such as "**2026/10/06 TAS**" and
  "**MH**" and parenthetical people. **Clean these before use; never display
  the parenthetical person** (rule 5).
- **Value:** a registry of firms licensed to work in Austin ROW (site, utility,
  concrete, dirt work). The licence number is a strong identifier for ADR-12
  `business_identifiers`. A new licence issue date is a "new firm entering the
  market" signal.
- **Earliest stage:** none (company registry). **Complexity:** S. **Pilot:**
  yes, as entity-resolution reference data, not as leads.

### 1.3 Affordable Housing Inventory `ifzc-3xz8`: subsidised and incentive pipeline

- **URL:** `https://datahub.austintexas.gov/resource/ifzc-3xz8.json` **[V 2026-11-14]**,
  updated 2026-11-13, rows modified 2026-11-02 to 11-05.
- **Fields:** `project_name`, `ownership`, **`developer`**, `address`,
  **`parcel_id`** (TCAD-style, e.g. `0212010216`), `unit_type`, `housing_tenure`,
  **`development_status`**, `development_type`, `total_units`,
  `affordable_units`, the funding flags `smart`, `density_bonus`,
  `affordability_unlocked`, `go_bonds_*`, `private_activity_bonds`,
  `aegb_rating`, `created`, `modified`.
- **Status counts (live):** Under Construction 122, **Loan Awarded 13**, Loan
  Closed 1, **Certified 181** (SMART / density-bonus certification, which
  generally precedes permits [Unverified]), Project Completed 833,
  Affordability Period Expired 1,272.
- **Example:** "Quarters at Grayson", developer Simmons Vedder & Company, 714 W
  22nd St, parcel 0212010216, 100 units, density bonus "University
  Neighborhood Overlay". The owner field can be "Unknown".
- **Loan Awarded sample (live, 8 of 13):** "Rowen Vale", Saigebrook, 206 E
  Annie St, parcel 0302000812, 64 units, created 2025-12-15. "The Lenora",
  Saigebrook, 4507 Menchaca Rd, 39 units, 2025-12-15. "Aspire at Big Austin",
  Mission Development Group, 1100 E Braker Ln, 368 units. "Verbena Flats", JCI
  Multifamily LP, 1017 W Slaughter Ln, 328 units (created 2022, still
  "Loan Awarded"). "Goodnight Ranch - Habitat SF - East Section 1", Momark
  Development LLC, 47 units, **no parcel_id**. Every developer is a company.
  Some rows sit at this status for years, so status age has to be tracked.
  I could not test whether these addresses already appear in `mavg-96ck` or
  `n8ck-xkda` (fetch budget). That is the first measurement to run.
- **Earliest stage:** **entitlement / financing**. A city loan award or SMART
  certification usually comes months before a site plan or permit
  [Unverified, needs a link-rate test].
- **Value:** names the **developer** (the buyer GCs and suppliers want) for
  income-restricted multifamily, a segment Dodge does cover. Unique angle: a
  `parcel_id` join to site plan `tcad_id` and BP `appraisal_id`.
- **Complexity:** S. **Freshness:** edits weekly-ish. **Pilot:** **yes.**
  Ingest the pre-construction statuses and measure how many reach `n8ck-xkda`
  or `mavg-96ck`, and with what lead time.

### 1.4 Capital Open Budget `ad5y-pg42` and Public Improvement Bonds `s39q-8hvy`

- **[V 2026-11-14]** `ad5y-pg42` updated 2026-11-13. Fields: `department_name`,
  `project_id`, `project_name`, `subproject_id`, `subproject_name`,
  `appropriation_to_date`, `expenses_to_date`. Example: Transportation and
  Public Works, project 12440 "Cap Metro Transit Speed and Reliability", sub
  12440.001.
- **No location, no contractor, no stage.** CIP subprojects show in the Work
  Zones feed as "CIP - ..." text, but no shared key was seen.
- **Earliest stage:** land/budget (years ahead). **Pilot:** **no.** Public
  works are bid-driven and already covered by ConstructConnect and Dodge.

### 1.5 Dead ends and weak items on datahub (recorded so nobody repeats them)

| Dataset | Finding [V 2026-11-14] | Verdict |
| --- | --- | --- |
| Residential Water Meter Inspections/Installs `6zcs-yxb3` | **47 rows**, dates 2026-04-24 to 2026-05-12, last data update 2026-05-14. Fields: `service_request`, `address`, `meter_installation_status`, `date` | A status lookup, not a feed. Stale. Drop |
| Demolition family (`pws3-a5fj`, `yiii-tj7t`, `qkuc-w9um` and others) | Named derived views of Issued Construction Permits ("custom query against ... Issued Construction Permits") | Nothing beyond `3syk-w9eu`. Demolitions are already in our feed (filter `permit_class`/work type). Note: a total demolition is a strong "new build coming" signal, so a demo-to-new-BP link is worth computing from data we already have |
| AEGB `dpvb-c5fy` (aggregate by fiscal year), `jguv-75bx` (map returned `{}` rows over SODA), FY rated-project datasets | Rated projects only, **after completion**, published per fiscal year | History and relationship value only (rated MF and commercial project lists can name developers). Not early. Low priority |
| Historic: `vvuz-m3y4` Historical Landmarks; EBPP tracking datasets | No case-level Historic Landmark Commission or demolition-review dataset found in the catalog | HLC cases are reachable only through Legistar and agenda PDFs (already listed). Drop as a dataset |
| Environmental: CEF layers (springs, rock outcrop, buffers), EII, Edwards Aquifer zone, Stormwater Reference Plans `neza-drgj` | Geometry layers digitised from construction plans, no applicant and no dates seen in the catalog text | Context layers only (for example, "site is in the recharge zone, expect long review"). Drop as signals |
| ROW permit counts `hyc6-zz9w`, `ij2v-mrv3` | Counts by type and week | Use only to measure feed completeness. Not leads |
| Registered Water Services Technicians `eyec-w6nz` | Technicians and **their employers** (catalog text) | Small entity reference set for plumbing and backflow firms. Optional |
| Austin Water SER (Service Extension Requests) | Process pages and EDIMS PDFs exist (`austintexas.gov/ser`) [Exists]. No dataset found in catalog searches for "water" (103 hits checked: top 20) | SERs are a **very early (land/entitlement)** signal for edge-of-city subdivisions. Route: council or Water and Wastewater Commission agenda items (Legistar) or a PIA request for the SER log. Not verified |

---

## 2. Travis, Williamson and Hays counties

| Source | What exists | Label | Earliest stage | Notes and route |
| --- | --- | --- | --- | --- |
| **Travis County TNR Development Services** (unincorporated permits, subdivision construction plans, final plats, commercial site plans) | Application pages exist under `traviscountytx.gov/tnr/development-services/apply-for-a-permit/...` and a "TNR open records" page | [Exists] | Entitlement / site plan | **No open dataset found.** The county GIS server `gis.traviscountytx.gov/server1/rest/services/...` exists (it hosts a "Travis County TCEQ Water Districts" layer [Exists]). Check it for a subdivision or plat layer. Otherwise use the open-records route. Unincorporated eastern Travis County (Manor, Del Valle ETJ) is where tract-builder subdivisions start |
| **Travis County Clerk official records** (deeds, plats, deeds of trust, liens) | "Recording Search + Copies of Records" page `countyclerk.traviscountytx.gov/?p=481`. Third-party resellers (TaxNetUSA, CourthouseDirect, Deeds.com) sell Travis records | [Exists] | **Land** (deeds to builders, plats, construction deeds of trust) | Bulk price and terms **not verified** (fetch budget). Highest-value county item, because a deed of trust to a construction lender plus a plat recording is the earliest lawful "this land will be built" signal with company names. Ask the clerk for a bulk index price (the Miami-Dade analogue is $110 a month) |
| **Texas lien and commencement records** | Texas **does** have an optional **Affidavit of Commencement** (Prop. Code §53.124) recorded by owner and original contractor. Homestead residential work needs a written contract (§53.254), often recorded [Unverified: statute pages exist but I did not read them] | [Unverified] | Construction start | The brief says "Texas has no Notice of Commencement". That is **only partly right**: it is optional, so coverage will be low, but where recorded it names the GC. Homestead contracts name homeowners (gated, rule 5). Mechanic's lien affidavits are post-dispute history, useful for risk and relationships. All of these live in the clerk index above |
| **Williamson County Commissioners Court** | Destiny Agenda: `public.destinyhosted.com/94526/agenda/agenda.cfm?seq=...` with full agenda packets (PDFs under `/wilcodocs/2026/COM/...`), e.g. "Request for CCH (Willis Creek MUD)" (2026-02-24) and preliminary-plat items | [Exists] | **Land / entitlement** (MUD consent, preliminary plats in the unincorporated area) | Weekly. HTML agenda plus PDFs. Needs parsing (M). No API terms seen. Check robots.txt before any automated read |
| **City of Georgetown** (WilCo, fast growth) | ArcGIS services `gis.georgetowntexas.gov/arcgis/rest/services/PublicWebMaps/Planning_WebMap/MapServer`, `Planning/PlanningDevelopmentNew_WebMap` (its legend page shows "Login / Get Token") and `EconomicDevelopment/BusinessDevelopments_WebMap` | [Exists]. Login status mixed | Entitlement / site plan | Probe the public `Planning_WebMap` layers for case number, applicant and dates. Any token-gated service stays off (rule 4) |
| **Hays County Development Services** | Plat application, fee schedule and permitting pages (`hayscountytx.gov/permitting`, `/development-process`) | [Exists] | Entitlement | No dataset found. Commissioners-court agendas and public-records requests are the route. Low priority until the Austin model is proven |
| **MUD / water-district creation** | TCEQ "Texas Water Districts" dataset (data.gov harvest of TCEQ), TCEQ IWDD district search `tceq.texas.gov/waterdistricts/iwdd.html`, TCEQ commissioners' agenda backup PDFs for district items (`/agendas/backup/2026/2026-0471-dis-edr.pdf`) | [Exists] | **Land** (1-3 years before homes) [Unverified lead time] | District creation names the developer's district and its engineer. Very early, but there are few events (tens a year regionally), it is master-planned-community scale, and builder lots follow years later. Good context for builder and supplier customers, not weekly leads |
| **Travis CAD** | Already governed by COMPLIANCE.md | n/a | Land | A builder-entity owner change on raw land is a land-stage signal, but owner fields are restricted (CAD rules). Use only entity-type owners, per the existing rules |

---

## 3. State sources

| Source | Status | Label | Earliest stage | Value |
| --- | --- | --- | --- | --- |
| **Comptroller "Recent Sales Tax Permits"** (`comptroller.texas.gov/transparency/open-data/recent-sales-tax-permits`) and **Active Sales Tax Permit Holders** (data.texas.gov, catalog.data.gov harvest) | Pages exist. I could not open them | [Exists] | Pre-opening of a **new business location** (tenant finish-out) | A new outlet permit at an Austin address with NAICS restaurant or retail suggests tenant improvement. It is like TABC but covers all retail. Likely names the taxpayer business and outlet address [Unverified]. Lag versus build-out unknown: permits are often taken near opening, which may be **too late** for construction. Test against BP addresses |
| **Texas SOS business filings bulk order** (`sos.state.tx.us/corp/bulk-order.shtml`, JSON spec `bf-bulk-border-json-spec-v1.2.pdf`) | Pages exist. Price not read | [Exists] | None (entity registry) | Registered agent, officers and formation date for LLCs. Single-purpose LLCs ("XYZ Holdings Phase II LLC") formed by developers precede land deals. Officer names are individuals (hidden). Use as **entity-resolution keys** (SOS file number) more than as leads. Apify scrapers of SOSDirect exist. Do not copy that approach: use the paid bulk order or nothing |
| **TCEQ Water Quality Individual Permits Active/Pending** (data.gov harvest of a TCEQ dataset) | Exists by title | [Exists] | **Land / entitlement** (new package wastewater plants for subdivisions and MUDs) | Pending TPDES applications for new WWTPs in Travis, Williamson and Hays name the applicant (often the MUD or developer). Few, very early. Worth one probe |
| **TCEQ Central Registry / download-data page** (`tceq.texas.gov/agency/data/lookup-data/download-data.html`) | Exists | [Exists] | Varies | The prior scan found construction stormwater NOIs (TXR15) absent from open data. The download page may list Central Registry files, but construction NOI coverage there is **unverified**. If absent, the lawful route is a PIR (TCEQ publishes "tips for making a PIR") |
| **TxDOT letting** (`txdot.gov/business/letting-bids/letting-schedule.html`, per-county detail letting pages) | Exists | [Exists] | Bid (public highway) | Heavy-civil and covered by every bid service. **Not our slice** |
| **Texas ESBD** | Prior scan: robots.txt refused our fetcher | [V by prior scan] | Bid | Stays off (rule 4) |
| **TDLR TABS** | Already covered. New fact: Zabalist publishes per-project pages keyed by TABS number (e.g. `zabalist.com/projects/TABS2026006622`) [Exists] | | Design | Confirms a third party republishes TABS. Our own access still needs the terms decision |

---

## 4. Procurement and institutional capital

| Source | Label | Earliest stage | Notes |
| --- | --- | --- | --- |
| City of Austin Finance Online (`financeonline.austintexas.gov/afo/account_services/solicitation/solicitations.cfm?ccat=...`, per-solicitation `solicitation_details.cfm?sid=`) | [Exists] | Bid | HTML only, no export found (prior scan). Public works. Covered by ConstructConnect and constructionbids.ai. **Skip** |
| AISD 2022 bond program: schedule PDFs at `bond.austinschools.org/.../AISD_BondSchedule_External_08262026_en.pdf` | [Exists] | Design → bid | One PDF, refreshed a few times a year. Names campuses and phases, not subs. Covered by bid services. Skip as a feed. At most, use it as context for the school-district GCs relationship graph |
| UT System Capital Improvement Program (`utsystem.edu/.../cip-updates/fy-2027-2032-cip-aug26.pdf`, quarterly reports) | [Exists] | Land / design (years) | Quarterly PDF listing institution, project, cost and phase. UT Austin projects are large and Dodge-covered. Skip |
| Capital Metro, Travis County bonds | Not checked (budget) | | Same category: public, bid-driven, already aggregated |

---

## 5. Scoring (1-5; cost 5 = cheap)

| Source | Early | Unique | Action | Contact | Fresh | Cover | Reliab | Legal | Cost | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Affordable Housing Inventory `ifzc-3xz8` | 4 | 3 | 3 | 3 | 3 | 2 | 4 | 5 | 5 | Developer named. Income-restricted MF only |
| Roadway Work Zones `qyfh-gwei` | 2 | 3 | 3 | 2 | 5 | 3 | 4 | 5 | 5 | Start-of-work and GC on big jobs |
| ROW Contractor Licences `8d92-wsiw` | 1 | 3 | 2 | 3 | 4 | 3 | 4 | 5 | 5 | Entity keys |
| Travis County Clerk index (deeds, plats, DOTs, affidavits) | 5 | 4 | 4 | 3 | 4 | 5 | 3 | 3 | 2 | Price and terms unknown |
| WilCo Commissioners Court agendas | 4 | 3 | 2 | 2 | 4 | 3 | 3 | 3 | 4 | PDF parsing |
| Georgetown Planning ArcGIS | 3 | 3 | 3 | 2? | 3? | 2 | 3 | 3? | 5 | Unprobed |
| TCEQ pending WQ individual permits | 5 | 4 | 2 | 2 | 3 | 1 | 4 | 5 | 5 | Few events |
| TCEQ water districts / MUD creation | 5 | 3 | 1 | 2 | 2 | 1 | 4 | 5 | 5 | Context |
| Comptroller new sales-tax permits | 2? | 3 | 3 | 3 | 4? | 4 | 4 | 4? | 5 | Probably too late. Test |
| SOS bulk filings | 2 | 2 | 1 | 2 | 4 | 5 | 5 | 4 | 2? | Entity keys |
| Capital budget `ad5y-pg42` | 3 | 1 | 1 | 1 | 4 | 2 | 4 | 5 | 5 | No location |
| Procurement (AFO, AISD, UT, TxDOT) | 3 | 1 | 2 | 2 | 3 | 2 | 3 | 4 | 4 | Competitors own this |
| Water meter `6zcs-yxb3` | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 5 | 5 | Dead |

---

## Top recommendations for the Austin pilot

1. **Affordable Housing Inventory `ifzc-3xz8`** (verified, public, S). Ingest
   `Loan Awarded` and `Certified` rows as entitlement-stage `planning_cases`
   with the developer as a business. Measure the lead time to `mavg-96ck` and
   `n8ck-xkda` via `parcel_id` = `tcad_id`.
2. **Roadway Work Zones `qyfh-gwei`** (verified, S). Record each closure as a
   `lifecycle_events` "construction activity" row joined spatially to BPs, and
   take the contractor text from `name` when present. Test whether `folderrsn`
   joins the AMANDA family keys.
3. **Travis County Clerk index.** Get the bulk index price and terms (a phone
   or email request, or PIA). Deeds of trust from construction lenders, plats
   and the optional Affidavits of Commencement are the earliest company-named
   signal in Texas. Owner's decision on cost, like the Miami NOC decision.
4. **ROW Contractor Licences `8d92-wsiw`** as ADR-12 reference keys (licence
   number). Clean the staff prefixes. Hide the parenthetical people.
5. **One-off probes, each about 1 fetch:** the Georgetown `Planning_WebMap`
   layers; the Travis County GIS server for a plat or subdivision layer; the
   TCEQ pending WQ individual permits dataset (Travis, Williamson and Hays
   rows). Promote any that show applicant names and dates.
6. **Compute the demolition → new-build link from `3syk-w9eu`**, data we
   already have: a total demolition followed by a new-construction plan
   review on the same `tcad_id`. No new source needed.

## Things that look valuable but are not worth it now

- **Public procurement (Finance Online, AISD and UT bonds, TxDOT, Capital
  Metro, ESBD):** early, but bid services already aggregate it, it is outside
  the residential/small-commercial slice, and ESBD refuses automation.
- **MUD creation and TCEQ water districts:** the earliest signal of all, but
  there are tens of events a year, lead times run to years, and it is
  unactionable for weekly leads. Revisit as builder-customer context.
- **Texas SOS new-entity filings as leads:** individuals dominate, the link to
  a site is weak, and the bulk order costs money. Useful later only as entity
  keys.
- **Comptroller sales-tax permits:** likely issued near opening, after
  build-out. Run one address-match test before spending more.
- **AEGB rated-project data:** post-completion and yearly. History value only.
- **Austin Water SER and tap data:** genuinely early, but no dataset exists.
  A PIA request for the SER log is the only lawful route. Defer until the
  plan-review link rate is measured.
- **Hays County and other county development data:** no dataset found. Wait
  until the Austin model is proven.

## Corrections to the brief or the repo

- "Texas has no Notice of Commencement": Texas has an **optional** Affidavit
  of Commencement (Prop. Code §53.124) [Unverified: statute pages found, not
  read]. Low coverage is expected.
- The AMANDA ROW data is **not entirely token-gated**: `qyfh-gwei` exposes
  ROW permit `folderrsn`, dates and geometry openly [V 2026-11-14].
