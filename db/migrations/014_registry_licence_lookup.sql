-- The licence-linked phone lookup (db/pilot_queries.js BEST_PHONE) goes from a
-- licence to the other contractors holding it.
CREATE INDEX contractor_registry_licences_licence ON contractor_registry_licences (licence_id, match_rule);
