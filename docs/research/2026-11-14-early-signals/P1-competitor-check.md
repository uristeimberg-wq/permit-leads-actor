# P1 competitive check: Austin plan-review filings vs competitors

Run date 2026-11-14 (checks between ~07:40 and 08:30 UTC). This is the P1 check from
`docs/DATA_STRATEGY.md` sections 7.3 and 8. Public pages only: no accounts, no
logins, no forms. Labels: **[V 2026-11-14]** = I fetched the page and saw it.
**[U]** = inference or not tested. Private individuals are written as [individual].

**Budget note.** The shared WebFetch budget (100 calls/hour across all agents) ran
ran out twice, after about 49 of my calls in total. Shovels was checked only from
its public docs. ConstructConnect and BuildZoom were not checked at all (section 5). Zabalist was checked case by case for only
5 plan-review folders (4 from the sample plus 1 control), not the planned 20+.
I used the rest of the budget on controls that test the whole approach instead
(section 3).

---

## 1. Verdict (blunt)

- **Pass criterion #4 ("at least 60% of the sample not shown by any checked
  competitor on the same date with the same company"): UNDETERMINED as a measured number.**
  - Only 4 of the 50 sampled cases were checked one by one on Zabalist. All 4 were not shown.
  - Shovels was not checked case by case.
  - 4 cases is too few to report a share.
- **The evidence points strongly towards a pass against Zabalist** [V for the mechanism, U for each unchecked case]:
  - Zabalist has no Austin plan-review (PR) record type. Its permit route returns "Permit Not Found" for every PR number tried.
  - That includes a PR that was approved and issued 2 weeks ago (2026-129874 PR), while the BP it produced (2026-143832 BP) is shown.
  - Its site-plan route also returns "Site Plan Not Found" for PR folderrsns.
  - Its Austin permits page says it covers issued permits only and never mentions plan review.
  - It shows the filing only after the BP is issued. That BP page shows no applied date and no company (2 of 2 BP pages checked).
  - So it fails "same date" and "same company" both.
- **Shovels** has an `in_review` status in its model, which means it can carry applications [V docs].
  - It refreshes "twice a month", plus up to a week before data reaches the API [V docs].
  - By its own documented cadence it cannot show a filing on the same date [V for the cadence statement; U for how Austin is handled in practice].
- **Site plans are already commodity on Zabalist, and fast.**
  - 10 of 10 of the newest Austin site plans (filed 2026-11-02 to 11-12) are shown.
  - They show the stage ("Intake Pending, Step 1 of 5"), the "Application filed" date, the applicant engineering firm, TCAD and deed history.
  - Cases filed 2026-11-12 were visible on 2026-11-14 (0 to 2 days).
  - Do not claim site plans as an edge.
- **Before any customer claim**, re-run sections 2 and 5 with a fresh budget:
  - the remaining 46 PR numbers on Zabalist, about 46 calls, or fewer if the pattern holds after about 15 more;
  - Shovels, which needs a free account or API key to test properly. That is "not checkable without an account" under the rules of this run.

## 2. Sample: Austin plan-review cases (`n8ck-xkda`)

Source: `https://datahub.austintexas.gov/resource/n8ck-xkda.json?work_class=New&$order=applied_date DESC&$limit=60` [V 2026-11-14].
- The dataset's `rowsUpdatedAt` is 2026-11-13 18:22 UTC.
- The filter worked: all 60 rows returned are `work_class = New`.
- Applied dates run from 2026-11-05 to 2026-11-13.
- The sample is the first 50 rows. Rows 51-60 are listed only for completeness.
- "New" includes pools and accessory structures (R-329, C-329). These are tagged in the segment column; they are not main buildings.

Segment counts across all 60 rows:
- R-101 single-family: 27
- R-329 residential structures other than building (mostly pools): 18
- R-330 accessory: 1
- R-102 secondary apartment: 1
- Commercial (C-*): 13

Within the first 50:
- R-101: 24
- R-329: 11
- R-330: 1
- R-102: 1
- C-*: 13

Applicant org:
- Only business names are kept.
- "— (none)" means the field is empty.
- "(placeholder)" means the field holds only "**** MAIN ****".
- "(expediter)" marks a permit service, not the builder.

