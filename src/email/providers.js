// Email providers behind one interface (ADR-20): send(msg) -> { id }.
//
//   dryrun    the default. Writes each email to DIGEST_OUT_DIR as .html, .txt
//             and .json (headers) and sends nothing. Needs no account.
//   resend    https://resend.com, POST /emails.
//   postmark  https://postmarkapp.com, POST /email.
//
// Real sending is off unless EMAIL_SEND_ENABLED=yes AND every setting a lawful
// send needs is present (see liveConfigProblems): a provider key, a From
// address on a verified domain, the postal address CAN-SPAM requires, a link
// secret and the https base URL the links point to. Anything missing makes
// the run refuse, with the list of what is missing, rather than send a
// half-compliant email. EMAIL_ALLOWLIST (comma-separated) restricts real
// sends to those addresses, for a first test to your own inbox.
//
// Errors carry errorClass: config | auth | rate_limit | rejected |
// provider_down | network | unknown (rule 3).

const fs = require('node:fs');
const path = require('node:path');
const { MIN_SECRET_LENGTH } = require('../digest/links.js');

const PROVIDERS = ['dryrun', 'resend', 'postmark'];

class SendError extends Error {
  constructor(message, errorClass, status) {
    super(message);
    this.errorClass = errorClass;
    this.status = status;
  }
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'provider_down';
  if (status >= 400) return 'rejected';
  return 'unknown';
}

const parseList = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** What stops a real send, in words. Empty means ready. */
function liveConfigProblems(env = process.env) {
  const p = [];
  if (!PROVIDERS.slice(1).includes(env.EMAIL_PROVIDER)) p.push('EMAIL_PROVIDER must be resend or postmark');
  if (!env.EMAIL_API_KEY) p.push('EMAIL_API_KEY (the provider API key, a secret) is not set');
  if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$|<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/.test(env.EMAIL_FROM || '')) p.push('EMAIL_FROM (e.g. "Contractos <digest@mail.example.com>") is not set or not an address');
  if (!env.MAILING_ADDRESS || env.MAILING_ADDRESS.trim().length < 10) p.push('MAILING_ADDRESS (a valid postal address, required by CAN-SPAM) is not set');
  if (!env.LINK_SECRET || env.LINK_SECRET.length < MIN_SECRET_LENGTH) p.push(`LINK_SECRET (${MIN_SECRET_LENGTH}+ random characters, same value in Railway) is not set`);
  if (!/^https:\/\/[^\s/]+/.test(env.PUBLIC_BASE_URL || '')) p.push('PUBLIC_BASE_URL (the https address of the web app) is not set');
  return p;
}

function dryRunProvider({ outDir }) {
  let n = 0;
  return {
    name: 'dryrun',
    mode: 'dry_run',
    outDir,
    async send(msg) {
      fs.mkdirSync(outDir, { recursive: true });
      n += 1;
      const base = path.join(outDir, String(msg.key || `email-${n}`).replace(/[^\w.-]/g, '_'));
      fs.writeFileSync(`${base}.html`, msg.html);
      fs.writeFileSync(`${base}.txt`, msg.text);
      fs.writeFileSync(`${base}.json`, JSON.stringify({ to: msg.to, from: msg.from, replyTo: msg.replyTo || null, subject: msg.subject, headers: msg.headers }, null, 2));
      return { id: `dry-run:${path.basename(base)}` };
    },
  };
}

async function post(fetchImpl, url, headers, body) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body) });
  } catch (err) {
    throw new SendError(`network error: ${err.message}`, 'network');
  }
  let json = null;
  try { json = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    // The provider's message, never our API key or the email body.
    const why = json && (json.message || json.Message || json.name) ? String(json.message || json.Message || json.name).slice(0, 300) : `HTTP ${res.status}`;
    throw new SendError(why, classifyStatus(res.status), res.status);
  }
  return json || {};
}

function resendProvider({ apiKey, fetchImpl }) {
  return {
    name: 'resend',
    mode: 'live',
    async send(msg) {
      const json = await post(fetchImpl, 'https://api.resend.com/emails', {
        authorization: `Bearer ${apiKey}`,
        // Resend drops a repeat with the same key for 24 hours, so a retried
        // run cannot double-send one digest.
        ...(msg.key ? { 'idempotency-key': String(msg.key) } : {}),
      }, {
        from: msg.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text,
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
        headers: msg.headers,
        tags: [{ name: 'kind', value: 'digest' }],
      });
      if (!json.id) throw new SendError('Resend returned no message id', 'unknown');
      return { id: String(json.id) };
    },
  };
}

function postmarkProvider({ apiKey, fetchImpl, stream }) {
  return {
    name: 'postmark',
    mode: 'live',
    async send(msg) {
      const json = await post(fetchImpl, 'https://api.postmarkapp.com/email', { 'x-postmark-server-token': apiKey }, {
        From: msg.from, To: msg.to, Subject: msg.subject, HtmlBody: msg.html, TextBody: msg.text,
        ...(msg.replyTo ? { ReplyTo: msg.replyTo } : {}),
        Headers: Object.entries(msg.headers || {}).map(([Name, Value]) => ({ Name, Value })),
        MessageStream: stream, Tag: 'digest', TrackOpens: false, TrackLinks: 'None',
      });
      if (json.ErrorCode) throw new SendError(String(json.Message || `Postmark error ${json.ErrorCode}`), 'rejected');
      if (!json.MessageID) throw new SendError('Postmark returned no message id', 'unknown');
      return { id: String(json.MessageID) };
    },
  };
}

/**
 * The provider for this run, from the environment.
 * @returns {{ name, mode: 'dry_run'|'live', send, allowlist: string[], from, replyTo, note }}
 */
function providerFromEnv(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const wanted = env.EMAIL_PROVIDER || 'dryrun';
  if (!PROVIDERS.includes(wanted)) throw new SendError(`EMAIL_PROVIDER=${wanted} is not one of ${PROVIDERS.join(', ')}`, 'config');
  const from = env.EMAIL_FROM || 'Contractos <digest@example.invalid>';
  const replyTo = env.EMAIL_REPLY_TO || null;
  const allowlist = parseList(env.EMAIL_ALLOWLIST);
  const outDir = env.DIGEST_OUT_DIR || 'digest-preview';

  if (wanted === 'dryrun' || env.EMAIL_SEND_ENABLED !== 'yes') {
    const note = wanted === 'dryrun'
      ? 'Dry run: no provider configured; emails are written to files, nothing is sent.'
      : `Dry run: EMAIL_PROVIDER=${wanted} but EMAIL_SEND_ENABLED is not "yes"; nothing is sent.`;
    return { ...dryRunProvider({ outDir }), allowlist, from, replyTo, note };
  }
  const problems = liveConfigProblems(env);
  if (problems.length) throw new SendError(`Real sends refused until these are set:\n- ${problems.join('\n- ')}`, 'config');
  const p = wanted === 'resend'
    ? resendProvider({ apiKey: env.EMAIL_API_KEY, fetchImpl })
    : postmarkProvider({ apiKey: env.EMAIL_API_KEY, fetchImpl, stream: env.POSTMARK_STREAM || 'broadcast' });
  const note = `Live: sending through ${p.name}${allowlist.length ? ` to the ${allowlist.length} allowlisted address(es) only` : ''}.`;
  return { ...p, allowlist, from, replyTo, note };
}

module.exports = { providerFromEnv, liveConfigProblems, dryRunProvider, resendProvider, postmarkProvider, SendError, classifyStatus, PROVIDERS };
