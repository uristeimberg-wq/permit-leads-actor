# Austin validation target list: method

Fetched 2026-11-13 (all queries run that day). Dataset: City of Austin "Issued Construction Permits", Socrata `3syk-w9eu`. The metadata showed `rowsUpdatedAt` = 1794497191, which is 2026-11-12 15:26 UTC. The latest `issue_date` in the data was 2026-11-11, so the data lags by about 2 days. Permits issued on 2026-11-12 and 2026-11-13 are not in the data yet.

Output: `austin-targets.csv`, in this folder. It has 30 rows: 10 Electrical, 10 Plumbing and 10 Mechanical (HVAC).

## Fields used (checked against `/api/views/3syk-w9eu.json`)
- `permittype`: EP (Electrical Permit), PP (Plumbing Permit), MP (Mechanical Permit), BP (Building Permit), DS (Driveway / Sidewalks). Each row comes with its `permit_type_desc`.
- `permit_class_mapped`: Residential or Commercial.
- `contractor_trade` takes these values: Electrical Contractor, Plumbing Contractor, Mechanical Contractor, General Contractor, or blank.
- Other fields: `issue_date`, `permit_number`, `contractor_company_name`, `contractor_full_name`, `contractor_phone`, `contractor_city`.
- Each row is one permit. In the window there were 4,620 EP rows and 4,620 distinct `permit_number` values.

## Window counts (issue_date > 2026-08-14, so 2026-08-15 through 2026-11-11)
EP 4,618 · PP 3,702 · BP 2,989 · MP 2,865 · DS 365. The first query used `>'2026-08-15'`. The later queries used `>'2026-08-14'`, which explains why EP shows 4,620 below.

By class and trade (top groups): EP Residential/Electrical Contractor 3,483; PP Residential/Plumbing 2,362; MP Residential/Mechanical 1,977; BP Residential/GC 1,940. 552 residential PP permits have a blank `contractor_trade`. In the plumbing list, 633 PP permits have no company and no phone, which is about 17% of all PP. Homeowner or owner-builder plumbing permits are a likely cause, but this was not verified.

## Exact queries (base `https://data.austintexas.gov/resource/3syk-w9eu.json`)
1. Permit types:
   `?$select=permittype,permit_type_desc,count(*) as n,max(issue_date) as last&$where=issue_date>'2026-08-15'&$group=permittype,permit_type_desc&$order=n DESC`
2. Class and trade mix:
   `?$select=permittype,permit_class_mapped,contractor_trade,count(*) as n&$where=issue_date>'2026-08-15'&$group=permittype,permit_class_mapped,contractor_trade&$order=n DESC&$limit=200`
3. Candidates per trade (run with T = EP, PP, MP):
   `?permittype=T&$select=contractor_company_name,contractor_phone,count(*) as n,max(issue_date)&$where=issue_date>'2026-08-14'&$group=contractor_company_name,contractor_phone&$order=n DESC&$limit=70`
4. Residential counts per trade:
   `?permittype=T&permit_class_mapped=Residential&$select=contractor_company_name,count(*) as n&$where=issue_date>'2026-08-14'&$group=contractor_company_name&$order=n DESC&$limit=90`
5. Builder check (the top 150 building-permit filers):
   `?permittype=BP&$select=contractor_company_name,contractor_phone,count(*) as n&$where=issue_date>'2026-08-14'&$group=contractor_company_name,contractor_phone&$order=n DESC&$limit=150`
6. Detail for each chosen phone P (gives contact name, city, sample permit, and every permit type pulled under that phone):
   `?contractor_phone=P&$select=permittype,contractor_full_name,max(contractor_city),count(*),max(permit_number)&$where=issue_date>'2026-08-14'&$group=permittype,contractor_full_name`
7. Row uniqueness check:
   `?permittype=EP&$select=count(*),count(distinct permit_number)&$where=issue_date>'2026-08-14'`