How to read the Zabalist column:
- **Not shown [V]** = I fetched `zabalist.com/permits/<number>%20PR` and got "Permit Not Found". For two cases I also fetched `zabalist.com/site-plans/<folderrsn>` and got "Site Plan Not Found".
- **Not shown [U]** = not fetched one by one. The inference comes from the mechanism checks in section 3: no Austin PR record type exists on Zabalist.

Shovels column:
- "n/c" = not checked.
- Shovels has no public per-permit page, and its search needs an account (section 5).

| # | Case | folderrsn | Applied | Segment | Applicant org (business only) | Status 11-13 | Zabalist shown? (stage / date / company / links) | Shovels |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-149340 PR | 13804788 | 2026-11-13 | C-329 | Fred Tillman Contractors | Prerequisite Review Approved | **Not shown [V]** (permit and site-plan routes) | n/c |
| 2 | 2026-149321 PR | 13804763 | 2026-11-13 | R-101 SF | — | Prerequisite Review Approved | Not shown [U] | n/c |
| 3 | 2026-149125 PR | 13804540 | 2026-11-12 | R-329 | — | In Review | Not shown [U] | n/c |
| 4 | 2026-148788 PR | 13804174 | 2026-11-12 | R-101 SF | — | In Review | Not shown [U] | n/c |
| 5 | 2026-149225 PR | 13804649 | 2026-11-12 | R-101 SF | Taylor Morrison | In Review | **Not shown [V]** (permit and site-plan routes) | n/c |
| 6 | 2026-149193 PR | 13804616 | 2026-11-12 | R-329 | — | Aborted | Not shown [U] | n/c |
| 7 | 2026-149127 PR | 13804542 | 2026-11-12 | R-329 | Permits Plus ATX (expediter) | Prerequisite Review Approved | Not shown [U] | n/c |
| 8 | 2026-148838 PR | 13804228 | 2026-11-12 | R-101 SF | Waterloo Permits LLC (expediter) | Intake Pending | Not shown [U] | n/c |
| 9 | 2026-149129 PR | 13804544 | 2026-11-12 | R-101 SF | Taylor Morrison | In Review | Not shown [U] | n/c |
| 10 | 2026-149212 PR | 13804635 | 2026-11-12 | C-328 | BAE Systems | In Review | Not shown [U] | n/c |
| 11 | 2026-148798 PR | 13804185 | 2026-11-12 | C-105 MF (5+) | Austin Permit Service Inc. (expediter) | e-Prerequisite Review Pending | Not shown [U] | n/c |
| 12 | 2026-149195 PR | 13804618 | 2026-11-12 | R-329 | — | In Review | Not shown [U] | n/c |
| 13 | 2026-149254 PR | 13804686 | 2026-11-12 | R-101 SF | Taylor Morrison | In Review | Not shown [U] | n/c |
| 14 | 2026-148839 PR | 13804229 | 2026-11-12 | C-329 | Rosch Company | In Review | Not shown [U] | n/c |
| 15 | 2026-149081 PR | 13804496 | 2026-11-12 | R-101 SF | Taylor Morrison | In Review | Not shown [U] | n/c |
| 16 | 2026-148800 PR | 13804187 | 2026-11-12 | C-322 | Burnham Nationwide (expediter) | In Review | Not shown [U] | n/c |
| 17 | 2026-148909 PR | 13804306 | 2026-11-12 | R-329 | Aqua Permits (expediter) | In Review | Not shown [U] | n/c |
| 18 | 2026-148632 PR | 13804014 | 2026-11-11 | R-101 SF | — | Queue | Not shown [U] | n/c |
| 19 | 2026-148638 PR | 13804020 | 2026-11-11 | R-101 SF | KB HOME Austin | Queue | **Not shown [V]** | n/c |
| 20 | 2026-148630 PR | 13804012 | 2026-11-11 | R-101 SF | — | Queue | Not shown [U] | n/c |
| 21 | 2026-148276 PR | 13803644 | 2026-11-10 | R-101 SF | — | In Review | Not shown [U] | n/c |
| 22 | 2026-148123 PR | 13803479 | 2026-11-10 | R-329 | Permit Solutions (expediter) | In Review | Not shown [U] | n/c |
| 23 | 2026-147845 PR | 13803169 | 2026-11-10 | R-101 SF | — | e-Prerequisite Review Pending | Not shown [U] | n/c |
| 24 | 2026-148344 PR | 13803715 | 2026-11-10 | R-329 | — | Prerequisite Review Approved | Not shown [U] | n/c |
| 25 | 2026-147982 PR | 13803320 | 2026-11-10 | R-329 | Westbank Pools | Prerequisite Review Approved | Not shown [U] | n/c |
| 26 | 2026-148312 PR | 13803680 | 2026-11-10 | R-330 | — | In Review | Not shown [U] | n/c |
| 27 | 2026-147975 PR | 13803313 | 2026-11-10 | R-329 | — | Prerequisite Review Approved | Not shown [U] | n/c |
| 28 | 2026-148083 PR | 13803430 | 2026-11-10 | C-329 | Site Property Company | **Approved, issued 2026-11-12** | **Not shown [V]**. `2026-148083 BP` was also "Not Found" [V], but the BP number is not confirmed: the city's issued dataset had no 2026 row for that address yet [V] | n/c |
| 29 | 2026-148427 PR | 13803804 | 2026-11-10 | R-329 | — | Prerequisite Review Approved | Not shown [U] | n/c |
| 30 | 2026-148094 PR | 13803441 | 2026-11-10 | R-101 SF | — | In Review | Not shown [U] | n/c |
| 31 | 2026-148346 PR | 13803717 | 2026-11-10 | C-329 | — | In Review | Not shown [U] | n/c |
| 32 | 2026-148169 PR | 13803525 | 2026-11-10 | C-320 industrial | AESUS Design Group | Prerequisite Review Approved | Not shown [U] | n/c |
| 33 | 2026-148394 PR | 13803766 | 2026-11-10 | R-101 SF | Austin Habitat for Humanity | In Review | Not shown [U] | n/c |
| 34 | 2026-147404 PR | 13802687 | 2026-11-09 | R-101 SF | Element 5 Architecture | e-Prerequisite Review Pending | Not shown [U] | n/c |
| 35 | 2026-147413 PR | 13802696 | 2026-11-09 | R-101 SF | — | e-Prerequisite Review Pending | Not shown [U] | n/c |
| 36 | 2026-147466 PR | 13802749 | 2026-11-09 | R-101 SF | — | In Review | Not shown [U] | n/c |
| 37 | 2026-147620 PR | 13802930 | 2026-11-09 | R-101 SF | (placeholder) | In Review | Not shown [U] | n/c |
| 38 | 2026-147615 PR | 13802925 | 2026-11-09 | C-328 | — | Awaiting Upload | Not shown [U] | n/c |
| 39 | 2026-147244 PR | 13802526 | 2026-11-09 | C-320 industrial | Atlas Design Services | Prerequisite Review Approved | Not shown [U] | n/c |
| 40 | 2026-147459 PR | 13802742 | 2026-11-09 | R-101 SF | — | In Review | Not shown [U] | n/c |
| 41 | 2026-147214 PR | 13802488 | 2026-11-09 | R-101 SF | — | e-Prerequisite Review Pending | Not shown [U] | n/c |
| 42 | 2026-147394 PR | 13802677 | 2026-11-09 | R-101 SF | Waterloo Permits LLC (expediter) | e-Prerequisite Review Pending | Not shown [U] | n/c |
| 43 | 2026-147436 PR | 13802719 | 2026-11-09 | R-101 SF | KB HOME Austin | In Review | Not shown [U] | n/c |
| 44 | 2026-147032 PR | 13802292 | 2026-11-06 | R-329 | — (no address either) | In Review | Not shown [U] | n/c |
| 45 | 2026-146766 PR | 13801985 | 2026-11-06 | R-101 SF | Waterloo Permits LLC (expediter) | e-Prerequisite Review Pending | Not shown [U] | n/c |
| 46 | 2026-146641 PR | 13801852 | 2026-11-06 | C-329 | Austin Permit Service, Inc (expediter) | In Review | Not shown [U] | n/c |
| 47 | 2026-146947 PR | 13802196 | 2026-11-06 | R-101 SF | Sidetracked Studio | e-Prerequisite Review Pending | Not shown [U] | n/c |
| 48 | 2026-146842 PR | 13802071 | 2026-11-06 | R-102 ADU | — | Awaiting Upload | Not shown [U] | n/c |
| 49 | 2026-146454 PR | 13801622 | 2026-11-05 | C-329 | — (owner: Capital Metro) | Withdrawn | Not shown [U] | n/c |
| 50 | 2026-146502 PR | 13801687 | 2026-11-05 | R-329 | — | In Review | Not shown [U] | n/c |

