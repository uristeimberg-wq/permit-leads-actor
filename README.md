# Permit Search

A searchable platform for recent municipal building permits: enter a postal code
(or pick a city/jurisdiction), apply filters, and browse the latest permits in
that area.

```
scrapers          ->  ingest        ->  Postgres  ->  API + UI
src/adapters/*        ingest/run.js     db/           web/
```

## Quick start

```bash
npm install
npx playwright install chromium   # the Accela adapter drives a real browser
npm run db:up                     # Postgres on :5433 (5432 is left alone)
npm run ingest                    # scrape recent permits into the database
npm run web                       # http://localhost:3000
npm test                          # 101 unit tests, no network needed
```

`npm run ingest` accepts `--area=`, `--days=`, `--max=` and `--all-details`.
`npm run schedule` keeps the data current on an interval (see **Freshness**).

## Permit lifecycle stage

The filter that matters most for finding work is **stage**, because a finished
job is the opposite of a lead. Each permit carries three status values:

| Field | What it is |
|---|---|
| `status_raw` | The portal's exact wording — `Ready to Issue`, `Finaled`, `TCO Issued` |
| `status_stage` | `pending` / `approved` / `finished` / `cancelled` / `unknown` |
| `status` | The older `applied`/`issued` bucket, kept so trade scoring is unaffected |

Search defaults to **pending + approved** — work that might still happen.
Finished and cancelled permits are reachable but never shown unless asked for.

Two deliberate judgment calls, both easy to flip in `src/status.js`:

- `Ready to Issue` and `Payment Due` are **pending**, not approved — nothing has
  been issued yet, so the work isn't committed.
- `TCO Issued` (temporary certificate of occupancy) is **finished** — the
  building is occupiable, so what's left is punch-list rather than the job.

A status we don't recognize becomes `unknown` and is reported at the end of the
run. It is never folded into a real stage, because silently guessing "approved"
would put finished work back into the results. This is how `Withdrawn`,
`TCO Issued` and `Revision Request Accepted` were found in live data.

## Freshness

`npm run schedule` runs ingest on an interval (default every 6 hours, last 7
days) and records every attempt — successes and failures — in `ingest_runs`,
which is what the UI's freshness badge reads. A failed refresh surfaces as a
warning rather than silently serving stale data. `INGEST_INTERVAL_MINUTES`,
`INGEST_DAYS`, `INGEST_MAX` and `INGEST_AREAS` configure it. If you'd rather use
the system scheduler, `ingest/schedule.js` documents the equivalent crontab line.

The badge in the header colours by age — green under a day, amber under a week,
red beyond that — and opens to a per-source breakdown, so "12 days old" can be
traced to the feed that is behind. A platform that claims "latest permits" should
say out loud when it is serving a stale snapshot.

`INGEST_AREAS` defaults to the pilot markets, Austin and Miami-Dade
(`PILOT_AREAS` in `src/sources.js`); the Oregon Accela sources run only when
named. Each run is capped by its source's own `maxPerRun` (Austin 5,000,
Miami-Dade 1,500). `INGEST_MAX` can lower a cap but not raise it, and a run
that hits its cap logs a warning, because the oldest permits in the window
were then not fetched. An unknown area name fails at startup rather than
being skipped.

```bash
INGEST_AREAS=austin-tx,miami-dade-fl,clackamas-county-or npm run schedule
```

Schema changes live in numbered files under `db/migrations/` and are applied
in order by `db/migrate.js` on every start (recorded in `schema_migrations`;
editing an applied file is an error). `001_baseline.sql` is the former
`db/schema.sql`.

## The web UI

No build step, no framework, no npm install for the frontend — three static
files served by `express.static`:

| File | Holds |
|---|---|
| `web/public/index.html` | App-shell markup only |
| `web/public/app.css` | Design tokens, layout, light + dark themes |
| `web/public/app.js` | Fetching, rendering, filter state, URL sync |

Every colour in `app.css` is checked for WCAG AA against the surface it actually
sits on, and that constraint is what sets the accent: `#e03214` is the brightest
coral that still clears 4.5:1 with white button text on top of it. If you
brighten it further, re-check that pair first — a primary button is
normal-weight text, so 3:1 is not enough.

