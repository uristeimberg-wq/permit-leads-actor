# Test strategy

`npm test` runs every suite with no network and no database. That rule stays.
Database and live tests are separate commands.

| Layer | What | Where | Runs |
| --- | --- | --- | --- |
| Unit | Pure functions: mapping, status, address, dates, phone, scoring, resolver rules, project grouping, digest selection | `src/**/*.test.js` (existing pattern) | `npm test`, every PR |
| Connector contract | Each connector against **recorded real responses**: paging, cursor advance, errors inside 200, schema-drift detection | `test/fixtures/<source>/*.json` | `npm test` |
| Integration | Real Postgres: migrations from empty and from today's schema, idempotent re-runs (F3), versioning, suppression, digest never repeating | `test/integration/` | `npm run test:integration`, CI with a Postgres service |
| Recovery | Kill the worker mid-sync, restart, and assert the same final state with no duplicates | `test/integration/recovery.test.js` | CI |
| API | Filters, auth (401 without a session), org isolation, feedback token validation | `test/integration/api.test.js` | CI |
| Live smoke | One small real request per enabled source, comparing the field list to the stored hash | `npm run smoke:live` | Manual and daily in prod (feeds the schema-drift alert) |
| End to end | Build a digest from fixtures, render the email, follow a feedback link | `test/e2e/` | CI, before M3 ships |

Rules:

- Fixtures are real responses trimmed to a few rows, with phone digits
  replaced by `555` numbers. Each fixture file starts with a `_fixture` key
  naming its source and capture date, so test data can never pass for
  production data.
- A bug fix lands with a test that fails before the fix.
- Classification changes are measured on the labelled sample. Precision at the
  top 20 is reported in the PR.
