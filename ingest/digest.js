// Daily customer digests (ADR-20). Runs after the sync in sync.yml.
//
//   node ingest/digest.js                 every due subscription
//   node ingest/digest.js --only=3        one subscription
//
// The provider comes from the environment (src/email/providers.js). With no
// EMAIL_PROVIDER, or without EMAIL_SEND_ENABLED=yes, this is a dry run: each
// email is written to DIGEST_OUT_DIR (default digest-preview/) and nothing is
// sent. Prints a Markdown summary with counts and statuses, never addresses.

const db = require('../db/index.js');
const { providerFromEnv } = require('../src/email/providers.js');
const { runDigests } = require('../src/digest/run.js');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  let provider;
  try {
    provider = providerFromEnv(process.env);
  } catch (err) {
    console.log(`### Digests\n\nNo digest ran (${err.errorClass || 'unknown'}): ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const only = arg('only');
  if (only && !/^\d+$/.test(only)) throw new Error('--only takes a subscription id');
  await db.applySchema();
  const r = await runDigests({ provider, only: only ? Number(only) : null, log: (l) => console.error(l) });
  const by = {};
  for (const x of r.results) by[x.status] = (by[x.status] || 0) + 1;
  const lines = ['### Digests', '', provider.note];
  if (r.linkSecretDev) lines.push('', 'LINK_SECRET is not set: links in these dry-run emails are signed with a dev key and will not open on the web app.');
  lines.push('', `${r.results.length} active subscription(s): ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}.`);
  if (r.results.length) {
    lines.push('', '| Subscription | Market | Status | Items |', '|---|---|---|---|');
    for (const x of r.results) lines.push(`| ${x.subscription} | ${x.market} | ${x.status}${x.errorClass ? ` (${x.errorClass})` : ''} | ${x.items} |`);
  }
  if (provider.mode === 'dry_run') lines.push('', `Rendered emails: ${provider.outDir}/ (uploaded as the digest-preview artifact in Actions).`);
  console.log(lines.join('\n'));
  if (r.failed) process.exitCode = 1;
}

if (require.main === module) {
  main().then(() => db.close()).catch(async (err) => { console.error(err.stack || err.message); await db.close(); process.exit(1); });
}
