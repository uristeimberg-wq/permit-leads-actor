# Contractos permit leads

A B2B construction-permit intelligence platform. It turns public permit
records into trade-matched leads for subcontractors, builders and suppliers:
the job, the business to contact, and the evidence behind each pick. The
newest work is the **data engine**: finding jobs before a permit is issued,
linking every filing to its property and its companies by official keys, and
recording where each value came from and how sure we are of it.

**Live demo:** https://permits-production-9581a3c0.up.railway.app (shared
password, ask the owner). Screens can lag the database by up to 10 minutes
because of the in-memory cache.

## Markets

| Market | Source | What it gives us |
| --- | --- | --- |
| Austin, TX | City of Austin open data (Socrata): issued permits and plan-review applications | Contractor company and phone, filings before issue (early track), parcel by TCAD id |
| Miami-Dade County, FL | County ArcGIS permit layer | Contractor and phone, master permit links; issued permits only |
| City of Miami, FL | City ArcGIS permit layer | Issued permits with line items; no contractor fields |
| Raleigh, NC | City of Raleigh ArcGIS layers (building and other permits) | Filings about 2 days after application (early track), Wake County parcels by PIN |

Oregon (Portland, Clackamas) Accela sources still exist in the code but are
off: they need a browser scraper, and ADR-5 keeps that out of the pilot.
Every source, its verified fields and the date it was checked are in
[`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md).

## How the data flows

```
public sources -> raw_records -> permits / parties / jobs -> enrichment -> facts + scorecard -> web
 (Socrata,        (verbatim,      (normalized,                (parcels, TCAD,   (provenance,      (Railway)
  ArcGIS)          dedup'd)        upserts)                    licences, TX       confidence)
                                                               registrations,
                                                               geocodes)
```

- **Daily sync.** `.github/workflows/sync.yml` runs at 17:15 UTC on GitHub
  Actions and writes into Neon Postgres (`DATABASE_URL`). It runs ingest,
  contractor resolution, lifecycle, enrichment, facts and the scorecard in
  order. Government hosts are reachable from Actions, so that is where the
  sync lives (ADR-14).
- **Health alarm.** `.github/workflows/health.yml` runs every 6 hours on its
  own schedule. On a stale source or a failed sync it fails and opens a
  `data-health` issue, so a sync that never starts is still noticed.
- **Raw first.** Every fetched row is stored verbatim in `raw_records`.
  Re-running a sync writes no duplicates; every write is an upsert on a
  natural key. Every attempt is recorded in `sync_runs` with its error class.
- **Provenance and confidence.** Displayed values are stored as facts with
  the raw record they came from, the method, and a confidence level
  (`permit_facts`, `field_observations`). Missing is `NULL` and is shown as
  missing; nothing is guessed.
- **Data-quality scorecard.** `src/scorecard.js` defines the metrics (parcel
  match, map point, official link, contractor resolved, entity anchored,
  phone coverage and corroboration, application and trade linkage, history
  depth, open pre-issue jobs) with day-30 and day-90 targets. One row per
  market per day lands in `scorecard_snapshots` (ADR-23).

The plan behind this is [`docs/DATA_ENGINE_PLAN.md`](docs/DATA_ENGINE_PLAN.md).

## What the product shows

The app opens on `/pilot/live/`. The original permit search UI is still
served at `/index.html` and is described in
[`docs/PROTOTYPE_NOTES.md`](docs/PROTOTYPE_NOTES.md).

- **Early filings.** Austin residential applications in plan review and new
  Raleigh filings, before a permit is issued, with an estimated issue window (ADR-16, ADR-18, ADR-21).
- **Builder or expediter flag.** The business that filed an Austin
  application, with its role and the evidence for it (ADR-19).
- **Past subs.** Which electricians, plumbers and HVAC firms a builder used
  before, from linked trade permits. About 94% of trade permits go to a sub
  the GC already used, so this history is the core signal.
- **Trade timing.** How many days after the building permit each trade
  usually pulls its permit, from our own history (ADR-21).
- **Builder momentum.** Which builders are filing more or less than usual
  (ADR-21).
- **Property and licence panels** on job and contractor pages: parcel and
  Travis CAD data, TDLR licences (ADR-15).
- **Street View photos** of the job site, live and labelled, from Google
  only (ADR-24).
- **Texas business registration.** Austin contractors matched to Comptroller
  franchise-tax records.
- **Trade scoring.** Permits scored for electrical, plumbing and HVAC by
  permit type first (ADR-17, [`docs/TRADE_SCORING.md`](docs/TRADE_SCORING.md)).
- **Guided tour** on first visit, replayable from the top bar.
- **Privacy.** Owner names and individual-looking contacts are stored but
  never shown or exported until the homeowner track's compliance gate passes
  (ADR-10, ADR-22). Business names are shown.
- **Email digests** exist but are parked in dry-run mode (ADR-20,
  [`docs/EMAIL.md`](docs/EMAIL.md)).

## Running it locally

```bash
npm install
npm run db:up        # Postgres 17 on :5433 (docker compose); 5432 is left alone
npm run ingest       # one-off ingest; --area= --days= --max= --all-details
npm run web          # http://localhost:3000
npm test             # all unit suites, offline, no database needed
npm run test:integration   # needs Postgres
```

Schema changes are numbered files in `db/migrations/`, applied in order on
every start and never edited after merge. Government hosts may block cloud
machines; if ingest can't reach a source from your machine, run it through
the `sync` workflow's `workflow_dispatch` (tick `ephemeral` for a dry run).

## Secrets and configuration

No secret is committed. Set them where each process runs.

| Name | Where | What it is for |
| --- | --- | --- |
| `DATABASE_URL` | GitHub Actions secret, Railway | Neon Postgres connection string |
| `TX_COMPTROLLER_API_KEY` | GitHub Actions secret | Texas Comptroller franchise-tax lookups; without it the step skips and says so |
| `GOOGLE_MAPS_BROWSER_KEY` | Railway | Street View photos on job pages; restrict it to the demo's domain |
| (none) | Railway | Access is invite-only (ADR-27): `npm run invite -- --label="who"` prints a personal code; `--list` shows sign-ins and the industries people gave; `--revoke=<id>` stops a code. `DEMO_PASSWORD` remains the owner's key |
| `SHOW_INFERENCES` | Railway | Unset (default): screens show recorded facts and counts only (ADR-26). `1` brings back estimates, fit scores, role tags, name matches, Street View and Raleigh job links |
| `DEMO_PASSWORD` | Railway, GitHub Actions (smoke, perf) | Shared password for the hosted demo (ADR-13) |
| `SOCRATA_APP_TOKEN` | GitHub Actions secret (optional) | Higher Socrata rate limits |
| `EMAIL_API_KEY`, `LINK_SECRET` | GitHub Actions secret (unused until email ships) | Digest sending and signed lead links |

Railway builds `Dockerfile.web` and runs `node web/server.js`, with
`/healthz` as its health check (`railway.json`). It auto-deploys from `main`.
Before each deploy goes live, Railway runs `node db/apply.js` (its
pre-deploy command), which applies pending migrations; if one fails, the
previous deploy stays live. `/healthz/schema` returns the applied migration
number, and the smoke workflow prints it.

## Repository map

| Path | Holds |
| --- | --- |
| `src/adapters/` | Socrata, ArcGIS and Accela source adapters |
| `src/sources.js` | Every source with its verified field map |
| `src/enrichment/` | Parcels, Travis CAD, licences, geocoding, TX registrations |
| `src/` | Normalization, status, scoring, contractors, lifecycle, facts, scorecard, forecast |
| `ingest/` | Command-line jobs the daily sync runs |
| `db/migrations/` | Numbered schema migrations |
| `web/` | Express server, pilot API, static UI in `web/public/pilot/live/` |
| `recon/` | One-off measurements behind the decisions (feasibility, backtests) |
| `test/` | Fixtures recorded from live responses, integration tests |
| `.github/workflows/` | Tests, daily sync, health alarm, smoke, audits |

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): design, pipeline stages, security
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md): schema
- [`docs/DECISIONS.md`](docs/DECISIONS.md): ADR-1 to ADR-24, the record of every decision
- [`docs/ROADMAP.md`](docs/ROADMAP.md): milestones and exit checks
- [`docs/DATA_ENGINE_PLAN.md`](docs/DATA_ENGINE_PLAN.md): the data engine and scorecard
- [`docs/DATA_STRATEGY.md`](docs/DATA_STRATEGY.md): early-signal strategy (ADR-18)
- [`docs/DATA_VALUE.md`](docs/DATA_VALUE.md): why the data is worth paying for: sources, what we add, competitors, limits
- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md): every source and its verified fields
- [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md): rules the product follows, open legal questions
- [`docs/IMAGERY.md`](docs/IMAGERY.md): job-site photos
- [`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md): how the code is tested
- [`docs/PROTOTYPE_NOTES.md`](docs/PROTOTYPE_NOTES.md): the original prototype's detailed notes
- [`CLAUDE.md`](CLAUDE.md): hard rules for anyone changing the code