Rows 51-60 (outside the sample) are 2026-11-05 filings:
- 2026-145994 PR
- 2026-146508 PR
- 2026-146093 PR
- 2026-146231 PR
- 2026-146254 PR (CLEANTAG LLC)
- 2026-146517 PR
- 2026-146469 PR (Austin Permit Service, expediter)
- 2026-146016 PR (Innovative Pools and Spas)
- 2026-146017 PR (Aqua Permits, expediter)
- 2026-146471 PR

Side observations from the sample [V 2026-11-14]:
- **Applicant org quality:**
  - 25 of 50 have no applicant org, and 1 more holds only a placeholder.
  - 11 of the 24 named orgs are expediters (Permits Plus ATX, Waterloo, Austin Permit Service, Burnham Nationwide, Permit Solutions, Aqua Permits).
  - Only about 13 of 50 name a builder, contractor or designer directly:
    - Taylor Morrison ×4
    - KB HOME ×2
    - Fred Tillman, BAE Systems, Rosch, Site Property, AESUS, Habitat, Element 5, Atlas, Sidetracked Studio
  - This matters for pass criterion #3 more than for #4.
- **Lag in the city's issued feed.** 2026-148083 PR shows `issued_date` 2026-11-12. The issued dataset `3syk-w9eu` had no 2026 BP at that address when checked, only the 2020 permits there. A one-day lag in the issued feed is plausible [U].

