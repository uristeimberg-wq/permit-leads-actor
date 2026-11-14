# Worker B: Deep document intelligence (Austin)

Checked 2026-11-14 with WebFetch. The container shell cannot reach city hosts
(proxy `connect_rejected` for `webapi.legistar.com` and
`services.austintexas.gov`), so every PDF was read through WebFetch's text
conversion, not through `pdftotext`. The shared WebFetch budget (100 an hour)
ran out partway through. The planned `mavg-96ck` comparison and the ZAP and
Board of Adjustment pages were **not** fetched; the gaps are marked below.

## 0. Bottom line

1. **The prior scan's model of Austin is incomplete.** The Legistar `austintexas`
   API carries **only City Council and its committees**. It has no Planning
   Commission, no Zoning and Platting Commission, no Historic Landmark
   Commission and no Board of Adjustment. Those bodies publish on
   `austintexas.gov/boards-commissions/meetings/{year}_{boardId}_{page}`, with
   PDFs at `services.austintexas.gov/edims/document.cfm?id=N`.
2. **`austintexas.legistar1.com/robots.txt` is `User-agent: * / Disallow: /`.**
   That host serves every Legistar agenda and attachment PDF. Under our hard
   line, we may read the Legistar **API** (JSON) but must **not** bulk-download
   its PDFs. That leaves Council staff-report PDFs reachable only by hand or
   through a public-information request. The edims host (boards and
   commissions) is not disallowed.