Filters live in a collapsible sidebar and apply on change; a results feed and a
map sit beside it, with a detail panel over the top. Which panes are showing is
controlled by two switches described under **Layout** below. Under 980px the
sidebar becomes a bottom sheet — the same markup, opened as a modal `<dialog>`
instead of rendered as a grid column.

One trap, since it cost an afternoon: **never give `.sidebar` or `.drawer` a bare
`display` value.** Author styles outrank the UA stylesheet, so `display: flex` on
a `<dialog>` defeats `dialog:not([open]) { display: none }` and the *closed*
dialog paints over the page. Both rules are scoped to `[open]`. For the same
reason there is a global `[hidden] { display: none !important }` — `.btn`'s own
`display` would otherwise beat the attribute.

## Location is a picker, not a text box

There is one **Where** control, built from `/api/areas`, and it can only offer
places we actually hold permits for. A free-text ZIP box invited searches for
areas we don't cover.

Its values are area keys — `z:78704`, `c:MIAMI|FL` — the same vocabulary the
map's pins use, so a pin click is a direct `setWhere()`. `currentFilters()`
expands the key back into `zip=` / `city=`+`state=`, which is what the API takes
and what stays in the URL, so links made before this change still work.

Every city gets an "— all" roll-up and every trusted ZIP its own entry. **The two
overlap on purpose** — selecting Austin returns its ZIP-bearing permits too —
which is why the state headings carry no total. Summing the options would count
Austin's permits twice.

`/api/areas` will not offer a ZIP it cannot place, or one whose centroid
contradicts its own city. Miami-Dade carries a few rows reading `10028`, `18225`
and `24037`: New York, Pennsylvania and Virginia postal codes on Miami
addresses. Nothing becomes unreachable, because filtering by city returns those
permits too — they sit under "Miami — all". The response states `zipsHidden` and
`permitsUnderCityOnly` rather than dropping them silently.

Two things worth knowing if you touch `app.js`:

- **Everything interpolated into `innerHTML` goes through `esc()`.** Permit text
  is third-party data from government portals; an unescaped `work_description`
  is a stored-XSS hole.
- **Filter state round-trips through the URL**, so a search can be bookmarked.
  `?stage=` is omitted when the selection is the default, and set to `any` when
  every stage is ticked.

Stage counts beside each checkbox come from the search response's `facets`
block, not from `/api/filters`. They respect every *other* active filter but not
the stage filter itself — so searching one ZIP correctly reports "0 waiting,
124 approved" for that ZIP rather than table-wide totals.

## Layout: two switches, one grid

`.app` carries `data-view` (`list` | `split` | `map`) and `data-filters`
(`open` | `closed`), and the CSS does the arithmetic. Hiding a pane collapses
its grid column to `0px` rather than swapping in a different template — six
templates for three views times two filter states would drift apart. The area
names stay valid either way; a `0px` column is simply empty.

The map column is a **fraction** (`minmax(380px, 0.9fr)`), not a clamp, so when
the filter panel collapses the feed and the map share the width it gave back
instead of the feed taking all of it.

Both switches persist in `localStorage`, not the URL: a shared link should carry
the search, not someone else's pane arrangement. Every access is wrapped in
try/catch, because storage throws in a private window.

Two things that will bite:

- **`splitFits()` clamps the stored preference.** Below 1181px there is no room
  for two panes, so Split is withdrawn from the control and a stored `split`
  renders as `list`. The *wish* is stored, not the clamp, so widening the window
  restores it.
- **Any column resize needs `map.invalidateSize()`**, inside a
  `requestAnimationFrame` so the grid has settled. Measure too early and Leaflet
  reads the old width and paints a band of grey where the pane just grew.

Clicking a permit centres the map on it — on its **area**, since the schema has
no lat/lng. The note says `Centred on 78704 — area centre, not this address`,
because a map that silently recentres on a neighbourhood after you clicked one
house is claiming a precision it does not have. On a phone the list and map are
never both on screen, so the detail sheet carries a **Show area on map** button
instead.

## Mobile is a first-class target, not a fallback

- The topbar **wraps to two rows** under 620px, with a full-width search on the
  second. On one row the search field collapsed to about three visible
  characters — the main input of the app, unusable.
