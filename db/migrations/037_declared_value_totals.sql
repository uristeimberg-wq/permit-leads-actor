-- 037: declared value = the job's total, and only a plausible one (ADR-34).
--
-- Value audit 2026-11-15 (recon/value_audit.js):
--   - Austin permits showed one trade's column as the job's declared value on
--     9,714 rows (8,228 from electrical_valuation_remodel alone); plan review
--     on 162 rows (all $1, mechanical_valuation_remodel).
--   - $1 and other values under $100 are fillers (6,481 Austin permits, 4,170
--     plan-review cases).
--   - $1B or more on one permit is a typo at the source (Austin $8.1B on one
--     floor of a 53-unit building; Miami-Dade $9.5B on a demolition).
-- The raw records keep what each source published; only the shown value
-- changes. New syncs apply the same rule (src/normalize.js, src/sources.js).

-- 1. Austin (permits and plan review): the total columns only, from the
--    latest raw record.
WITH latest AS (
  SELECT DISTINCT ON (p.id) p.id, r.payload
    FROM permits p
    JOIN sources s ON s.slug = p.source_area
    JOIN raw_records r ON r.source_id = s.id AND r.source_key = p.permit_number
   WHERE p.source_area IN ('austin-tx', 'austin-plan-review-tx')
   ORDER BY p.id, r.id DESC
), total AS (
  SELECT id,
         coalesce(
           nullif(CASE WHEN payload->>'total_job_valuation' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (payload->>'total_job_valuation')::numeric END, 0),
           nullif(CASE WHEN payload->>'total_valuation_remodel' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (payload->>'total_valuation_remodel')::numeric END, 0)
         ) AS v
    FROM latest
)
UPDATE permits p SET valuation = t.v
  FROM total t
 WHERE p.id = t.id AND p.valuation IS DISTINCT FROM t.v;

-- 2. Every market: fillers and typos are not shown.
UPDATE permits SET valuation = NULL
 WHERE valuation IS NOT NULL AND (valuation < 100 OR valuation >= 1000000000);
