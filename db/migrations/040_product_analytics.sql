-- 040: first-party product analytics (ADR-37, docs/ANALYTICS.md).
--
-- Two tables: one row per browser session, one row per event. Events are
-- append-only except user_id, which is filled in once when an anonymous device
-- signs in (identity stitching); a trigger enforces that. No IP address and no
-- full user-agent string is stored: the server derives coarse families (device
-- type, browser, OS) and a country/region only from a proxy header, then drops
-- the raw values. Free text (search queries, labels) is redacted for emails,
-- phone numbers and token-like strings before it is written (web/telemetry.js).
--
-- Not partitioned: there is no traffic yet. The primary key is event_id alone
-- because retries are de-duplicated with ON CONFLICT (event_id); a partitioned
-- table would need server_received_at in the key, which would let a retry that
-- lands in a later partition through. Partition when volume calls for it, with
-- dedup moved to a short-lived staging table (ADR-37).

CREATE TABLE IF NOT EXISTS analytics_sessions (
  session_id           uuid PRIMARY KEY,
  user_id              bigint REFERENCES app_users(id) ON DELETE SET NULL,
  anonymous_device_id  uuid NOT NULL,
  started_at           timestamptz NOT NULL,
  last_active_at       timestamptz NOT NULL,
  ended_at             timestamptz,
  -- Active seconds: the sum over page views of the longest visible-tab time
  -- each reported (page_exit.dwell_time_ms). A background tab adds nothing.
  duration_seconds     integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  entry_path           text CHECK (length(entry_path) <= 300),
  exit_path            text CHECK (length(exit_path) <= 300),
  -- The referring site's host only (never its path or query), and only when
  -- it is another site.
  referrer             text CHECK (length(referrer) <= 255),
  utm_source           text CHECK (length(utm_source) <= 100),
  utm_medium           text CHECK (length(utm_medium) <= 100),
  utm_campaign         text CHECK (length(utm_campaign) <= 100),
  device_type          text CHECK (device_type IN ('desktop', 'mobile', 'tablet', 'unknown')),
  browser              text CHECK (length(browser) <= 40),
  os                   text CHECK (length(os) <= 40),
  ip_country           text CHECK (ip_country ~ '^[A-Z]{2}$'),
  ip_region            text CHECK (length(ip_region) <= 80),
  -- Excluded from every metric: the owner's own traffic, and automated clients.
  is_internal          boolean NOT NULL DEFAULT false,
  is_bot               boolean NOT NULL DEFAULT false,
  CHECK (last_active_at >= started_at)
);
CREATE INDEX IF NOT EXISTS analytics_sessions_started ON analytics_sessions (started_at);
CREATE INDEX IF NOT EXISTS analytics_sessions_device ON analytics_sessions (anonymous_device_id, started_at);
CREATE INDEX IF NOT EXISTS analytics_sessions_user ON analytics_sessions (user_id, started_at) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS analytics_events (
  event_id             uuid PRIMARY KEY,
  session_id           uuid NOT NULL REFERENCES analytics_sessions(session_id) ON DELETE CASCADE,
  user_id              bigint REFERENCES app_users(id) ON DELETE SET NULL,
  anonymous_device_id  uuid NOT NULL,
  event_name           text NOT NULL CHECK (event_name ~ '^[a-z][a-z0-9_]{1,47}$'),
  event_category       text NOT NULL CHECK (event_category IN
                         ('navigation', 'search', 'record_engagement', 'export_or_action', 'auth', 'ui_interaction', 'error')),
  page_path            text CHECK (length(page_path) <= 300),
  page_title           text CHECK (length(page_title) <= 200),
  element_id           text CHECK (length(element_id) <= 100),
  element_label        text CHECK (length(element_label) <= 120),
  target_record_id     text CHECK (length(target_record_id) <= 100),
  target_entity_type   text CHECK (target_entity_type IN ('permit', 'pre_approval', 'contractor', 'property', 'project')),
  properties           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(properties) = 'object'),
  client_timestamp     timestamptz NOT NULL,
  server_received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analytics_events_received ON analytics_events (server_received_at);
CREATE INDEX IF NOT EXISTS analytics_events_name_received ON analytics_events (event_name, server_received_at);
CREATE INDEX IF NOT EXISTS analytics_events_session ON analytics_events (session_id, client_timestamp);
CREATE INDEX IF NOT EXISTS analytics_events_device ON analytics_events (anonymous_device_id) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS analytics_events_user ON analytics_events (user_id, client_timestamp) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS analytics_events_target ON analytics_events (target_entity_type, target_record_id) WHERE target_record_id IS NOT NULL;

-- Which devices became which users, and when (one row per pair).
CREATE TABLE IF NOT EXISTS analytics_identities (
  anonymous_device_id  uuid NOT NULL,
  user_id              bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  first_linked_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (anonymous_device_id, user_id)
);
CREATE INDEX IF NOT EXISTS analytics_identities_user ON analytics_identities (user_id);

-- Append-only: an event row may only gain a user_id (NULL -> a user), never
-- change anything else. Deletes are allowed (a user's data on request, or a
-- retention purge).
CREATE OR REPLACE FUNCTION analytics_events_append_only() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'user_id') IS DISTINCT FROM (to_jsonb(OLD) - 'user_id')
     OR (OLD.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'analytics_events is append-only (only a NULL user_id may be filled in)';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS analytics_events_append_only ON analytics_events;
CREATE TRIGGER analytics_events_append_only BEFORE UPDATE ON analytics_events
  FOR EACH ROW EXECUTE FUNCTION analytics_events_append_only();
