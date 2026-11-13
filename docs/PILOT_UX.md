# Pilot UX: digest email, lead page, GC relationships

Status: **accepted for the pilot screens**, 2026-11-13. The static templates live in
`web/public/pilot/` (sample data only). This page records the rules the real
templates must keep when M3 wires them to data.

## Decisions

- Lead pages open from the email by a signed link, no login (like `/f/:token`).
- The new visual system applies to the pilot screens only. The prototype
  search UI keeps its look until M5.
- The pilot screens support both pitches under test: trade-gap leads and GC
  relationship intelligence (PR #6: 94% of Austin trade permits go to a sub the
  GC already used).

## Wording rules

| Say | Never say |
| --- | --- |
| No electrical permit filed yet | Nobody hired yet, you're first |
| Of permits that get an electrical permit (78%), the median files 34 days after | You have N days left |
| Phone from permit X, field `contractor_phone`, issued D | Direct line, business line (unless `party_kind = 'business'`) |
| Unverified / Corroborated / Verified (DATA_MODEL meanings only) | Verified for anything less than a human or vendor check |
| Value not published | $0 |
| Our sync is N days behind, on top of the source's 2–3 day delay | Live, real-time |

## Surfaces

**Email.** Subject `N <trade> leads · <market> · permits first seen <window>`.
Freshness line first. Leads 1–10 in full blocks: address and job, gap sentence,
contractor and phone with verification label and source permit, value and
status, reason, links, six one-click verdicts. Leads 11–25 as compact rows that
still carry source, label, reason and value. Footer: filters, CSV note,
feedback terms (no login, 30 days), attribution, correction, removal request,
unsubscribe. Production template: 600 px tables, inline CSS, no images, plain
text part.

**Lead page.** Header: address, gap tag, grouping basis, freshness. Left:
project timeline (median as a marker, not a range), building-permit record with
matched words highlighted, other trades on the project. Right: who to call with
full provenance and the GC's electrician rotation, relevance and data quality as
two separate itemized scores, feedback.

**GC relationships.** Segments: spreads work, new or small GC, changed
electrician, where competitors work. Thresholds in the template are proposals;
set them from the PR #6 distribution. Individual-looking companies are left out.

**States.** No contact, phone held for review (never rendered, not even
masked), inferred project link, gap closed after send, stale sync.

## Visual system (pilot screens)

IBM Plex Sans and Mono (email: Helvetica/Arial and system mono). Paper
`#F5F4F0`, surface `#FFFFFF`, ink `#17191C`, secondary `#5A5F66`, rule
`#D8D6CF`, link `#1D4B8F`, corroborated `#0D6B58`. One signal colour, `#A84A06`
on `#FBEEE2`, used only for the open gap. 2 px radii, hairline rules, tabular
figures; no shadows, gradients, emoji or KPI tiles.
