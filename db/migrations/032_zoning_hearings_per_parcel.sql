-- 032: Miami-Dade zoning hearing applications are one row per parcel (951
-- rows for 578 process numbers on the first read, 2026-11-14). Cases are now
-- keyed by process number and folio; the 578 stored under the process number
-- alone kept one parcel each and are removed. Their raw records stay, and the
-- next daily full read stores every parcel under the new key.
DELETE FROM planning_cases
 WHERE source_area = 'miami-dade-zoning-hearings-fl'
   AND case_number NOT LIKE '% | %';
