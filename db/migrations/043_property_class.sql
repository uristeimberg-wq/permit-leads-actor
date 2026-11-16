-- 043: residential or non-residential, as the source classes the property.
--
-- Four permit sources publish a class column (src/sources.js propertyClass):
-- Austin permit_class_mapped, Miami-Dade ResidentialCommercial, City of
-- Miami PropertyType, Raleigh permitclassmapped. Value sets measured on the
-- stored raw records 2026-11-16 (counts in src/sources.js). A source with no
-- class column, or an unmapped word, stays NULL ("not published").
--
-- Backfill reads the latest raw record of each permit. Permits with no raw
-- record get their class when the sync or the rolling re-read
-- (ingest/refresh.js) next reads them.

ALTER TABLE permits ADD COLUMN IF NOT EXISTS property_class text
  CHECK (property_class IN ('residential', 'non_residential'));

WITH latest AS (
  SELECT DISTINCT ON (p.id) p.id, p.source_area, r.payload
    FROM permits p
    JOIN sources s ON s.slug = p.source_area
    JOIN raw_records r ON r.source_id = s.id AND r.source_key = p.permit_number
   WHERE p.source_area IN ('austin-tx', 'miami-dade-fl', 'miami-city-fl', 'raleigh-nc')
   ORDER BY p.id, r.id DESC
), classed AS (
  SELECT id,
         CASE source_area
           WHEN 'austin-tx' THEN CASE trim(payload->>'permit_class_mapped')
             WHEN 'Residential' THEN 'residential' WHEN 'Commercial' THEN 'non_residential' END
           WHEN 'miami-dade-fl' THEN CASE trim(payload->>'ResidentialCommercial')
             WHEN 'R' THEN 'residential' WHEN 'C' THEN 'non_residential' END
           WHEN 'miami-city-fl' THEN CASE trim(payload->>'PropertyType')
             WHEN 'Residential' THEN 'residential' WHEN 'Commercial' THEN 'non_residential' END
           WHEN 'raleigh-nc' THEN CASE trim(payload->>'permitclassmapped')
             WHEN 'Residential' THEN 'residential' WHEN 'Non-Residential' THEN 'non_residential' END
         END AS cls
    FROM latest
)
UPDATE permits p SET property_class = c.cls
  FROM classed c
 WHERE p.id = c.id AND c.cls IS NOT NULL AND p.property_class IS DISTINCT FROM c.cls;
