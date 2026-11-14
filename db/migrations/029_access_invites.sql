-- 029: invite-only access (ADR-27). Each person gets their own access code;
-- only its SHA-256 is stored. A sign-in records the optional industry the
-- person gave, so we learn who finds the data useful without assuming an
-- audience. The owner's DEMO_PASSWORD still signs in (invite_id NULL).
CREATE TABLE IF NOT EXISTS access_invites (
  id          bigserial PRIMARY KEY,
  code_hash   bytea NOT NULL UNIQUE,
  label       text,                    -- the owner's own note, e.g. who it was for
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE TABLE IF NOT EXISTS access_signins (
  id              bigserial PRIMARY KEY,
  invite_id       bigint REFERENCES access_invites(id) ON DELETE SET NULL,
  industry        text,                -- one of web/invites.js INDUSTRIES, or NULL
  industry_other  text,                -- free text when industry = 'other', max 80 chars
  signed_in_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS access_signins_invite ON access_signins (invite_id, signed_in_at DESC);
