# Data engine research: new early signals and contractor-intelligence sources

Date: 2026-11-14. Markets: Austin TX, Raleigh/Wake NC, Miami-Dade FL and City of Miami.

Scope: this report covers only what earlier work does **not** already cover.
I read `early-signals/A-sources.md`, `C-indirect-signals.md`,
`D-entity-resolution.md`, `P0-backtest-results.md`, `source_registry.json`, and
the "Enrichment sources" and "Pre-approval scan" sections of
`docs/DATA_SOURCES.md` first. Sources already covered there are not repeated:
Austin `n8ck-xkda`, `mavg-96ck`, `s7gx-9m54`, `edir-dcnf`, `ifzc-3xz8`,
`qyfh-gwei`, `8d92-wsiw`, TABC `mxm5-tdpj`, Raleigh pre-issue rows and ROW,
the Miami-Dade Clerk NOC bulk, TDLR licences, TSBPE, FL DBPR, TCAD, Miami-Dade PA,
TCEQ NOI (negative), and Austin Water SER / Austin Energy (no dataset).

## Method and labels

- 25 WebFetch calls and about 20 WebSearch calls. No shell access to
  government hosts (the container proxy refuses them; see A-sources).
- **[V URL, 2026-11-14]**: I read the page or service on that date. The
  field lists and dates come from the page.
- **[V-3p]**: verified only on a third-party page that mirrors official
  metadata (for example `d48reu.github.io/DataDictionary`, Abreu Data Works
  LLC, "Not an official Miami-Dade County product"). Re-verify from Actions.
- **[Exists]**: the URL or title appeared in a search result, but I did not
  open it.
- **[Inferred]**: my reasoning or prior knowledge. This is not a finding.
- "Unverified from container, verify from Actions via `recon/preapproval_scan.js`"
  is written as **[Actions]**.
- Scores: **Value** 1-5 (5 = most lead value for subs). **Effort** 1-5
  (1 = one connector afternoon, 5 = contracts, money or a lawyer first).

---

## 1. Headline findings

1. **Raleigh does have a planning-stage feed.** This corrects PADAS "no
   planning feed". `Development_Plans` on the City's ArcGIS Online org
   (`services.arcgis.com/v400IkDOw1ad7Yad`) holds "all submitted development
   plans that are approved or under review". It names the **developer** and
   gives units and square footage requested. It was last edited
   2026-11-13 23:30 UTC **[V, 2026-11-14]**. This is Raleigh's analogue of
   Austin site plans, which lead MF and commercial by about a year in P0.
2. **Miami-Dade has a pre-permit utility signal.** "DERM Sewer Allocation" is
   the sewer capacity certification "before a building permit is issued",
   with `BLDPROCNO` (building process number), `FOLIO`, flow in gallons per
   day, and certification dates. "Permits Requiring Allocation" (WASD) is a
   second such layer. Both update weekly **[V-3p, 2026-11-14; Actions]**.
   Today Miami-Dade scores 25 on PADAS (issued permits only). These layers
   would give it a pre-issue stage without the $110/month Clerk NOC.
3. **Sunbiz is free bulk over SFTP, daily.** The state publishes the
   credentials: host `sftp.floridados.gov`, user `Public`. The daily files
   cover corporate filings and events, **fictitious names (Florida's assumed
   names)**, general partnerships and federal tax liens **[V, 2026-11-14]**.
   This is the cheapest legal-entity and DBA key set across our three states.
4. **The Texas Comptroller has a public REST API.** It covers franchise tax
   (taxpayer ID, SOS file number, registered agent, right to transact,
   officers) and sales-tax locations by ZIP. It needs an `x-api-key` from
   registration **[V api-doc.comptroller.texas.gov, 2026-11-14]**. This
   replaces the "verify `9cir-efmm` columns" task in D-entity-resolution.
   **Correction:** `9cir-efmm` is a **City of Austin** datahub id
   (`data.austintexas.gov/d/9cir-efmm`), not data.texas.gov. Its data was last
   modified 2026-01-24 **[V catalog.data.gov, 2026-11-14]**.
5. **The FAA OE/AAA web service is open, needs no key, and is queryable by
   state and date.** It returns sponsor name, address, **phone and email**,
   structure type (`BUILDING`, `CRANE$MOBILE`), height and lat/long
   **[V FAA External Web Services Guide 2022-NOV, 2026-11-14]**. Crane filings
   mean construction is starting. Building filings flag tall projects before
   construction.
