-- Wake County parcels (ADR-23 sprint 1): property facts for Raleigh permits,
-- joined on the permit's own `pin` = the parcel PIN_NUM (283 of 300 recent
-- pins found, feasibility run 43594319991). Rows go in parcels /
-- permit_parcels like the Miami-Dade appraiser's, provider 'wake-parcels'.
-- Owner, mailing, ownership, billing class, deed book/page/date, sale and
-- exemption fields are never requested (src/enrichment/parcels.js).

INSERT INTO jurisdictions (slug, name, kind, state, timezone) VALUES
  ('wake-county-nc', 'Wake County', 'county', 'NC', 'America/New_York')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled, role,
                     terms_url, terms_reviewed_on, terms_reviewed_by, automated_access, redistribution, attribution_text)
SELECT 'wake-parcels', j.id, 'arcgis',
       'https://maps.wake.gov/arcgis/rest/services/Property/Parcels/MapServer/0',
       'snapshot', '15 17 * * *', interval '1 day', true, 'enrichment',
       'https://creativecommons.org/licenses/by/4.0',
       -- Read 2026-11-14: the ArcGIS Hub dataset (item f5ed009c66e844ec82f29064edd95017)
       -- states CC BY 4.0, source Wake County; the item's own licence text is
       -- a liability disclaimer (not a legal document; verify with primary sources).
       DATE '2026-11-14', 'claude (not legal advice)', 'unknown', 'attribution',
       'Wake County Geographic Information Services (CC BY 4.0). Not a legal document; tax values are county estimates.'
  FROM jurisdictions j WHERE j.slug = 'wake-county-nc'
ON CONFLICT (slug) DO NOTHING;
