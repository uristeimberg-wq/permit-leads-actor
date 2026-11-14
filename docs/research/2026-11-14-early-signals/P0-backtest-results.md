# P0 backtest results: what came before Austin's new buildings (2019-2024)

- **Run:** 2026-11-14, `feasibility` workflow input `backtest=yes`, run
  [43575063372](https://github.com/Yuval-Steimberg/permits/actions/runs/43575063372)
  (`recon/early_backtest.js`, 23 requests, read-only, nothing stored).
- **Rows:** 9,396 planning cases (site plan `mavg-96ck`, zoning `edir-dcnf`,
  subdivision `s7gx-9m54`, filed 2017-01 to 2024-10), 143,738 plan-review
  cases (`n8ck-xkda`), 74,412 new and demolition BPs (`3syk-w9eu`, applied
  2013-06 to 2024-12).
- **Outcome:** a *new main-building* BP (census classes 101-105, 213-214,
  318-328). Dumpsters, carports and other structures (329), remodels and
  additions do not count.
- **Caveats:** statuses are current values, so no status is used as a
  predictor. Parcel links under-count where lots are replatted (subdivisions
  especially). 279 campus parcels (>5 cases or >20 main BPs) are excluded from
  parcel and spatial links. "Spatial" (75 m) is inferred and shown only as
  context. The affordable-housing inventory (`ifzc-3xz8`) has no filing dates,
  so it is not in this backtest.

## 1. Pre-application capture: did a planning record exist before the building application?

New main BPs applied 2020-2024; a planning signal (site plan, zoning,
subdivision; not ROW or utility site plans) on the same city property id,
parcel or cited case number, 1 to 1,095 days before the BP application.

| Segment | New main BPs | Earlier planning signal | 95% CI | Median lead over the application | Any earlier signal incl. demolition | Median lead (any) |
| --- | --- | --- | --- | --- | --- | --- |
| Single-family (101-102) | 14,836 | **7.3%** | 6.9-7.7 | 768 d | 25.7% | 119 d |
| Small multifamily (103-104) | 574 | 22.3% | 19.1-25.9 | 433 d | 47.6% | 236 d |
| **Multifamily 5+ (105)** | 1,151 | **91.9%** | 90.2-93.4 | **363 d** | 92.4% | 369 d |
| **Commercial (213-214, 318-328)** | 1,164 | **80.3%** | 77.9-82.5 | **385 d** | 82.0% | 414 d |
| All | 17,725 | 18.1% | 17.5-18.7 | 504 d | 34.5% | 249 d |

Which signal carried it: for multifamily, a building site plan was on record
first for 88.7% of BPs (approved rezoning 20.4%, subdivision 25.3%); for
commercial, a site plan for 74.1%. For single-family, a residential
demolition came first for 19.3% and a site plan for only 4.8%.

## 2. Conversion: how often a signal is followed by a new main BP

Official links (cited case number, city property id or parcel); placebo = the
same link for the 24 months starting five years earlier.

| Signal (filed 2019-01 to 2024-10) | n | 6 mo | 12 mo | 24 mo | 95% CI | Placebo | Lift | Median lead |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Residential demolition | 3,669 | 62.3% | 68.5% | **72.3%** | 70.9-73.8 | 0.4% | 166 | 47 d |
| Commercial / other demolition | 1,750 | 31.8% | 35.6% | 38.4% | 36.1-40.7 | 1.2% | 32 | 50 d |
| Site plan, building | 2,633 | 6.6% | 15.9% | **22.0%** | 20.5-23.7 | 1.7% | 13 | 258 d |
| Site plan, extension or revision | 409 | 6.1% | 9.5% | 13.2% | 10.3-16.8 | 10.5% | 1.3 | 219 d |
| Site plan, ROW / utility | 498 | 2.6% | 6.6% | 8.6% | 6.5-11.4 | 1.2% | 7 | 265 d |
| Rezoning, approved | 530 | 3.0% | 8.1% | 15.3% | 12.5-18.6 | 1.5% | 10 | 342 d |
| Rezoning, not approved | 312 | 0.6% | 2.6% | 5.8% | 3.7-8.9 | 0.3% | 18 | 398 d |
| Zoning, other case types | 474 | 1.5% | 5.5% | 10.1% | 7.7-13.2 | 1.3% | 8 | 360 d |
| Subdivision, final plat etc. | 1,822 | 3.1% | 7.1% | 11.1% | 9.8-12.7 | 0.9% | 13 | 299 d |
| Subdivision, preliminary | 227 | 0.4% | 0.9% | 3.1% | 1.5-6.2 | 0% | | 486 d |

- For **49.5%** of residential demolitions that converted, the new building's
  application came **before** the demolition permit was issued (64.1% for
  commercial). Seen from the issued-permit feed, a demolition is usually not
  early; seen as an application, it is weeks early.
- Site plans: only 22% are followed by a *new main building* on the same
  property within 24 months. Some of the rest are parking lots, additions or
  change-of-use plans (no new building by design), some expire, some build on
  a different parcel id.
- Subdivisions: the low rates mostly reflect the join, not the projects:
  houses are permitted on new lot ids after the plat records. They need the
  plat-name or spatial-polygon link before they can be scored.

## 3. Link quality (new main BPs applied 2019-2024, n = 22,937)

- Parcel id 99.0%; `masterpermitnum` 99.9%, and **100%** of those resolve to a
  plan-review folder; the city property id (`propertyrsn`) is therefore
  available for 99.9% of new main BPs.
- A case number is cited in the description on only 5.0% (single-family 5.6%,
  multifamily 1.3%, commercial 1.7%). Citations are a minor link; the city
  property id is the main official one.
- 463 parents have more than 5 child BPs (umbrella folders: campuses, events,
  subdivisions).

## 4. Against the pass criteria (DATA_STRATEGY section 8)

| # | Check | Result | Verdict |
| --- | --- | --- | --- |
| 1 | Pre-application capture, multifamily + commercial, at least 30%, median lead at least 120 d | 91.9% and 80.3%; median 363 d and 385 d | **Pass** |
| 2 | Building site plans reaching a main BP within 24 months, at least 50% | 22.0% (CI 20.5-23.7) | **Fail** |
| 3-5 | Forward list, competitor check, design partners | Not run yet (P1, P2) | Open |

## 5. What it means

1. **The months-early window exists, but almost only for multifamily and
   commercial.** Nine in ten Austin multifamily buildings and eight in ten
   commercial buildings had a site plan on file about a year before the
   building application. That is the segment Dodge, ConstructConnect and
   Zabalist already cover with site plans.
2. **For single-family (84% of new main BPs), planning records see 7%.** The
   realistic early window there is the plan-review period (median 63 days
   before issue) plus demolitions (19% of new homes, median lead 47 days over
   the demolition application).
3. **A site plan is not a project forecast.** 22% become a new main building
   within two years. Any L2 screen must carry that measured rate, and the
   product cannot call a site plan "upcoming construction".
4. **The city property id is the backbone.** It resolves for 99.9% of new main
   BPs through plan review, so planning-to-permit links can be official for
   most projects; parcel-only links are the fallback.
5. Approved rezonings (15.3%, lift 10) just reach the proposed L3 floor on the
   point estimate but not on the lower bound; unapproved rezonings, preliminary
   plats and site-plan extensions do not.
