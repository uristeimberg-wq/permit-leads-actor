-- Numbered 011, not 009: it merged alongside 009_suppressions (PR #28) and
-- had not been applied anywhere, so it was renamed rather than edited.
-- City of Miami and Raleigh passed a 30-day trial backfill on 2026-11-13
-- (2,722 and 2,324 permits, no failures), so they join the daily sync.
UPDATE sources SET enabled = true WHERE slug IN ('miami-city-fl', 'raleigh-nc');