## 3. Zabalist (zabalist.com): mechanism checks

robots.txt [V 2026-11-14]:
- Claude-User is allowed, with `/api/`, `/admin/`, `/forms/`, `/subscribe` and `/upgrade` disallowed. Crawl delay is 2 to 5 seconds.
- Every page used here is allowed.

| Check | Result |
|---|---|
| `/permits/city/austin` | [V] Covers "issued" Austin permits: 166,039 on record, "last updated Nov 11, 2026", "re-synced nightly", source `3syk-w9eu`. **No mention of plan review, applications, pending, in review or pre-issuance.** It still says "Issued in 90 days: 0" next to 25 permits dated Nov 11 (the same contradiction Worker E found). The listed permits are BP/EP/MP/PP only, with no company per row |
| Permit URL pattern | [V] `/permits/<number>%20<suffix>`. `2026-146470 BP` and `2026-143832 BP` resolve |
| **Positive/negative control** | [V] `2026-129874 PR` (applied 2026-10-02, approved and issued 2026-10-30; folderrsn 13782768) gives **"Permit Not Found"**. The BP it produced, `2026-143832 BP` (masterpermitnum 13782768, issued 2026-11-11), **is shown**: "Active", address only, **no applied or issued date, no company, no linked trade permits or PR** |
| PR numbers from the sample | [V] 2026-149340, 2026-149225, 2026-148638 and 2026-148083 PR: all "Permit Not Found" |
| PR folderrsn on the site-plan route | [V] `/site-plans/13804649` and `/site-plans/13804788`: "Site Plan Not Found". The route takes only site-plan folderrsns |
| Old records | [V] `2020-052958 BP` and `2020-052958 PR`: Not Found. The Austin permit archive is a rolling window, not the full history [U on the window length] |
| `/permits` explorer | [V] Covers Austin, San Antonio, Fort Worth and Houston. Status values seen: Issued, Pending, and **"Plan Review" for one Fort Worth permit**. So Zabalist already shows pre-issuance stages where the source feed carries them (Fort Worth). Address search is client-side; `?q=` is ignored [V], so I could not search by address |
| Sitemaps (`z-sitemap.xml`, lastmod 2026-11-13) | [V] Children: static, directory, projects, permits, bids, site plans, reports, pipeline. The "pipeline" sitemap has **Austin zoning cases** (`/zoning-cases/case/austin%3AC14-2026-0068`, NPA cases) plus San Marcos and Leander planning cases. No PR identifiers in the visible part. The permits child sitemap was not read |
| `/pricing` | [V] Free $0, Scout $19, Pro $39, Command $99 per seat per month. No claim about permit applications, plan review or pre-issuance. One-off lists: "Austin Site Plan Developers & Owners" $129 (350+ records), "Active General Contractors, Austin Metro" $149 (2,400+). The free-account 7-day delay from Worker E was not re-seen on this page [U] |
| `/data` | Not read (budget ran out) |