6. **Google Places cannot be our phone database.** Lat/long may be cached for
   30 days at most. Content "must not" be used with a non-Google map, and our
   map is Leaflet over OSM (README) **[V Maps Service Terms 2026-10-15
   archive, 2026-11-14]**. Places is at most a click-time lookup that is
   never stored.

---

## 2. Early signals, by market

### 2.1 Raleigh / Wake County, NC

| Source | URL / ID | Access | Licence / ToS / robots | Refresh | Fields that matter | Lead vs permit issue | Value | Effort | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Raleigh Development Plans** | `https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Development_Plans/FeatureServer/0` | Open ArcGIS REST, `maxRecordCount` 2000 | Presumably "Open Raleigh Data Policy", same org as our permit layers (City may order a stop). Item licence not read **[Inferred]** | Edited daily (last edit 2026-11-13 23:30 UTC) | `plan_number`, `plan_type`, `status`, `submitted`, `approved`, `updated`, `appealperiodends`, `sunset_date`, **`developer`**, `plan_name`, `major_street`, `acreage`, `zoning`, `lots_req/apprv`, `units_req/apprv`, `sq_ft_req`, `missing_middle` | Months before building permits for subdivisions, MF and commercial **[Inferred from Austin P0: site plans lead MF/commercial by about 1 year, with low SF conversion]**. Not measured for Raleigh | 5 | 1 | **[V 2026-11-14]**. No parcel/PIN field in the list. Link by geometry or address (candidate links only, ADR-16) |
| Raleigh Development_Plan_Areas, Building_Permits_Pending | Same org: services `Development_Plan_Areas`, `Building_Permits_Pending` | Open ArcGIS REST | Same | Unknown | Not read | Pending layer = review stage, probably duplicates the pre-issue rows we already get **[Inferred]** | 3 | 1 | **[V service names only, directory 2026-11-14; Actions]** fields |
| **Wake County Development** (county-jurisdiction subdivisions) | `https://maps.wakegov.com/arcgis/rest/services/Planning/Wake_County_Development/FeatureServer/0`. CSV: `data-wake.opendata.arcgis.com/api/download/v1/items/ca24614b86b34df98f2c0600e02080c8/csv?layers=0` | Open REST + CSV | **CC BY 4.0** (data.gov record) | Last update 2026-11-11 | `CASENUMBER`, `WORK_CLASS`, `APPLICATIONDATE`, **`PIN_NUM`** (parent parcel), `PLAN_STATUS`, `SUBDIVISION_NAME`, `PROPOSED_NO_LOTS`, `NUMBER_OF_ACRES`, `DESCRIPTION` | Preliminary subdivision application, about 1-3 years before homes **[Inferred]** | 3 | 1 | **[V catalog.data.gov, 2026-11-14]**. No developer or applicant field, so it is context plus lot count. Joins to Wake permits by PIN |
| Wake County building permits (outside Raleigh) | data.gov "Building Permits" (`ff506`) **[Exists]** | Open | Wake open-data harvest | Unknown | DATA_SOURCES already found `CONTRACTOR` empty on recent rows | n/a | 1 | 1 | Already checked: not useful for contacts. Use only for counts |
| Raleigh rezoning cases | raleighnc.gov "Rezoning Cases" pages; data.gov "property rezoning case" **[Exists]** | Web pages; dataset unopened | Unread | Unknown | Case number, applicant (in petitions) **[Inferred]** | 6-18 months before site/development plans **[Inferred]** | 2 | 2 | **[Actions]**: open the data.gov record. Agendas moved to eScribe (DATA_SOURCES) |
| Raleigh tree removal / ROW | Tree service names in the org are vendor or project layers (`APlus_Tree_Service_Tree_Removal`) | | | | Not permit data | | 1 | | Not a signal source |
| NCHFA LIHTC | `nchfa-live.agaric.com/rental-housing-partners/rental-developers/timeline-and-events` **[Exists]**. Raleigh Rental Development NOFA PDFs **[Exists]** | PDFs / web | Public agency | Annual cycle | Preliminary applications and awards list developer, county, units **[Inferred]** | Awards about 12-24 months before construction start **[Inferred]** | 3 | 2 | **[Actions]** or manual: one cycle per year. Few rows |

### 2.2 Miami-Dade County and City of Miami, FL

