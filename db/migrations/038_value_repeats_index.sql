-- 038: index for counting one declared value repeated on several permits (ADR-35).
--
-- Screens show how many permits of a source carry the same declared value at
-- the same address, or filed the same day when it is $1M or more
-- (src/display_policy.js valueRepeatsSql). Sources copy a project's total
-- onto each of its permits (Austin $830M on 77 permits filed one day;
-- Miami-Dade $580M on "LIGHT POLES" at one address), and such a value must not
-- read as that permit's own cost. The count runs per displayed row; this
-- index keeps it to a few index entries.
CREATE INDEX IF NOT EXISTS permits_source_valuation_idx
  ON permits (source_area, valuation) WHERE valuation IS NOT NULL;
