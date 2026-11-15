# Inspections, reviews and demolition notices: scan, 2026-11-15

Thread "Add inspections, reviews and demolition notices". Read-only probes in
GitHub Actions (`recon/lifecycle_scan.js`, feasibility.yml input
`lifecycle`, runs 43682343417, 43682754960, 43683238897, 43683384836,
43683655988). Nothing was downloaded past robots.txt and landing pages for
the portals.

## What a competitor brief claimed, checked against our own study

The brief's claims about Shovels were checked against our Shovels study
(2026-11-14, our own read of their public docs; not measured):

- "Biweekly batch updates": consistent with our study (twice-monthly refresh).
- "Hundreds of clean trade tags": our study counted 23 tags with a claimed
  98% accuracy. The brief overstates it.
- "Decisions" pre-permit product: our study saw only that they are adding
  planning signals; the product name and its coverage are unverified.
- "200M+ records, 2,800+ jurisdictions, SOC 2": not checked; their own
  marketing figures.

## Built (connected, nothing displayed)

| Source | Rows | Window | Key | Link to our permits | Link precision |
|---|---|---|---|---|---|
| Miami-Dade `inspectionsData` | 8,366 (4,984 distinct) | ~1 week + next day | permit + sequence + request date + input order + inspector id (day-to-day stability unverified) | 278/300 numbers (92.7%) | 142/150 same address; links also need the house number |
| Raleigh `Inspection_Schedule_Public/1` | 2,074 | last 2 working days | EnerGov `IMInspectionID` (unique) | 240/300 (80%); 100% on the building/trade prefixes we hold | 149/150 same address; same house-number guard |

Both windows are short: a day not read is lost, so the value is the history
we keep from now on (`inspection_result_history`). Raleigh's housing-code
and nuisance inspections are filtered out at the source (rule 5).

## Not found or not usable

- **Austin inspections:** not published as open data. The AMANDA citizen
  portal shows a CAPTCHA marker. Not automated (rule 4).
- **City of Miami inspections:** not in its ArcGIS org.
- **Plan-review cycles and comments:** no open source in the four markets.
  The status changes we can see are already kept (`permit_status_history`,
  `planning_case_status_history`).
- **Demolition and asbestos notices:** no open dataset in TX, FL or NC.
  Texas notices go to DSHS (not TCEQ), 10 working days ahead, for every
  demolition; records only by Public Information Act request. NC DHHS's
  asbestos pages disallow automated reads in robots.txt. Florida unverified.
  A records request to DSHS is the only lawful route in Texas; it needs the
  owner's go (it is a message sent outside the project).
- **Right of way and street cuts:** Austin publishes weekly totals only and
  boundary polygons; Roadway Work Zones (excavation permits) was already
  listed on 2026-11-14 and is not connected. Raleigh right-of-way occupancy
  comes ~105 days after the building permit (2026-11-14). Raleigh utility
  cuts: 5 rows, stale since 2022.

## Probes only (not built), as asked

**Permit-portal PDF attachments.** Not lawful to automate in our markets as
checked: Austin's AMANDA portal shows a CAPTCHA marker; Raleigh's portal
(`permitportal.raleighnc.gov`) answered 403 to an automated request; City of
Miami iBuild and Raleigh EnerGov did not answer from Actions. Miami-Dade's
sites have no robots.txt, but its document viewers were not probed and its
user agreement grants no licence. Recommendation: do not build; if wanted,
ask each department for bulk access.

**Secretary of State owner-LLC lookups.** Texas SOSDirect is a paid login
(and its robots.txt blocks major crawlers; the www site shows a CAPTCHA
marker): not automated. Florida: we already hold Sunbiz's public SFTP files;
the officer and agent fields are people's names, which rule 5 stores but
never shows, so "unmasking" the principals behind an LLC is the gated
homeowner/individual track (ADR-10), not B2B. North Carolina SOS has no
robots.txt; its terms and any bulk file were not read. Recommendation: do
not build until the owner decides whether principal names are ever shown;
the Texas Comptroller franchise-tax API (already connected) is the lawful
Texas path for entity facts.
