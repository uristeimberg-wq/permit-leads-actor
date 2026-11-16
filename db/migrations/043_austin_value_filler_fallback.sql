-- 043: an Austin $1 filler total falls to the remodel total (ADR-34 fix).
--
-- 037 took total_job_valuation unless it was 0, then nulled anything under
-- $100. Austin puts '1' (a filler) in total_job_valuation on rows whose
-- total_valuation_remodel holds the real total, so those rows lost their
-- value. Measured 2026-11-16 on the local database: 1 Austin permit and 1
-- plan-review case (rare: most Austin fillers are '0', which 037 handled),
-- e.g. 2025-055228 BP: total_job_valuation '1', total_valuation_remodel
-- '1352' (matches the live record). New syncs apply the same rule
-- (src/adapters/socrata.js pick). Raw records are unchanged.

WITH latest AS (
  SELECT DISTINCT ON (p.id) p.id, r.payload
    FROM permits p
    JOIN sources s ON s.slug = p.source_area
    JOIN raw_records r ON r.source_id = s.id AND r.source_key = p.permit_number
   WHERE p.source_area IN ('austin-tx', 'austin-plan-review-tx')
   ORDER BY p.id, r.id DESC
), parsed AS (
  SELECT id,
         CASE WHEN payload->>'total_job_valuation' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (payload->>'total_job_valuation')::numeric END AS job,
         CASE WHEN payload->>'total_valuation_remodel' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (payload->>'total_valuation_remodel')::numeric END AS remodel
    FROM latest
), total AS (
  SELECT id,
         CASE WHEN job >= 100 AND job < 1000000000 THEN job
              WHEN remodel >= 100 AND remodel < 1000000000 THEN remodel END AS v
    FROM parsed
)
UPDATE permits p SET valuation = t.v
  FROM total t
 WHERE p.id = t.id AND p.valuation IS DISTINCT FROM t.v;

-- Repeat counts depend on the value (ADR-36); refresh them for both sources.
SELECT refresh_value_repeats('austin-tx');
SELECT refresh_value_repeats('austin-plan-review-tx');