Notes on running these:
- URL-encode the spaces, quotes and `>`.
- The fetch proxy refuses URLs longer than about 230 characters. That is why the queries use the short `?permittype=EP` filters and separate queries rather than one combined query with `sum(case(...))`.
- Send requests one or two at a time. Socrata rate-limits parallel unauthenticated requests.

## Candidate pool (from query 3: top 70 rows per trade, which reaches about 10 permits)
These figures are rows that have a full phone number, 8 to 80 permits in 90 days, and a last permit on or after 2026-10-23. They were counted by hand from the fetched tables. They are lower bounds, because query 3 stopped at 70 rows, which reaches about 10 permits in EP and PP and 7 in MP.
- Electrical: 53
- Plumbing: 57
- Mechanical: 56

This pool is before excluding chains, solar/EV/battery installers, multi-trade brands and mostly-commercial firms.

## Selection rules applied
1. Trade permit type is EP, PP or MP, issued in the last 90 days.
2. Active: the last permit was issued on or after 2026-10-23. All 30 picks were issued on or after 2026-11-03.
3. Volume of roughly 8 to 80 permits. Landmark Electric has 86 and is included as clearly local. It is flagged.
4. A `contractor_phone` must be present. Phones are digits only, exactly as published.
5. Residential share of 80% or more. The lowest pick is Edumar at 0.81.
6. Excluded:
   - National or multi-market brands and franchises: Base Power, IES Residential, Power Home Remodeling, ARS/Rescue Rooter, Airtron, Mister Sparky, Mr Electric, West Shore Home, USHS, Goettl, Temperature Pro.
   - Solar, battery, EV and generator installers: Freedom Solar, 512 Solar, Charge Pro, Smart Charge, Nomic, Generator Supercenter, Greenstar. Their timing is not tied to new construction.
   - Multi-trade home-service brands that would muddy the "when do you get hired" question: Radiant, Stan's, ABC, New Abacus, Salt Light & Electric, Protex, Casa, Christianson, Airco.
   - Mostly commercial firms: for example Texas Multifamily Solution (254 MP), Cool Country, Guevara AC, J & D Vision.
   - Firms whose last permit was more than 21 days ago: Doctor Electric, JPI Electric, 6B Plumbing, Bridgeview.
7. Larger local firms left out to keep within the volume rule, but usable if the founder wants bigger shops: Victory Plumbing (183 PP), McCullough Heating & Air (132 MP), Service Wizard (88 MP), In Charge Electrical (192 EP), AEI Electric (115 EP).
8. Ranking is by trade, then by residential permit count.

## Flags
- `OWNER_SURNAME_IN_COMPANY_NAME` / `OWNER_INITIALS_IN_COMPANY_NAME`: the company name contains the permit contact's surname or initials. These may be owner-operators whose number is a personal cell. Compliance should review these rows before any call. 10 rows carry this flag. No picked row has a blank company name.
- `PHONE_12_DIGITS_AS_PUBLISHED`: Mustang Plumbing's phone is published as 512733111040. It is probably a number plus an extension. It has not been corrected.
- `CONTRACTOR_CITY_OUTSIDE_AUSTIN_METRO` / `CONTRACTOR_CITY_MISSING`: as the source reports them.
- `ALSO_PULLS_PLUMBING`: Elite Heating also pulled 3 PP under the same phone.
- Builder doing in-house trades: none of the 30 picks pulled a BP under the same phone (query 6). None appears by name among the top 150 BP filers (query 5, down to about 3 BP each). So none is flagged as a builder. A builder with 1 or 2 BPs under a different phone would not be caught.

## Caveats
- `contractor_full_name` is the person on the permit. That is often the license holder or the permit runner, not necessarily the owner or the right person to call.
- The phone may be an office line, an answering service, or a personal cell. Do not assume it is a business line.
- Publication lag is about 2 days (latest issue_date 2026-11-11, dataset updated 2026-11-12). "Last permit" understates recency by that much.
- `sample_permit_number` is `max(permit_number)` in the window, which is not necessarily the last permit issued. Trade permits share their numeric prefix with the project folder: for example, 2026-141462 appears as both an EP and a PP. That is the likely join key for the BP-to-trade gap analysis, but it was not verified here.
- Residential share comes from query 4, which is grouped by company name only. If a company files under several name spellings, its counts may split.
- The results were read through a fetch tool that turns JSON into tables. The 30 picked rows were cross-checked between queries 3, 4 and 6, and the counts agree. Spot-check against the raw JSON before relying on exact numbers.
- Nobody was contacted.

