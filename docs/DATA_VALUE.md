# Why our data is worth paying for

As of 2026-11-14. This is the buyer-facing case for the data: where it comes
from, how we collect it, what we add, and why a builder, sub or supplier
should pay for it when the raw permits are free. Every number is measured and
cites where it was measured (section 9). A claim we have not measured is
marked as unmeasured. Sales copy follows `docs/COMPLIANCE.md` and the "what
we must not claim" table in the sales brief.

## 1. The short version

The permits themselves are free. Anyone can open the City of Austin portal.
What we sell is the work a buyer cannot do in an afternoon:

1. **Earlier.** In Austin and Raleigh we see building applications while they
   are still in plan review. Austin residential review takes a median of
   **63 days** (p90 300) before a permit is issued. In Miami-Dade, a county
   sewer certification comes a median of **33 days** before the permit.
2. **Joined up.** Every filing is linked by official keys to its parcel
   (84.6-99.5% by market), its later permit, its contractor as one business
   across spellings and licences, and that contractor's past jobs and subs.
3. **Who hires whom.** We hold **10,647 GC-to-sub links**. In Austin, when a
   GC had already done a job in a trade, **94%** of its next permits in that
   trade went to a sub it had used before. That is the most useful single
   fact for a sub deciding whom to call.
4. **Traceable.** Every value we show traces to the raw government record it
   came from, with the time we fetched it. Where two sources disagree we keep
   both and show the conflict. We don't pick one quietly.
5. **Daily.** We sync every source once a day and record every attempt. Over
   the last 30 days, 94.7-100% of syncs succeeded, depending on the source.

We do **not** claim to be bigger than the national vendors. Section 6 says
where we win and where we lose.

## 2. Where the data comes from, and how we get it

All sources are public and lawful. We use official open-data APIs and
published bulk files only. We never log in as someone else, solve CAPTCHAs,
or fetch anything that `robots.txt` or a site's terms forbid. Sources that
forbid automation stay off (for example Washington County, OR;
Philadelphia blocks commercial use; the NC general-contractor board disallows
robots).

**How collection works.** A scheduled GitHub Actions job runs at 17:15 UTC
every day. It fetches each source and stores every row verbatim in
`raw_records`. It then normalizes the rows, resolves contractors, links
records and enriches properties, all as upserts, so a re-run never duplicates
a row. Every attempt is logged with its error class. A separate health check
runs every 6 hours and opens an issue when a source goes stale.

### 2.1 Permits and applications

| Source | Market | What it gives | How fresh |
| --- | --- | --- | --- |
| City of Austin issued permits (Socrata `3syk-w9eu`) | Austin, TX | Permit, value, description, contractor company and phone (91.4% of permits) | City publishes 2-3 days after issue; we sync daily |
| City of Austin plan review (`n8ck-xkda`) | Austin | **Applications before issue**, applicant organisation (62% filled), city property id | Same-day intake statuses; 2,030 open applications on 2026-11-14 |
| Miami-Dade County permit layer | Miami-Dade, FL | Issued permits, contractor, licence, master permit links, folio | County refreshes weekly; we sync daily |
| City of Miami permit layer (CC BY 4.0) | City of Miami, FL | Issued permits with line items; no contractor fields | Daily |
| City of Raleigh permit layers | Raleigh, NC | Filings about 2 days after application, contractor email (90% of businesses) | Daily; 1,691 open pre-issue filings on 2026-11-14 |

### 2.2 Before the building application (planning stage)

Connected in PR #71 (migration 025). Live counts come from the nightly sync.

| Source | What it tells a buyer | Measured lead |
| --- | --- | --- |
| Austin site plans (`mavg-96ck`) | A building is planned on a property | For Austin multifamily 5+, a site plan was on file before **91.9%** of new buildings, median **363 days** ahead; commercial **80.3%**, **385 days** (2020-2024 backtest). Only **22%** of building site plans become a new main building within 24 months, so a site plan is context, not a forecast |
| Austin subdivision cases (`s7gx-9m54`) | New lots and the developer behind them | Lead not measurable yet: houses are permitted on new lot ids |
| Raleigh development plans and plan areas | Plans, developer (86% filled), units and lots | 70 of the newest 300 plans had a building permit on the same parcel later, median **210 days** after the plan |
| Miami-Dade DERM sewer certifications | A utility certification ahead of the county permit | Where it links to a county permit (85 of 595 in a year), the permit came a median **33 days** later (p25 21, p75 77), never before |

**The honest part.** For single-family homes, which are 84% of new Austin
buildings, planning records come first only **7.3%** of the time. For homes,
the real early window is plan review (median 63 days) plus demolitions (19.3%
of new homes have one first).

### 2.3 Property

