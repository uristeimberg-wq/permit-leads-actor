# Product analytics

First-party usage analytics (ADR-37). Our own tables, our own tracker, no
third-party service. Purpose: learn from real use which data, filters and
workflows create value while the buyer segment is still open.

## Opening the dashboard

`/admin/analytics` on the deployed app. Sign in at `/login` with the **owner
key** (DEMO_PASSWORD, under "Owner key"), or use HTTP Basic with any user name
and the key. An email user gets 403. With no owner key configured the
dashboard is closed. Opening it marks that browser's own visits internal.

Range: Today, 7D, 30D, All (UTC). User: all, or one registered user (which
also opens their timeline). CSV: events, sessions, searches for the current
range and user.

## What is recorded

| Event | When | Key properties |
|---|---|---|
| `page_view` | each page load | `view_id`, `session_start` |
| `page_exit` | tab hidden (`final:false`) and page closed (`final:true`) | `dwell_time_ms`: visible time for this view so far |
| `scroll_depth_reached` | 25/50/75/100% of the page or the results pane | `percent`, `scroller` |
| `tab_switched` | Leads/Contractors/Saved nav, List/Split/Map | `tab` |
| `search_executed` | a search with new filters returns | `query`, `filters`, `view`, `results_count`, `zero_results`, `stage`, `jurisdiction` |
| `filter_applied` / `filter_cleared` / `sort_changed` | against the previous search | `filter`, `value` |
| `pagination_clicked` | pager | `direction`, `page` |
| `record_clicked` | a permit, project or contractor opened | `position` in the list, `from` |
| `record_detail_viewed` | the permit/project drawer closes or the page goes | `read_time_ms` (visible time) |
| `external_source_link_clicked` | any link to another site | `host` only |
| `contact_info_clicked` | the phone pill (copy on desktop, call on touch) | `method`; never the number |
| `record_saved` / `record_unsaved` | the heart | target permit |
| `signup_started` / `signup_completed` / `login_succeeded` / `logout` | the email dialog | |
| `ui_click` | any element with `data-track="<label>"` | `target` |
| `ui_error_encountered` / `api_request_failed` / `rage_click_detected` | friction | message, endpoint path and status, element |

Defined but not emitted yet, because the app has no such feature: `data_exported`
(there is no export for users) and `alert_created` (digest subscriptions are
made with a CLI, not in the app). Contractor panels record the click but not
reading time.

Events carry `page_path` (no query string), `target_entity_type` and
`target_record_id` where there is a record. Sessions carry the entry and exit
path, referrer host, UTM tags, device type, browser and OS family, and
`duration_seconds`: the sum over page views of the longest `dwell_time_ms`
each reported, so time in a background tab is never counted.

A session ends after 30 minutes without activity. The device id is a random
UUID in localStorage. When someone signs in, the next batch carries their
cookie and every earlier event and session of that device gets their
`user_id` (`analytics_identities` records the link).

## What is not recorded

IP addresses (only used in memory for the rate limit), full user-agent
strings, referrer paths or queries, cookies, tokens, passwords, phone numbers
a user copies or calls. Emails, phone numbers and token-like strings in any
text (a search box) are replaced with `[email]`, `[phone]`, `[token]` on the
client and again on the server. Keys named like password/token/email/phone
are dropped. Country/region is NULL unless the host's proxy sets a header
named in `GEO_COUNTRY_HEADER` / `GEO_REGION_HEADER`.

Off entirely with Do Not Track, Global Privacy Control, or the switch on
`/privacy`; the server also drops any batch sent with `DNT: 1` or `Sec-GPC: 1`.

## Exclusions

Every metric leaves out sessions marked `is_internal` (the request carried the
owner key, or the browser opened the dashboard) and `is_bot` (crawler,
headless browser, curl and similar user-agents). They are stored, and the
dashboard says how many were excluded.

