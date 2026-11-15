-- Product analytics: the owner's own accounts and browsers (ADR-37, docs/ANALYTICS.md).
--
-- A visit with the owner key, or from a browser that opened /admin/analytics,
-- was already marked internal. These two lists close the gap the owner hit on
-- Nov 15: an email sign-in on the owner's phone, made before that phone ever
-- opened the dashboard, counted as a real registered user. Once a device or a
-- user is on a list, all of its sessions (past and future) are internal.
CREATE TABLE IF NOT EXISTS analytics_internal_devices (
  anonymous_device_id  uuid PRIMARY KEY,
  marked_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics_internal_users (
  user_id    bigint PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  marked_at  timestamptz NOT NULL DEFAULT now()
);
