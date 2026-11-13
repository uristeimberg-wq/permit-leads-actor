-- Travis Central Appraisal District property facts for Austin permits
-- (ADR-15 step 3b). Use rules are in docs/COMPLIANCE.md, "Travis CAD use
-- rules" (PR #38): an allowlist of facts, no owner, deed, exemption or sale
-- fields, confidential parcels skipped whole, values shown as appraisal
-- estimates with their roll year.

INSERT INTO jurisdictions (slug, name, kind, state, timezone) VALUES
  ('travis-county-tx', 'Travis County', 'county', 'TX', 'America/Chicago')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO sources (slug, jurisdiction_id, kind, endpoint_url, sync_mode, schedule_cron, expected_interval, enabled, role,
                     terms_url, terms_reviewed_on, terms_reviewed_by, automated_access, redistribution, attribution_text)
SELECT 'travis-cad', j.id, 'other', 'https://traviscad.org/publicinformation', 'snapshot', '15 17 * * *', interval '1 day', true,
       'enrichment', 'https://traviscad.org/publicinformation',
       -- No terms, licence or login on the page (read 2026-11-13). Released
       -- voluntarily, so Gov't Code §552.007(b) applies (compliance review,
       -- PR #38; not legal advice).
       DATE '2026-11-13', 'claude (not legal advice)', 'unknown', 'unknown',
       'Travis Central Appraisal District. Values are appraisal estimates for the roll year shown.'
  FROM jurisdictions j WHERE j.slug = 'travis-county-tx'
ON CONFLICT (slug) DO NOTHING;

-- Appraisal values. The homestead and non-homestead parts are summed before
-- storage, because the split would reveal an exemption.
ALTER TABLE parcels
  ADD COLUMN land_value        NUMERIC,
  ADD COLUMN improvement_value NUMERIC,
  ADD COLUMN improvement_type  TEXT;
