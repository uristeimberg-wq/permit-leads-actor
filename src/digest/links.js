// Signed, no-login links in digest emails (ADR-20). Pure functions.
//
// Two kinds:
//   j  a job link: opens one permit or filing, for one subscription, until it
//      expires. It grants nothing else: no other permit, no app screens.
//   u  an unsubscribe link: never expires (CAN-SPAM: the opt-out must keep
//      working for at least 30 days after the send; we keep it forever).
//
// Token: v1.<kind>.<subscriptionId>.<targetId>.<expiresAt or 0>.<hmac>
// The HMAC (SHA-256, base64url, 22 chars = 128 bits) covers everything before
// it, keyed with LINK_SECRET. Comparison is constant-time. Ids are plain
// integers, so a token reveals a permit id and a subscription number but no
// email address or name.

const crypto = require('node:crypto');

const VERSION = 'v1';
const JOB_LINK_DAYS = 60;
const DEV_SECRET = 'dev-only-link-secret-not-for-production';
const MIN_SECRET_LENGTH = 32;

/**
 * The signing key. A real send needs LINK_SECRET (32+ characters), the same
 * value on the sender (GitHub Actions) and the web app (Railway) that checks
 * the links. A dry run without one signs with a dev key and says so.
 */
function linkSecret(env = process.env, { required = false } = {}) {
  const s = env.LINK_SECRET || '';
  if (s.length >= MIN_SECRET_LENGTH) return { secret: s, dev: false };
  if (required) {
    throw Object.assign(new Error(`LINK_SECRET must be set to ${MIN_SECRET_LENGTH}+ characters before real sends`), { errorClass: 'config' });
  }
  return { secret: DEV_SECRET, dev: true };
}

const mac = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('base64url').slice(0, 22);

function sign(secret, { kind, subscriptionId, targetId = 0, expiresAt = 0 }) {
  if (!['j', 'u'].includes(kind)) throw new Error(`unknown link kind ${kind}`);
  for (const [k, v] of Object.entries({ subscriptionId, targetId, expiresAt })) {
    if (!Number.isSafeInteger(Number(v)) || Number(v) < 0) throw new Error(`bad ${k}`);
  }
  const body = [VERSION, kind, Number(subscriptionId), Number(targetId), Math.floor(Number(expiresAt) / 1000)].join('.');
  return `${body}.${mac(secret, body)}`;
}

/** The decoded token, or null when it is malformed, tampered with or expired. */
function verify(secret, token, { now = Date.now() } = {}) {
  const m = /^(v1)\.([ju])\.(\d{1,18})\.(\d{1,18})\.(\d{1,12})\.([\w-]{22})$/.exec(String(token || ''));
  if (!m) return null;
  const body = m.slice(1, 6).join('.');
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(m[6]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const expiresAt = Number(m[5]) * 1000;
  if (expiresAt && expiresAt < now) return null;
  return { kind: m[2], subscriptionId: Number(m[3]), targetId: Number(m[4]), expiresAt: expiresAt || null };
}

/** Absolute URLs for one subscription's email. */
function linkMaker({ secret, baseUrl, subscriptionId, now = Date.now() }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return {
    job: (permitId) => `${base}/l/${sign(secret, { kind: 'j', subscriptionId, targetId: permitId, expiresAt: now + JOB_LINK_DAYS * 86400000 })}`,
    unsubscribe: () => `${base}/u/${sign(secret, { kind: 'u', subscriptionId })}`,
  };
}

module.exports = { sign, verify, linkSecret, linkMaker, JOB_LINK_DAYS, DEV_SECRET, MIN_SECRET_LENGTH };
