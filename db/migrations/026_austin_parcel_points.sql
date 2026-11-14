-- Austin parcel points (coverage plan item 4): 10,146 Austin permits had no
-- map point (sync run 43618444328). Travis CAD's export has no coordinates,
-- so the parcel centroid comes from the City of Austin's published copy of
-- the Travis CAD parcel polygons (ArcGIS item 6f5f919cf5c948cfaa3b3c326af3fba3,
-- EXTERNAL_tcad_parcel, owner CTM.Publisher), joined on the permit's own
-- tcad_id = PID_10 (93.3% of recent unlocated permits' ids found, probe run
-- 43623969955). Rows go in parcels / permit_parcels as provider
-- 'austin-parcels', point only: no property facts are read from it.

INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled, role,
                     terms_url, terms_reviewed_on, terms_reviewed_by, automated_access, redistribution, attribution_text)
SELECT 'austin-parcels', j.id, 'arcgis',
       'https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/EXTERNAL_tcad_parcel/FeatureServer/0',
       'snapshot', '15 17 * * *', interval '1 day', true, 'enrichment',
       'https://www.arcgis.com/home/item.html?id=6f5f919cf5c948cfaa3b3c326af3fba3',
       -- Read 2026-11-14: the item's licence text is a disclaimer only (for
       -- informational purposes, approximate boundaries, no warranty); no
       -- licence grant or restriction. Public item, no login.
       DATE '2026-11-14', 'claude (not legal advice)', 'unknown', 'unknown',
       'City of Austin (Communications and Technology Management), Travis Central Appraisal District parcels. Approximate parcel centroid, not a survey.'
  FROM jurisdictions j WHERE j.slug = 'austin-tx'
ON CONFLICT (slug) DO NOTHING;