| Source | URL / ID | Access | Licence / ToS / robots | Refresh | Fields that matter | Lead vs permit issue | Value | Effort | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **DERM Sewer Allocation** | `https://opendata.miamidade.gov/datasets/d583b45dae464e30b4fb438d4da979f2` (hub item `d583b45d...`) | Open ArcGIS feature service | County hub disclaimer (as in DATA_SOURCES: no grant, no restriction) | Weekly | `EEOSALLCNO`, `EEOSPRJDSC` (project description), `FOLIO`, `ADDRESS`, **`BLDPROCNO`** (building process number), `PRPDFLWGPD` / `PREVFLWGPD` (proposed / previous flow, gal/day), `SEWEXTREQD`, `SWRAPVCODE`, `SWRCRTDATE`, `SWRRCTDATE`, `EXPDT90DAY`, `SWRDEALLDT` | "Before a building permit is issued" (dataset description). Exact lead time not measured | 4 | 2 | **[V-3p, 2026-11-14; Actions]**. No participant names, so it is project existence (L2) plus size via flow. Link through `BLDPROCNO` to the county permit process number (to test) and `FOLIO` (99% PA join) |
| **Permits Requiring Allocation** (WASD) | `https://opendata.miamidade.gov/datasets/dd2ca578b5304216a1c10bb6acc5a9cf` | Open feature service | Same | Weekly | 42 fields: `FOLIO`, `PROJNAME`, `PROJDESC`, `PROJADD`, lat/lon, building permit numbers, types, statuses and dates, CO fields, allocation fields (`DEALLOCTYP`, `DEALLOCDT`, `EFFECTIVE`) | Allocation precedes issue **[Inferred]**. Carries both the permit and the CO, so it can measure the lag | 4 | 2 | **[V-3p, 2026-11-14; Actions]**. This was listed as "found, not probed" in DATA_SOURCES |
| WASD agreement / letter of availability / ordinance letter / verification form layers | `d48reu.github.io/DataDictionary/dataset/wasd-agreement`, `.../wasd-letter-availability`, `.../wasdwscagreement-feature-layer` **[Exists]** | Feature services | Same | Unknown | Developer agreements name the developer **[Inferred]** | Letters of availability are among the earliest utility steps for new development (often before site plan) **[Inferred]** | 4 | 2 | **[Actions]**. The WASD construction service agreement process is described at `miamidade.gov/water/construction-service-agreement.asp` **[Exists]** |
| RER DERM permit / environmental plan review / surface-water general permit | `.../dataset/rer-derm-permit`, `.../environmental-plan-review`, `.../surface-water-management-general-permit` **[Exists]** | Feature services or tables (tier unclear) | Same | Unknown | Not read | Environmental review runs in parallel with building review **[Inferred]** | 3 | 2 | **[Actions]** |
| Miami-Dade zoning hearings | `miamidade.gov/zoning/hearing-applications.asp`; monthly hearing reports `.../zoning/Hearing_Reports/{yyyy}/HEAR_MONTHLY_APPLNAME.pdf` (search results show 2001-2013) **[Exists]** | PDF reports; hearing view in the GIS hub (DATA_SOURCES: not probed) | County disclaimer | Monthly (historical) | Applicant name, process number, location **[Inferred from file names]** | Rezoning or variance, months before permit | 2 | 3 | The PDFs appear to stop in 2013. Prefer the GIS "Land Management Hearing" view **[Actions]** |
| Contractor table | `https://opendata.miamidade.gov/datasets/1a2cb89e4c134eae80074395fd90d5b0` | Open hub | Same | Stated weekly, but the third party measured it 525 days stale | Undocumented | n/a (history) | 2 | 1 | **[V-3p; Actions]**: check whether it is the county certificate-of-competency roster |
| **City of Miami Planning/Zoning Entitlements** | `https://gis.miami.gov/gis/rest/services/Maps/SpecialPermits/MapServer/0` ("all City of Miami Special permits": warrants, exceptions, waivers) | Open MapServer | © 2024 City of Miami DoIT GIS; item licence not read. The permit layer is CC BY 4.0 | Unknown | Fields not shown on the service page | Entitlement stage, before building permits for larger projects **[Inferred]** | 3 | 1 | **[V service exists, 2026-11-14; Actions]** for fields and dates. Could raise City of Miami above PADAS 41 |
| City of Miami tree permits | already in DATA_SOURCES (no names) | | | | | | | | Not repeated |
| Florida private-provider notices (F.S. 553.791) | Paper/PDF "Notice to Building Official" forms per permit (Miami-Dade BORA guidance memos, municipal packets) **[Exists]** | No dataset found | n/a | n/a | Private provider firm, permit, owner | Filed at application | 1 | 4 | No bulk source. Drop |
| FHFC LIHTC RFAs | `floridahousing.org/programs/developers-multifamily-programs/competitive/{year}/{rfa}` (e.g. 2025-108). Miami-Dade RFAs such as 2024-203 **[Exists]** | Excel per RFA: applications received, application scores, preliminary awards; Application Submitted Report | Public agency; no terms read | Per RFA (several a year) | Column list not shown on the page | Preliminary award, then credit underwriting, then closing and permits: many months **[Inferred]** | 3 | 2 | **[V page structure, 2026-11-14]**. Columns: **[Actions]** |
| Miami-Dade Surtax / HBEC RFAs | `miamidade.gov/resources/housing/documents/requests/2026-surtax-*.pdf` **[Exists]** | PDF | | Annual | Developer, project | Early (financing) | 2 | 3 | PDF parsing. Later |