3. **The structured zoning dataset already carries most of what a packet
   holds.** Compared on case C14-2026-0057, `edir-dcnf` already has the case
   number, the parcel (`tcad_id`), owner organization, agent firm, applicant
   phone, from/to zoning, acreage (in the description), status and case
   manager. The Legistar matter **title** (free JSON, no PDF) adds the staff
   recommendation, the commission recommendation and the agent. What only the
   PDF adds: the **proposed use** (here "mini warehouse / self-storage", which
   the dataset doesn't say), the vote and hearing dates, the postponement
   history, letters for and against, ROW and traffic notes, and conditional
   overlay limits.
4. **The marginal value is real but narrow.** Proposed use and postponement
   status help GCs, builders and suppliers. Two document streams the datasets
   probably lack are the most interesting: **HLC demolition and relocation
   applications** (an early redevelopment signal, with applicant firms such as
   Drenner Group) and **postponement or opposition** status. Neither needs an
   LLM to be useful.
5. **Recommendation: build a small, deterministic "agenda index", not a
   general document AI pipeline.**
   - Discover items from the boards-commissions listing pages and from the
     Legistar API.
   - Store case number, document URL, label, hash and meeting date.
   - Run regex extraction on the agenda text, which is born-digital.
   - Link to `planning_cases` by case number.
   - Defer LLM field extraction until a gold set shows that regex misses
     fields customers pay for. At Austin's volume the LLM costs dollars a month
     either way, so the reason to defer is reviewer time and the evidence
     rules, not cost.

## 1. Where Austin's land-use documents actually are

| Body | Where agendas/backup live | Verified | Board id | Cadence seen | Docs per meeting |
| --- | --- | --- | --- | --- | --- |
| City Council (zoning items "Z-n") | Legistar API `webapi.legistar.com/v1/austintexas`; PDFs on `austintexas.legistar1.com` | **[Verified-live 2026-11-14]** `/bodies` lists 23 bodies, all Council, committees, AHFC, TIRZ and LGC boards; **no Planning Commission, ZAP, HLC or BoA** | Legistar BodyId 138 | Council about 2 regular meetings a month (events 4078, 4079, 4081) | 3 attachments per zoning matter (Staff Report, Draft Ordinance, RCA) |
| Planning Commission | `https://www.austintexas.gov/boards-commissions/meetings/2026_40_1`; docs `services.austintexas.gov/edims/document.cfm?id=` | **[Verified-live 2026-11-14]** | 40 | 2 a month (Oct 13, Oct 27, Nov 10) | 14-25 backup docs (Nov 10: 13 case items, about 20 docs) |
| Historic Landmark Commission | `https://austintexas.gov/boards-commissions/meetings/2026_31_1` | **[Verified-live 2026-11-14]** | 31 | 1 regular a month, plus Architectural Review and Operations committees | **61** (Nov 4) and **83** (Oct 7) backup docs |
| Zoning and Platting Commission | Same site, board id not checked | **[Unverified]** (budget ran out). The ZAP vote of 2026-10-06 on C14-2026-0057 is cited in the Council staff report, so ZAP meets and publishes | ? | Likely 2 a month **[Unverified]** | ? |
| Board of Adjustment | Same site; dataset `ykxk-t5y9` also exists | **[Unverified]** | ? | ? | ? |
| Video | `austintx.new.swagit.com/videos/N` | [Read-from-page] links on the PC page | | | out of scope |

**URL patterns:**

- Listing pages: `/boards-commissions/meetings/{YYYY}_{boardId}_{page}`.
  Page 1 is newest. HLC 2026 has 5 pages.
- Each document: `edims/document.cfm?id={6-digit, monotonically increasing}`.
  Ids 482781 to 485172 cover Oct 13 to Nov 12, about 2,400 ids a month
  citywide, all document types.
- Agenda PDFs and Legistar attachments are named by GUID
  (`/attachments/{uuid}.pdf`), so a changed file usually gets a new GUID, and
  `MatterAttachmentLastModifiedUtc` gives a version time.

### Robots and terms for each host touched

| Host | robots.txt | Terms | Verdict |
| --- | --- | --- | --- |
| `webapi.legistar.com` | Fetch failed (client error, no file) **[Verified-live]** | No API terms published (prior scan) | JSON API usable at polite rates. Record "no terms found" in `sources` |
| `austintexas.legistar1.com` (PDFs) | **`Disallow: /` for all agents** **[Verified-live 2026-11-14]** | n/a | **No automated download.** Use the API's metadata only. For packet text, use the edims copy where the same staff report is re-posted for PC or ZAP, or a PIA request |
| `austintexas.legistar.com` (InSite UI) | Fetch failed **[Verified-live]** | | Don't scrape the UI. The API covers it |
| `www.austintexas.gov` | Disallows `/core/`, `/profiles/`, locale prefixes, `/search`, `/user/*`, admin and node-add paths. **`/boards-commissions/` is not disallowed** **[Verified-live 2026-11-14]** | City site terms not read this session **[Unverified]** | Allowed at low rates. Read the site terms before building |
| `services.austintexas.gov` | `/robots.txt` 302-redirects to the www file **[Verified-live]**. RFC 9309 lets a crawler follow the redirect and apply those rules, and `/edims/` is not listed | Not read | Allowed at low rates (about 1 request every 5 s). Re-check before building |
| `datahub.austintexas.gov` | Not re-checked | Public domain (COMPLIANCE 1.1) | Allowed |

## 2. What a case item contains (real examples, abbreviated)

### 2a. Council zoning matter via the Legistar API (no PDF needed)

Source: `https://webapi.legistar.com/v1/austintexas/matters/29514`
**[Verified-live 2026-11-14]**

- `MatterFile`: 26-3145
- `MatterTypeName`: "Zoning and Neighborhood Plan Amendments"
- `MatterAgendaDate`: 2026-11-19
- `MatterLastModifiedUtc`: 2026-11-10T15:25
- `MatterTitle` (abbreviated): "C14-2026-0057 - 3601 Davis Lane - ... District 8 ...
  rezoning ... Williamson Creek Watershed ... from GR-CO to CS-CO. Staff
  Recommendation: deny ... Zoning and Platting Commission Recommendation:
  grant CS-CO with conditions. Owner: W.W. Deerfield, Ltd. Agent: [individual]
  (Armbrust & Brown, PLLC). City Staff: [individual], Austin Planning,
  512-974-7620."
- The attachments call (`/matters/29514/attachments`) returns Staff Report,
  Draft Ordinance and Recommendation for Action. All three are GUID PDFs on
  `legistar1.com`, which is robots-disallowed.

The title alone is a semi-structured record: case number, address, district,
from/to zoning, staff and commission recommendations, owner, agent firm and
staff phone. A `substringof('C14-',MatterTitle)` filter returned 15 such
matters introduced from 2026-09-01 to 2026-11-05 (the query cap was 15), so
at least about 7 a month reach Council. Other title prefixes (NPA-, C814-,
RCA/RCT) also occur.

The event-items call for Council meeting 4081 returned 40+ items. None of
those visible had zoning titles, so the zoning "Z" items sit after item 40
and need paging. **[Verified-live, partial]**

### 2b. Council staff report PDF (read once by hand, not automatable on that host)

`attachments/597ad821-...pdf` was read once through WebFetch to measure
content. Under the robots rule this host is **not** for automated reads.

- 18 pages. Pages 1-8 are the report; pages 9-18 are exhibits and letters.
- Born-digital text with "Page X of 18" footers. The maps (Exhibits A and B)
  are images with no text, so tesseract would add nothing useful.

Fields found in the report:

- C14-2026-0057; related C14-2023-0068, Ordinance 20231130-105 and area cases.
- TCAD 0422280507; 2.89 ac.
- Owner W.W. Deerfield, Ltd.; agent Armbrust & Brown, PLLC.
- Staff: deny CS-CO, keep GR-CO.
- **ZAP 2026-10-06: approved CS-CO with prohibited uses, 8-1.**
- **Council 2026-11-05 postponed at the applicant's request to 2026-11-19.**
- **Proposed use: mini-warehouse / self-storage.**
- Height 40 ft to 50 ft, FAR 0.5 to 1:1.
- ASMP ROW deficits (Davis Ln: 86 ft existing against 116 ft required).
- 2 support letters, no petition.
- No conceptual site plan.

### 2c. Planning Commission agenda (edims, automatable)

`https://services.austintexas.gov/edims/document.cfm?id=484646` (PC, 2026-11-10)
**[Verified-live 2026-11-14]**

- 8 pages, born-digital text.
- 13 case items: 4 NPA, 7 C14, 1 C14H, 1 C20. No site plans or subdivisions
  this time.
- Each item follows a fixed template: case number and name (district),
  location, watershed, owner/applicant, agent, request, staff recommendation,
  staff contact.

Example items:

- `C14-2026-0040 - 1221 S IH-35 Rezoning (D9)`
  - Owner/applicant: Aztecas de Juventino Rosas, LLC
  - Agent: Husch Blackwell, LLP ([individual])
  - Request: LR-NP and SF-3-NP to CS-NP
  - Staff recommendation: CS-CO-NP
  - Staff contact: Nancy Estrada, 512-974-7617
- `NPA-2018-0021.02 - Skyline Oltorf Mixed Use (D3)`
  - Owner: ADD Land, Ltd. and Charitable Holdings II
  - Agent: Armbrust & Brown, PLLC
  - Staff recommendation: "Applicant indefinite postponement request"

The listing page labels each backup document by type, for example
"neighborhood postponement request", "applicant postponement memo", "public
comment", "staff report" and "Robinson Hill NA opposition letters". The
**document labels alone** therefore carry postponement and opposition signals,
without opening the PDF.

The listing also includes site plans: `SPC-2026-0258A Higher Spirits Rooftop
Lounge` and `SPC-2024-0302C Toyota of North Austin` reached PC in October.

### 2d. Historic Landmark Commission agenda (edims)

`https://services.austintexas.gov/edims/document.cfm?id=484142` (HLC, 2026-11-04)
**[Verified-live 2026-11-14]**

- Born-digital text, 26 items:
  - 1 historic zoning (C14H-2026-0063)
  - 3 landmark and local-district applications
  - 4 National Register district permits
  - **11 demolition or relocation applications**
  - 7 other
- Number formats:
  - `PR-2026-008188` (6-digit; demolition or relocation permit review)
  - `HR-2026-130765` (paired with a PR)
  - `DA-2026-132248` paired with `SP-2026-108262`
  - `SP-2023-0269C`
- Examples:
  - Item 13: 800 W 34th St, demolish a ca. 1975 office building. Applicant:
    AAR Inc.
  - Item 15: 2307 Rio Grande St, demolish a ca. 1924 building. Applicant:
    Drenner Group (a land-use firm, a redevelopment tell).
  - Item 17: 2002 New York Ave, demolish ca. 1940. Applicant: [individual].

Whether these PR, HR and DA numbers appear in the open permit datasets
(`3syk-w9eu`, `n8ck-xkda`) at that stage is **[Unverified]**. It is the first
thing to check, because if they do, the HLC agenda adds only the commission
date and outcome.

### 2e. Dataset vs packet, field by field (case C14-2026-0057)

`edir-dcnf` row: `https://datahub.austintexas.gov/resource/edir-dcnf.json?$where=case_number='C14-2026-0057'`
**[Verified-live 2026-11-14]**

| Field | `edir-dcnf` | Legistar title (JSON) | PC/ZAP agenda (edims) | Staff report PDF |
| --- | --- | --- | --- | --- |
| Case number, folder | Yes (`case_number`, `folderrsn` 13748174, `permit_number` "2026-099629 ZC") | Yes | Yes | Yes |
| Parcel | **`tcad_id` 0422280507** | No | No | Yes |
| Address, district, watershed | Yes | Yes | Yes | Yes |
| From/to zoning | Yes | Yes | Yes | Yes |
| Acreage | In `description_of_work` text | No | No | Yes |
| Owner organization | `W W DEERFIELD LTD` (hidden by rule 5 only if a person) | Yes | Yes | Yes |
| Agent / applicant firm | `applicant_organization_name` "Armburst & Brown" (typo in source) | Yes (correct spelling) | Yes | Yes |
| Applicant phone | **Yes** (`applicant_phone`) | No | No | No |
| Status | `Scheduled for Hearing`, `status_date` | `MatterStatusName` "Agenda Ready" | n/a | n/a |
| Hearing dates | **No** | `MatterAgendaDate` | Meeting date | Full history |
| Staff recommendation | No | **Yes** | **Yes** | Yes, with conditions |
| Commission vote | No | Yes (recommendation) | n/a | Yes, with count |
| Postponements | No | No | **Document labels** | Yes |
| Proposed use | **No** | No | Sometimes in the case name | **Yes (self-storage)** |
| Units / sq ft | Fields exist (prior scan says the dataset has proposed units for some types) | No | No | Not stated in this case |
| Opposition / support / petition | No | No | **Document labels** ("opposition letters") | Yes |
| TIA | `tia_required` = No | No | No | ROW notes |
| Engineer / architect | No | No | No | Not in this report. For site plans, likely in the plan set, which is not posted **[Unverified]** |

**Blunt answer:** for zoning cases, the PDF's unique value is **proposed use,
hearing and postponement history, and opposition**. Architects, engineers and
GCs are *not* in zoning packets; zoning is handled by land-use lawyers and
expediters (Armbrust & Brown, Husch Blackwell, Drenner Group), whom
`edir-dcnf` already names. The packet does not deliver the "who will build
it" relationship data the product is about. Site-plan packets (SPC-) might
name civil engineers, but only about 2 site plans a month reach PC, and
`mavg-96ck` already covers every site plan with its applicant organization
(88%). That comparison is **not done** because the budget ran out.

One data-quality note: the dataset says `approved_in_last_30_days = Yes` for a
case that is still pending. Don't trust that column without checking it.

## 3. Volume estimate (from what was seen)

| Stream | Meetings a month | Case items a month | Docs a month | Pages a month (est.) |
| --- | --- | --- | --- | --- |
| PC | 2 | 26 | 30-50 | 300-600 (staff reports about 10-20 pp) |
| ZAP **[Unverified]** | 2 | about 20 | 30-40 | 300-500 |
| HLC (regular + committees) | 1 + 2 | about 25 (11 demolitions) | 65-90 | 500-1,000 (applicant materials and engineer's reports are long) |
| BoA **[Unverified]** | 1 | 10-20 | 20-40 | 200-400 |
| Council zoning (Legistar JSON only) | 2 | about 7+ | metadata only | 0 (robots) |
| **Total** | | **about 80-100 items** | **about 150-220 docs** | **about 1,300-2,500 pages** |

Storage: about 3 KB of text a page gives about 4-8 MB a month uncompressed,
2-4 MB after TOAST. That is about 25-50 MB a year. It fits on Neon Launch but
not on the free tier's remaining headroom. Agenda-only text (8 pp per meeting,
about 60 pp a month) is about 0.2 MB a month.

## 4. Pipeline design (Node CommonJS, Postgres, Actions cron)

```
cron (daily 06:00 CT; HLC/PC agendas post ~1 week before meeting)
  -> discover: fetch listing page 1 for boards 40, 31, ZAP, BoA  (4 GETs)
               + Legistar /matters?$filter=MatterTypeName eq 'Zoning...' and MatterLastModifiedUtc gt <cursor>
  -> diff: new edims ids / changed matter LastModified  -> documents rows
  -> download (edims only): If-None-Match/If-Modified-Since if served; else compare sha256; 1 req / 5 s; <=60 docs/run
  -> extract: pdftotext -layout (poppler; apt in the Action) -> per-page text; pages with <50 chars flagged image_only
              (no OCR in pilot: born-digital in every sample; maps are images and carry no fields)
  -> parse (deterministic): case numbers, item blocks, labelled lines (Owner:, Agent:, Request:, Staff Recommendation:)
  -> link: case_number -> planning_cases (edir-dcnf / mavg-96ck / s7gx-9m54) -> tcad_id -> project_members ('official_reference')
  -> events: hearing_scheduled, postponed, decided, opposition_filed -> lifecycle_events
  -> discard PDF bytes; keep text + hashes
```

### Deterministic patterns (all seen in the live samples)

```
C14-\d{4}-\d{4}(\.\d{2})?   C14H-\d{4}-\d{4}   C14-\d{2}-\d{4}(\.\d{2})?(\((RCA|RCT)\))?
NPA-\d{4}-\d{4}\.\d{2}      C20-\d{4}-\d{3}    C814-\d{2,4}-\d{4}
SPC?-\d{4}-\d{4}[A-Z]{0,2}  C8[J]?-\d{2,4}-\d{4}  PR-\d{4}-\d{6}  HR-\d{4}-\d{6}  DA-\d{4}-\d{6}
TCAD parcel: \b0\d{9}\b near "TCAD"     district: \(D(\d{1,2})\) | District (\d{1,2})
```

- `C8-` and `SP-` 4+4 forms are **[Unverified]**: those exact forms were not
  seen this session.
- One source typo was seen ("C14-2206-0030" for 2026). A case number that
  doesn't match `planning_cases` is stored as `unlinked`, never "corrected"
  (rule 1).

### LLM step (deferred; design for when the gold set justifies it)

- **Use:** proposed use, unit count, sq ft, vote tally and postponement reason
  from staff-report pages 1-3.
- **Model:** default `claude-opus-5-5`, with structured output (`output_config.format`).
  Each field is `{value, quote, page}`.
- **Acceptance check:** the code normalises whitespace and checks that `quote`
  is an exact substring of that page's stored text, and that `value` is
  derivable from `quote`:
  - numbers: the digits appear in the quote;
  - enums: a keyword table.
- **On failure:** store nothing and log `rejected_evidence`. Facts are shown
  as "Extracted from staff report p.3" with the quote, labelled inferred until
  reviewed.
- **Cost at Austin volume:**
  - Per item: about 90 items a month × (about 6k input + 0.8k output tokens).
  - Opus 5.5 at $4/$20 per MTok: 0.54M input ($2.16) + 0.07M output ($1.44),
    about **$3.60 a month**; about $1.80 with the 50% Batch discount.
  - Whole packets: even sending every page (about 2.5k pages ≈ 1.75M tokens)
    costs about $7-10 a month.
  - Cheaper tiers exist (Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50), but that
    choice is the owner's; cost is not the constraint.

### Minimal schema (fits migration 018+; reuses `sources`, `raw_records`, `planning_cases`)

```sql
CREATE TABLE documents (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id     BIGINT NOT NULL REFERENCES sources(id),
  doc_key       TEXT NOT NULL,          -- 'edims:484646' | 'legistar:matter:29514'
  url           TEXT NOT NULL,
  body_name     TEXT, meeting_on DATE,
  doc_label     TEXT,                   -- listing label: 'staff report', 'neighborhood postponement request'
  case_numbers  TEXT[] NOT NULL DEFAULT '{}',  -- from label/title by regex
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetch_policy  TEXT NOT NULL CHECK (fetch_policy IN ('download','metadata_only')), -- legistar1 = metadata_only
  UNIQUE (source_id, doc_key)
);
CREATE TABLE document_versions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id   BIGINT NOT NULL REFERENCES documents(id),
  sha256        TEXT NOT NULL,          -- of the bytes
  etag TEXT, last_modified TEXT, byte_size INT, page_count INT,
  text_pages    TEXT[],                 -- pdftotext per page; NULL when metadata_only
  image_only_pages INT[] NOT NULL DEFAULT '{}',
  extractor     TEXT NOT NULL,          -- 'pdftotext-24.02 -layout'
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, sha256)
);
CREATE TABLE document_extractions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id    BIGINT NOT NULL REFERENCES document_versions(id),
  item_key      TEXT,                   -- case number or agenda item no.
  item_hash     TEXT,                   -- sha256 of the item's text block: detects per-item revisions
  field         TEXT NOT NULL,          -- 'case_number','owner_org','agent_org','request','staff_rec','proposed_use','postponed'
  value         TEXT,
  evidence_quote TEXT NOT NULL, page INT NOT NULL, char_start INT, char_end INT,
  method        TEXT NOT NULL,          -- 'regex:v1' | 'label:v1' | 'llm:<model>:<prompt_ver>'
  confidence    NUMERIC(3,2) NOT NULL,  -- regex 0.95, label 0.90, llm <=0.70 until reviewed
  verified_span BOOLEAN NOT NULL,       -- quote re-found at page/offset
  reviewed_by   TEXT, reviewed_at TIMESTAMPTZ,
  UNIQUE (version_id, item_key, field, method)
);
```

- `agenda_items` (DATA_MODEL) stays as the per-item row. Its `document_url`
  points at `documents`.
- **Change detection:**
  - A new sha256 means a new version.
  - An `item_hash` diff against the previous version of the same meeting
    gives "item revised", "item added" or "item withdrawn".
  - A case number that appears with label "postponement" means a `postponed`
    event.
  - Legistar `MatterLastModifiedUtc`, `EventAgendaLastPublishedUTC` and
    `MatterAttachmentLastModifiedUtc` are cursors; the API is not
    robots-disallowed.
- **Provenance (rule 6):** every displayed value cites `document_extractions`,
  then the version, then the URL and page.

### Accuracy validation

- **Gold set:** 60 items, hand-checked by one reviewer with a second check on
  10.
  - 20 PC, 15 ZAP and 15 HLC demolitions from 3 months of agendas.
  - 10 Council matter titles.
- **Fields scored:** case number, owner org, agent org, request, staff rec,
  postponed (y/n), and proposed use where stated.
- **Bars:**
  - Ship regex fields at ≥ 98% precision and ≥ 95% recall on case number and
    link.
  - Ship labelled fields at ≥ 95% precision.
  - An LLM field ships only at ≥ 95% precision with 100% `verified_span`.
- **Re-run** the gold set on every parser change (offline fixture test,
  `npm test`).

## 5. Build or skip

| Step | Pilot? | Why |
| --- | --- | --- |
| Legistar API zoning-matter poller (JSON only), titles parsed by regex and labelled lines | **Build** (S) | Free, no robots issue, gives staff and commission recommendations, hearing date, owner and agent. Join on case number |
| Boards-commissions listing scraper (PC 40, HLC 31, ZAP, BoA): doc labels + edims ids + case numbers | **Build** (S) | 4 GETs a day. Labels alone give postponement and opposition events |
| Agenda PDF text (8 pp per meeting) + item parser | **Build** (S-M) | Born-digital, fixed template. Gives owner, agent, request and staff rec for PC, ZAP and HLC, including HLC demolitions that may be absent from datasets |
| Staff report download and text storage | Build only for case numbers already in `planning_cases` with units ≥ 5 or commercial use (M) | Proposed use and history; keeps storage at about 1 MB a month |
| OCR (tesseract) | **Skip** | Every sample was born-digital; images are maps |
| LLM field extraction | **Skip until the gold set shows a need** | Value is narrow (proposed use, units); a regex on "Proposed use" lines may cover it |
| Council PDFs on `legistar1.com` | **Do not automate** (robots `Disallow: /`) | Use the same report from the edims PC or ZAP backup, or ask the Clerk for a bulk export (PIA) |
| Video transcripts (swagit) | Skip | High cost; opposition is already visible in doc labels |

## Earliest stage revealed

All of these are **entitlement** on the ladder. HLC demolition applications
sit at **entitlement / pre-site-plan** for redevelopment. The agenda adds no
stage earlier than what `edir-dcnf` and `mavg-96ck` already show from the
application date. Its contribution is *status within entitlement* (scheduled,
postponed, recommended, opposed) and the proposed use.

## Top recommendations for the Austin pilot

1. **Correct DATA_SOURCES.md:**
   - Legistar `austintexas` holds Council and committees only.
   - PC, ZAP, HLC and BoA are on `austintexas.gov/boards-commissions` plus
     edims.
   - `austintexas.legistar1.com` is robots `Disallow: /`.
2. **Legistar zoning-matter poller (JSON):** about 7+ zoning matters a month,
   regex on title fields, events `hearing_scheduled` and `decided`, join on
   case number to `edir-dcnf`.
3. **Boards-commissions listing indexer for PC, HLC, ZAP and BoA:** document
   label plus case number gives postponement and opposition events. No PDF
   needed.
4. **HLC demolition items:** first verify whether the PR, HR and DA numbers
   appear in `3syk-w9eu` or `n8ck-xkda`. If not, parse the HLC agenda. About
   11 a month, applicant firms named, an early redevelopment signal.
5. **Agenda-text parser with a 60-item gold set** before any LLM work.
6. **Store text and hashes only;** cap staff-report downloads to linked,
   larger cases.

## Looks valuable, not worth it now

- **A general LLM document-AI pipeline.** The datasets already give parcel,
  owner, agent and phone. Packets don't name architects, engineers or GCs for
  zoning. Cost is trivial (under $10 a month); reviewer time and evidence
  checking are not.
- **Council attachment PDFs.** Robots-disallowed. They duplicate the PC/ZAP
  staff reports on edims.
- **OCR.** No scanned pages seen.
- **Meeting video and transcripts.** Expensive, and the signal is mostly
  duplicated by "opposition letters" labels.
- **Full historical backfill of packets.** 25-50 MB a year of text. Backfill
  only agenda text (about 2 MB a year) if history is needed.

## Not verified (next checks)

- ZAP and BoA board ids and their volumes.
- `mavg-96ck` record for SPC-2026-0258A against its PC staff report
  (engineer or architect named?).
- Whether HLC PR, HR and DA numbers exist in the open permit datasets.
- The austintexas.gov site terms.
- Whether edims serves ETag or Last-Modified headers.
