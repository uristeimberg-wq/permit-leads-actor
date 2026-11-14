// Invite codes for the hosted app (ADR-27). The gate (web/access.js) asks
// this store two things: is this code a live invite, and record a sign-in.
// Only a code's SHA-256 is stored, so a database copy cannot sign anyone in.

const crypto = require('node:crypto');

// "Your industry" on the sign-in page. Optional, and never used to change
// what anyone sees: it only tells us who uses the data.
const INDUSTRIES = {
  '': 'Prefer not to say',
  subcontractor: 'Specialty or trade contractor',
  builder: 'General contractor or builder',
  supplier: 'Supplier or distributor',
  insurance: 'Insurance',
  real_estate: 'Real estate or investor',
  finance: 'Lender or finance',
  services: 'Home or property services',
  public: 'Government, research or media',
  other: 'Other',
};

const hashCode = (code) => crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest();

/** A new code: 12 characters from an alphabet without look-alikes, grouped for reading aloud. */
function newCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  const s = [...bytes].map((b) => abc[b % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** Industry fields from a form, cleaned: unknown values become NULL. */
function cleanIndustry(body = {}) {
  const industry = Object.prototype.hasOwnProperty.call(INDUSTRIES, body.industry) && body.industry ? body.industry : null;
  const other = industry === 'other' ? String(body.industryOther || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null : null;
  return { industry, industryOther: other };
}

/** The store over Postgres. `query` is db/index.js query. */
function pgStore(query) {
  return {
    async find(code) {
      const norm = String(code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(norm)) return null;
      const { rows: [r] } = await query('SELECT id FROM access_invites WHERE code_hash = $1 AND revoked_at IS NULL', [hashCode(norm)]);
      return r ? { id: Number(r.id) } : null;
    },
    async isLive(id) {
      const { rows: [r] } = await query('SELECT 1 FROM access_invites WHERE id = $1 AND revoked_at IS NULL', [id]);
      return Boolean(r);
    },
    async record({ inviteId, industry, industryOther }) {
      await query('INSERT INTO access_signins (invite_id, industry, industry_other) VALUES ($1, $2, $3)', [inviteId, industry, industryOther]);
    },
  };
}

module.exports = { INDUSTRIES, hashCode, newCode, cleanIndustry, pgStore };
