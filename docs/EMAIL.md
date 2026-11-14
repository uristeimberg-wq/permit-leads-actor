# Customer email digests: setup and operation

ADR-20. The digest runs as the last step of the daily sync
(`.github/workflows/sync.yml`, 17:15 UTC). **Until every step below is done it
is a dry run**: it renders each email, records it as `rendered`, uploads the
HTML as the `digest-preview` artifact on the run, and sends nothing.

## What the owner sets up before the first real send

Values marked *secret* go in GitHub under Settings > Secrets and variables >
Actions > **Secrets**; the rest under the **Variables** tab of the same page.
Two of them also go in Railway (service > Variables), because the web app
checks the links.

### 1. A sending domain

Buy a domain you will keep (any registrar). Send from a subdomain, for example
`mail.yourdomain.com`, so a deliverability problem never touches the mail you
send and receive at the root domain.

### 2. A provider account (Resend recommended)

| | Resend | Postmark |
| --- | --- | --- |
| Free tier (check their pricing page; it changes) | about 3,000 emails/month, 100/day | about 100 emails/month |
| Setting `EMAIL_PROVIDER` | `resend` | `postmark` |
| Notes | Simplest setup; one API key | Strong deliverability reputation; set `POSTMARK_STREAM` to your broadcast stream id (default `broadcast`) and set its unsubscribe handling to "None", since every email already carries ours |

Either works; switching later is one variable. Add the sending subdomain in
the provider's dashboard ("Domains"). It then shows the exact DNS records.

### 3. DNS records (at your registrar or DNS host)

Copy the exact names and values from the provider's dashboard. Typically:

- **DKIM**: one or more TXT (Resend: `resend._domainkey.mail`) or CNAME
  records. This signs the email.
- **SPF / return path**: Resend asks for an MX and a TXT record on a `send`
  subdomain; Postmark asks for a CNAME (`pm-bounces`). This lets bounces come
  back to the provider.
- **DMARC**: a TXT record at `_dmarc.yourdomain.com`, for example
  `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`. Gmail and Yahoo require
  one for bulk senders. Start with `p=none`, tighten later.

Wait until the dashboard says the domain is verified (minutes to a few hours).

### 4. GitHub settings

| Name | Where | Value |
| --- | --- | --- |
| `EMAIL_API_KEY` | secret | the provider API key (Resend: a "sending access" key for that domain only; Postmark: the server token) |
| `LINK_SECRET` | secret, **and Railway** | 32+ random characters, the same in both places. Generate with `openssl rand -base64 32`. Changing it breaks the links in emails already sent |
| `EMAIL_PROVIDER` | variable | `resend` or `postmark` |
| `EMAIL_FROM` | variable | `Contractos <digest@mail.yourdomain.com>` (must be on the verified domain) |
| `EMAIL_REPLY_TO` | variable | an inbox someone reads, optional but recommended |
| `CONTACT_EMAIL` | variable | the address shown for questions and removal requests |
| `MAILING_ADDRESS` | variable | a valid postal address, required by CAN-SPAM (a street address, a PO box or a registered commercial mailbox) |
| `PUBLIC_BASE_URL` | variable, **and Railway** | the web app's https address, today `https://permits-production-9581a3c0.up.railway.app` (also the default) |
| `EMAIL_ALLOWLIST` | variable | for the first test: your own address only. Remove it to send to every subscriber |
| `EMAIL_SEND_ENABLED` | variable | `yes` turns real sending on. Set it last |

If `EMAIL_SEND_ENABLED=yes` but anything above is missing, the run sends
nothing and lists what is missing in the job summary.

### 5. First real send (needs the owner's go-ahead)

1. Add yourself: `npm run digest:subscribe -- --email=you@... --area=austin-tx --trades=electrical --early=homes`
   (against the production `DATABASE_URL`).
2. Set `EMAIL_ALLOWLIST` to your address and `EMAIL_SEND_ENABLED=yes`.
3. Run the `sync` workflow by hand (Actions > sync > Run workflow), or wait
   for 17:15 UTC. Check the email on your phone, tap a call button, open a
   job link without being signed in, and unsubscribe once to see it work.
4. Re-subscribe yourself (lift the row: `UPDATE email_suppressions SET
   lifted_at = now() WHERE email = 'you@...'` then `--resume`), add the
   customers, and remove `EMAIL_ALLOWLIST`.

## Day to day

```bash
npm run digest:subscribe -- --list                                  # who gets what, last email, suppressed?
npm run digest:subscribe -- --email=ops@acme.com --area=austin-tx \
     --trades=electrical,plumbing --early=homes --company="Acme Electric"
npm run digest:subscribe -- --email=ops@acme.com --frequency=weekly --weekday=1 ...   # Mondays
npm run digest:subscribe -- --email=ops@acme.com --pause            # or --resume
npm run digest                                                      # run now (dry unless enabled)
```

- **Previews**: `/digest/preview` on the web app (behind the demo password)
  shows the next email for each subscription from today's data, and a sample
  for any market, trades and segment. Nothing is sent or recorded.
- **What was sent**: `digest_sends` (one row per subscription, mode and day,
  with status, item count, provider message id, error class) and
  `digest_items` (which permits each email carried).
- **Unsubscribes** land in `email_suppressions` at once and stop every email
  to that address. Never lift one without the customer's own written request.
- **Bounces and spam complaints**: not wired to a webhook yet. Check the
  provider dashboard weekly and add each one:
  `INSERT INTO email_suppressions (email, reason, channel) VALUES ('x@y.com', 'bounce', 'provider_dashboard');`
- **A failed send** turns the sync job red. The next run the same day retries
  it; the job summary and `digest_sends.error_class` say why (`auth`: wrong
  key; `rejected`: the provider refused the message, often an unverified From
  domain; `rate_limit`, `provider_down`, `network`: try again).

## What the email promises, and what it doesn't

It says "first seen by us" and "no electrical permit on the job in the city's
data yet". It never says verified, unhired, real-time, live or open now
(`src/digest/render.test.js` checks). Phones are as published on permits;
nobody has called to check them.
