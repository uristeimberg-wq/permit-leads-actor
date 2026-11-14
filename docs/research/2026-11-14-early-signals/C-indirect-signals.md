# Worker C: Indirect construction signals in Austin. What comes before a building permit, and how to prove it

Author: Worker C. Live checks 2026-11-14 through WebFetch against `datahub.austintexas.gov` (SODA). Labels: **[V 2026-11-14]** = verified live (query shown); **[RP]** = read from a page; **[U]** = unverified belief or memory. The shared WebFetch budget (100 calls/hour for all agents) ran out several times, so the link samples are **small** (see §1.3). They are anecdotes, **not rates**. The rates come from the backtest in §4.

## 0. Bottom line (blunt)

1. **The join key is good on paper and weak where it matters most.** `tcad_id` is filled on 99.4% of BPs and plan-review cases, 94% of site plans, 93% of zoning cases and only 84% of subdivisions (2019–2024, §1.1). But a greenfield subdivision or zoning case sits on the **parent acreage parcel**. The houses are later permitted on **new lot IDs** created when the plat records. So a `tcad_id` equality join will under-count conversion for exactly the high-volume residential pipeline. The backtest must add a spatial join and a subdivision-name ↔ BP `legal_description` join, and report each link basis separately.
2. **Two Austin planning fields are dead.** `related_cases` in zoning is filled on 0 of 1,365 cases (2019–24). Site-plan `status` is a *current* value, with no history of when a case expired. So "expired / withdrawn" can only be measured looking back as an outcome, **not used as a predictor as of the signal date**: that would be leakage. Abandonment predictors have to come from our own snapshots going forward (`lifecycle_events`).
3. **The repo's "early-capture rate" (ARCH 19.4, ROADMAP E go/no-go ≥80%) will pass trivially and prove little.** Every Austin BP has a plan-review case (`masterpermitnum` = `folderrsn`, 96.0% filled on 2019–24 BPs, §1.1), and the BP's `applieddate` *is* that case's applied date. Capturing at plan review therefore gives lead time over **issuance** (median 63 d residential), not over the application. The metric that tests the "before a permit search would find it" thesis is **pre-application capture**: the share of new-construction BPs with an earlier planning, demolition or other signal. Report both, and do not let the first stand in for the second.
4. **Site plans are the best pre-application signal. Rezonings give the longest lead but convert worst. Residential demolitions convert well, but they are rarely early.** Small samples [V 2026-11-14], *not rates*:

   | Signal | Sample | Main BP later on the same parcel | Lead before the BP application |
   |---|---|---|---|
   | Building site plans filed 2023-03 | 11 checked | 6 (5 of 7 approved; 1 of 6 expired or withdrawn) | Median about 10 months (177–699 d) |
   | Approved 2022 rezonings | 6 | 4 got a site plan (+6 to 20 months); **0 of 6** got a BP in about 4.8 years | Not reached |
   | Residential total demolitions issued 2023-01 | 12 | 7 (7 of 9 Final demos; 0 of 3 expired or withdrawn) | Median **88 d**. In 3 of 7, the new-home application came *before* the demo was issued |

   About half of site-plan filings never reach approval. **"Expired" does not mean dead:** one expired MF site plan was built anyway, and the zoning sample shows repeated expire-and-refile loops.
5. **Some links are official, not inferred.** BP descriptions cite site-plan numbers ("Concurrent Review: SP-2023-0202C") [V]. An exact-pattern extractor turns these into `official_reference` links.

## 1. Live measurements

### 1.1 Join-key fill rates, cases filed or applied 2019-01-01 to 2024-12-31 [V 2026-11-14]

| Dataset | Rows | `tcad_id` (or `appraisal_id`) filled | Other keys | Query |
|---|---|---|---|---|
| Site plans `mavg-96ck` | 3,626 | 3,422 (**94.4%**) | `propertyrsn` 100% (but `0` is a placeholder on 324 rows, all years); lat/long 99.6% | `$select=count(*),count(tcad_id),count(propertyrsn),count(latitude)&$where=application_start_date between '2019-01-01T00:00:00' and '2024-12-31T23:59:59'` |
| Zoning `edir-dcnf` | 1,365 | 1,273 (**93.3%**) | lat 96.3%; **`related_cases` 0 (0%)** | same, `count(related_cases)` |
| Subdivision `s7gx-9m54` | 2,090 | 1,765 (**84.4%**) | lat 93.5% | same |
| Plan review `n8ck-xkda` | 74,260 | `appraisal_id` 73,846 (**99.4%**) | `propertyrsn` 100% | `applied_date between …` |
| Issued BPs `3syk-w9eu` (`permittype='BP'`) | 85,377 | 84,858 (**99.4%**) | `masterpermitnum` 82,002 (**96.0%**) | `applieddate>'2019-01-01' and applieddate<'2025-01-01'` |

