// Spot-check of the "Builder" tag on Austin applications (ADR-19).
//
// Question: when the Early screen says a business is the builder on an
// application, is that business the contractor on the building permit the
// city later issued for it? Two measurements:
//
//   1. Population (our database): every application whose shown filer is a
//      builder and that already links to an issued building permit
//      (masterpermitnum = folderrsn). Share where the permit's contractor has
//      the filer's name. Split by the basis of the tag.
//   2. Live sample: 20 of those applications (10 tagged on linked-permit
//      behaviour, 10 on name match), each re-read from the city's own open
//      data (plan review n8ck-xkda, issued permits 3syk-w9eu), so the check
//      does not rest on our copy.
//
// Read-only: SELECTs only, 40 polite requests. Person-looking names are
// printed as "(individual)" (rule 5).
//
//   DATABASE_URL=... node recon/filer_spotcheck.js [--n=20] [--seed=filers-check-1]

const { normalizeName, partyKind } = require('../src/contractors.js');
const { cleanOrgName } = require('../src/filers.js');

/** Same business? Exact normalised name, or one name extends the other ("acme homes" / "acme homes of texas"). */
function sameBusiness(a, b) {
  const x = normalizeName(cleanOrgName(a)); const y = normalizeName(cleanOrgName(b));
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.split(' ').length >= 2 && l.startsWith(`${s} `);
}

/**
 * correct | wrong | no_permit | filer_missing, from the live rows.
 * @param {string} filer          the business we show
 * @param {object[]} reviewRows   live n8ck-xkda rows for the folderrsn
 * @param {object[]} bpRows       live 3syk-w9eu rows with masterpermitnum = folderrsn
 */
function verdict(filer, reviewRows, bpRows) {
  const named = reviewRows.some((r) => [r.applicant_organization_name, r.other_organization_name].some((n) => sameBusiness(n, filer)));
  if (!named) return { verdict: 'filer_missing', contractor: null };
  const bps = bpRows.filter((r) => String(r.permittype || '').toUpperCase() === 'BP' || /\bBP$/.test(r.permit_number || ''));
  if (!bps.length) return { verdict: 'no_permit', contractor: null };
  const hit = bps.find((r) => sameBusiness(r.contractor_company_name, filer));
  return hit ? { verdict: 'correct', contractor: hit.contractor_company_name, permit: hit.permit_number }
    : { verdict: 'wrong', contractor: bps[0].contractor_company_name || null, permit: bps[0].permit_number };
}

const shown = (name) => (name == null ? '(none)' : partyKind(name) === 'business' ? name : '(individual)');

const POPULATION_SQL = `
  WITH builder_apps AS (
    SELECT DISTINCT ON (ff.permit_id) ff.permit_id, o.org_key, o.display_name,
           CASE WHEN o.basis LIKE 'same name%' THEN 'name' ELSE 'behaviour' END AS basis_kind
      FROM filing_filers ff JOIN filer_orgs o ON o.org_key = ff.org_key
     WHERE o.role = 'builder' AND o.party_kind = 'business'
     ORDER BY ff.permit_id, o.org_key),
  checked AS (
    SELECT b.*, k.to_permit_id,
           bool_or(c.normalized_name = b.org_key) OVER (PARTITION BY b.permit_id) AS any_same
      FROM builder_apps b
      LEFT JOIN permit_links k ON k.from_permit_id = b.permit_id
      LEFT JOIN permit_parties pp ON pp.permit_id = k.to_permit_id AND pp.role = 'contractor' AND pp.is_building
      LEFT JOIN contractors c ON c.id = pp.contractor_id)
  SELECT basis_kind,
         count(DISTINCT permit_id)::int AS applications,
         count(DISTINCT permit_id) FILTER (WHERE to_permit_id IS NOT NULL)::int AS with_permit,
         count(DISTINCT permit_id) FILTER (WHERE any_same)::int AS same_contractor
    FROM checked GROUP BY 1 ORDER BY 1`;

