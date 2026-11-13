-- City of Miami and Raleigh passed a 30-day trial backfill on 2026-11-13
-- (2,722 and 2,324 permits, no failures), so they join the daily sync.
UPDATE sources SET enabled = true WHERE slug IN ('miami-city-fl', 'raleigh-nc');
