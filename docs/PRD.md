# Product requirements (v1 pilot)

Status: **proposed**, 2026-11-13.

## Vision

Turn public permit records into a short weekly list of construction jobs a
specific trade business can still win, with the right business to contact and
the evidence behind each pick.

## Target users (v1)

| Segment | Sells to | v1? |
| --- | --- | --- |
| Specialty subcontractors (electrical, HVAC, plumbing, roofing, drywall, insulation, low-voltage) | GCs named on permits | **Primary** |
| Suppliers and distributors | Contractors | Secondary: 3 to 5 discovery conversations |
| Home-service sellers to homeowners (roofing, solar, pools, windows) | Homeowners | **Second track** (ADR-10): built into the data model, delivered after the compliance gate |

## Problems

1. Finding new jobs means checking several government portals by hand. Those
   portals weren't built for this.
2. By the time a sub hears about a job, the trade is often already chosen.
3. Raw permits are noisy: most are irrelevant to any one trade, and many name
   the owner rather than a business.

## Core workflow (v1)

**Weekly email**, then **open the lead**, then **call the GC**, then **click
feedback**, then **answer the check-in.**

## Functional requirements

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| F1 | Daily sync of each enabled source | Every enabled source has a successful `sync_run` each day by 08:00 local time, or an alert has fired |
| F2 | Late and updated records are captured | A permit first published 10 days after issue appears in the next digest as new |
| F3 | No duplicates | 30 re-runs of the same window add 0 permits, 0 versions and 0 digest items |
| F4 | Trade classification with reasons | Every lead lists at least one rule and the evidence that matched |
| F5 | Personalized digest | Filters by trade, area and minimum value. 10 to 25 leads. Never repeats a lead to the same subscription |
| F6 | Contact shown with provenance | Each phone shows its source permit and date. Unverified is labelled. A missing contact says "no contact on record" |
| F7 | One-click feedback | Six verdicts, recorded without login, through a signed link valid for 30 days |
| F8 | Outcome check-in | Weekly 2-question email. Answers stored as self-reported |
| F9 | Human review before send (pilot) | A digest cannot be sent until an admin marks it reviewed |
| F10 | Admin source health | Per source: last attempt, last success, counts, lag, coverage, alerts |
| F11 | Suppression | A suppressed phone or name never appears in a digest, the API or an export |

## Non-functional requirements

These are the performance and security targets in ARCHITECTURE.md sections
13 and 16, plus:

- No secrets in the client.
- No individual contact shown by default.
- Every displayed value traceable to a raw record.

## Success metrics (pilot)

| Metric | Target | Type |
| --- | --- | --- |
| Feedback rate on delivered leads | 60% or more | Measured |
| Share of leads marked "relevant" | 40% or more | Measured |
| Partners reporting at least one call per week | 2 or more of 5 | Self-reported |
| Partners reporting a quote or win within 4 weeks | 1 or more | Self-reported |
| Agreement to a paid pre-commitment | 2 or more | Measured |

## Out of scope for v1

Billing, public sign-up, the partner-facing pipeline/CRM, the map-first UI,
the AI assistant, CRM integrations, homeowner contact delivery (until the
ADR-10 gate passes), and more than two markets.