**Formats are mixed.** Most values are 10-digit geo IDs (`0203030706`), but site plans also carry TCAD account-style IDs (`R329313`, `R051154`; 1 of the 39 sampled), and so do some BPs (`R063112` seen). Normalise to `geo_id` and keep the `R…` form as a second key. A crosswalk between the two forms exists in the TCAD export (property facts only, which the COMPLIANCE Travis CAD rules allow) [U for the crosswalk field names].

**Mega-parcels over-match.** The site-plan parcel `0315410104` (Giga Texas) has 16 site plans in 2019–24 [V]. Campus, airport, university and COTA parcels attract many unrelated cases and BPs. Cap the join (for example, skip parcels with more than 5 planning cases or more than 20 BPs in the window) and report what the cap excludes.

**`propertyrsn` is a key worth testing.** It is the city's own AMANDA property record, present on site plans, zoning, subdivisions **and plan-review cases** (not on issued BPs, but plan review links to the BP through `masterpermitnum`). It may survive replats differently from TCAD IDs [U]. The backtest should measure it as a third link basis.

### 1.2 Site-plan sample: 39 cases filed 2023-03-02 to 2023-03-17 [V 2026-11-14]

Query: `mavg-96ck?$where=application_start_date between '2023-03-01' and '2023-03-20'&$order=application_start_date&$limit=40`

| Outcome status today | n |
|---|---|
| Approved and Released | 18 |
| Expired | 17 |
| Withdrawn | 2 |
| Closed | 1 |
| Aborted | 1 |

- **Composition:**
  - 5 are revisions or extensions (`…(XT)`, `(XT2)`, `(R1)`) of 2017–2021 site plans. An extension is evidence of a stalled but living project.
  - 6 are ROW, utility, drainage or transit cases, which never produce a building BP. Filter them out by `proposed_land_use` and `work` (`Utility Line`, `ROW`, `Drainage`).
  - Boat-dock site plans *do* produce R-437 BPs (§1.3).
- **Filing to approval**, for the 15 cases with an `approval_date`:
  - The days were 132, 164, 309, 360, 388, 399, 416, 462, 502, 516, 563, 607, 818, 865 and 1,209.
  - The median is **462 days**, which is small-sample.
- **Expired cases** have no approval date. In Austin an unapproved application expires when it is not updated within the code's window [U: LDC 25-5-81, about 180 days]. **An expired case is often refiled under a new number** [U]. So "expired" ≠ "abandoned" until a later case or BP on the same parcel or `case_name` is ruled out.

### 1.3 Signal → BP on the same `tcad_id` (anecdotes, not rates) [V 2026-11-14]

Query pattern (URL-encoded, which WebFetch needs): `3syk-w9eu?$where=permittype='BP' AND tcad_id IN ('…','…')`

| Signal (filed) | Parcel | Later BPs on the parcel | Lag from signal filing |
|---|---|---|---|
| Site plan SPC-2023-0072C "Palace Laundry", cocktail lounge (2023-03-03; approved 2024-07-31) | 0203030706 | **Demo BP** applied 2023-06-16 (issued 2024-11-13); **New C-327 BP** applied 2025-01-30, issued 2025-03-11 | Demo +105 d; new BP application **+699 d**, which is 6 months after SP approval |
| Site plan SP-2023-0075C "Dutch Bro Coffee at Southpark Meadows" (2023-03-06; approved 2024-03-28) | 0432090501 | New C-327 BP and dumpster BP, both applied 2023-10-25, issued 2024-07-22 | BP application **+233 d**, *before* SP approval. Issue +504 d |
| Site plan SP-2023-0070D "Old Lockhart Apartments", MF (2023-03-03; approved 2024-10-30) | 0448080132 | **None** on this parcel (all years) | Not converted, **or** the BPs sit on a replatted lot ID. This is exactly the replat problem in §0.1 |
| SP-2023-0093C "Dutch Bros Coffee at Loyola Lane" (2023-03-14; approved 2024-04-16) | 0219280649 | New C-327 BP applied 2023-09-07, issued 2024-06-13 | **+177 d**; issue +457 d |
| SP-2023-0099C "Estancia Multifamily 360 Apartments" (2023-03-16; A&R, no approval date) | 0453190208 | 12 C-105 MF BPs × 30 units (=360, matching the case name) + clubhouse and carports, all applied 2023-09-26, issued 2024-07-17 | **+194 d**; issue +489 d |
| SP-2023-0113C "DC-2422" (2023-03-13; approved 2024-09-26) | 0204100907 | Shell office + parking garage + finish-outs, applied 2024-03-04, issued 2024-10-25 | **+357 d**; issue +592 d |
| SP-2023-0074C.SH "Cairn Point" (150 units, 2023-03-09; approved 2023-07-19) | 0227190912 | Only a dumpster enclosure (C-329, applied 2023-05-16) and a 2024 solar remodel with `housing_units` 150; **no main building BP on this parcel in any year** | The main building is probably on another parcel ID or permitted under a different record. **C-329 accessory "New" BPs must be excluded from the outcome**, or they create false conversions |
| SP-2023-0090C "Enclave at Easton Park" (2023-03-14; **Expired**) | 0336150203 | 8 C-105 MF BPs (30–54 units each) + amenities applied 2024-06-13, issued 2025-05-09 | **+457 d. The project was built although this case "Expired"** (presumably refiled) |
| Expired or withdrawn site plans: Holden Hills G-6 Condos (0105340302), 7BREW US-290 (0416700301), Wells Branch MF (withdrawn, 0267111101), BoostLogic HQ (0348310501) | | **No BP of any kind** on these parcels | Not converted as of 2026-11-14 |

