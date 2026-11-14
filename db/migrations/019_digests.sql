-- 019: customer email digests (ADR-20). Additive only.
-- Never edit this file after merge; add 020_*.sql instead.
--
-- A subscription is one email address, one market, the trades it wants and
-- whether it wants the early (not yet issued) filings. A digest run renders
-- and sends one email per due subscription, records the attempt in
-- digest_sends (rule 3: every attempt, with its error class) and the items it
-- carried in digest_items, so a permit is never sent twice to the same
-- subscription (rule 2) and a re-run on the same day sends nothing new.
--
-- Rule 5: subscriptions hold the customer's own business email only. Nothing
-- here copies owner, applicant or person fields from a permit.

CREATE TABLE digest_subscriptions (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email           TEXT NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  label           TEXT NOT NULL DEFAULT 'default',  -- tells two subscriptions of one address apart
  company         TEXT,                             -- the customer's business, for the greeting
  source_area     TEXT NOT NULL,                    -- a display market in src/sources.js (austin-tx, ...)
  trades          TEXT[] NOT NULL DEFAULT '{}'
                  CHECK (trades <@ ARRAY['electrical','mechanical','plumbing']::text[]),
  -- Early filings section (ADR-16/19): NULL = none; 'all' = every segment.
  early_segment   TEXT CHECK (early_segment IN ('homes','apartments','commercial','all')),
  zips            TEXT[],                           -- NULL = the whole market
  min_valuation   NUMERIC,
  frequency       TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily','weekly')),
  send_weekday    SMALLINT NOT NULL DEFAULT 1 CHECK (send_weekday BETWEEN 0 AND 6),  -- weekly only; 0 = Sunday, UTC date
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','unsubscribed')),
  unsubscribed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email, label),
  CHECK (cardinality(trades) > 0 OR early_segment IS NOT NULL)
);

-- Addresses that must never get a digest: an unsubscribe (CAN-SPAM opt-out
-- covers every commercial email from us, not one list), a hard bounce, a
-- spam complaint or a manual request. Rows are never deleted; lifting a
-- request sets lifted_at (same pattern as suppressions, migration 009).
CREATE TABLE email_suppressions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        TEXT NOT NULL CHECK (email = lower(email)),
  reason       TEXT NOT NULL CHECK (reason IN ('unsubscribe','bounce','complaint','manual')),
  channel      TEXT,               -- link, one_click, provider_webhook, email, phone
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifted_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX email_suppressions_active ON email_suppressions (email) WHERE lifted_at IS NULL;

-- One row per subscription per day per mode. 'dry_run' rows come from the
-- default run that renders without sending (no provider configured yet);
-- 'live' rows from real sends. Each mode tracks its own "since last send".
CREATE TABLE digest_sends (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id     BIGINT NOT NULL REFERENCES digest_subscriptions(id) ON DELETE CASCADE,
  mode                TEXT NOT NULL CHECK (mode IN ('dry_run','live')),
  send_date           DATE NOT NULL,                -- the UTC day of the run
  period_start        TIMESTAMPTZ NOT NULL,         -- items first seen after this ...
  period_end          TIMESTAMPTZ NOT NULL,         -- ... and before this
  status              TEXT NOT NULL CHECK (status IN ('started','sent','rendered','skipped_empty','skipped_suppressed','skipped_allowlist','failed')),
  item_count          INTEGER NOT NULL DEFAULT 0,
  subject             TEXT,
  provider            TEXT,
  provider_message_id TEXT,
  error_class         TEXT,     -- config | auth | rate_limit | rejected | provider_down | network | data | unknown
  error_message       TEXT,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  UNIQUE (subscription_id, mode, send_date)
);
CREATE INDEX digest_sends_recent ON digest_sends (subscription_id, mode, period_end DESC);

-- What each email carried. The primary key is what stops a permit reaching
-- the same subscription twice in the same section.
CREATE TABLE digest_items (
  subscription_id BIGINT NOT NULL REFERENCES digest_subscriptions(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL CHECK (mode IN ('dry_run','live')),
  section         TEXT NOT NULL,   -- 'early' or 'trade:<trade>'
  permit_id       BIGINT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  send_id         BIGINT NOT NULL REFERENCES digest_sends(id) ON DELETE CASCADE,
  PRIMARY KEY (subscription_id, mode, section, permit_id)
);
CREATE INDEX digest_items_send ON digest_items (send_id);
