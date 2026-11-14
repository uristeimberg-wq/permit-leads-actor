# North Carolina contractor licence sources (lane C, 2026-11-14)

Goal: tie Raleigh contractor businesses to a state licence or registry key
(plan target NC ≥50% legal-entity anchoring; today 0%). Lawful sources only:
no scraping of a site that disallows it, no paid list without the owner's go.

## What we already receive

Raleigh's permit layers have `contractorlicnum` (mapped as the licence key)
and `statelicnum` columns, but they are empty: 1 of 31,082 permits has either
(`recon/identity_recon.js --audit`, 2026-11-14). So an NC roster has to be
matched by business name, as Texas licences are, and it should carry the
business name, licence number, classification, status and city.

## Boards and what each offers

| Board | Licences | Bulk data | Price | Automated lookup | Notes |
| --- | --- | --- | --- | --- | --- |
| NC Licensing Board for General Contractors (nclbgc.org) | General contractors (building, residential, highway, public utilities, specialty) | No download found. Not readable by our fetcher: robots.txt disallows it | n/a | Web lookup only; robots.txt disallows automated fetching | Third parties sell scrapers of its lookup (Apify listings). We do not use them (CLAUDE.md rule 4). A records request under the NC Public Records Act (G.S. ch. 132; copies at actual cost) is the lawful path |
| NC State Board of Examiners of Electrical Contractors (ncbeec.org) | Electrical contractors | "Licensee Listing (.csv file) ... $50.00" (fees page, read 2026-11-14) | $50 per file | Web search at arls-public.ncbeec.org | Columns not published; phone unknown until bought |
| NC State Board of Examiners of Plumbing, Heating and Fire Sprinkler Contractors (nclicensing.org) | Plumbing, heating (HVAC), fire sprinkler | "Request Register of Licensees" order form (public.nclicensing.org/PUBLIC/RequestRoster) with classification, status and county filters | Not shown before ordering | Web lookup | Format and columns not shown |
| NC Secretary of State, business registrations | Legal entities (the Sunbiz/Comptroller equivalent) | Bulk data product; price not checked | Unknown | n/a | Would give entity keys like Sunbiz does for Florida |

## Recommendation

1. Free first: send the NCLBGC a public-records request for its licensee
   roster (business name, licence number, classification, status, city). It is
   a message outside the project, so it needs the owner's go.
2. Buy the NCBEEC licensee CSV ($50, one-off) to cover electrical
   contractors, once the owner approves the spend.
3. Ask the plumbing/HVAC board for the roster price before ordering.
4. Price the NC Secretary of State bulk file before committing to it.

None of these are connected. Each needs a `docs/DATA_SOURCES.md` entry, a
fixture and a terms row in `docs/COMPLIANCE.md` before it is loaded (rule 10).