| Source | Market | What we take | Fill |
| --- | --- | --- | --- |
| Travis CAD appraisal exports | Austin | Year built, living area, lot size, appraisal band (never the exact value or owner) | 84.6% of Austin permits linked to a parcel; year built 94.1%, area 94.2% |
| Miami-Dade Property Appraiser | Miami-Dade | Floors, units, area, land use, beds and baths | 96.3% of permits linked by folio |
| Wake County parcels (CC BY 4.0) | Raleigh | Parcel facts by PIN | 95.6% linked |
| City of Austin parcel geometry | Austin | Map point for permits Census could not place | |
| US Census geocoder | All | Map points | 82.7-100% of permits on the map |
| Google Street View (live, never stored) | All | A photo of the job site, labelled with its capture date | 12 of 12 job pages showed a photo on the 2026-11-14 check |

We hold **365,161 appraiser field values**, each with its source and time.
**44,076** property fields have more than one source; we track every
disagreement instead of overwriting.

### 2.4 Who the companies are

| Source | What it proves | Result |
| --- | --- | --- |
| Florida DBPR licence file | The contractor holds a state licence | 85.5% of Florida businesses tied to a licence or registration |
| Texas TDLR licence file | Same, for licensed trades in Texas | Part of the Texas 34.1% |
| Texas Comptroller franchise-tax API | The business is one exact registered entity, and whether it can still transact in Texas | First run: **245 of 534** names verified (**46.3%**), covering 71.8% of their permits. **40** verified businesses have lost the right to transact in Texas. About 530 more names a night |
| Florida Sunbiz corporate files | Joins records that are one firm under two keys | **72.6%** of Florida business names map to exactly one Sunbiz entity. On a 200-firm hand audit, firms split across two records fell from **29.5% to 9.0%**, with **0 wrong merges in 200** |

People's names, officers, registered agents and home addresses are never
stored or shown (rule 5).

## 3. What we add on top of the raw records

- **Official links, not guesses.** Application to issued permit: 86.1% linked. The Austin city property id links 99.9% of new main
  building permits to their plan-review case. Where only a parcel links two
  records, the link is labelled with a lower confidence.
- **One business per firm.** Spellings, licences, phones and registrations
  are resolved into one contractor (91.0% of Austin permits, 82.5% Miami-Dade,
  95.6% City of Miami, 93.0% Raleigh resolve to a business). Wrong merges
  measured at 0 of 200.
- **GC-to-sub relationships.** Built from trade permits on the same job:
  10,647 links. Share of building jobs with a linked trade permit: Austin
  51.9%, Miami-Dade 15.7%, City of Miami 20.0%, Raleigh 78.6%.
- **Who filed the application** (Austin): the organisation that filed,
  classed as builder or expediter from its permit history, so an expediter is
  never called "the builder".
- **Provenance and confidence per field.** Each property value carries its
  source, fetch time and method. Conflicts are explicit. Missing is shown as
  missing; nothing is invented.
- **Status history.** Sources keep only the current status. We snapshot
  every change, which is how we will measure how long each stage takes. This
  started on 2026-11-13, so today it is about a day deep.
- **A daily quality scorecard.** Ten metrics per market per day (parcel
  match, contractor resolved, phone coverage, linkage, history depth and
  more), so a buyer can see quality, not a record count.

## 4. What a buyer gets

| Buyer | What they get | The number behind it |
| --- | --- | --- |
| **Subcontractor** (electrical, plumbing, HVAC) | Which GCs are winnable: who spreads work across 3+ subs, who just switched, and which subs hold which GCs | 94% repeat hiring in Austin, so a list of new jobs alone is weak and relationship data is the real lead |
| **Subcontractor** | Jobs with no trade permit **issued** yet, ranked by trade fit | 50-78% of Austin building permits later get a trade permit, median 25-63 days after, by trade |
| **Builder, supplier** | Early filings in plan review, about two months before issue, with the filer and whether it is a builder or an expediter | 63-day median residential review; 2,030 open Austin and 1,691 open Raleigh filings on 2026-11-14 |
| **Builder, supplier** | The builder's usual subs per trade, from its own issued permits | Top three past subs per trade, labelled as history |
| **Anyone** | Likely issue window, trade timing, builder momentum (rising, new, slowing) | **Estimates** from our own history, labelled as such. Calibration target is about 60% inside the range; **not yet measured** |
| **Anyone** | Phone, and in Raleigh email, from the public record, with how many permits it appears on | Phones on 96.7% of TX, 80.3% FL, 86.0% NC businesses; seen on 2+ permits 43.5% / 31.7% / 44.1%; email 90% NC |

## 5. Why pay instead of using the free city portals

The portals publish the same raw rows. A buyer using them still has to:

- check four separate portals in different formats, daily;
- find applications, which in Austin are a different dataset from permits;
- match spellings and licences of the same firm by hand (29.5% of sampled
  Florida firms were split across two records before our fix);
- rebuild who-hires-whom from thousands of trade permits;
- look up each property in the appraiser's site, and each company in the
  state registries;
- keep their own history, because the portals overwrite status.

That is the work the subscription pays for. It is also the honest limit:
someone patient enough can do it for one ZIP code by hand.

## 6. Us against the paid alternatives

### Shovels (national, $599 and $999 a month for paid plans)

