-- City of Miami and Raleigh connectors (src/sources.js registry blocks).
-- Disabled until a trial backfill passes the health check and they join
-- PILOT_AREAS. Terms read 2026-11-13 (docs/DATA_SOURCES.md, PR #24).
INSERT INTO jurisdictions (slug, name, kind, state, timezone) VALUES
  ('miami-fl',   'Miami',   'city', 'FL', 'America/New_York'),
  ('raleigh-nc', 'Raleigh', 'city', 'NC', 'America/New_York')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled,
                     terms_url, terms_reviewed_on, terms_reviewed_by, automated_access, redistribution, attribution_text)
SELECT s.slug, j.id, 'arcgis', s.endpoint_url, 'date_window', '15 17 * * *', interval '1 day', false,
       s.terms_url, DATE '2026-11-13', 'claude (not legal advice)', 'unknown', s.redistribution, s.attribution_text
  FROM (VALUES
    -- CC BY 4.0: the credit line must appear wherever the data does.
    ('miami-city-fl', 'miami-fl',
     'https://services1.arcgis.com/CvuPhqcTQpZPT9qY/arcgis/rest/services/Building_Permits_Since_2014/FeatureServer/0',
     'https://creativecommons.org/licenses/by/4.0/', 'attribution',
     '© 2019 City of Miami, Department of Innovation and Technology, GIS Team. Licensed CC BY 4.0 (creativecommons.org/licenses/by/4.0); normalized by us'),
    -- Two layers; endpoint_url names the building layer, the trade layer is in
    -- src/sources.js layerUrls. The City may require us to stop at any time.
    ('raleigh-nc', 'raleigh-nc',
     'https://services.arcgis.com/v400IkDOw1ad7Yad/arcgis/rest/services/Building_Permits/FeatureServer/0',
     NULL, 'unknown', 'City of Raleigh Open Data')
  ) AS s(slug, jslug, endpoint_url, terms_url, redistribution, attribution_text)
  JOIN jurisdictions j ON j.slug = s.jslug
ON CONFLICT (slug) DO NOTHING;
