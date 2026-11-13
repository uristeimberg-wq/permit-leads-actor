# Adding a market (connector template)

A connector is configuration, not code, as long as the portal is Socrata or
ArcGIS. The contract is enforced by `src/sources.contract.test.js` (offline, in
`npm test`) and `test/integration/registry.test.js` (Postgres, in CI). ADR-14.

## Steps

1. **Terms first.** Read the portal's terms of use and the dataset licence.
   Record what you read in `docs/DATA_SOURCES.md` with the date. If the terms
   forbid automated access or commercial use, stop (hard rule 4). The registry
   `terms` block must say `unknown` when nothing was read; a `yes` or
   `attribution` needs `reviewedOn` and `url`, and the test rejects it without.
2. **Config.** Add an entry to `src/sources.js`:
   - `type`, the endpoint (`domain` + `datasetId`, or `layerUrl`), `dateField`,
     `defaultState`, `maxPerRun`, `backfillMaxPerRun`, `maxDataAgeDays`
     (publication lag measured live, plus slack)
   - `fieldMap`: only columns seen in live data (hard rule 1). `permitNumber`
     and `filedDate` are required.
   - `statusMap` for every status the source uses; anything else becomes
     `unknown` and is reported.
   - `parties`: how to read contractors and tie trade permits to a job.
     `job.kind` is `numberBase` (strip a type suffix, Austin) or `masterField`
     (a column naming the building permit, Miami-Dade; `none` is a regex for
     the "no master" value). `tradeByType` maps the source's type codes to
     `electrical` / `mechanical` / `plumbing`.
   - `registry`: `jurisdiction`, `syncMode`, `expectedInterval`, `terms`,
     `fixture`.
3. **Fixture.** Run the `fixture` workflow (Actions, inputs source and rows).
   It prints redacted rows between `BEGIN FIXTURE` and `END FIXTURE`; save the
   JSON to `test/fixtures/sources/<slug>.json`. Check the redaction by eye:
   people's names, phones and emails must be placeholders.
4. **Migration.** A new numbered file in `db/migrations/` inserting the
   jurisdiction and the `sources` row (`enabled = false` until it is a pilot
   area), matching the registry block. `registry.test.js` fails otherwise.
5. **Run** `npm test` and `npm run test:integration`, then a one-off
   `npm run ingest -- --area=<slug> --days=7` from Actions, and check the
   health report the next morning before adding it to `PILOT_AREAS`.

A portal that is not Socrata or ArcGIS needs an adapter in `src/adapters/`
and a mapper entry in the contract test. Accela and other scraped portals are
off for the pilot (ADR-5).
