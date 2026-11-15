// The Contractors tab: one row per company on the permits in the current
// filters, with its phone, licence, registration and activity.
//
// Duplicates: the resolver already makes one contractor per licence number or
// per normalized name within a state (src/contractors.js). Here rows are also
// merged when they share a normalized name (case, LLC/Inc. and punctuation
// ignored) across states, or a licence number recorded on their permits.
// Never by phone: 77 phone numbers are shared by two or more different
// companies (permit runners, answering services), so a phone is not an identity.
//
// Licence and registration records matched by business name or by phone are
// inferences (docs/DATA_TRUST_AUDIT.md class C): shown only with
// SHOW_INFERENCES=1, and always with how they were matched. A licence matched
// by the permit's own licence number is a fact and always shown.

const PROVIDER = { 'tx-tdlr': 'Texas TDLR', 'fl-dbpr': 'Florida DBPR', 'tx-comptroller': 'Texas franchise tax', 'fl-sunbiz': 'Florida Sunbiz' };
const MATCH = { licence: 'licence number on the permit', name_state: 'same business name in the state', name_state_active: 'same business name in the state', phone: 'same phone number' };

// Some portals append a branch marker to the company name ("Joseph Design
// Build**MAIN***"); it is noise to a reader, so it is dropped for display.
const cleanName = (n) => String(n || '').replace(/\s*\*+\s*MAIN\s*\*+\s*/gi, ' ').replace(/\s+/g, ' ').trim() || n;

/** Union rows sharing a normalized name or a licence number. */
function merge(rows) {
  const parent = rows.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const seen = new Map();
  rows.forEach((r, i) => {
    const keys = [];
    if (r.normalized_name) keys.push(`n|${r.normalized_name}`);
    for (const l of r.licences || []) keys.push(`l|${String(l).toUpperCase().replace(/\s+/g, ' ')}`);
    for (const k of keys) { if (seen.has(k)) union(i, seen.get(k)); else seen.set(k, i); }
  });
  const groups = new Map();
  rows.forEach((r, i) => { const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); });
  return [...groups.values()].map((members) => {
    members.sort((a, b) => b.permits - a.permits);
    const lead = members[0];
    const names = [...new Set(members.map((m) => cleanName(m.display_name)))];
    return {
      ids: members.map((m) => String(m.id)),
      name: cleanName(lead.display_name),
      aliases: names.slice(1),
      state: lead.business_state || null,
      trade: lead.primary_trade || null,
      permits: members.reduce((n, m) => n + m.permits, 0),
      active: members.reduce((n, m) => n + m.active, 0),
      activeValue: members.reduce((n, m) => n + (Number(m.active_value) || 0), 0) || null,
      latest: members.reduce((d, m) => (m.latest && (!d || m.latest > d) ? m.latest : d), null),
      licences: [...new Set(members.flatMap((m) => m.licences || []))],
    };
  });
}

const SORTERS = {
  active: (a, b) => b.active - a.active || (b.activeValue || 0) - (a.activeValue || 0) || String(b.latest).localeCompare(String(a.latest)),
  value: (a, b) => (b.activeValue || 0) - (a.activeValue || 0) || b.active - a.active,
  recent: (a, b) => String(b.latest || '').localeCompare(String(a.latest || '')) || b.active - a.active,
};

/**
 * A page of contractors. `deps`: { rows (contractorsInFilters), phonesById
 * (pilot_queries.contractorsById), recordsFor (contractorRecords) }.
 */
async function listContractors({ rows, phonesById, recordsFor }, { sort = 'active', page = 1, pageSize = 25, inferences = false } = {}) {
  const all = merge(rows).sort(SORTERS[sort] || SORTERS.active);
  const pageRows = all.slice((page - 1) * pageSize, page * pageSize);
  const ids = pageRows.flatMap((r) => r.ids);
  const [phones, records] = await Promise.all([phonesById(ids), recordsFor(ids)]);
  const keep = (rec) => inferences || rec.match_rule === 'licence';
  const results = pageRows.map((r) => {
    const phone = r.ids.map((id) => phones.get(id)).map((c) => c && c.phone).find(Boolean) || null;
    const registry = records.registry.filter((x) => r.ids.includes(String(x.contractor_id)) && keep(x)).map((x) => ({
      provider: PROVIDER[x.provider] || x.provider, number: x.licence_number, type: x.licence_type,
      status: x.primary_status || null, expires: x.expires_on || null, fileDate: x.file_date || null,
      matchedBy: MATCH[x.match_rule] || x.match_rule, official: x.match_rule === 'licence',
    }));
    const registrations = inferences ? records.registrations.filter((x) => r.ids.includes(String(x.contractor_id))).map((x) => ({
      provider: PROVIDER[x.provider] || x.provider, name: x.legal_name, status: x.sos_status || x.right_to_transact || null,
      asOf: x.source_as_of || null, matchedBy: MATCH[x.match_rule] || x.match_rule,
    })) : [];
    return { ...r, phone: phone ? { value: phone.value, verification: phone.verification, seenOnPermits: phone.seenOnPermits } : null, registry, registrations };
  });
  return { results, total: all.length, page, pageSize };
}

module.exports = { merge, listContractors, cleanName, SORTERS };