**What this means.**
- On 2026-11-14 Zabalist shows nothing of an Austin building filing at plan-review stage.
- It shows the filing only once a BP is issued and its own nightly sync runs. Its page was "last updated Nov 11" while the city had issued BPs dated Nov 12.
- Even then, the BP page does not show the applicant company or the applied date.
- The gap is a product choice, not a technical barrier:
  - Zabalist already ingests Austin site plans and zoning cases by folderrsn.
  - It shows a "Plan Review" status for Fort Worth.
  - Adding `n8ck-xkda` would be a small job for them (Worker E's "a week" estimate stands) [U].

## 4. Austin site plans (`mavg-96ck`) on Zabalist

Source: `mavg-96ck.json?calendar_year_folder_created=2026&$order=application_start_date DESC&$limit=14` [V 2026-11-14]. Two other queries were ignored, so the filter was checked:
- `$order=applied_date` failed, because the field does not exist.
- `$order=folderrsn` sorted as text, not numbers.

Zabalist URL used: `/site-plans/<folderrsn>`. As checked on `/site-plans/10350716`, the id is the city folderrsn and the page links to the ABC portal.

| # | folderrsn | Case | City filed | City status | Zabalist shown? | Stage shown | Date shown | Company named (business) | Links |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 13804472 | 183 & Duval Bldg 1 & 5 | 2026-11-12 | Intake Pending | **Yes** [V] | Intake Pending, Step 1 of 5 | Application filed Nov 12, 2026 | Garza EMC (applicant); owner LLC from TCAD | ABC portal, TCAD |
| 2 | 13804434 | Pion (10217 Dessau Rd) | 2026-11-12 | Intake Pending | **Yes** [V] | Intake Pending, 1 of 5 | Nov 12, 2026 | Pape-Dawson Engineers | ABC portal |
| 3 | 13804411 | 6309 Hudson St (parking) | 2026-11-12 | Intake Pending | **Yes** [V] | Intake Pending, 1 of 5 | Nov 12, 2026 | None (owner [individual]; applicant redacted) | ABC portal, TCAD |
| 4 | 13803546 | Met Center II Base Power Campus (SP-2026-0349D.CC) | 2026-11-10 | CC Pending | **Yes** [V] | "CC Pending, step 4 of 5" | Nov 10, 2026 | Thrower Design (applicant); owner LLCs | ABC portal, TCAD |
| 5 | 13803511 | Koenig Lane MF Site Plan Extension | 2026-11-10 | Intake Pending | **Yes** [V] | Intake Pending, 1 of 5 | Nov 10, 2026 | Armbrust & Brown PLLC (applicant); owner Ltd | ABC portal |
| 6 | 13803357 | Solana Circle C Ranch Clearing Plan | 2026-11-10 | Intake Pending | **Yes** [V] | Intake Pending, 1 of 5 | Nov 10, 2026 | LJA Engineering (applicant); owner LLC + **deed history** | TCAD |
| 7 | 13802611 | Tru Pointe Ranch Townhomes Ph 1 | 2026-11-09 | Intake Pending | **Yes** [V] | Intake Pending, 1 of 5 | Nov 9, 2026 | Kimley-Horn; DLR Group | ABC portal |
| 8 | 13802591 | FM 969 C-Store | 2026-11-09 | Intake Pending | **Yes** [V] | Intake Pending | Nov 9, 2026 | Owner LLC (TCAD); deed history names individuals | TCAD |
| 9 | 13800683 | 1723 E. Oltorf (SP-2022-0400CS(XT).CC) | 2026-11-04 | CC Pending | **Yes** [V] | CC Pending, 4 of 5 | Nov 4, 2026 | Thrower Design; owner LLC | TCAD |
| 10 | 13799483 | Canopy Apartments (8403 S 1st St) | 2026-11-02 | Intake Pending | **Yes** [V] | Intake Pending, 1 of 5 | Nov 2, 2026 | Kimley-Horn & Associates; owner LLC | TCAD |

Totals and points to note:
- **10 of 10 shown**, each with the same stage and the same application date as the city.
- 9 of 10 name a business (applicant engineer or owner LLC).
- Speed: the 3 cases filed on 2026-11-12 were visible by the 2026-11-14 check, so the lag is at most 2 days. The site-plan sitemap lastmod is 2026-11-12. I could not test same-day visibility [U].
- Zabalist reads ".CC" cases as "Council Review" (step 4 of 5) [V that it displays "CC Pending, step 4 of 5"; whether that reading is right is U]. The city's ".CC" suffix on site plans usually marks a change or correction, not council review [U]. This looks like a data-quality slip.
- Zabalist pages show **deed grantors, including individuals**. That is consistent with Worker E's compliance note, and we must not copy it.

## 5. Shovels, ConstructConnect, BuildZoom

**Shovels** (public docs at docs.shovels.ai, no account):
- **Pre-issuance stage exists in its model** [V 2026-11-14, `permit-statuses.md`]:
  - `in_review` covers the time "from the moment the permit is filed with the local jurisdiction until it is approved".
  - The other statuses are `active`, `final` and `inactive`.
  - So Shovels *can* carry applications, where a jurisdiction's feed does.
- **Current status only:** "a permit's status reflects what its jurisdiction reported as of the most recent refresh" [V]. No status history is described.
- **Cadence** [V, `refresh-frequency.md`]:
  - "Data is refreshed twice a month".
  - Then "up to a week" passes before the data reaches the API and Shovels Online.
- **Consequence:**
  - By Shovels' own documented cadence, a filing made this week is visible about 0 to 22 days later. That is not on the same date.
  - **This fails "same date" for essentially every case in the sample, whatever its Austin coverage.** [V for the cadence statement; U for how Austin is handled in practice]
- **Not checked:**
  - Austin coverage: `coverage-areas.md` and `/coverage` were not read because the budget ran out.
  - Whether its Austin source is `n8ck-xkda` or `3syk-w9eu` is unknown.
  - Which company it names is unknown.
  - Each permit needs the app or API (an account or key). Per case: **not checkable without an account.**
- Docs index: `docs.shovels.ai/llms.txt` lists Decisions pages ("decision-to-permit" and others) and `start-end-dates.md`. `start-end-dates.md` was not read because of the budget.

**ConstructConnect:**
- Not checked this run (budget).
- Worker E [read from page, 2026-11-14]: commercial focus, "Permit Filing" stage, paid per market.
- Project pages need an account, so it is not checkable without an account. There is no public Austin residential filing page known [U].

**BuildZoom:**
- Not checked this run (budget).
- Worker E [read from page]: issued permits only, bulk weekly or monthly.
- Public contractor pages exist, but no plan-review stage is claimed [U].

## 6. Totals

| Measure | Value |
|---|---|
| Plan-review sample size | 50 (of 60 fetched), applied 2026-11-05 to 11-13, all `work_class = New` |
| Zabalist checked one by one | 4 sample cases + 1 control PR + 2 PR folderrsns on the site-plan route |
| Zabalist shown (sample, checked) | **0 of 4** |
| Zabalist shown (control PR already issued) | 0 of 1. Only the resulting BP is shown, without date or company |
| Shovels checked one by one | 0. Not checkable without an account. Its docs give a lag of about 0 to 22 days (twice-monthly refresh + up to 1 week) |
| ConstructConnect / BuildZoom checked one by one | 0 |
| Site plans shown by Zabalist | **10 of 10**, same stage, same filed date, business named in 9 of 10, visible within 2 days or less |
| Criterion #4 | **Undetermined.** 4 of 50 is too few. The mechanism evidence predicts that about 100% are not shown by Zabalist on the same date with the same company. Shovels is untested |

## 7. What to do next (for the owner)

1. With a fresh WebFetch budget:
   - Check about 15 more sample PR numbers on Zabalist (`/permits/<n>%20PR`). If all are Not Found, report Zabalist as 0 of 50 with confidence.
   - Also fetch `zabalist.com/data` and the permits child sitemap for any PR entries.
2. Shovels needs a free account or API key to test per case. That is outside this run's rules, so the owner must decide whether a free sign-up is acceptable for P1. Section 7.3 already budgets "Shovels (free)".
3. Recheck Zabalist in 4 weeks. It already shows a "Plan Review" status for Fort Worth and ingests Austin folderrsn cases, so it could start carrying `n8ck-xkda` at any time.
4. Drop any "early site-plan visibility" claim. Zabalist matches it at $0 to $49.