### 2.3 Austin, TX (only what is new)

| Source | URL / ID | Access | Licence / ToS / robots | Refresh | Fields | Lead vs permit | Value | Effort | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Austin Energy ESPA / BSPA (Electric/Building Service Planning Application) | `austinenergy.com/contractors/Construction-Renovation/Electric-Service-Planning-Application`, `.../Building-Service-Planning-Application` **[Exists]** | Application process pages only. No dataset (consistent with DATA_SOURCES) | n/a | n/a | Applicant, electrician, load | Before or with the building permit **[Inferred]** | 3 | 4 | PIA only (`austin-energy-pia` in registry). Nothing new |
| TDLR TABS bulk | `tdlr.texas.gov/TABS/Search`; per-project `.../TABS/Search/Project/TABS2026019669` **[Exists]** | Public search only. The 2025-09-09 TABS update announcement mentions **no export or API** **[V, 2026-11-14]** | Terms decision still pending (registry) | | Already documented | | 4 | 3 | Lawful bulk route = Texas PIA request for the registration table **[Inferred]**. Competitor Zabalist offers a TABS API (`zabalist.com/developers`) **[Exists]** |
| TDHCA LIHTC logs | `tdhca.texas.gov/competitive-9-housing-tax-credits` | Excel: Pre-Application Log (posted Jan 14, Feb 12, Feb 20), Application Log (Mar-Jun), Tentative Award and Waiting List (Jul 15), Award list (Jul 23). Imaged applications as PDF | Public agency | About monthly in season | Columns not listed on the page | The pre-app in January precedes award by about 6 months and construction by more **[Inferred]** | 3 | 2 | **[V page, 2026-11-14]**. Statewide; Travis rows overlap `ifzc-3xz8` but come earlier. 4% bond pipeline: see the Multifamily Bond page **[Exists]** |
| Comptroller sales-tax locations by ZIP | `api-doc.comptroller.texas.gov` (sales tax "search locations by ZIP code or name") | REST, `x-api-key` | Terms not stated | Unknown | Taxpayer, outlet location, status | New retail/restaurant outlet. A-sources judged it likely too late for build-out | 2 | 2 | **[V API doc, 2026-11-14]**. Run the address-match test from A-sources via this API |

### 2.4 Cross-market

| Source | URL | Access | Licence / ToS | Refresh | Fields | Lead vs permit | Value | Effort | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **FAA OE/AAA cases** | `https://oeaaa.faa.gov/oeaaa/services/caseList/{type}/{year}?state=TX&dateEnteredStart=...`. Also `/caseList/date/{type}` and `/case/{asn}` | Public REST, **no key**, max 8,000 rows per query | Federal. No licence stated in the guide. robots not read | Live | `asn`, `structureType` (`BUILDING`, `CRANE$MOBILE`...), `structureDescription`, sponsor name, address, **phone, email**, `aglStructureHeight`, lat/long, `dateEntered`, `statusCode`, `expirationDate` | 14 CFR 77 notice is due at least 45 days before construction **[Inferred, not read today]**. Crane cases mark actual start | 3 | 2 | **[V guide 2022-NOV, 2026-11-14; Actions]** for a live call. Miami (airport proximity, towers) and downtown Austin benefit most. Sponsors are often airspace consultants or individuals: store; display business sponsors only (rule 5) |
| TCEQ, SOS assumed names, new business registrations | See section 3 | | | | | | | | |

---

## 3. Contractor intelligence and contacts

