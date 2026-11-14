# Fidelity check: how accurate is what we store? (2026-11-14)

Measured, not estimated. On 2026-11-14 at 20:17 UTC we drew a fixed random
sample from each pilot source: up to 150 filings dated in the last 30 days and
150 older ones. Each was re-fetched by its permit number from the live public
API and compared field by field with what we store. Run: workflow `fidelity`,
run 43636656233 (PR #81), `recon/fidelity_check.js --per-stratum=150`, seed
2026-11-14. The check is read-only.

## How to read this

- **Match** counts only the records where our value or the source's value is
  non-empty. Two empty values are not a check.
- **95% CI** is a Wilson interval. "100%, 98.7-100%" on 300 checks means the
  true error rate is below 1.3%, not that it is zero.
- This measures **fidelity**: does our copy equal the source's current record?
  It does not measure whether the source itself is right (truth), or whether
  our joins are right (parcel, contractor entity, trade links). Those are
  separate checks, listed under "Not checked".
- **Edit and delete rates are a floor.** Every source was first loaded on
  2026-11-13. So "since our last fetch" means about one day of exposure. The
  "older" stratum is old by filing date, not by how long ago we fetched it.

## Results per source

| Source | Sampled | Gone from the source | Substantive edit since our fetch | Edit the next sync would miss | Any stored field wrong |
|---|---|---|---|---|---|
| Austin permits | 300 | 0 (0-1.3%) | 0 | 0 | 108 of 300 (all `permit_url`, older stratum) |
| Austin plan review | 300 | 0 (0-1.3%) | 0 | 0 | 0 |
| Miami-Dade | 300 | 0 (0-1.3%) | 0 | 0 | 0 |
| City of Miami | 189 (only 39 older rows exist) | 0 (0-2.0%) | 4 (2.1%) | 2 of the 39 older (5.1%) | 4 (2.1%) |
| Raleigh | 300 | 0 (0-1.3%) | 0 | 0 | 0 |

## Per-field match, by market (compared / match)

| Field | Austin permits | Austin plan review | Miami-Dade | City of Miami | Raleigh |
|---|---|---|---|---|---|
| permit_type | 300 / 100% | 300 / 100% | 300 / 100% | 189 / 100% | 300 / 100% |
| work_description | 300 / 100% | 300 / 100% | 297 / 100% | 189 / 100% | 299 / 100% |
| valuation | 77 / 100% | 127 / 100% | 288 / 100% | 173 / 100% | 53 / 100% |
| status_raw | 300 / 100% | 300 / 100% | 300 / 100% | 189 / **98.4%** (3 wrong) | 300 / 100% |
| lifecycle_stage | 300 / 100% | 300 / 100% | 300 / 100% | 189 / **98.4%** (3 wrong) | 300 / 100% |
| filed_date | 300 / 100% | 300 / 100% | 300 / 100% | 189 / 100% | 275 / 100% |
| submitted_on | 300 / 100% | 300 / 100% | not published | not published | 59 / 100% |
| stage_since | 300 / 100% | 300 / 100% | not published | not published | not published |
| address | 300 / 100% | 299 / 100% | 299 / 100% | 189 / 100% | 300 / 100% |
| zip | 300 / 100% | not mapped | 1 / 100% (not mapped) | not mapped | 300 / 100% |
| contractor_name | 276 / 100% | n/a | 300 / 100% | 177 / **99.4%** (1 wrong) | 278 / 100% |
| contractor_phone | 274 / 100% | n/a | 253 / 100% | not published | 248 / 100% |
| contractor_licence | not published | n/a | 253 / 100% | not published | not published |
| permit_url | 300 / **64.0%** (108 wrong) | 300 / 100% | not mapped | not mapped | not mapped |

## The three defects found

1. **Austin official-record links are broken on 36% of permits (108 of 300;
   all 108 in the older stratum, 72% of it).** We store the literal JSON
   `{"url":"https://abc.austintexas.gov/..."}` instead of the URL. Today's code
   maps the same raw row correctly (pipeline mismatch 108 of 108), so these are
   rows written before the `urlOf` fix and never rewritten. The fix is a
   re-map of stored rows from their raw records, with no re-fetch. **Not done:
   measurement only, per the owner's 2026-11-14 course correction.**
2. **City of Miami status goes stale outside the sync window.** 3 of 189
   sampled permits show "Active" while the City now says "Final" (the source
   edited `BuildingPermitStatusDescription`, `IsPermitFinal`, `Statusdate`). 2
   of the 3 are older permits whose dates fall outside every sync window, so
   the nightly sync will never correct them. That is 2 of the 39 older permits
   (5.1%, CI 1.4-16.9%) in about one day. This is the re-read gap, measured.
3. **City of Miami contractor name changed at source** on 1 of 177 (`CompanyName`).
   It was inside the window, so the next sync corrects it.

No sampled record was missing from its source (0 of 1,389), so no deletions
were seen in one day. With about one day of exposure, that is weak evidence.

## Classification of every field (owner's five classes)

| Field | Class | Evidence |
|---|---|---|
| Permit number, type, description, address, filed date, value as published | **Verified source fact** | Matches the live record on 100% of non-empty checks in every market (CI lower bounds 93-98.7%, depending on n) |
| Status as published (`status_raw`) | **Verified source fact**, but **stale in City of Miami** for old permits | 98.4% in City of Miami; 100% elsewhere |
| Contractor name, phone, licence as written on the permit | **Verified source fact** (as filed; not checked against the firm) | 100% where published; City of Miami 99.4% |
| Austin official record link (`permit_url`) | **Verified source fact** on 64% of rows; **broken on 36%** | Defect 1 |
| Lifecycle stage | **Inferred** (our mapping of the city's words; Miami-Dade derives it from dates) | Mapping reproduces 100%, but the mapping itself is our rule |
| Property facts from appraisers by official parcel key | **Cross-source verified** (join on official key) | Fidelity of appraiser values not measured in this run |
| State licence record matched by licence number | **Cross-source verified** | Not measured in this run |
| Contractor as one business across spellings and licences | **Inferred** | 0 wrong merges in 200, 9.0% splits (entity audit, 2026-11-14) |
| GC-sub links, building-to-trade links | **Inferred** (Austin and Miami: official job key, but the pairing is ours); Raleigh by parcel: **unverified** | Not measured |
| Trade scores, likely-issued windows, momentum | **Inferred** | Hidden since ADR-26; not measured |
| Phone answers and reaches the business | **Unverified** | Never checked |
| Fees; ZIP in Miami-Dade, City of Miami and plan review; official link in Miami-Dade, City of Miami and Raleigh; licence number in Austin, City of Miami and Raleigh; phone in City of Miami | **Unavailable** to us today (not published, or published and not mapped) | Fill rates in `docs/research/2026-11-14-data-engine/audit.md` |

## Not checked (do not count as passed)

- Whether the sources themselves are true, for example a declared value or a contractor name that is wrong on the city's own record.
- Join accuracy: parcel links, contractor entity merges (beyond the 200-firm audit), building-to-trade links, GC-sub pairs, duplicates. This needs a labelled sample checked against the official pages; it is not done.
- Appraiser and licence-registry values against their live sources.
- Edit and delete rates over more than about a day. Re-run this check weekly for a month to measure them properly.

## Recommendations (not done; measurement only)

1. Re-map stored Austin rows from their raw records to repair the 36% broken record links.
2. Close the re-read gap: a periodic full re-read per source, so status changes on old permits (City of Miami 5.1% in a day) and any deletions reach us.
3. Fill the cheap gaps from data we already receive: ZIP for both Miami feeds, official record links for Miami-Dade, City of Miami and Raleigh, and fees where published.
4. Re-run this check weekly. Persist its results to the scorecard, so the numbers are tracked rather than read from logs.
