// What a change to src/contractors.js partyKind would make visible (rule 5).
// Compares the party_kind stored by the last resolver run with what the
// current code says for the same names. Read-only; run it after merging a
// change and before the next sync re-resolves.
//
//   DATABASE_URL=... node recon/party_kind_diff.js [--sample=40]

const { partyKind } = require('../src/contractors.js');

function diff(rows) {
  const out = { total: rows.length, toBusiness: [], fromBusiness: [] };
  for (const r of rows) {
    const now = partyKind(r.name);
    if (r.stored !== 'business' && now === 'business') out.toBusiness.push(r);
    if (r.stored === 'business' && now !== 'business') out.fromBusiness.push(r);
  }
  return out;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const sample = Number(args.sample || 40);
  const db = require('../db/index.js');
  try {
    const { rows: contractors } = await db.query(`
      SELECT c.display_name AS name, c.party_kind AS stored, c.permit_count AS permits,
             (SELECT count(*)::int FROM contact_points cp WHERE cp.contractor_id = c.id AND cp.kind = 'phone') AS phones
        FROM contractors c WHERE c.permit_count > 0`);
    const { rows: filers } = await db.query("SELECT display_name AS name, party_kind AS stored, filings AS permits, 0 AS phones FROM filer_orgs WHERE contractor_id IS NULL");
    const c = diff(contractors); const f = diff(filers);
    const sum = (xs, k) => xs.reduce((a, x) => a + Number(x[k] || 0), 0);
    const lines = ['## Person-name filter change: what becomes visible', '',
      '| Who | Names checked | Become visible (business) | Their permits or filings | Their phones | Become hidden |', '| --- | --- | --- | --- | --- | --- |',
      `| Contractors | ${c.total} | ${c.toBusiness.length} | ${sum(c.toBusiness, 'permits')} | ${sum(c.toBusiness, 'phones')} | ${c.fromBusiness.length} |`,
      `| Application filers (no contractor match) | ${f.total} | ${f.toBusiness.length} | ${sum(f.toBusiness, 'permits')} | n/a | ${f.fromBusiness.length} |`,
      '', `### Top ${sample} newly visible names by permits (check none is a person)`, ''];
    for (const r of [...c.toBusiness, ...f.toBusiness].sort((a, b) => b.permits - a.permits).slice(0, sample)) lines.push(`- ${r.name} (${r.permits}, was ${r.stored})`);
    console.log(lines.join('\n'));
  } finally {
    await db.close();
  }
}

if (require.main === module) main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });

module.exports = { diff };