| Source | URL | Access | Cost | Licence / ToS | Refresh | Fields that matter | Use | Value | Effort | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Florida Sunbiz data downloads** | `https://dos.fl.gov/sunbiz/other-services/data-downloads/` (daily: `/daily-data/`; quarterly: `/quarterly-data`; corporate layout: `/corporate-data-file/`) | **SFTP** `sftp.floridados.gov`, user `Public`, with the password published on the page. Browser access too | **Free** ("for informational purposes") | "Offered as is and may be changed, replaced or deleted at any time". A Data Usage Guide is linked but was not read | Daily on workdays. Quarterly full active file (Jan/Apr/Jul/Oct) | Daily `doc/cor/yyyymmddc.txt` (corporate filings), `.../events/yyyymmddce.txt`, **`doc/fic/yyyymmddf.txt` (fictitious names)**, `doc/flr/*` (federal tax liens: filings, debtors, secured parties), `doc/gen/*` partnerships. Field layouts are in separate definition docs (not read) | Legal-entity key, DBA to entity for Miami contractors, new LLC formations (developer SPEs). Federal tax liens as a risk flag | 4 | 2 | **[V, 2026-11-14]**. Fixed-width layout: **[Actions]**. Officers are individuals: store, never display |
| **Texas SOS bulk order** | `https://www.sos.state.tx.us/corp/bulk-order.shtml` | SOSPortal account; JSON download valid 90 days | **Master Unload $1,350** one-time; **Daily Filing Update $60 per day**; **Weekly new-formation update $20 per week** (last 8 weeks) | No restriction stated on the page | On order | Record layout PDF referenced, not read | Entity keys plus new formations (about $1,040 a year for weekly formations) | 3 | 3 | **[V, 2026-11-14]**. The Comptroller API (next row) may make the master unload unnecessary |
| **Texas Comptroller public API** | `https://api-doc.comptroller.texas.gov/` (hosts `api.comptroller.texas.gov`) | REST, `x-api-key` (register) | Free **[Inferred: no price shown]** | Terms and rate limits not stated | Live | Franchise: taxpayer ID, FEI, entity name, **DBA name**, mailing and registered-office address, `rightToTransactTX`, state of formation, **SOS file number**, SOS status, registered agent, officers. Also SIFT quarterly bulk files via signed links | Legal name, active status and SOS number for each Austin contractor by name search. Officers stay hidden (rule 5) | 4 | 2 | **[V API doc, 2026-11-14]**. Read the registration terms before use. SIFT file contents: **[Actions]** |
| Texas assumed names | Entities: SOS (in bulk order). Sole props: Travis County Clerk **[Exists, per D]** | | | | | DBA to legal entity | | 3 | 3 | Comptroller `DBA name` covers part of this |
| **NC SOS data subscriptions** | `https://www.sosnc.gov/online_services/data_subscriptions/about_the_data`. Layout: `b2b.sosnc.gov/webfiles/documents/forms/Data_Subscriptions/Business_Registration_layout.pdf` **[Exists]** | Subscription; FTP mentioned (data dictionary) | **Price not on page** (`sosnc.gov/manual/assets/sos/pdf/data_subscriptions.pdf` **[Exists]** may list it) | Disclaimer page not read | **Weekly** CSV | Business name, contact and address, officers/partners/directors, status, filings, name reservations. Also UCC and tax-lien files | Entity keys for Raleigh contractors. UCC filings can show equipment lenders (risk) | 3 | 3 | **[V, 2026-11-14]** except price. Email or call SOS for a quote |
| **NC Licensing Board for General Contractors** | Public licence search (nclbgc.org) **[Exists via third parties]** | **No official download found**. Only Apify scrapers and an app (search results) | n/a | Not read | n/a | Licence number, classification, limitation, qualifier, address, status **[Inferred]** | Licensed-GC check for Raleigh (permits carry contractor names) | 3 | 3 | Do **not** copy the scrapers. The lawful route is a public-records request (NC G.S. ch. 132 applies to state boards **[Inferred]**). Trades boards (NC Electrical, NC Plumbing/HVAC) were not checked |
| Raleigh / Wake trade licences | No city trade licence (NC licenses trades at state level **[Inferred]**) | | | | | | | 1 | | Use the state boards above |
| **Miami-Dade contractor licensing** | BCCO Contractor Inquiry and Complaint Search `https://www.miamidade.gov/Apps/RER/BCCOContractorMenu`. Hub "Contractor" table (see 2.2) | Public search; hub table possibly stale | n/a | County disclaimer | Unknown | County certificate of competency (specialty trades the state doesn't license) **[Inferred]**; complaints | Complaints history and local-trade check. DBPR (already in use) covers state licences | 2 | 2 | **[Exists]**. Probe the hub table **[Actions]**. Don't automate the BCCO search until its terms are read |
| **OSHA enforcement (DOL)** | `catalog.data.gov/dataset/dol-enforcement-data-inspection`; portal `dataportal.dol.gov`; `enforcedata.dol.gov` **[Exists]** | Excel/API (key on the DOL portal **[Inferred]**) | Free | Not stated | Daily (`R/P1D`); last metadata update 2026-03-27 | Establishment name, site address, NAICS, open date, violations, penalties **[Inferred]** | (a) Contractor safety history; (b) inspections at construction sites show an active job site and the employer on it | 3 | 2 | **[V catalog, 2026-11-14]**. Fields: **[Actions]**. Individuals are rare (establishments) |
| **SAM.gov Entity API** | `https://open.gsa.gov/api/entity-api` | API key. Personal key without a role: **10 requests/day**; with a role or a system account: **1,000/day**. Extract (`format=csv/json`) up to 1M records | Free | Public tier only | Live | Public tier: legal name, UEI, addresses, NAICS, business types, POC names and titles. **POC phone and email are FOUO** (not available) | Sub verification for public-works subs only | 1 | 2 | **[V, 2026-11-14]**. Low value for residential and light commercial |
| **Google Places API** | Billing: `developers.google.com/places/web-service/usage` **[Exists]**. Terms: Maps Service Terms 2026-10-15 archive | API key, pay per call | Place Details as of June 2026 (Woosmap): Essentials $5, Pro $17, Enterprise $20 per 1,000 (10k-100k tier); free monthly caps 10k / 5k / 1k. Woosmap puts "contact info" in Pro **[V third-party; conflicts with my recollection that phone and website are Enterprise fields: check Google's SKU page]** | Lat/long cached up to **30 days**, then deleted. `place_id` cacheable. "Customer must not use Google Maps Content from the Places API in conjunction with a non-Google map". The general ToS restricts caching and storing other content **[clause not read; Inferred]** | Live | Phone, website, hours, business status | Click-time "look up this business" only. **Never stored, exported or shown on our Leaflet map** | 2 | 2 | **[V terms, 2026-11-14]**. Treat as a UI convenience, not enrichment |

### 3.1 How to get verified business phones and emails lawfully (ranked)

1. **The permit itself.** Austin 91% phone, Raleigh 76-86% phone plus email,
   City of Miami company data (DATA_SOURCES). It is the source of record;
   keep provenance (rule 6).
2. **Licence boards that publish business contacts.** TDLR EC 100% business
   phone, TSBPE RMP 50% phone (already in use), DBPR (address only). Add
   NCLBGC by records request (above).
3. **State business registries.** Sunbiz, the TX Comptroller API and NC SOS
   give addresses and status, not phones. Use them to confirm that a company
   exists and is active. That confirmation is the "verified" part.
4. **The company's own website** (contact page), read by a human or by a
   polite fetch that obeys robots. Store the URL as provenance. Domain from
   Places `websiteUri` cannot be stored (see above) **[Inferred]**; find it
   another way (permit email domain, registry).
5. **Email.** Derive from the permit email domain (Raleigh) or the website.
   B2B email is allowed under CAN-SPAM with a footer and opt-out
   (COMPLIANCE 3.5). Don't buy scraped lists (data-broker exposure,
   COMPLIANCE 4.1). MX and SMTP "verification" pings to single addresses are
   a deliverability practice, not a legal basis **[Inferred]**.
6. **Phones that may be mobiles.** Hand-dial only (COMPLIANCE 3.1). Florida
   s. 501.059 is already open (COMPLIANCE 3.6). **NC** has its own telephone
   solicitation statute (G.S. 75-100 ff.) **[Inferred, not read]**. Add it
   to the counsel list before Raleigh outreach.
7. **Texas ch. 302 registration** (COMPLIANCE 3.3, counsel Q6). This is
   **noted, not resolved**, as instructed.

---

## 4. Ranked: top 10 to add next

The ranking weighs value against effort and verification state. "Probe
first" means one Actions call through `recon/preapproval_scan.js` (or
`enrichment_sources.js`) before any connector work. Each probe should read
the fields, count the rows applied in the last 30 days, and record the item
licence.

