-- 003: Austin syncs by date windows, not :updated_at (docs/DECISIONS.md, ADR-11).
-- The publisher reloads all 2.4M rows daily, so :updated_at moves on every row.
-- The windows themselves live in src/sources.js (syncWindows), so there is one
-- source of truth until connectors move into the database.
-- Never edit this file after merge; add 004_*.sql instead.

UPDATE sources
   SET sync_mode = 'date_window'
 WHERE slug = 'austin-tx';
