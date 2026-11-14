# Data trust audit: what the app shows, and how sure we are

Date: 2026-11-14. Scope: every value and label on the pilot screens
(`web/public/pilot/live/`), the permit search (`/search.html`) and the
`/api/pilot/*` responses behind them. Owner's rule (2026-11-14): the product
shows only what is certain. Reliability beats coverage, and nothing is added to
the automatic pull until it is verified.

## The three classes

| Class | Meaning | Rule |
|---|---|---|
| **A. Recorded fact** | A value as an official source published it, with its raw record | Show, with source and provenance |
| **B. Deterministic count** | Arithmetic over class A values on an official key (permit number, licence number, parcel id) | Show, with the count's denominator and the key used |
| **C. Inference** | Anything that rests on a heuristic, a fuzzy or name-only join, a threshold we chose, or a prediction | Keep computing; do not show by default |

A count is only as good as the join under it. A count over a class C join is
class C, even if the arithmetic is exact.

## Classification

### Class A: recorded facts (keep)

| Value | Where | Source key |
|---|---|---|
| Permit number, type, address, ZIP, description as filed | all screens | raw record |
| Status as published (`status_raw`) | job, search | raw record |
| Issue date, application date (city's own) | job, early filings, overview | raw record |
| Declared value, with "N of M publish a value" | overview, job, digest | raw record |
| Contractor name as written on the permit | all screens | raw record |
| Phone as written on the permit | job, GCs, overview, digest | raw record (number of permits carrying it shown) |
| Licence number on the permit | contractor | raw record |
| Map point published with the permit (City of Miami) | job | raw record |
| Appraiser facts matched by parcel id / folio / TCAD id (land use, year built, area, lot, assessed value band) | job | official key |
| State licence record matched by the permit's own licence number | job, contractor | official key |
| Linked application (Austin plan review to issued permit) by the city's own reference | job | official reference |
| Last sync, publication lag, history range | every screen | our sync log |
| Weekly counts, building/trade split, top ZIPs | overview | counts of class A rows |

### Class B: deterministic counts on official keys (keep, with the key named)

| Value | Key | Note |
|---|---|---|
| Trade permits on a job (Austin, Miami-Dade, City of Miami) | base / master permit number / application number | official job key |
| Subs on a GC's past jobs, repeat-hire rate, "top one's share" | same | history only; says nothing about the next job |
| "Different sub on latest job" (was "Changed sub recently") | same | fixed rule: 3+ earlier jobs, one sub on 75%+ |
| "Spreads work" | same | fixed rule: 2+ subs, top share under 60% |
| "No trade permit on record" | same | absence in the source. Never means "no sub hired"; Miami-Dade and City of Miami publish issued permits only |
| Phone "on 3+ permits" (was "corroborated") | contractor id | count of permits carrying the number, none shared with another company |
| Early filings stage counts | city's status wording, mapped in code; unmapped statuses are excluded | |

### Class C: inferences (hidden since ADR-26 unless `SHOW_INFERENCES=1`)

| Value | Screen | Why it is not certain | Proposal |
|---|---|---|---|
| **"Likely issued" date range** (ADR-21) | Early filings | Prediction from last year's permits | Hide; keep computed |
| **Trade timing "N% likely · date range"** (ADR-21) | Job | Prediction | Hide; keep computed |
| **Builder momentum trend: rising / slowing / new** (ADR-21) | Momentum | Our label on counts; "new to market" really means "first permit in the history we hold", not first permit ever | Done: the two counts and their difference stay, no label |
| **Trade fit score and the digest ranking** (ADR-17) | Job, digest, search | Keyword/permit-type rules we wrote | Hide the number; sort the digest by issue date |
| **"Builder" / "Permit expediter" role tag** (ADR-19) | Early filings, momentum | Heuristic on filing counts and name words | Show the name as filed, no role |
| **Builder's past subs on an early filing** | Early filings | Depends on the role tag above | Hide with it |
| **Street View photo, "likely / probably the job site"** (ADR-24) | Job | Camera-distance heuristic | Hide by default |
| **Licence or registration matched by business name or by phone** (`name_state` 0.80, `name_state_active` 0.75, `phone` 0.90) | Job, contractor | Not an official key | Show only `licence`-number matches |
| **State business registration panel** (Texas Comptroller, PR #64; Florida Sunbiz, ADR-25) | Job, contractor | Linked by exact normalized business name within the state (`name_state` 0.80; Sunbiz `name_state_active` 0.75). Prefix-only lookups are stored as candidates and never linked | Hide the panel until a shared official key (SOS file or licence number) links it |
| **Census geocoded map point** | Job | Interpolated along the street | Already labelled "approximate"; keep the label or hide the point |
| **Raleigh job links by parcel PIN** | Job, GCs, overview (Raleigh) | A parcel holds many jobs over the years; PIN is not a job key (72-85% match, PR #21) | Hide Raleigh GC-sub relationships and trade-on-job until a real job key is found |
| **Raleigh development-plan links** (`parcel_window`, confidence 0.6) | Not shown today | Parcel + 3-year window | Keep unshown |
| **Contractor merged by exact name within a state** (`name_state`, 0.80) and **Florida legal-entity joins** (ADR-25, 0.85) | Every contractor count | Same name is strong but not an official key; prototype rule was "offer near-matches, never merge" | Keep (counts break without it) but say on each contractor page which rule merged it; review ADR-25 separately |
| **Property field conflicts** (`field_conflicts`) | Not shown today | Comparison rules we chose | Keep unshown |
| **Site-plan "92% / 80% a year before" context line** | Early filings | Research statistic, not about this filing | Move to docs; drop from the screen |

## Sync-side items held in PR #77

| Item | Join | Class | Verdict |
|---|---|---|---|
| Austin parcel points | permit `tcad_id` = parcel id (official key); ambiguous ids skipped | A, as the parcel's point, not the building's | Passes; keep the "Map point of the appraiser parcel" label |
| Travis CAD lot size | same key | A | Passes |
| fields-v3 conflict rule | comparison rule, not displayed | C, internal only | Passes as long as conflicts stay off the screens |

## Wording that implied intent (fixed in this PR)

The app never knows whether a GC is looking for a sub. These labels said or
implied it, and were changed:

| Before | After |
|---|---|
| "See which GCs hire new subs" / "Which GCs hire new electricians" | "Which subs each GC has used" |
| "The GCs below are where that is less true: they spread work, switched recently, or have jobs with no permit yet" | "Counts, for each GC, the subs on its past permits... does not say whether a GC is looking for a sub now" |
| "Changed sub recently" / "It is a reason to call" | "Different sub on latest job" / "a fact about past permits, not a sign the GC is looking for someone" |
| "N electrical leads", "Open lead", "Call the contractor named on the permit" | "N building permits with no electrical permit on record", "Open permit" |
| "Who to call" | "Contractor on the permit" |
| "How this GC hires electricians" | "Electricians on this GC's past permits" |
| "No trade permit yet" | "No trade permit on record" |
| Phone pill "corroborated" / "unverified" | "on 3+ permits" / "on N permits" / "shared number" |
| Tour: "turned into leads... who to call" | "organised for subcontractors... the business on each permit and its phone as published" |

## Where we diverged from the first prototype

The prototype (`uristeimberg-wq/permit-leads-actor`, README) was a permit
search with these rules. Status today:

| Prototype rule | Today |
|---|---|
| Show permits as published; no estimates anywhere | ADR-21 added three estimates (issue window, trade timing, momentum) |
| "Near-matches are offered, never merged" (no stable contractor id) | Exact-name merges within a state, and Florida legal-entity joins (ADR-25) |
| Trade rules were left weak "for a human rather than guessed" | Trade fit scores now rank the digest (ADR-17) |
| A map pin is "N permits in this area", never "a permit at this point" | Job pages show a point; Census points are labelled approximate |
| Product framed as search ("browse the latest permits") | Framed as "leads" and "who to call", implying an open job (fixed above) |
| Unknown status stays `unknown`, never folded | Still true (lifecycle vocab; unmapped statuses excluded) |
| `OWNER` is not a company; values state their denominator | Still true |
| Washington County CAPTCHA = off | Still true (rule 4) |

## What is not decided here

Which market the data serves (subs, GCs, suppliers, insurance agents) and when
in the permit process each one cares is a separate question. The class A and B
data above is the same for all of them; the class C items are where the choice
of buyer would change what is worth computing.