- Buttons and labels drop to **icons only** at that width.
- Touch sizing is keyed to `@media (pointer: coarse)`, not to width: a small
  desktop window still has a mouse, a large tablet still has fingers. Targets
  are set with `min-height: 44px` rather than padding, because padding has to be
  recomputed against the line box every time the type scale moves — it silently
  landed at 39px.
- The filter sheet has a **standing action that doubles as the result count**
  ("Show 11,404 permits"). Filters already apply on change, so it commits
  nothing; it reports the effect and gets you back to the results, which is the
  part that is awkward on a phone.
- The permit and contractor panels become **near-full-height bottom sheets**
  with a grab handle. There is no "side" for a side drawer at 390px.

## Contractor history

A permit is one job; a contractor's record is the reason to call them. Clicking
a company name anywhere — a card, the permit drawer, the sidebar field's
suggestions — opens their history: permit count by stage, active date range,
declared value, what they pull, and where they work.

| Endpoint | Returns |
|---|---|
| `GET /api/contractors?q=` | Matching names with permit counts, busiest first |
| `GET /api/contractors/:name` | One firm's full record, or 404 |

Three honesty rules are built in, and all three came from the data:

- **`OWNER` is not a company.** Portals write it (and `SELF`, `HOMEOWNER`,
  `N/A`) in the contractor column when the property owner pulled the permit
  themselves. It is 1,188 rows — treating it as a firm would invent a builder
  with a thousand jobs across three states. Those names are excluded from search
  and are not linked; asking for one directly returns 404 with
  `reason: "owner-builder"`, and the UI explains it.
- **Near-matches are offered, never merged.** "Radiant Plumbing and Air
  Conditioning" (106 permits) and "Radiant Plumbing & AC" (49) are one firm.
  Portals issue no stable contractor ID, so the panel surfaces the other
  spellings under "Possibly the same firm" and lets the user decide — fuzzy
  joining would eventually fuse two genuinely different companies.
- **Declared value states its own denominator.** Many permits report `$0`, so
  the total is captioned "from 10 of 106 permits that report a value" rather
  than presented as the firm's turnover.

## The map, and what its pins actually mean

Leaflet over OpenStreetMap tiles, both loaded from a CDN — still no build step.

**Counts on the pins are real** and follow the active filters, straight from
`GROUP BY` over the permits table. **Pin positions are not addresses.** The
schema stores no lat/lng, so `/api/map` attaches a centroid per area: the ZIP's
where the source gives one, the city's otherwise. A pin means *"N permits in this
ZIP/city"*, never *"a permit at this point"*. Keep any wording you add honest
about that — and note the response's `unplaced` count, which the UI surfaces as
"N permits not shown", rather than quietly dropping rows.

Grouping by city is not a nicety: Miami-Dade publishes no property ZIP, so its
~2,900 permits would be invisible on a ZIP-only map.

| Piece | Where |
|---|---|
| Centroids | `data/area-coords.json` — geocoded **once** against Nominatim and committed |
| Pins for the current filters | `GET /api/map?<same filters as /api/permits>` |
| Multi-area filter | `areas=z:78704,c:MIAMI|FL` — ORs ZIPs and cities together |

Nothing geocodes at request time. To refresh the cache after adding a source,
re-run a one-time script against Nominatim at **no more than 1 request/second**
with a real `User-Agent`; that is their acceptable-use policy, and bulk querying
gets the IP blocked.

Three behaviours worth knowing:

- **Pins are clustered in screen space**, not geographically — a fixed pixel grid
  re-bucketed on every `zoomend`. At continental zoom fifty Portland-area ZIPs
  land on the same few pixels; this keeps the map legible at every zoom and
  splits it apart as you go in. Clicking a cluster zooms to its extent rather
  than filtering by it, because a screen-space cluster is an artefact of the
  current zoom, not a place anyone chose.
- **"Search this area"** appears only after genuine input on the map container
  (`mousedown`/`wheel`/`touchstart`). It cannot key off Leaflet's `movestart`,
  because `fitBounds()` fires those events exactly like a drag does.
- **"Use my location"** compares the browser's coordinates against every area we
  hold and applies the nearest within 60km. Beyond that it says how far away you
  are and *changes nothing* — dropping someone into a city 1,000 miles off
  without saying so would be worse than no answer.

