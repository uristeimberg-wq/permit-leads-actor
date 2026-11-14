-- 031: two pre-issue sources found by the 2026-11-14 discovery scan
-- (docs/DATA_SOURCES.md). Both write planning_cases only (role 'planning').
--   miami-city-trees-fl: City of Miami tree permit reviews, tied to City
--     permits by the City's own application number (official reference).
--   miami-dade-zoning-hearings-fl: Miami-Dade zoning hearing applications,
--     read whole daily (no date field); its folio link is off until checked.
INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled, role,
                     terms_url, terms_reviewed_on, terms_reviewed_by, automated_access, redistribution, attribution_text)
SELECT s.slug, j.id, 'arcgis', s.endpoint_url, s.sync_mode, '15 17 * * *', interval '1 day', true, 'planning',
       s.terms_url, DATE '2026-11-14', 'claude (not legal advice)', 'unknown', 'unknown', s.attribution_text
  FROM (VALUES
    ('miami-city-trees-fl', 'miami-fl', 'date_window',
     'https://services1.arcgis.com/CvuPhqcTQpZPT9qY/arcgis/rest/services/Tree_Permits/FeatureServer/0',
     NULL, 'City of Miami Open Data (Tree Permits)'),
    ('miami-dade-zoning-hearings-fl', 'miami-dade-county-fl', 'snapshot',
     'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/LandManagementHearingView/FeatureServer/0',
     'https://www.miamidade.gov/global/disclaimer/disclaimer.page', 'Miami-Dade County Open Data (Land Management Hearings)')
  ) AS s(slug, jslug, sync_mode, endpoint_url, terms_url, attribution_text)
  JOIN jurisdictions j ON j.slug = s.jslug
ON CONFLICT (slug) DO NOTHING;
