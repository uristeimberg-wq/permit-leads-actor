-- Terms of use for the pilot sources, read 2026-11-13 (docs/DATA_SOURCES.md,
-- "Licence and terms review"). Only what the text says is recorded:
-- Austin: datasets are public domain and "offered free and without
--   restriction", so redistribution = yes. Automated access is not addressed
--   in the part that could be read, so it stays unknown.
-- Miami-Dade: the county site's user agreement grants no licence and reserves
--   all rights not granted, so both stay unknown (on the lawyer list).
UPDATE sources SET terms_url = 'https://data.austintexas.gov/stories/s/City-of-Austin-Open-Data-Terms-of-Use/ranj-cccq/',
                   terms_reviewed_on = DATE '2026-11-13', terms_reviewed_by = 'claude (not legal advice)',
                   redistribution = 'yes', automated_access = 'unknown'
 WHERE slug = 'austin-tx';
UPDATE sources SET terms_url = 'https://www.miamidade.gov/global/disclaimer/disclaimer.page',
                   terms_reviewed_on = DATE '2026-11-13', terms_reviewed_by = 'claude (not legal advice)',
                   redistribution = 'unknown', automated_access = 'unknown',
                   attribution_text = coalesce(attribution_text, 'Source: Miami-Dade County')
 WHERE slug = 'miami-dade-fl';
