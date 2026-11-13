-- 009: removal and correction requests (docs/COMPLIANCE.md, rule 6).
-- contact_points is rebuilt from scratch on every resolve, so a hand-set
-- display_policy would be lost by the next sync. Requests live here instead and
-- are applied when data is read, so they take effect at once and survive
-- re-resolves. Rows are never deleted: a lifted request sets lifted_at.
-- Never edit this file after merge; add 011_*.sql instead.

CREATE TABLE suppressions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- 'phone': an E.164 number, hidden wherever it appears.
  -- 'contractor': a contractors.identity_key; the company's phones are hidden
  --   and its name is withheld like an individual's.
  kind          TEXT NOT NULL CHECK (kind IN ('phone','contractor')),
  value         TEXT NOT NULL,
  request       TEXT NOT NULL CHECK (request IN ('remove','correct','do_not_contact')),
  channel       TEXT,                    -- how the request arrived: email, phone, form
  note          TEXT,                    -- free text; no personal data beyond what is needed
  source_ref    TEXT,                    -- the permit number the requester pointed to
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  honored_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifted_at     TIMESTAMPTZ,
  CHECK (kind <> 'phone' OR value ~ '^\+1[2-9][0-9]{9}$')
);
-- One active request per target; re-adding a lifted one is a new row.
CREATE UNIQUE INDEX suppressions_active ON suppressions (kind, value) WHERE lifted_at IS NULL;

-- Every phone that must not reach a client: suppressed numbers, plus every
-- number of a suppressed contractor. Read paths filter on this view.
CREATE VIEW suppressed_phones AS
SELECT s.value FROM suppressions s
 WHERE s.kind = 'phone' AND s.lifted_at IS NULL
UNION
SELECT cp.value FROM suppressions s
  JOIN contractors c ON c.identity_key = s.value
  JOIN contact_points cp ON cp.contractor_id = c.id AND cp.kind = 'phone'
 WHERE s.kind = 'contractor' AND s.lifted_at IS NULL;