**Site-plan sample summary** (11 building site plans checked, n=11, *not a rate*):

| Group | Main-building BP on the same `tcad_id` |
|---|---|
| Approved and Released (7) | 5 |
| Expired (6) | 1 |
| Withdrawn (1) | 0 |

- **Lag from site-plan filing to the BP application:** 177, 194, 233, 357, 457 and 699 d, a **median of about 9.8 months**.
- **Lag to issue:** 457–739 d.
- **The BP application often came before site-plan approval.** That happened in 3 of 6: Austin allows **concurrent review** (see query D below).

**Demolition → new home, same parcel** [V 2026-11-14]. These are 12 residential total demolitions (R-645) issued 2023-01-03…20, taken in issue order with no other selection. Query: `3syk-w9eu?work_class=Demolition&permittype=BP&permit_class_mapped=Residential&calendar_year_issued=2023&$order=issue_date`, then `permittype=BP&work_class=New&$where=tcad_id IN (…)`.

| Demo status | n | New R-101/102 BP on the parcel | Lag demo application → new-home application |
|---|---|---|---|
| Final | 9 | **7** | 5, 32, 55, 88, 95, 511, 691 d (median **88 d**) |
| Expired | 2 | 0 | — |
| Withdrawn | 1 | 0 | — |

**The key finding: seen from the issued-permit feed, demolition is often not early.**

- **3 of the 7** new-home applications were filed **before the demolition permit was issued**: 84, 169 and 253 days before. In those cases the new home's plan-review case was already visible.
- A demolition gives a lead only when its own *application* is visible. Our example demo BP carries a `masterpermitnum`, so demo applications probably appear in `n8ck-xkda` [U: not checked].
- Within plan review, the lead it adds over the new-home application is **weeks**, not months, for most infill. The exception is the 2 slow cases, at 17 and 23 months, one of which became 6 units.

**Rezoning → site plan → BP** [V 2026-11-14]. Sample: the first 20 `Zoning/Rezoning` cases created in 2022 (filed 2022-01-03…02-15).

- **Status mix:** 16 *Closed*, 1 *Withdrawn*, 1 *Expired*, 2 other. 13 have an approval date.
- **"Closed" hides the outcome.** Approved and unapproved cases are both "Closed"; only `approval_date` separates them.
- **Six approved, development-intent rezonings were checked against site plans and BPs** on the same `tcad_id`:
  - Clayton Lane (V)
  - Fifty First (V)
  - Hudson Place (MF-4)
  - 708 E 12th (CBD)
  - 7603 Cooper (MF-2)
  - Springdale (CS-MU)
- **4 of 6 were followed by a site plan:**

  | Case | Lag after rezoning filing | Site-plan history |
  |---|---|---|
  | 708 E 12th | +180 d | Three site plans, all Expired or VOID |
  | Hudson Place | +224 d | "Waiting on Legal" since 2022-09 |
  | Fifty First | +441 d | Expired, then refiled twice in 2025, now "Pending" |
  | 7603 Cooper | +622 d | Expired, then a 2024 VOID |

- **0 of 6 have a new-construction BP after about 4.8 years.**
- **One more chain is entirely unbuilt.** Zoning C14-2022-0007 (10258 Old Lockhart Rd, → MF-2, *Expired*) is the same parcel as site plan SP-2023-0070D "Old Lockhart Apartments" (approved 2024-10-30), and that parcel has no BP.

This is the 2022 multifamily cohort that met the 2023–24 rate rise. It shows what a rezoning signal is worth:

- a real project intent
- a lead of years
- conversion that depends heavily on the cycle
- many expire-and-refile loops that must not be counted as new projects

**Official cross-references exist in BP descriptions** [V 2026-11-14]. Query: `3syk-w9eu?permittype=BP&work_class=New&$q=SP-2023`. All 15 rows returned cite a site-plan number, for example:

- "Concurrent Review: SP-2023-0202C"
- "SP-2023-0446C - In Review"
- "Concurrent Review with site plan review SP-2023-0411C"
- "Ref SP-2023-0332D"

7 of the 15 are boat docks (R-437), so **boat-dock site plans do produce BPs**; keep them as a residential-marine segment. The spacing varies ("SP-2023- 0227D"). These give `official_reference` links for a subset of commercial and marine BPs. The **share** of BPs with a citation is not measured.

Observations, still a sample:

- The demolition BP on the Palace Laundry parcel came **between** the site plan and the new-building BP. Demolition is a mid-chain signal for infill commercial, not only a residential one.
- A BP application can **precede** site-plan approval (Dutch Bros), because the city allows a concurrent review. So "lead time over the BP application date" can be shorter than the time to site-plan approval.

