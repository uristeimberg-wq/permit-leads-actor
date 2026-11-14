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

## Precision of name- and phone-based links (2026-11-14, evening)

`recon/identity_recon.js --precision` on the live database (identity-recon
run 43638898914). These links are class C and hidden on screens (ADR-26); the
numbers say how far they could be trusted. Labelled by hand on fixed samples
(md5 order), plus two checks that need no judgement.

| Link | Links | Hand-labelled sample | Objective checks |
| --- | --- | --- | --- |
| Texas Comptroller, exact name, one taxpayer | 1,298 | 39 of 40 plausible. Doubtful: "M & C ELECTRIC Inc" (Taylor) -> a Dallas company from 1972 whose franchise tax ended | Registered after the contractor's last permit: 3 (0.2%). Registry address outside Texas: 56 (4.3%) |
| TDLR, phone | 831 | 29 of 30. Wrong: "Legacy Falls Development" on POWERTECH ELECTRIC's phone (a builder listing its electrician) | Licence expired before the last permit: 32 (3.9%) |
| TDLR, exact name | 735 | 28 of 30. Doubtful: generic names far apart ("Mitchell Electric" Austin -> Fort Davis; "White Construction" Austin -> Clinton) | |
| DBPR, exact name | 955 | 30 of 30 | Licence address outside Florida: 23 (2.4%), mostly typos ("MIAMI GA") |
| Sunbiz | 0 | Not yet linked in production: every Sunbiz run failed on the SFTP host key until PR #76 | |

Change made: a phone link now also needs the two names to share a distinctive
word or initials (`namesCompatible`, `src/enrichment/licences.js`). It drops
the builder-on-electrician's-phone case and keeps "Pearson Mechanical" ->
"PEARSON AIR CONSTRUCTION" and "Electrical Panel Xperts" -> "EPX ENERGY".
Against all 831 live phone links, a first version flagged 106 (12.8%); about
a third of those were the same firm spelled differently ("M&G" / "M & G",
"MLJ" / "M L J"), so the rule now joins single letters and compares the
names whole before looking for a shared word. The rest are other firms on the
same number: builders and solar installers listing their electrician
("Security Solar" on FACILITY INNOVATIONS GROUP's phone, "Triangle Electrical"
on PROTO ELECTRIC's). With the refined rule, 57 of 831 live phone links
(6.9%) are dropped (identity-recon run 43640776098). By hand, 33 of the first
40 dropped are another firm; about 7 are the same firm with a typo or a
second trading name ("POWER ENTERPRIZES", "AUSTIN ELECTRIC SERV"), which we
now lose. Net: roughly 1 phone link in 17 pointed at another firm, which the
sample of 30 had under-counted.

What official keys can and cannot do here:

- Austin publishes no contractor licence or registry number, so no Texas link
  can rest on an official key. Raising the Comptroller match rate (it grows by
  about 500 names a night as the backlog is worked) does not change what
  screens show under ADR-26.
- City of Miami publishes no licence number either, so the Florida splits
  that remain (9.0%) can only be closed by name rules. Those would be class C,
  so the 3% split target is not pursued by adding name merges.