A row whose ZIP contradicts its own city (Miami-Dade has a few reading `10028`
and `18225`) is placed by **city**, since the city field is far more reliable.
Without that rule those permits pin to Manhattan.

## How ingest stays cheap

Accela costs one detail-page visit per permit at a 1s delay, so re-scraping a
wide window naively takes hours. Ingest asks the database which permits it
already holds **with their details filled in**, and fetches detail pages only
for the rest. A repeat run over the same window does no detail fetching at all.

Two consequences worth knowing, both learned the hard way by running it twice:

- A permit stored after a *failed* detail fetch is not treated as known, so it
  gets retried rather than staying blank forever.
- The upsert never overwrites a description or valuation with an empty value,
  because an incremental run deliberately doesn't have them.

## Two limits on how much each run can pull

Both were found by running a catch-up ingest on 2026-09-25, not by reading code.

**Accela caps at ~100 records per run, whatever `--max` says.** The ACA grid's
pager stops advancing after 10 pages, so `clackamas-county-or` and
`oregon-statewide` return 100 and then stop. The data is current, just shallow.
Fixing it means teaching `gotoPage()` to drive the pager past its visible page
range.

**Miami-Dade's ArcGIS endpoint fails on very large requests.** `--max=6000`
returned `fetch failed`; `--max=2000` pulled 2,000 records in four clean pages
of 500. Keep `INGEST_MAX` at or below ~1,500 for that source. The failure is
recorded in `ingest_runs`, so the freshness badge shows it rather than serving a
stale snapshot as if it were fresh.

## Detail-page parsing is substring matching, so bound it

`labelledField()` finds `Label: value` in the detail page's flattened text. Two
guards exist because both were violated in live data:

- **The label is word-bounded.** Without `\b`, `Owner` matches inside
  `Homeowners` — and an Oregon ePermitting page carries site navigation in its
  text, so `Homeowners Register for Oregon ePermitting Apply for...` was stored
  as 192 permits' owner.
- **A capture over 200 characters is discarded.** These fields are names and
  codes, never paragraphs. The stop list cannot anticipate every page variant,
  so length is the backstop: a run-on capture means the label matched somewhere
  unintended, and `NULL` ("not collected") is the truthful answer.

Both are covered by tests in `src/adapters/accela.test.js`. If you clear
polluted rows, note that an incremental run will **not** refill them — it skips
detail fetches for permits it already holds. Use `--all-details` for that.

## Coverage

| Source | Type | Records | Contractor phone | Pre-approval permits |
|---|---|---|---|---|
| **Austin, TX** | Socrata | 2.37M available | ✅ 92% | limited |
| **Miami-Dade, FL** | ArcGIS | ~140k (2 yrs) | ✅ 82% | ❌ none |
| **Clackamas County, OR** | Accela scrape | live | ❌ | ✅ |
| **Oregon statewide** | Accela scrape | live, 26 jurisdictions | ❌ | ✅ |

The two kinds of source complement each other, and that is deliberate:

- **Open data (Austin, Miami-Dade)** is fast and rich — ~170 permits/sec, with
  contractor phone numbers the scraped portals simply don't publish. But it is
  overwhelmingly *already issued* work.
- **Accela scrapes (Oregon)** are slow (~7s/permit) and publish no contractor
  contact, but they are the only source of permits still **awaiting approval**.

Two per-market limitations, both verified against the live data rather than
assumed:

- **Miami-Dade has no property postal code** — only a street address plus City
  and State. Miami permits are searchable by city, not ZIP, and no ZIP is
  invented for them.
- **Miami-Dade has no status column.** Every record has an issue date, so the
  lifecycle stage is derived from dates (Certificate of Completion → finished,
  otherwise approved). That derivation is stated explicitly in `src/sources.js`.

Not available: Portland's CSV columns are unverified and its host was
unreachable; Clark County WA has a working ArcGIS adapter but its field names
need reading off the live layer; Washington County is CAPTCHA-gated and
deliberately not implemented. See `src/sources.js`.

## Contractor contact

Where the source publishes it, each permit carries the contractor's company
name, phone, trade, city and licence number, plus the applicant's name and
phone. Phones are stored as bare digits so they compare and de-duplicate
reliably, and formatted only for display.