### 1.4 Remaining live checks

These checks were not finished because the shared fetch budget ran out. They are marked [U] and handed to the Actions job in §4. Exact SoQL:

```
# A. More site-plan → BP checks (2023 sample parcels)
3syk-w9eu?$where=permittype='BP' AND applieddate>'2022-01-01' AND tcad_id IN ('0227190912','0204100907','0219280649','0453190208')
# B. Residential demolition → new SFR on the same parcel
3syk-w9eu?$where=permittype='BP' AND work_class='Demolition' AND permit_class like 'R- 645%' AND applieddate between '2023-01-01' and '2023-01-31'&$limit=50
   then for each tcad_id: work_class='New' AND permit_class like 'R- 10%' AND applieddate>=<demo applieddate>
# C. Rezoning → site plan → BP
edir-dcnf?$where=sub_type='Zoning/Rezoning' AND application_start_date between '2022-01-01' and '2022-03-31'&$limit=50
   then mavg-96ck and 3syk-w9eu on the same tcad_id
# D. Official cross-references: SP case numbers cited in BP descriptions (an exact pattern gives official_reference)
3syk-w9eu?$select=count(*)&$where=permittype='BP' AND description like '%SP-20%' AND applieddate>'2023-01-01'
# E. Outcome mix for the denominators
mavg-96ck?$select=status,count(*)&$where=application_start_date between '2019-01-01' and '2022-12-31'&$group=status
edir-dcnf?$select=detailed_status,count(*)&$where=application_start_date between '2019-01-01' and '2022-12-31'&$group=detailed_status
```

Status of these checks:

- **A, C and D (partially) were run** (§1.3).
- **Still [U]:**
  - B for the 7 remaining demolitions
  - D's *share*
  - E's full outcome mix
  - whether demolition applications appear in `n8ck-xkda`

**WebFetch caveat, seen 6 times this session:** a `$where` with a date comparison (`>`, `between`), an unencoded `%`, an `IN(…)` list of more than 6 IDs, or an over-long URL can be **silently dropped**. The proxy then returns the unfiltered newest rows with no error. What worked:

- percent-encoded `IN` lists of ≤6 IDs
- simple `column=value` parameters
- `$q`

**Hard rule 3 applies to recon too: check that the result changes when the filter changes.** The Actions job uses Node `fetch`, not WebFetch, and must assert this.

## 2. What the literature and industry say about conversion

