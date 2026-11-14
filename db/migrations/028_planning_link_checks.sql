-- 028: planning cases after the 2026-11-14 hand checks (docs/DATA_SOURCES.md
-- "Planning sources", hand-check results).
--
-- Miami-Dade DERM sewer certifications are now one case per lot (allocation
-- number, folio, address) instead of one per allocation number: an
-- allocation covers a group of lots, each often with its own process number,
-- and the old key kept one lot and dropped the rest with their permit links.
-- The cases stored under the old key are removed (their status history,
-- parties and links go with them by ON DELETE CASCADE; the history began
-- 2026-11-14, so one day is lost). The raw records stay, so nothing published
-- is lost; the next DERM ingest stores the lots under the new key.
DELETE FROM planning_cases
 WHERE source_area = 'miami-derm-sewer-fl'
   AND case_number NOT LIKE '% | %';
