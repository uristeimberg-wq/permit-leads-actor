# CLAUDE.md

A B2B construction-permit intelligence platform. It turns public permit records
into weekly, trade-matched lead lists for subcontractors, with the business to
contact and the evidence behind each pick. Pilot markets: Austin, TX, then
Miami-Dade, FL.

## Read first

- `docs/ARCHITECTURE.md`: target design, pipeline stages, sync modes, security
- `docs/DATA_MODEL.md`: target schema and its mapping from today's tables
- `docs/DECISIONS.md`: numbered decisions (ADR-n). Supersede entries; never
  delete them
- `docs/ROADMAP.md`: milestones and their exit checks. Work in this order
- `docs/DATA_SOURCES.md`: every source, verified fields, and the date checked
- `docs/DATA_STRATEGY.md`: early-signal strategy, source registry and scoring,
  evidence ladder, pilot (ADR-18)
- `docs/COMPLIANCE.md`: rules the product follows, and open legal questions
- `docs/REPOSITORY_AUDIT.md`: what the prototype does and what to keep
- `README.md`: the prototype's own detailed notes (UI, map, ingest gotchas)

## Commands

```bash
npm install
npm run db:up        # Postgres 17 on :5433 (docker compose); 5432 is left alone
npm run ingest       # one-off ingest; --area= --days= --max= --all-details
npm run schedule     # interval scheduler (being replaced by pg-boss, M2)
npm run web          # http://localhost:3000
npm run digest       # customer email digests; dry run unless docs/EMAIL.md is done
npm run digest:subscribe -- --email=... --area=austin-tx --trades=electrical --early=homes
npm test             # all unit suites, offline, no DB; must stay green
```

The Accela adapter needs `npx playwright install chromium`, but Accela sources
are disabled for the pilot (ADR-5).

## Hard rules

1. **No invented data.** Missing is `NULL` and is shown as missing. No guessed
   field maps: a connector without a verified `fieldMap` must refuse to run
   (the existing adapters already do this).
2. **No duplicates on re-runs.** Every write is an upsert on a natural key or
   an insert guarded by a unique constraint.
3. **No silent failures.** Every sync attempt is recorded with its error class.
   An unknown status becomes `unknown` and is reported.
4. **No bypassing access controls.** No CAPTCHA solving or evasion. A source
   that signals no automation stays off (for example, Washington County, OR).
5. **B2B ships first; homeowner leads are a gated second track (ADR-10).**
   Until that track's compliance gate passes, owner names and
   individual-looking contacts are stored but never displayed or exported.
6. **Provenance on every displayed value.** Know which raw record it came from.
7. **Never claim freshness the source doesn't have.** Show last sync and
   publication lag.
8. **Escape all third-party text** before `innerHTML` (`esc()` in
   `web/public/app.js`).
9. **Don't rewrite working code without a migration plan.** Keep `npm test`
   green on every commit.
10. **Before adding a source:** fetch it live, record a fixture, and fill in
    its `docs/DATA_SOURCES.md` entry with the date.

## Conventions

- CommonJS Node, plain `pg`, hand-written parameterized SQL. No ORM.
- Tests are plain Node scripts next to the code (`*.test.js`) and run offline.
  Integration tests that need Postgres go in `test/integration/`.
- Schema changes go in numbered files under `db/migrations/` (from M0) and are
  never edited after merge.
- Phones are stored normalized and formatted only for display.

## Current priority

Milestone **M0, then M1** in `docs/ROADMAP.md`:

- CI
- the migration runner
- scheduler defaults (Austin and Miami-Dade on, Oregon off)
- then the Austin data-feasibility measurements: publication lag, phone
  coverage, and the trade-gap link rate
