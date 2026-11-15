-- 039: a declared value repeated on several permits counts once (ADR-36).
--
-- ADR-35 marks a value that a source repeats on several permits (one
-- project's total copied onto each: Austin $830M on 77 permits filed one day,
-- Miami-Dade $580M on "LIGHT POLES") on every screen. Sorting by value, the
-- minimum-value filter, sums and the overview medians still counted it once
-- per permit, so 77 copies of one figure sorted to the top and weighed 77
-- times. They now use the first permit of each repeat group only.
--
-- Within one source, two permits repeat each other when they carry the same
-- value and (the same address, or the same filing day when the value is $1M
-- or more). A missing address or filing day matches nothing.
--   valuation_repeats  the larger of the two group sizes (0 when no value)
--   valuation_first    false when a permit with a lower id repeats this one
-- db/index.js upsertPermits refreshes a source after every write.

ALTER TABLE permits
  ADD COLUMN IF NOT EXISTS valuation_repeats integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS valuation_first boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION refresh_value_repeats(p_source text) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
  WITH g AS (
    SELECT id,
           count(*) OVER by_addr AS n_addr,
           row_number() OVER (by_addr ORDER BY id) AS rn_addr,
           CASE WHEN valuation >= 1000000 THEN count(*) OVER by_day ELSE 1 END AS n_day,
           CASE WHEN valuation >= 1000000 THEN row_number() OVER (by_day ORDER BY id) ELSE 1 END AS rn_day
      FROM permits
     WHERE source_area = p_source AND valuation IS NOT NULL
    WINDOW by_addr AS (PARTITION BY valuation, coalesce(nullif(upper(trim(address)), ''), 'id:' || id)),
           by_day AS (PARTITION BY valuation, coalesce(filed_date::text, 'id:' || id))
  ), v AS (
    SELECT id, greatest(n_addr, n_day)::int AS n, (rn_addr = 1 AND rn_day = 1) AS first FROM g
  )
  UPDATE permits p SET valuation_repeats = v.n, valuation_first = v.first
    FROM v
   WHERE p.id = v.id AND (p.valuation_repeats <> v.n OR p.valuation_first <> v.first);
  GET DIAGNOSTICS changed = ROW_COUNT;

  UPDATE permits SET valuation_repeats = 0, valuation_first = true
   WHERE source_area = p_source AND valuation IS NULL AND (valuation_repeats <> 0 OR NOT valuation_first);
  RETURN changed;
END $$;

SELECT refresh_value_repeats(s) FROM (SELECT DISTINCT source_area AS s FROM permits WHERE source_area IS NOT NULL) x;