| Claim | Evidence | Label |
|---|---|---|
| A large share of entitled housing is never built, or is built years later. England: the LGA reports over 1 million homes granted permission in a decade but not built; Lichfields tracked build-out in 5 local authorities and suggests a non-implementation allowance of about 10–20% | [LGA news](https://local.gov.uk/about/news/housing-backlog-more-million-homes-planning-permission-not-yet-built), [Lichfields "Tracking Progress"](https://lichfields.uk/content/insights/tracking-progress) | Titles [RP from search results]; the percentages are [U] |
| Montgomery County, MD: about 27,000 approved-but-unbuilt units; staff cite market, permitting and policy hurdles | [Montgomery Planning pipeline analysis, staff report 2025-10-16](https://montgomeryplanningboard.org/wp-content/uploads/2025/10/Pipeline-Analysis-Staff-Report_10.16.25.pdf); [summary article](https://cpo.soar.com/articles/6713417/Montgomery-County/Maryland/Montgomery-Planning-frames-development-tracker-after-finding-27000-approved-but-unbuilt-units-staff-points-to-market-permitting-and-policy-hurdles) | Figure from a search-result title [RP]; report not read |
| Entitlement-to-construction durations of years in California (LA "nearly four years to build apartments"; SF permitting process measured end to end) | [Terner Center SF](https://ternercenter.berkeley.edu/research-and-policy/measuring-the-housing-permitting-process-in-san-francisco/), [The Real Deal LA 2024](https://therealdeal.com/la/2024/02/27/study-finds-it-takes-nearly-four-years-to-build-apartments-in-la/), [Berkeley Law entitlement study](https://www.law.berkeley.edu/wp-content/uploads/2019/02/Examining-the-Local-Land-Use-Entitlement-Process-in-California.pdf) | Titles [RP]; durations [U]; California-specific, not transferable to Texas |
| Planning-stage commercial projects (Dodge) lead construction spending by about a year; a share are abandoned | [Federal Reserve FEDS 2024-016](https://www.federalreserve.gov/econres/feds/files/2024016r1pap.pdf); ConstructConnect tracks abandoned and on-hold projects in its [Project Stress Index](https://www.constructconnect.com/project-stress-index-faq) | Existence [RP]; the lag figure and abandonment share are [U] |
| Texas is a non-disclosure state: sale prices are not on deeds, and appraisal districts gather them by survey and must keep them confidential | [Dallas News 2020](https://dallasnews.com/news/watchdog/2020/06/04/why-fighting-your-property-tax-protest-is-so-hard-texas-hides-sales-numbers-from-public-view), [Redfin](https://www.redfin.com/blog/non-disclosure-states-real-estate/), Tax Code §22.27 (already cited in COMPLIANCE) | [RP] / statute already verified by the repo |

**Planning-practice abandonment predictors** [U, standard in the literature and practitioner experience; to be tested]:

- extension filings (the project is stalled)
- repeated "Awaiting Update" cycles
- an application expired for lack of update
- postponed indefinitely at commission
- withdrawal after a valid petition, or a neighbourhood objection (Austin council supermajority rule)
- change of applicant or owner mid-case
- rezonings with **no** accompanying site plan or subdivision within 12 months, which suggests the case was entitlement-for-sale
- cases filed in a peak-cycle quarter for multifamily (2022 Austin MF filings meeting 2023–24 rate shock)

**What we cannot honestly import:** no published Austin-specific conversion rate was found. Every external number above comes from a different legal system or market cycle. **The only defensible number for the product is our own backtest.**

## 3. Evidence ladder for project existence (distinct from participant labels)

The four participant labels in DATA_MODEL (Confirmed / Historically associated / Potentially relevant / Unverified inferred) answer *who* is involved. The ladder below answers *whether there is a project at all*. They are shown in separate UI slots and never combined into one badge. A participant label never raises the ladder level, and the ladder level never upgrades a participant.

| Level | Entry rule (all required) | Qualifying sources | Allowed UI wording | Never |
|---|---|---|---|---|
| **L1 Confirmed application** | A government record of an application or permit **to build** at this location exists, and the project's members are joined only by `same_record` or `official_reference` | Austin plan-review case (`n8ck-xkda`), issued BP (`3syk-w9eu`) and trade permits on its permit base; Raleigh / NYC / Orlando same-record applications | "Building application filed <date> (City of Austin <case no.>)"; the status as the source wrote it, plus the canonical stage | "Approved" before the source says so; claiming the trade or scope beyond the record |
| **L2 Documented early-stage project** | An official **planning case whose own record proposes physical development** on an identified parcel; status not terminal (expired, withdrawn, denied, aborted or void → shown as *Ended*) | Site plan with a building land use (exclude ROW, utility, drainage, boat dock, extension-only); subdivision preliminary or final plat or construction plan; TDLR TABS registration (if access is approved) | "Site plan in review: <proposed use>, <sq ft / units if stated>. No building application yet." "Filed <date>; typical time to a building application in Austin: <backtest median> (measured)" | Calling it a construction project or "coming soon"; showing a start date; inferring a GC |
| **L3 Potential construction signal** | An official record that does **not itself propose a building**, but whose category has a **measured** base rate in our backtest (§4) above a set floor (proposed: P(new BP ≤24 mo) ≥ 15% *and* lift ≥ 3× over the parcel base rate) | Rezoning / NPA, residential or commercial demolition BP (as a signal of *new* construction; the demolition itself is L1 work), Board of Adjustment variance (owner-individual rule 5 applies), TABC original application, Legistar agenda item, site-plan **extension** | "Possible future project: <signal>. In Austin 2019–24, <x>% of similar cases were followed by a building application within 24 months (n=<n>)." The base rate is always shown with its n | Shown without its base rate. A signal type with no measured rate can't be L3, so it is L4 |
| **L4 Unverified hypothesis** | Anything else: combinations scored by a model, `address_window` links, name-only matches, signals without a measured base rate, land transfers | Our inference | "Hypothesis, not confirmed: <reasons>." Admin or analyst view only; off by default for customers | Alerts; exports; promotion by score |

**Promotion and demotion rules:**

- **Automatic promotion only on new official evidence that itself qualifies for the higher level.**
  - Example: a plan-review case appears on the site plan's parcel. The *plan-review case* is L1 on its own.
  - The *claim that it is the same project as the L2 site plan* rests on `parcel_window`, so the link is shown as "Possible link, not confirmed", the participant label vocabulary. It becomes official only when:
    - the BP or plan-review description cites the site-plan case number (exact pattern `SP[C]?-\d{4}-\d{4}[A-Z]*`), or
    - the source publishes a cross-reference.
- **Never promoted automatically:**
  - L4 to anything
  - L3 to L2 on a score
  - demolition to "new construction planned"
  - rezoning approval to "project"
  - an Expired or Withdrawn case revived by a new case on the same parcel (shown as two cases, with "possibly refiled" if `case_name` matches; a human confirms)
- **Official same-case relations are `official_reference`:**
  - extension and revision suffixes (`SP-2018-0466C(XT)` → `SP-2018-0466C`)
  - `masterpermitnum`
- **Demotion is automatic and immediate on a terminal status.** The project keeps its id (ADR-16) and shows "Ended: <status> <date>". The source wording is kept.
- **Mapping to `link_basis`:**
  - `same_record` and `official_reference` may carry L1 and L2 claims.
  - `parcel_window` supports only "possible link" and L3 or L4 inference.
  - `address_window` stays a candidate only, as today.

## 4. Backtest design (pilot proof)

**Question:** For each signal type and combination *S*:

- P(new-construction BP **applied** within 6, 12 and 24 months of *S*), and the same for **issued**
- median and IQR lead time from *S* to the BP application date
- lift over the base rate
- **pre-application capture**: the share of BPs that had any earlier signal

### 4.1 Data (all public domain, read-only)

| Table | Source | Window | Columns (narrow `$select`) | Rows (2019–26) |
|---|---|---|---|---|
| `sig_siteplan` | `mavg-96ck` | filed 2018-07 to 2024-12 | folderrsn, permit_number, case_name, sub_type, work, status, application_start_date, approval_date, proposed_land_use, tcad_id, propertyrsn, lat, lon | about 4.5k (3,626 for 2019–24 [V]) |
| `sig_zoning` | `edir-dcnf` | same | folderrsn, case_number, sub_type, detailed_status, proposed_zoning, application_start_date, approval_date, tcad_id, propertyrsn, lat, lon | about 1.7k (1,365 [V]) |
| `sig_subdiv` | `s7gx-9m54` | same | projectid, permitnum, case_name, sub_type, status, application_start_date, approval_date, existing_no_of_lots, tcad_id, propertyrsn, lat, lon | about 2.6k (2,090 [V]) |
| `bp` | `3syk-w9eu` `permittype='BP'` | applied 2016-01 to today | permit_number, permit_class, work_class, applieddate, issue_date, status_current, tcad_id, masterpermitnum, housing_units, total_job_valuation, legal_description, lat, lon | about 150k [U; 85,377 for 2019–24 V] |
| `pr` | `n8ck-xkda` | applied 2019 to today | folderrsn, permit_number, applied_date, status_current, appraisal_id, propertyrsn | about 110k [U; 74,260 for 2019–24 V] |
| (optional) `tabc` | `mxm5-tdpj` | as available | location address, licence type, dates | small; history depth [U] |

Size: about 270k rows × about 200 bytes, which is **about 55 MB in memory and under 100 MB in an ephemeral Postgres**. It is about 10–15 paged SODA requests (50k per page) per dataset, so about 25 requests at ≤2 req/s.

### 4.2 Where it runs: no Neon storage needed

- A **read-only GitHub Actions job**, a new `feasibility` input `backtest`, in the pattern of `recon/plan_review.js`.
- It uses an Actions `services: postgres:17` container. That container exists only for the run, so it needs **zero Neon storage**. (Plain Node arrays would also work; Postgres gives PostGIS-free distance with `earthdistance`, or simple haversine in SQL, and reviewable SQL.)
- Output: `report.md` + `report.json` (aggregates only, a few KB) as a workflow artifact, plus a committed fixture for an offline unit test of the matching logic (rule: tests offline).
- Nothing reaches the product DB.
- If the owner later wants the chains in the product, only the planning cases go to Neon (about 9k rows, a few MB). The BPs are already ingested.

### 4.3 Method (SQL level)

```sql
-- 1. Normalised parcel key; mega-parcel guard
CREATE TABLE parcel_guard AS
SELECT pkey FROM (
  SELECT norm_parcel(tcad_id) pkey FROM sig_all
  UNION ALL SELECT norm_parcel(tcad_id) FROM bp WHERE applieddate >= '2019-01-01') x
GROUP BY pkey HAVING count(*) > 40;          -- reported, then excluded

-- 2. Outcome BPs: new building work only, per segment
CREATE VIEW bp_new AS
SELECT *, CASE WHEN permit_class ~ '^R- 10[1-5]' THEN 'res_new'
               WHEN permit_class ~ '^C- 10[1-5]' THEN 'mf_new'
               WHEN permit_class ~ '^C- 3[0-9]{2}' AND permit_class !~ '^C- 329' THEN 'com_new'  -- 329 = dumpsters, carports, pools, event stages
               WHEN permit_class ~ '^R- 437' THEN 'marine'
               END AS segment
FROM bp WHERE work_class IN ('New','Shell')
  AND permit_class !~ '^(R|C)- 329';               -- accessory structures are never an outcome (Cairn Point case)

-- 3. Signal -> first qualifying BP, three link bases scored separately
CREATE TABLE chain AS
SELECT s.signal_id, s.kind, s.filed_on, l.basis, b.permit_number, b.applieddate, b.issue_date, b.segment
FROM sig_all s
CROSS JOIN LATERAL (
  SELECT 'parcel' basis, b.* FROM bp_new b
   WHERE b.pkey = s.pkey AND s.pkey NOT IN (SELECT pkey FROM parcel_guard)
  UNION ALL
  SELECT 'propertyrsn', b.* FROM bp_new b JOIN pr ON pr.folderrsn = b.masterpermitnum
   WHERE pr.propertyrsn = s.propertyrsn AND s.propertyrsn <> '0'
  UNION ALL
  SELECT 'distance_75m', b.* FROM bp_new b
   WHERE haversine_m(b.lat,b.lon,s.lat,s.lon) < 75
  UNION ALL                                        -- subdivisions: plat name in the BP legal description
  SELECT 'plat_name', b.* FROM bp_new b
   WHERE s.kind='subdivision' AND b.legal_description ILIKE norm_name(s.case_name) || '%'
) b
WHERE b.applieddate BETWEEN s.filed_on - 30 AND s.filed_on + 1095   -- -30 d allows concurrent review
ORDER BY s.signal_id, l.basis, b.applieddate;      -- keep the first per (signal, basis)

-- 4. Conversion with full follow-up only (right-censoring handled by restriction)
SELECT kind, combo, basis, w AS window_m,
       count(*) FILTER (WHERE first_bp_applied <= filed_on + w*30) :: float / count(*) AS p_bp,
       count(*) AS n
FROM signal_outcome, unnest('{6,12,24}'::int[]) w
WHERE filed_on <= DATE '2026-11-01' - w*30
GROUP BY 1,2,3,4;   -- add Wilson 95% CI in JS
```

**Metrics to report:**

1. **P(BP applied | S, w)** and **P(BP issued | S, w)**, with Wilson CIs and n, per segment and per link basis.
2. **Lift**: the same probability for a **control**, being random parcels with a BP history in the same ZIP and year that had no signal. Without a control, a busy parcel looks predictive.
3. **Placebo**: shift every signal date by −5 years and re-run. The match rate this gives is the **coincidental-match floor**, which matters most on large parcels and for `distance_75m`.
4. **Lead time**: median and IQR of `first_bp_applied − filed_on` among converters, and of `issue_date − filed_on`.
5. **Pre-application capture** (the key number): of new-construction BPs applied 2021-01 to 2024-12 (2 years of look-back available), the share with ≥1 signal in the prior 36 months, by segment and basis, plus the median lead over the BP application date. Report **plan-review capture separately**. It is about 96% by construction and is lead over *issuance* only.
6. **Kaplan–Meier** time-to-BP per signal kind, using all signals with censoring, as a check on the fixed windows.
7. **Leakage guard**: use only fields knowable at time *t*: `filed_on`, and `approval_date` only when it is before *t*. Never use the current `status`. Abandonment predictors are measured forward from our own snapshots.

**Combinations to test:**

- site plan alone
- zoning alone
- zoning → site plan within 18 months
- subdivision (final plat)
- residential demolition
- commercial demolition
- demolition + site plan
- site-plan extension
- TABC original + no BP within 12 months (finish-out detection)

**Minimum sample:** about 100 signals per cell for a ±10-point CI. Zoning and demolition have that. Site-plan sub-segments may not, so pool and say so.

**Pass criteria to put to the owner:** a signal type qualifies for L3 display only if P(24 mo) has its lower CI ≥ 15% and lift ≥ 3×. Pre-application capture is reported, not gated. If it is under 10% for residential new BPs, the "before the permit" thesis rests on plan review alone, and planning feeds become a commercial/MF add-on, which is a market Dodge and ConstructConnect already serve.

## 5. Signals that sound good but mislead

| Signal | Why it misleads | Use instead |
|---|---|---|
| **Land sales / deed transfers (Texas)** | No sale price (non-disclosure; TCAD sale data confidential under §22.27, a misdemeanour to disclose). Most transfers are refinances, estate and entity reshuffles, or land-banking. Grantors and grantees are often individuals (rule 5). Clerk-record terms are unread | Only as L4 context. A construction **deed of trust** naming a construction lender is stronger, but involves individuals and clerk terms [U]; not now |
| **Rezonings in general** | Entitle-to-sell is common; NPA cases are about the plan, not a project. 508 all-time cases are **historic zoning**, often a *preservation*, anti-demolition signal [V sub_type counts]. `detailed_status` "Closed" (5,414 of 6,959 all-time [V]; 16 of the 20 sampled) does not say approved or denied. In the sample, 0 of 6 approved rezonings were built in about 4.8 years [V] | L3 only with a measured rate; boost only when a site plan or subdivision follows |
| **Site plans for public works** | ROW, utility, drainage, road widening and transit cases (6 of 39 in the sample [V]) never produce a building BP | Filter by `proposed_land_use` / `work` |
| **Accessory "New" BPs as conversion** | Dumpster enclosures, carports and pools are `work_class='New'` (C-329, R-329). The Cairn Point parcel had only a dumpster BP and would have counted as "converted" [V] | Outcome = main-building classes only (R-101/102/103/104, C-101..105, C-3xx except 329) |
| **Demolition as an early signal when read from the issued feed** | In 3 of 7 converted cases, the new home was applied for *before* the demolition was issued [V] | Read demolitions at application (plan review) or not at all |
| **Site-plan extensions** | They signal a stalled project as much as a living one (3 extensions of 2017–18 plans in the sample [V]) | Report as their own cell |
| **Expired = abandoned** | Often refiled under a new number [U] | Check for a later case or BP on the parcel or name before calling it dead |
| **TABC original applications at existing buildings** | Many are changes of ownership at an operating bar or restaurant, or a new licence in a finished space. Applications usually come late in a finish-out, after the remodel BP [U] | A *tenant identity* and finish-out confirmation signal, matched to an existing remodel BP; not an early signal |
| **Demolition permits as "new home coming"** | Commercial demos for parking or vacancy; partial demos; fire demos; residential demos where the lot is sold before rebuilding | L3 with a measured rate; residential infill (R-645 → R-101 on the same parcel) is the strongest case [U until measured] |
| **Plan-review "early capture"** | It is not pre-application: the BP's applied date is that case's applied date | Report lead over issuance separately |
| **Legistar agenda items** | They echo zoning cases already in `edir-dcnf`; they add hearing dates, not new projects | Hearing-date enrichment only |
| **Mega-parcel matches** | Campus parcels (Giga Texas: 16 site plans) create false chains | Parcel guard and placebo |

## 6. Signal combinations: best current estimate of predictive value

**Read with care.** Every estimate here is a **prior to be replaced by §4**. "Confidence" is about the estimate, not the signal.

| Combination | Expected P(new BP ≤24 mo) | Typical lead over BP application | Evidence today | Confidence |
|---|---|---|---|---|
| Plan-review case filed (L1) | about 85–95% issue eventually [U]; residential median review 63 d [repo, V] | 0 over application; 63 d median over issue | Repo measurement; `masterpermitnum` 96% [V] | High |
| Site plan, building land use, **approved** | High (estimated 60–80%) [U] | 6–23 months after filing; the BP is often filed during site-plan review (concurrent) | 5 of 7 parcels got the main BP, +177 to +699 d [V, n=7] | Low–medium |
| Site plan **filed** (any outcome, building use) | Moderate (estimated 35–55%) | Median about 10 months | 6 of 11 checked [V]; about half of the 39 never reached approval [V] | Low |
| Site plan **expired** | Low but not zero (estimated 10–25%) | — | 1 of 6 built anyway, at +457 d [V] | Low |
| Site plan citing case number in a BP | n/a: it is the link itself | Concurrent | 15 of 15 `$q=SP-2023` hits cite it [V]; share unknown | Medium (as a link method) |
| Subdivision final plat (residential) | High for *some* lots; lots build out over years [U] | 6–36 months | Join needs the plat-name or spatial basis (lot IDs change) | Low |
| Residential total demolition (R-645), Final | High (estimated 60–85%) | Median 88 d over the new-home application; **often negative relative to demo *issue*** | 7 of 9 [V, n=9] | Medium |
| Residential demolition expired or withdrawn | Very low | — | 0 of 3 [V] | Low |
| Commercial demolition (C-649) | Lower, mixed [U] | Variable | 1 case: demo between SP and new BP [V, n=1] | Low |
| Rezoning alone (approved, development intent) | Low within 24 months (estimated 5–25%); cycle-sensitive | Years | 0 of 6 BPs after about 4.8 years (2022 cohort) [V]; external literature | Low |
| Rezoning → site plan within 24 months | Better than a rezoning alone; still dominated by site-plan conversion | Rezoning adds 6–20 months of lead over the site plan | 4 of 6 got a site plan, +180 to +622 d [V]; 0 BPs yet | Low |
| Site-plan extension (XT) | Ambiguous: survival vs. stall | n/a | 3 of 39 in the sample [V] | Low |
| TABC original application | As a pre-BP signal: low; as a finish-out co-signal: moderate [U] | Likely after the remodel BP | Not sampled | Low |
| Land transfer (TX) | Unknown, likely low; no price | n/a | Structural (non-disclosure) | Medium that it is weak |

## 7. Pilot recommendation (ranked)

1. **Run the §4 backtest as a read-only Actions job** (no Neon storage). It is the only way to put numbers in the ladder's L3 wording, and it answers ADR-16's real question: pre-application capture by segment. Complexity **M** (matching logic and fixtures; no new infrastructure).
2. **Report two capture numbers, not one.** Expect pre-application capture to be **low for residential new BPs**. Most single-family infill has no site plan (the demolition is the only earlier record, and it is close in time). The planning-feed lead lives mainly in commercial and multifamily [inference from the samples]. Change the E-go/no-go wording: plan-review capture (lead over issue) and pre-application capture (lead over application). The ≥80% gate should apply to the first only.
3. **Site plans first** among the planning feeds (94% `tcad_id`, the longest documented lead). Zoning and subdivisions come after the backtest shows a rate. Subdivisions need the plat-name or spatial link.
4. **Add the exact-pattern cross-reference extractor** (SP or C14 case numbers in BP and plan-review descriptions) to turn some `parcel_window` links into `official_reference`. Measure its hit rate in the backtest (query D).
5. **Start snapshotting planning-case statuses now** (they are tiny). That is the only way to learn abandonment predictors without leakage.
6. **Adopt the L1–L4 ladder** in DATA_MODEL beside the participant labels, with the "never promoted" list.

**Not worth it now:**

- **Deed and land-sale feeds:** non-disclosure, individuals, clerk terms unread.
- **Legistar parsing:** it duplicates zoning cases.
- **TABC as an early signal:** it is late and better as tenant identity.
- **ML scoring of combinations:** too little labelled history until the backtest exists. Hand rules with measured base rates are enough.
- **Board of Adjustment:** mostly individuals and existing structures (rule 5).
