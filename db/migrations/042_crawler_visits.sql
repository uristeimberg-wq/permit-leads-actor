-- Crawler visits to the public market pages (ADR-42, web/seo/router.js).
--
-- Search and AI crawlers run no JavaScript, so the browser tracker never sees
-- them. This counts their requests server-side: one row per UTC day, claimed
-- crawler name (from the User-Agent, which anyone can set), route and status
-- class. Routes are the router's own fixed paths, never the raw URL, so the
-- table stays small. Nothing about the requester is stored: no IP, no full
-- user-agent.
CREATE TABLE IF NOT EXISTS crawler_visits (
  day           date NOT NULL,
  crawler       text NOT NULL CHECK (length(crawler) <= 40),
  path          text NOT NULL CHECK (length(path) <= 80),
  status_class  text NOT NULL CHECK (status_class ~ '^[1-5]xx$'),
  hits          integer NOT NULL DEFAULT 1 CHECK (hits > 0),
  last_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, crawler, path, status_class)
);