| # | Source | Market | Why | Value | Effort | Next step |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Raleigh `Development_Plans`** | Raleigh | Verified, open, daily, names the **developer**, units and sq ft. The Raleigh twin of the Austin site plans that lead MF/commercial by about 1 year | 5 | 1 | Probe the item licence, row count and 30-day volume. Then run the P0-style backtest against Raleigh BPs (spatial and address links only: no PIN field) |
| 2 | **Miami-Dade DERM Sewer Allocation** | Miami-Dade | First pre-issue stage for the weakest pilot market. `BLDPROCNO` may give an official link to the permit | 4 | 2 | Probe. Test `BLDPROCNO` against county permit process numbers |
| 3 | **Miami-Dade Permits Requiring Allocation (WASD)** | Miami-Dade | Has both allocation and permit/CO dates, so it measures the lead and the lag in one table | 4 | 2 | Probe together with #2 |
| 4 | **Sunbiz daily + quarterly SFTP** | Miami | Free daily entity and **fictitious-name** feed. Gives ADR-12 legal-entity keys for Miami contractors | 4 | 2 | Download one daily file and the layouts. Write a fixture. Read the Data Usage Guide first |
| 5 | **TX Comptroller public API** | Austin | Free legal entity, DBA, SOS number and active status by name. Closes the D-entity `9cir-efmm` gap | 4 | 2 | Register for a key. Read the terms. Batch-verify Austin contractor names |
| 6 | **FAA OE/AAA web service** | All | Open, no key. Tall-building and crane filings with sponsor contacts and coordinates | 3 | 2 | One `caseList` call each for TX, FL and NC over 90 days. Count `BUILDING` and `CRANE` cases inside the pilot bounding boxes |
| 7 | **City of Miami Planning/Zoning Entitlements** | City of Miami | Open MapServer. Could add an entitlement stage to a PADAS-41 market | 3 | 1 | Probe the fields (applicant? dates?) |
| 8 | **LIHTC logs** (TDHCA, FHFC, NCHFA) | All | Named developers, months to years early, tiny volume. Excel | 3 | 2 | Read the column headers of one TDHCA application log and one FHFC "applications received" file |
| 9 | **Wake County Development** | Wake | CC BY 4.0, PIN join, county-area subdivisions with lot counts | 3 | 1 | Ingest as `planning_cases` context. No participants |
| 10 | **OSHA enforcement inspections** (NAICS 23) | All | Contractor safety history plus job-site evidence with an employer name | 3 | 2 | Pull Travis, Wake and Miami-Dade construction inspections. Measure the name-match rate to permit contractors |

