-- 034: app users and saved permits (the Leads screen's heart button).
-- A user is an email address, nothing more: sign-in is email only, with no
-- verification (an owner decision for the pilot, 2026-11-15). That means
-- anyone who types an address can read and change that address's saved list,
-- so nothing sensitive may be stored here. Emails are stored lower-cased.
CREATE TABLE IF NOT EXISTS app_users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);

-- One row per (user, permit). `status` is where the user is with that lead.
CREATE TABLE IF NOT EXISTS saved_permits (
  user_id     bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  permit_id   bigint NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'saved'
              CHECK (status IN ('saved', 'called', 'no_answer', 'quoted', 'won', 'lost', 'not_relevant')),
  note        text CHECK (note IS NULL OR length(note) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permit_id)
);
CREATE INDEX IF NOT EXISTS saved_permits_user_updated ON saved_permits (user_id, updated_at DESC);