`hasContact=true` filters to permits that actually have a phone number;
`contractor=` searches by company name.

**Oregon publishes no contractor at all** — not a name, licence, phone or
email. This is why CCB (Oregon's licence board) matching isn't implemented:
there is no contractor name on the permit to match on. No source here publishes
email addresses.

Using scraped contact details for outreach is regulated (TCPA for calls and
texts, CAN-SPAM for email, plus state rules). The data is public record; how
it's used is the part with rules attached.

The UI distinguishes "we don't cover this postal code" from "nothing matched
your filters" — an empty list for an uncovered area would be misleading.

## Known limitation: trade scoring

Trade is an optional filter, and it is currently weak. `TRADE_RULES` in
`src/scoring.js` was written against Portland-style prose and does not match
Accela vocabulary (`NSFR`, `Building - Residential New`), so trade-filtered
searches return little. All six trade scores are precomputed at ingest, so
extending the rules and re-running ingest is all that's needed — but which
wording counts as a lead for which trade is a domain judgment call.

---

## Source status

**Working, verified against live data:**
- **Clackamas County** and **Oregon statewide** (`accela`). Both verified end to
  end against live data: search, pagination, and per-record detail pages
  yielding project description and job value. The two instances label their grid
  columns differently ("Date"/"Permit Number" vs "Opened"/"Permit/Application
  Number"), which `HEADER_ALIASES` in the adapter absorbs.
- Scoring engine (`src/scoring.js`) — unit tested.

**Blocked or unverified:**
- **Portland CSV column mapping is still a guess.** `portlandmaps.com` was
  unreachable from the machine this was last worked on, so `columnMap` in
  `src/sources.js` has never been checked against a real response.
- **Clark County WA** publishes an ArcGIS feature layer — structurally the best
  of these sources. The `arcgis` adapter is implemented and unit tested, but the
  entry stays disabled until someone can reach `gis.clark.wa.gov` to read the
  layer's real field names. The adapter throws rather than running without a
  `fieldMap`, so guesses can't leak in.
- **Washington County is intentionally not implemented.** Its permit search is
  CAPTCHA-gated, which is an explicit signal that automated access isn't
  permitted. The legitimate path is a bulk-data request to the county.

## Known limitation: scoring rules don't fit Accela vocabulary

The Accela adapter works, but the trade rules in `scoring.js` were written
against Portland-style prose and **do not match how Clackamas words permits**.
On a live 24-permit sample, every permit scored 0 for every trade, so at the
default `minScore: 25` these sources return **no leads**.

Real examples that should be leads but score 0:

| Permit text | Why it misses |
|---|---|
| `Add new bathroom and relocate a lavatory` | plumbing rule matches `bathroom addition` |
| `NSFR Electrical Install incl. Meter base and panel` | rules look for `new construction` / `new sfr`, not `NSFR` |
| `Install 50 amp EV car charger` | electrical rule requires `ev charger` **and** `addition` |

Fixing this means extending `TRADE_RULES` to cover Accela's controlled permit
types (`Building - Residential New`, `Building - Electrical`, …) and its
abbreviations. That's a domain judgment call about lead quality, so it was left
for a human rather than guessed at.

Note also that Clackamas records often carry no Job Value (3 of 8 populated in
one sample), so every rule with a `minValuation` threshold is unreachable for
them.

## Scraper-only dev notes

```bash
npm install
npx playwright install chromium   # required by the accela adapter
npm test                          # all suites, no network needed
```

Run the actor locally by writing input to
`storage/key_value_stores/default/INPUT.json`, then `npm start`:

```json
{ "area": "clackamas-county-or", "trade": "plumbing", "minScore": 0, "daysBack": 7, "maxRecords": 6 }
```

Results land in `storage/datasets/default/`.

`maxRecords` is a real cost control: the Accela adapter visits one detail page
per record (with a 1s delay between requests), so a large cap means a long run
against someone else's server. `fetchDetails: false` on a source trades lead
quality for speed.

## recon/

One-off scripts used to discover how each portal actually behaves — they save
real HTML into `recon/out/` (gitignored) so selectors are written from evidence
rather than guessed. Keep using this pattern before touching any portal's
markup.