Next after these: NC SOS subscription (get the price), the NCLBGC
records request, TX SOS weekly formations ($20 a week), Miami-Dade WASD
agreement / letter-of-availability layers, and the Raleigh rezoning dataset.
**Not worth it now:** SAM.gov (POC phones are FOUO; a public-works niche),
Google Places as stored enrichment (terms), private-provider notices (no
data), Miami-Dade hearing PDFs (appear to stop in 2013), Austin Energy
ESPA (no data; PIA only), Wake permits (no contractor).

## 5. Corrections to repo docs (for the owner to apply; not edited here)

- `DATA_SOURCES.md` PADAS: "Raleigh ... no planning feed" is wrong.
  `Development_Plans` exists and is current (section 2.1).
- `D-entity-resolution.md` row "Texas Comptroller taxpayer number":
  `9cir-efmm` is on `data.austintexas.gov`, not data.texas.gov (catalog.data.gov
  harvest). The Comptroller also has a public API with SOS file number and DBA.
- The Miami-Dade "Permits Requiring Allocation" entry in DATA_SOURCES is
  labelled "Hearings (zoning)". By its fields it is a **utility allocation**
  layer, not a hearing view [V-3p].

## 6. Not verified (do these from Actions)

Raleigh `Development_Plans` item licence and volume; `Building_Permits_Pending`
fields; the Miami-Dade DERM, WASD, Contractor and DERM-permit layers (live
fields, row counts, licence); City of Miami SpecialPermits layer fields; a live
FAA `caseList` call; Sunbiz file layouts and Data Usage Guide; Comptroller API
terms and rate limits; NC SOS price; TDHCA/FHFC column headers; OSHA field
list and API key; the Google Places SKU that carries the phone field.

## Sources

