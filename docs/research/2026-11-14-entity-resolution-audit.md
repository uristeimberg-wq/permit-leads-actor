# Entity-resolution audit, 200 firms (lane C, 2026-11-14)

How often does one contractor record hold two firms (a wrong merge), and how
often is one firm spread over two records (a split)? Measured on the live
database before contractors-v5, then re-measured for the v5 rules.

## Method

- `recon/identity_recon.js --audit` (workflow `identity-recon`, PR #68 run on
  2026-11-14). Read-only.
- Sample: 50 business entities with 2+ permits per market (Austin, Miami-Dade,
  City of Miami, Raleigh), ordered by `md5(id || 'lane-c')`, so the sample is
  fixed and re-drawable. 200 entities.
- For each: every raw spelling it holds, its phones, licence and registry
  links, and every other entity in the same state that shares a phone or its
  first two name words. People's names are masked in the output (rule 5).
- Judgement by hand on that output:
  - **Wrong merge:** the entity's spellings name two different firms.
  - **Split, exact:** another entity in the state has the same normalised name
    (flag T). Counted as the same firm.
  - **Split, near:** another entity is very likely the same firm under a
    variant name: a typo ("PLUMING"), a dropped word ("CONTRACTOR LLC"),
    singular/plural, an apostrophe, a name truncated by Miami-Dade at 37-38
    characters, or a suffix like "- Contr". Different brands or legal
    entities that only share a first word ("L & J ELECTRICAL" / "L & J
    CONSTRUCTION", "Foundation Pro NC ta Ram Jack" / "Foundation Solutions ta
    Ram Jack") are not counted.
- v5 effect: an exact split is joined when exactly one Sunbiz entity carries
  the name (flag J), computed against the 2026-10-07 quarterly file
  (12,987,601 records).

## Results

| Measure | contractors-v4 (live) | contractors-v5 |
| --- | --- | --- |
| Wrong merges | **0 of 200** (upper 95% bound 1.5%) | 0 of the 40 new joins on inspection: all are the same name after legal-form stripping |
| Exact-name splits (T) | 49 (24.5%) | 9 (4.5%): names Sunbiz holds more than once, or not at all |
| Near-name splits | 10 (5.0%) | 9 (4.5%): the apostrophe fix joins "Titan's Plumbing" / "Titans Plumbing" |
| **Entities with a likely twin** | **59 (29.5%)** | **18 (9.0%)** |

By market (v4): Austin 0 exact / 0 near; City of Miami 34 / 6; Miami-Dade
15 / 0; Raleigh 0 / 4. The split problem was almost all Florida, and it had
one cause: the City of Miami layer has no licence number, so its firms are
keyed by name, while Miami-Dade's are keyed by licence; and a firm holding two
licences became two records.

Registry links (not entity merges) with doubtful targets: 2 of 200. A
Miami-Dade licence whose DBPR holder has another business name ("TRANCOL
COMPANY" -> "MARVAL INTEGRATED SECURITY SYSTEMS"), and an Austin firm linked
to a TDLR licence by phone ("Premier Electric Contracting" -> "PREMIER
ELECTRICAL"). Both are shown with their match rule; neither changes the
entity.

## Whole-population effect of v5 (Florida)

- Florida business contractor names: 6,320. One Sunbiz entity: 4,588 (72.6%);
  one active of several: 840 (13.3%); several active: 97; none: 795 (12.6%).
- Rule 3 joins 2,010 Florida entities into 906: 1,104 fewer records (of 7,736),
  holding 9,388 permits.
- 127 contractors carried an Austin "*MAIN*" account mark; v5 strips it.

## What is left

Against the plan's target (wrong-merge ≤1%, split ≤3%): wrong merges pass on
this sample; splits are 9.0% after v5, so the target is not met. The rest:

1. Miami-Dade truncates `ContractorName` at 37-38 characters ("AMERICAN HOME
   BUILDERS OF SOUTH FLORID"). Joining a truncated name to the one full name
   it is a prefix of, within the same licence holder or Sunbiz entity, would
   fix about 3 of the 18.
2. Sunbiz names held by more than one entity (PYE-BARKER, AMADOR ROOFING,
   MEISNER ELECTRIC). The DBPR licence holder name could pick the entity.
3. Typos and singular/plural ("PLUMING", "SPRINKLER/S"). Not merged by
   design: a fuzzy rule needs its own audit before it ships.
4. Raleigh has no licence or registry key at all (its permit licence fields
   are 0.0% filled); see `2026-11-14-nc-contractor-licences.md`.

Re-run the sample after the first sync with v5 and Sunbiz loaded to measure
v5 on its own records rather than by simulation.