## How to re-run
Replace the dates: the window start is today minus 90 days, and "active" means today minus 21 days. Run queries 3 and 4 for EP, PP and MP. Apply the rules above. Then run query 6 for each chosen phone and query 5 for the builder check. With a normal HTTP client, or a Socrata app token, queries 3 and 4 can be merged using `sum(case(permit_class_mapped='Residential',1,true,0))`.

## GC weighting (v2, added 2026-11-13)

Why this was added: another analysis found that 94% of a GC's trade permits go to a sub it has already used, so openings for a new sub come mostly from small or new GCs and from owner-builders. The list was re-ranked toward subs whose jobs come from those GCs. The v1 list is kept as `austin-targets-v1.csv`. `austin-targets.csv` is now v2.

### Linking a trade permit to its building permit (verified)
- **The link works.** Every trade permit has a `masterpermitnum` field, which equals the `project_id` of its parent building permit. Neither field shows in the column list from `/api/views` (it was cut off), but both are in the row data.
  - Example: BP 2026-141462 has `project_id` 13796007. EP 2026-141462 (Bethea Electric) and PP 2026-141462 (PK Plumbing) both have `masterpermitnum` 13796007.
- **The shared number prefix agrees** with the `masterpermitnum` link in that example. The prefix was not used for counting.
- **Reliability.** 688 sampled trade permits:
  - 408 had a `masterpermitnum`. Of those, 406 resolved to a building-permit record, 0 failed to resolve, and 2 were not looked up.
  - The other 280 had a blank `masterpermitnum`. These are standalone trade permits with no parent building permit: service work, replacements and panel upgrades. They are counted as `standalone_share`.
- **What wasn't checked.** I didn't fetch `permittype` for every parent record. One spot check without that filter only returned rows that were clearly building permits, but a few parents could be other permit types.

### Queries (base `https://data.austintexas.gov/resource/3syk-w9eu.json`)
- **L1, parent ids for each sub's most recent jobs:**
  `?contractor_phone=P&$select=masterpermitnum&$where=issue_date>'2026-08-14'&$order=issue_date DESC&$limit=18`
  For the 15 alternates the limit was 9.
- **L2, building-permit GC for those parents, at most 9 ids per call:**
  `?$select=project_id,contractor_company_name&$where=project_id in(13760636,13677248,...)`
  The ids are unquoted. **Warning:** with 10 or more ids, or with quoted ids, the URL passed the fetch tool's length check, but the `$where` was silently dropped. Those calls returned 1,000 unrelated rows. Every L2 result was checked so that only the requested ids came back.
- **G1, GC size list** (building permits from 2025-05-14 to 2026-11-11, GCs with more than 5):
  `?permittype=BP&$select=contractor_company_name,count(*) as n,min(issue_date)&$where=issue_date>'2025-05-13'&$group=contractor_company_name&$having=n>5&$order=n DESC&$limit=200&$offset=0|200|400`
  This returned about 525 GCs. The second page started with two rows that repeat from the first page, because rows with equal counts can come back in a different order on each page. A GC near a page boundary could therefore be missing, which would make it look small.
- **D1, contact and city for each alternate:** query 6 above.

### Definitions
- **SMALL GC:** not in G1, so 5 or fewer building permits in the last 18 months.
- **NEW GC:** in G1, but its first building permit in the 18-month window came after 2025-11-13.
  - Limitation: building permits from before 2025-05 were not checked, so "new" means new within the last 18 months.
  - Example: Trophy Signature Homes (57 building permits, first one in the window 2026-04-10) counts as NEW. It is a large production builder that is new to Austin, and JRV's row is flagged for it.