| | Shovels (published, checked 2026-11-14) | Us | Verdict |
| --- | --- | --- | --- |
| Breadth and history | About 2,000 jurisdictions, from 2010, 159M properties | 4 markets, mostly 2025-26 | **They win, and will keep winning** |
| Update frequency | Twice monthly plus up to 7 days | Daily (Miami-Dade publishes weekly) | We win, provable from our sync log |
| Pre-approval in our markets | `in_review` statuses; council-stage decisions in about 600 cities (beta) | Austin plan review same day, Raleigh pre-issue, DERM ~33 days ahead | Likely win; **not provable until we measure discovery latency** |
| Status history | Current status only | Every change since 2026-11-13 | Win over time; one day deep today |
| GC-sub relationships | One contractor per permit, no role | 10,647 GC-sub links | We win |
| Provenance | No source-record link | Every value to its official record | We win |
| Contractor identity | Per-state dedup | 0 wrong merges in 200, 9.0% splits | Unproven against theirs |
| Contacts | Phone and email, no fill rate published | Fill rates above | Unknown |

The risk: Shovels already runs custom cadences for enterprise customers. If
it moves big metros to daily, our speed edge shrinks to days. The edges it
would struggle to copy are GC-sub history, status history and provenance.
Their terms bar using their service to compete, so we compare only against
their published documentation.

### Zabalist (Austin, from $49 a month)

Sells Austin issued permits, site plans, Travis CAD, TDLR and contractor
history. Site plans are already a commodity there. In our check it showed no
Austin plan-review applications (4 of 50 sampled cases checked one by one,
all absent; its permit route has no plan-review record type). So plan-review
intake and the GC-sub model are what we offer that it does not, as far as we
have checked. It is much cheaper; our price has to be justified by those two.

## 7. Limits (read before quoting anything above)

- **Four markets.** Austin, Miami-Dade, City of Miami, Raleigh. Nothing else.
- **No paying customer, and no pilot user yet.** No buyer has told us a lead
  was new to them. That is the measurement that matters most and we don't
  have it.
- **Discovery latency is not measured.** "Earlier than Shovels" is likely but
  unproven.
- **Estimates are estimates.** Issue windows, trade timing and momentum are
  labelled as estimates and are not yet calibrated against outcomes.
- **Raleigh has no licence or registry key.** 0% of NC businesses are tied
  to a state licence; the board disallows automated access and a lawful
  source isn't chosen yet.
- **Texas identity is thin.** 34.1% of Texas businesses are anchored today,
  rising nightly as the Comptroller backlog clears.
- **Miami is issued-only** except for DERM certifications, and only 85 of 595
  certifications linked to a county permit.
- **History is short.** Permits mostly 2025-26; status history one day deep.
- **Splits remain.** 9.0% of sampled Florida firms still have a twin record
  (target 3%).
- **Phones are from public permits, not verified by calling.**
- **"No trade permit issued" is not "unhired".** Austin publishes issued
  permits only.
- **Redistribution is unsettled for some sources.** Austin is public domain
  and City of Miami and Wake are CC BY 4.0 (credit required). Miami-Dade
  grants no explicit licence, Raleigh can ask us to stop, and the Texas
  Comptroller and Sunbiz state no terms. Exports for customers wait on the
  review in `docs/COMPLIANCE.md`.

## 8. What we will not do

- No homeowner names or personal contacts until the homeowner-track
  compliance gate passes (ADR-10).
- No scraping behind logins or CAPTCHAs, and nothing a source's terms or
  `robots.txt` forbid.
- No sale prices, deeds or owner fields from appraisers.
- No stored copies of Street View images.
- No contacting anyone on a customer's behalf.

## 9. Where each number comes from

| Number | Source |
| --- | --- |
| 137,455 permits and applications, 16,643 contractors, 10,647 GC-sub links, fill rates by market and state, 2,030 / 1,691 open filings, 46.3% Comptroller, 12 of 12 photos, sync success 94.7-100% | Coverage doc "Data engine coverage vs the brief", full sync run 43618444328 (2026-11-14 17:23 UTC) |
| 63-day median review, p90 300 | `docs/DATA_STRATEGY.md`, `docs/ROADMAP.md` |
| 91.9% / 363 d, 80.3% / 385 d, 7.3%, 22%, 99.9% property id | `docs/research/2026-11-14-early-signals/P0-backtest-results.md` |
| 33 days DERM lead, Raleigh 210 days | `docs/DATA_SOURCES.md` (planning sources) |
| 72.6%, 29.5% to 9.0%, 0 wrong merges in 200 | `docs/research/2026-11-14-entity-resolution-audit.md`, ADR-25 |
| 94% repeat hiring, 25-63 days, 50-78% | `docs/DATA_SOURCES.md` (timing analysis, PR #6) |
| Travis CAD fills, parcel link rates | `docs/DATA_SOURCES.md` enrichment sources, ADR-15 |
| Shovels facts and prices | `docs/research/2026-11-14-data-engine/shovels.md` |
| Zabalist | `docs/research/2026-11-14-early-signals/P1-competitor-check.md` |
| Source terms | `docs/COMPLIANCE.md` register |