const SAMPLE_SQL = `
  WITH builder_apps AS (
    SELECT DISTINCT ON (ff.permit_id) ff.permit_id, ff.raw_record_id, o.org_key, o.display_name, o.basis,
           CASE WHEN o.basis LIKE 'same name%' THEN 'name' ELSE 'behaviour' END AS basis_kind
      FROM filing_filers ff JOIN filer_orgs o ON o.org_key = ff.org_key
     WHERE o.role = 'builder' AND o.party_kind = 'business'
       AND EXISTS (SELECT 1 FROM permit_links k WHERE k.from_permit_id = ff.permit_id)
     ORDER BY ff.permit_id, o.org_key),
  ranked AS (
    SELECT b.*, p.permit_number, p.permit_url, r.payload ->> 'folderrsn' AS folderrsn,
           row_number() OVER (PARTITION BY b.basis_kind ORDER BY md5(p.permit_number || $2)) AS n
      FROM builder_apps b JOIN permits p ON p.id = b.permit_id JOIN raw_records r ON r.id = b.raw_record_id)
  SELECT * FROM ranked WHERE n <= $1 ORDER BY basis_kind, n`;

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
  const n = Number(args.n || 20);
  const seed = String(args.seed || 'filers-check-1');
  const db = require('../db/index.js');
  const UA = 'permit-leads-feasibility/0.1 (research; read-only)';
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let last = 0;
  async function getJson(url, attempts = 4) {
    for (let i = 1; ; i += 1) {
      const wait = 500 - (Date.now() - last); if (wait > 0) await sleep(wait); last = Date.now();
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        return JSON.parse(text);
      } catch (err) {
        if (i >= attempts) throw new Error(`${err.message} <- ${url}`);
        await sleep(2000 * 2 ** (i - 1));
      }
    }
  }
  const soql = (domain, id, where, select) => `https://${domain}/resource/${id}.json?${new URLSearchParams({ $where: where, $select: select, $limit: '50' })}`;

  try {
    const { rows: pop } = await db.query(POPULATION_SQL);
    const { rows: sample } = await db.query(SAMPLE_SQL, [Math.ceil(n / 2), seed]);
    const out = ['## Builder tag spot-check (ADR-19)', '', '### Population (our database)', '',
      '| Basis | Applications shown as builder | With an issued building permit | Permit contractor has the filer\'s name | Share |', '| --- | --- | --- | --- | --- |'];
    for (const p of pop) {
      out.push(`| ${p.basis_kind} | ${p.applications} | ${p.with_permit} | ${p.same_contractor} | ${p.with_permit ? `${((100 * p.same_contractor) / p.with_permit).toFixed(1)}%` : 'n/a'} |`);
    }
    out.push('', `### Live sample (${sample.length} applications, seed \`${seed}\`), re-read from the city's open data`, '',
      '| # | Basis | Application | Filer we show | Issued permit | Permit contractor (live) | Verdict |', '| --- | --- | --- | --- | --- | --- | --- |');
    const tally = {};
    for (const [i, s] of sample.entries()) {
      if (!/^\d+$/.test(s.folderrsn || '')) { out.push(`| ${i + 1} | ${s.basis_kind} | ${s.permit_number} | ${s.display_name} | | | no folderrsn |`); continue; }
      const review = await getJson(soql('datahub.austintexas.gov', 'n8ck-xkda', `folderrsn=${s.folderrsn}`, 'permit_number,folderrsn,applicant_organization_name,other_organization_name'));
      const bps = await getJson(soql('data.austintexas.gov', '3syk-w9eu', `masterpermitnum='${s.folderrsn}'`, 'permit_number,permittype,contractor_company_name,issue_date'));
      const v = verdict(s.display_name, review, bps);
      tally[s.basis_kind] = tally[s.basis_kind] || {};
      tally[s.basis_kind][v.verdict] = (tally[s.basis_kind][v.verdict] || 0) + 1;
      out.push(`| ${i + 1} | ${s.basis_kind} | [${s.permit_number}](${s.permit_url || ''}) | ${s.display_name} | ${v.permit || ''} | ${shown(v.contractor)} | **${v.verdict}** |`);
    }
    out.push('', '### Live sample verdicts', '');
    for (const [k, t] of Object.entries(tally)) out.push(`- ${k}: ${Object.entries(t).map(([a, b]) => `${a} ${b}`).join(', ')}`);
    console.log(out.join('\n'));
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
}

module.exports = { sameBusiness, verdict };
