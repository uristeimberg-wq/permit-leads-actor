// Invite codes for the hosted app (ADR-27).
//
//   npm run invite -- --label="who it is for"   create one; prints the code once
//   npm run invite -- --list                     invites, sign-ins and industries given
//   npm run invite -- --revoke=<id>              stop a code (open sessions end within a minute)
//
// Only the code's SHA-256 is stored, so a lost code cannot be shown again:
// revoke it and create another.

const db = require('../db/index.js');
const { newCode, hashCode, INDUSTRIES } = require('../web/invites.js');

const arg = (name) => {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};

async function create(label) {
  const code = newCode();
  const { rows: [r] } = await db.query('INSERT INTO access_invites (code_hash, label) VALUES ($1, $2) RETURNING id',
    [hashCode(code), typeof label === 'string' ? label.slice(0, 200) : null]);
  console.log(`Invite ${r.id} created. Code (shown once): ${code}`);
}

async function list() {
  const { rows } = await db.query(`
    SELECT i.id, i.label, i.created_at, i.revoked_at, count(s.id)::int AS signins, max(s.signed_in_at) AS last_in,
           string_agg(DISTINCT coalesce(s.industry_other, s.industry), ', ') AS industries
      FROM access_invites i LEFT JOIN access_signins s ON s.invite_id = i.id
     GROUP BY i.id ORDER BY i.id`);
  for (const r of rows) {
    console.log([`#${r.id}`, r.label || '(no label)', r.revoked_at ? 'REVOKED' : 'live', `${r.signins} sign-ins`,
      r.last_in ? `last ${r.last_in.toISOString().slice(0, 10)}` : 'never signed in', r.industries ? `industry: ${r.industries}` : ''].filter(Boolean).join(' · '));
  }
  const { rows: ind } = await db.query(`SELECT coalesce(industry, '') AS k, count(*)::int AS n FROM access_signins GROUP BY 1 ORDER BY 2 DESC`);
  console.log(`Sign-ins by industry: ${ind.map((x) => `${INDUSTRIES[x.k] || x.k} ${x.n}`).join(', ') || 'none yet'}`);
}

async function revoke(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('--revoke needs an invite id');
  const { rowCount } = await db.query('UPDATE access_invites SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [Number(id)]);
  console.log(rowCount ? `Invite ${id} revoked.` : `Invite ${id} not found or already revoked.`);
}

async function main() {
  await db.applySchema();
  if (arg('revoke') !== undefined) await revoke(arg('revoke'));
  else if (arg('list')) await list();
  else await create(arg('label'));
  await db.close();
}

main().catch(async (err) => {
  console.error(err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