- **BIG GC:** everyone else.
- Name variants were grouped by hand, for example "Trinity Contructors" with "Trinity Constructors", "Remodel Boutique" with "Remodeling Boutique", and the Moore-Tate variants.
- **owner_builder_share:** the parent building permit has a blank `contractor_company_name`. This is likely an owner-builder, but that is not verified.
- **Denominator:** both `small_new_gc_share` and `owner_builder_share` are shares of the sampled jobs that link to a building permit.
- **distinct_gcs_90d:** the number of distinct GCs among the linked sample jobs, not across all 90 days. It is a lower bound for that sub.
- **gc_score:** (small_new + owner) × min(distinct GCs, 8)/8.
  - Multiplied by (1.5 − top_gc_share) when one GC has more than 50% of the jobs.
  - Multiplied by linked/5 when fewer than 5 jobs link.
  - Set to 0 when no sampled job links to a building permit.
- **Ranking:** 10 per trade, ordered by gc_score, then distinct GCs, then volume.
- **Rules kept from v1:** activity, phone, residential share, exclusions and flags. Intelligent Air Services was dropped because its residential share is 0.53.

### Coverage
- **Subs checked (45):**
  - all 30 v1 picks (18 most recent jobs each; Bethea Electric's full 33)
  - 15 alternates (9 most recent jobs each): Triangle, Wilkins, Bird's Eye, MTZ, Chavez, Calixto, Sal's, G&R Lone Star, Buffy's, Austin Air Conditioning, Masters HVAC, Intelligent Air, Lowden's, Quality Living, C & S
- **About 116 other candidates were not checked.** Each sub costs 2 to 4 fetches, and the source rate-limits requests made in parallel.
- **Every sub-to-GC link checked** is in `gc-links-sample.tsv`.

### What changed
- **14 subs have no linked jobs in their sample.** All their sampled trade permits are standalone, so they are service or replacement shops and a weak fit for the "building permit, then trade permit" signal:
  - Lanehart, D and C, Bird's Eye
  - Reliant, Proven, Beyond Wow, Calixto
  - Alamo Austin, The Coolest, Totally Cool, Austin Air Conditioning, C & S
  - (also Intelligent Air, checked but dropped for its residential share)
  All of them except Intelligent Air are out of v2.
- **Tied to one or two builders** (demoted or flagged):
  - Powerhouse: Hoch, 89%
  - Trujillos: Paradisa, 100%
  - Houk: Perry Homes and Highland Homes
  - Masters: Joseph Design Build, 89%
  - Mustang: Hoch, 58%
  - JRV: Trophy, 67%
  - Vega: Canedo, 56%
  - Wahoo: New Home Co, 50%
- **Strongest fits:**
  - DeLuna Electrical: 82% small/new GC across 6 GCs
  - Triangle Electrical: 100% small, 5 GCs
  - Edumar Electric: 42% small/new plus 8% owner, 8 GCs
  - KRD Mechanical: 69% small/new, 10 GCs
  - Elite Heating: 55%, 8 GCs
  - Loredos Plumbing: 47%, 11 GCs
  - Sal's Plumbing: 43%, 7 GCs
  - G&R Lone Star Plumbing: 44%, 5 GCs
- **Weak picks kept only to fill 10 per trade** (flagged): Plumbing #20 Trujillos, and Mechanical #29 Houk and #30 Masters. The checked candidates had no better option. Re-check more alternates before calling them.
- **Pool builders** (Denali, Anthony & Sylvan, Cody, Golden Hour, Austin Pool Builders and others) account for much of the electrical and plumbing work. That matters for the "when do you get hired" question.

### Caveats specific to v2
- **Small samples:** shares come from 9 to 18 jobs per sub, so one job moves a share by 6 to 11 points.
- **Not exact cutoffs:** "Small" and "new" are measured at today's date, not at the date of each job.
- **Possible missing GCs:** a GC dropped by the G1 page-boundary issue would be misclassified as small.
- **Transcription:** WebFetch passed back table transcriptions, not raw files. The project_id sets were checked against the ids requested.
- **Details not fetched:** contact, city and sample permit were not fetched for the dropped alternates.
