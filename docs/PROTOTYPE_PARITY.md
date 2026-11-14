# Prototype parity: the original README against the live app

Audited 2026-11-14 against `main` at 83c2338, by reading the code and running
the app on the layout-check sample data. Production was not queried (the
container cannot reach Neon or Railway), so anything about production data is
inferred from code and committed files and is marked as such.

All prototype features live on the search screen (`/search.html`, "Permit
search" in the pilot nav). The pilot screens (`/pilot/live/`) are newer and
richer per job and per contractor, but have no free search.

| Prototype feature | State | Note |
|---|---|---|
| Stage filter (pending / approved / finished / cancelled / unknown), default pending + approved | Present | `status_stage`. The richer `lifecycle_stage` (ADR-16) is not used by search yet |
| Unknown statuses reported, never folded into a stage | Present | `ingest/lifecycle.js` prints unmapped statuses per run |
| Stage counts that ignore only the stage filter | Present | `facets.stages` |
| Filters in the URL | Present | |
| Location picker from covered areas only | **Was partial, fixed in this PR** | ZIPs were offered only if `data/area-coords.json` had them: no North Carolina entries, so no Raleigh ZIPs (from the file, not a production query) |
| Uncovered-area vs no-results message | Present | ZIP only |
| Freshness badge with per-source breakdown | Partial | Reads the prototype `ingest_runs`; no publication lag per source (rule 7) |
| Contractor history, owner-builder exclusion | Present | Name-keyed; does not link to the resolved contractor profile (`contractor.html?id=`) |
| Near-match spellings offered, not merged | Present | |
| Declared value with its denominator | Present | |
| `hasContact` filter | Present | |
| Map: counts follow filters, unplaced counted | **Was partial, fixed in this PR** | Raleigh and all Miami-Dade municipalities except Miami and Homestead had no centroid, so their pins were dropped as "not shown" (from the file, not a production query) |
| Map: screen-space clustering, search this area, use my location | Present | |
| Map: real job sites | **New in this PR** | Zoom 14+ draws located permits, each labelled source / parcel / Census |
| List / split / map layout, mobile bottom sheets | Present | In the layout check |
| Permit detail panel | Partial | No property, licence, location or lifecycle panels; the job page has them |
| Top navigation to the other screens | Missing | The search header has no nav |
| Trade scoring | Broken | See the scoring proposal; not changed without the owner's approval |

Not ported, on purpose:

- **Oregon Accela scrapers** (Clackamas, Oregon statewide): about 7 s per
  permit, no contractor name or phone, not a pilot market, and their terms are
  not reviewed in `docs/COMPLIANCE.md`. They stay runnable by hand
  (`--area=clackamas-county-or`) and out of the sync.
- **Washington County, OR**: CAPTCHA-gated (rule 4).
- **Philadelphia**: commercial use prohibited without written permission.
- **Portland, Clark County**: unverified field maps; adapters refuse to run.