When the dashboard opens, it reports its browser's device id
(`POST /api/admin/analytics/internal`, owner only). That device, any email
account signed in on the request or ever linked to that device, and every
session of either (past ones included) become internal
(`analytics_internal_devices`, `analytics_internal_users`, migration 041).
Later batches from them are internal on arrival, and those accounts are left
out of Registered users. To undo one: delete its row and set `is_internal`
back on its sessions by hand.

`api_request_failed` carries `status` (0 = no answer: the fetch itself failed)
and `hidden` (the tab was in the background, which on iOS usually means the
user switched apps and Safari dropped the request, not a server fault).

## Definitions

- **Actor**: a registered user, else a device.
- **DAU / WAU / MAU**: distinct actors with a session today / in the last 7
  days / in the last 30 days, ending now (not the selected range).
- **Stickiness**: mean daily actors divided by MAU, the mean taken over the
  days with tracking in the last 30 (so the first weeks after launch are not
  diluted by days before there was any data). 100% means every monthly user
  came every day.
- **Retention at N days**: of actors whose first session is in range and at
  least N days old, the share with any later session starting N or more days
  after the first.
- **Anonymous to registered**: devices first seen in range that were later
  linked to a user.
- **Funnel** (ordered, per actor): page view, then a search, then a record
  opened after that search, then contact/save/export/alert after that, then a
  session that starts after that action.

## Retention

Events and sessions are deleted 13 months after they were recorded (owner
decision 2026-11-15). `ingest/analytics_retention.js` runs daily in the sync
workflow and prints what it deleted; events go by `server_received_at`,
sessions by `last_active_at`, and a device-to-user link once its device has
no session left.

## Ingestion

`POST /api/telemetry/events`, JSON (or text/plain from old beacons), at most
64 KB and 50 events. The whole batch is refused (400) if any event is
malformed; 409 if the session id belongs to another device; 429 over 300
events a minute from one IP; 503 if the database write fails (the client
retries 5xx). One transaction: session upsert, events `ON CONFLICT (event_id)
DO NOTHING`, stitching, duration recompute. Client clocks more than a day off
are replaced with the server time.

## Tests

`web/public/analytics_core.test.js` (redaction, timer, queue, scroll, rage),
`web/telemetry.test.js` (validation, DNT, limits, marking),
`web/admin_analytics.test.js` (401/403), and
`test/integration/analytics.test.js` (idempotency, dwell, zero results,
stitching, exclusions, dashboard numbers, timeline, CSV, append-only).

## Trend charts

`GET /api/admin/analytics/charts?days=7|30|90&role=&source=` (web/admin_charts.js),
drawn with Chart.js 4.4.7 (pinned in package.json, served from node_modules at
`/admin/analytics/chart.umd.js`, owner only; no CDN). Each chart has a table view.

- **People per day**: active, new (first visit that day), returning (first
  seen earlier), email sign-ups (`app_users.created_at`; email sign-in is
  optional). Or active people split by pop-up answer. Days before visitor
  tracking started are blank, not zero.
- **Records added per day**: `permits.first_seen_at` and
  `planning_cases.first_seen_at` (when our sync first saw a record, not its
  filing date), by region or by the stage it was in then: pre-approval
  (planning case), permit not yet issued, issued or later, other/unknown. A
  source's first sync puts its back history on one day.
- **Funnel**: people first seen in the window; each step requires every
  earlier one: answered the pop-up, searched, opened a record, high intent
  (`contact_info_clicked`, `record_saved`; no export or alert feature exists),
  came back on a later day. The table also gives "did it at all".
- **Roles compared**: three small charts (avg active time per visit, searches
  per person, day-7 retention), because they have different units.
- **Traffic sources**: per visit, UTM source else referrer host else direct;
  activated = searched and opened a record in the window.

Role = the latest answer to the "What do you do?" pop-up (web/public/lens.js):
page views carry `lens_roles` (role keys, or `skipped`) from the saved lens,
and the pop-up sends `onboarding_completed` / `onboarding_skipped`. Free text
("Something else") is never sent. Someone with two roles counts in both;
`none` = no answer recorded (all visits before Nov 16 2026).