- [Raleigh ArcGIS services directory](https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services) (V 2026-11-14)
- [Raleigh Development_Plans layer](https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Development_Plans/FeatureServer/0?f=pjson) (V 2026-11-14)
- [Raleigh Development_Plans_TestingETL2](https://services.arcgis.com/v400IkDOw1ad7Yad/ArcGIS/rest/services/Development_Plans_TestingETL2/FeatureServer) (V 2026-11-14)
- [Wake County Development, data.gov](https://catalog.data.gov/dataset/wake-county-development) (V 2026-11-14)
- [Miami-Dade DERM Sewer Allocation (third-party dictionary)](https://d48reu.github.io/DataDictionary/dataset/derm-sewer-allocation) (V-3p 2026-11-14)
- [Miami-Dade Permits Requiring Allocation (third-party dictionary)](https://d48reu.github.io/DataDictionary/dataset/permits-requiring-allocation) (V-3p 2026-11-14)
- [Miami-Dade Contractor table (third-party dictionary)](https://d48reu.github.io/DataDictionary/dataset/contractor) (V-3p 2026-11-14)
- [Miami-Dade BCCO contractor search](https://www.miamidade.gov/Apps/RER/BCCOContractorMenu) (Exists)
- [Miami-Dade zoning hearing applications](https://miamidade.gov/zoning/hearing-applications.asp) (Exists)
- [Miami-Dade WASD construction service agreement](https://www.miamidade.gov/water/construction-service-agreement.asp) (Exists)
- [City of Miami SpecialPermits MapServer](https://gis.miami.gov/gis/rest/services/Maps/SpecialPermits/MapServer) (V 2026-11-14)
- [FAA OE/AAA External Web Services Guide 2022-NOV](https://oeaaa.faa.gov/oeaaa/downloads/external/content/External%20Web%20Services%20Guide%20V_2022-NOV.pdf) (V 2026-11-14)
- [Florida Sunbiz data downloads](https://dos.fl.gov/sunbiz/other-services/data-downloads/) and [daily data](https://dos.fl.gov/sunbiz/other-services/data-downloads/daily-data/) (V 2026-11-14)
- [Texas SOS business filings bulk order](https://www.sos.state.tx.us/corp/bulk-order.shtml) (V 2026-11-14)
- [Texas Comptroller API documentation](https://api-doc.comptroller.texas.gov/) (V 2026-11-14)
- [Active Franchise Tax Permit Holders, data.gov](https://catalog.data.gov/dataset/active-franchise-tax-permit-holders) (V 2026-11-14)
- [NC SOS data subscriptions](https://www.sosnc.gov/online_services/data_subscriptions/about_the_data) (V 2026-11-14)
- [DOL Enforcement Data - Inspection, data.gov](https://catalog.data.gov/dataset/dol-enforcement-data-inspection) (V 2026-11-14)
- [SAM.gov Entity API](https://open.gsa.gov/api/entity-api) (V 2026-11-14)
- [Google Maps Platform Service Specific Terms, 2026-10-15 archive](https://cloud.google.com/archive/maps-platform/terms/maps-service-terms-20261015?hl=it) (V 2026-11-14)
- [Woosmap, Google Places API pricing 2026](https://www.woosmap.com/blog/google-places-api-pricing) (V third-party 2026-11-14)
- [TDHCA competitive 9% HTC](https://tdhca.texas.gov/competitive-9-housing-tax-credits) (V 2026-11-14)
- [FHFC RFA 2025-108](https://www.floridahousing.org/programs/developers-multifamily-programs/competitive/2025/2025-108) (V 2026-11-14)
- [NCHFA timeline and events](https://nchfa-live.agaric.com/rental-housing-partners/rental-developers/timeline-and-events) (Exists)
- [TDLR TABS updates, 2025-09-09](https://www.tdlr.texas.gov/news/2025/09/09/tabs-updates-and-enhancements-3/) (V 2026-11-14)
- [TDLR TABS search](https://www.tdlr.texas.gov/TABS/Search) (Exists)
- [Zabalist API](https://www.zabalist.com/developers) (Exists)
- [Austin Energy ESPA](https://austinenergy.com/contractors/Construction-Renovation/Electric-Service-Planning-Application) (Exists)
- [Raleigh rezoning cases](https://raleighnc.gov/planning/rezoning-cases) and [property rezoning case, data.gov](https://catalog.data.gov/dataset/property-rezoning-case) (Exists)
- NCLBGC: only third-party scraper listings found (for example [Apify NCLBGC scraper](https://apify.com/haketa/nc-licensing-board-for-general-contractors-scraper)); no official download (Exists, negative)
