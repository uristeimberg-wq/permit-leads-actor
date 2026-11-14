# Compliance

**This is not legal advice.** It records what we found, the rules the product
follows, and the questions that need qualified counsel. Review it before any
outbound feature ships, before charging money, and before adding a state.

Last full review: **2026-11-13** (risk register below). Outreach rules for the
founder's own calls and emails are in `docs/validation/outreach-compliance.md`.
Next-market licence readings (City of Miami, Raleigh, Philadelphia, Orlando)
are in `docs/DATA_SOURCES.md`, "Licence and terms review".

## Rules the product follows (v1)

1. **B2B first; homeowner leads are gated** (ADR-10). No display or export of
   owner names or individual contacts until the homeowner gate passes. The
   gate needs: counsel's answers to the homeowner questions below, a contact
   vendor whose terms permit marketing use, Do Not Call scrubbing, and working
   suppression.
2. **Never bypass access controls.** That means no CAPTCHA solving, no logging
   in with someone else's credentials, and no evading rate limits or blocks.
   If a source signals no automation (CAPTCHA, terms, `robots.txt`), it stays
   off. We use an official API or a bulk request instead.
3. **Every source records its terms review** in `sources`: URL, date,
   reviewer, automated-access verdict, redistribution verdict. A source with
   `automated_access = 'no'` cannot be scheduled. A source whose licence
   requires attribution shows it on every screen and export that uses it.
4. **Contacts carry provenance and a display policy.** Business contacts on
   the permit are shown. Anything that looks like an individual, such as an
   applicant's personal phone or a sole proprietor's cell, defaults to
   `review` or `hide`. This also applies to the name spellings ("aliases")
   shown on a contractor profile.
5. **We never contact anyone on a user's behalf.** No dialing, texting or
   emailing contractors from the platform. Users get a number and make their
   own call.
5a. **Customer emails (ADR-20).** Only to a customer who asked for them,
   with a postal address and a working one-click unsubscribe in every email
   (CAN-SPAM; Gmail and Yahoo bulk-sender rules). An unsubscribe stops every
   Contractos email to that address within the same run and is never lifted
   without the customer's own request. Emails follow the screens' rules:
   business names only, suppressed phones never, no banned sales claims, no
   open or click tracking. Real sending stays off until `docs/EMAIL.md` is
   done and the owner approves the first send.
6. **Removal and correction requests are logged and honoured** in
   `suppressions` (migration 009). See "Handling a removal request" below.
7. **Retention.** Raw payloads are kept for traceability; superseded payloads
   are deleted after `raw_retention_days` (default 90, ADR-14).
8. **No endorsement claims.** Screens say the data is from public records,
   name the agency, and say we are not affiliated with or endorsed by it.
   Sales never says "verified", "unhired", "real-time", "live" or "open now"
   (`/mnt/project-files/sales/SALES_BRIEF.md`, section 5).

## Handling a removal request

Anyone listed (a company, or a person whose number appears on a permit) can
ask to be removed or corrected. Honour it within **10 business days**; aim for
the same day.

```sql
-- One phone, hidden everywhere it appears (search, GC list, job page, profile, overview).
INSERT INTO suppressions (kind, value, request, channel, note, source_ref)
VALUES ('phone', '+15125550100', 'remove', 'email', 'asked by phone owner', '2026-123456 EP');

-- A whole company: every phone it has is hidden.
INSERT INTO suppressions (kind, value, request, channel)
SELECT 'contractor', identity_key, 'do_not_contact', 'phone' FROM contractors WHERE id = 123;

-- Lifting a request (never delete the row).
UPDATE suppressions SET lifted_at = now() WHERE id = 42;
```

It applies at read time, so it survives the nightly re-resolve (which
rebuilds `contact_points`). The web app keeps each screen's answer in memory
for up to 10 minutes (web/cache.js), so a new suppression shows on screen
within about 10 minutes; restart the Railway web service to make it
immediate. It does not yet withhold a
company's **name**, and a corrected value cannot be entered yet; a correction
is handled by hiding the wrong value. Keep the founder's outreach suppression
log (`docs/validation/outreach-compliance.md`, section 6) in step with it.

## Risk register (2026-11-13)

Status: 🟢 low or handled · 🟡 open, manageable, needs a step or a read ·
🔴 blocks the step named until resolved.
Basis: **V** = verified this session (text read, code or test run) ·
**S** = secondary source (law firm, news) · **A** = assumed or general
understanding, not checked against a primary source.

### 1. Data sources: terms, licences, automated access

| # | Item | Status | Basis | Finding | Next step |
| --- | --- | --- | --- | --- | --- |
| 1.1 | **Austin**, Socrata `3syk-w9eu` (live) | 🟢 | V (read 2026-11-13 through the Storyteller API by the markets review, PR #24; first ~6,000 characters) | Site terms (`ranj-cccq`): "Data available through the City of Austin Open Data Portal are offered free and without restriction" and, unless metadata says otherwise, datasets "are in the public domain". Use is "at your own risk". The dataset is tagged `USGOV_WORKS`; credit "City of Austin, Texas - data.austintexas.gov" is a courtesy, and we show it. Not read: the text after "Confidentiality" and the incorporated City Privacy Notice | Read the remaining section and the Privacy Notice once; nothing blocks use now |
| 1.2 | **Miami-Dade County** permit layer (live) | 🟡 | V | ArcGIS item `6db5f56e886446df88313ca279e59120` (owner `MDPublisher`, credit "Miami-Dade County"): the licence field is a disclaimer only ("provides this data for use 'as is'", "assumes no responsibility for errors or omissions"). The county site's "Liability Disclaimer and User Agreement" grants nothing specific, ends "Any rights not expressly granted herein are reserved", forbids conduct that blocks access for others, and disclaims endorsement. No attribution rule found. Florida's public-records law (ch. 119) generally lets anyone copy and reuse public records **[A]** | Counsel Q3. Keep request volume modest (pages of 500, once a day) |
| 1.3 | Socrata / Tyler API terms (Austin, Orlando, TDLR) | 🟡 | **Unread** (page errors) | The portal footer links to Socrata's terms; neither page loaded | Read once in a browser |
| 1.4 | **City of Miami** (next connector) | 🟡 | V (by the markets review) | **CC BY 4.0**. Credit line: "© 2019 City of Miami, Department of Innovation and Technology, GIS Team". Attribution is **required wherever its data appears**: screens, digests, exports | The connector (#29, migration 008) stores the credit in `sources.attribution_text` and is disabled. Before enabling it or adding it to the pilot screens, show that text in `attribution()`, the digest and any export |
| 1.5 | **Raleigh** (next connector) | 🟡 | V (by the markets review) | "Open Raleigh Data Policy": as is, at own risk, and the City may require us to stop "displaying, distributing or otherwise using" the data for any reason. Its privacy policy was unreadable. It publishes contractor emails (85-91%) | Build so a source can be switched off and purged in a day. Emails trigger CAN-SPAM for any subscriber who mails them (section 3) |
| 1.6 | **Philadelphia** | 🔴 | V (by the markets review) | phila.gov: "Commercial use is prohibited without the prior written permission of the City." | Blocked. Use only with written permission |
| 1.7 | Orlando (fallback) | 🟡 | **Unread** | No licence in metadata; "Legal" page not read | Read before building |
| 1.8 | **Oregon** sources in code (Washington County, Clackamas, statewide Accela, Portland CSV) | 🟢 while off | V (config) | Washington County is CAPTCHA-gated and excluded (rule 2). Accela portals are off (ADR-5). Accela Citizen Access sites commonly forbid automated access in their terms **[A]** | Keep off. Turning one on needs its terms read and a `sources` entry |
| 1.9 | **TDLR** licence file, data.texas.gov `7358-krk7` (planned) | 🟡 | V (metadata); portal terms unread | Metadata requires attribution "Texas Department of Licensing and Regulation" with link to the TDLR licence search. Rows hold `owner_name` and `owner_telephone`, which are individuals' data | Show the attribution wherever a TDLR value appears. Never display `owner_*`. Treat `business_telephone` of a one-person licensee as possibly personal (2.3) |
| 1.10 | **TSBPE** plumber lists (planned) | 🟡 | V | "Free licensee list" CSVs, updated daily. Only a disclaimer: "we make no guarantees". No commercial or redistribution rule found. Lists are of individual licensees with a "last known company name" | Use the company name and licence number only; hide personal names |
| 1.11 | **Travis CAD** appraisal exports (planned) | 🟢 for property facts, with the rules below / 🔴 for owner, exemption and sale fields | V (Actions run 43462398001: TCAD page, export layout, statute text) | TCAD posts the exports on its public-information page "for public review" with no terms, licence, disclaimer, fee or login (searched the page for terms, licence, commercial, disclaim, resale: none). Gov't Code §552.007(b): information a body releases voluntarily "must be made available to any person". In the sections read, no statute limits what a private recipient does with released roll data. But the layout carries owner name and mailing address, a "Confidential Flag", an "Address Suppression Flag", a "Current Appraisal Owner Confidential Name", homestead, over-65 and disabled-veteran exemptions, and deed fields. Tax Code §25.027 bars posting on the Internet any appraisal-record information that "indicates the age of a property owner, including ... 65 years of age or older", or a residential "photograph, sketch, or floor plan". §25.025 makes listed people's home addresses (peace officers, judges, family-violence victims and others) confidential. §22.27 makes renditions and promised-confidential sale prices confidential, and (c) makes it a misdemeanor for anyone who "legally obtains" them to disclose them | Follow "Travis CAD use rules" below. Counsel Q9 still applies |
| 1.12 | **Miami-Dade Property Appraiser** (planned) | 🟡 | V (disclaimer); search app unreadable | "As is"; "all rights not expressly granted herein are reserved"; users must not present themselves as the Appraiser's representative. Florida s. 119.071(4)(d) exempts some protected people's home addresses **[A]** | As 1.11. Counsel Q9 |
| 1.13 | **US Census geocoder** (planned) | 🟡 | V | API terms: users "will not use these data, alone or in combination with any other ... data, to identify any individual person, household, business or other entity", and must show "This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau." It is unclear whether the geocoder is covered; the clause targets Census data, but its words are broad. Batch limit 10,000 | Counsel Q4. Show the notice anyway; never present a geocoded point as a person's location |
| 1.14 | OpenStreetMap tiles and Nominatim (map, `data/area-coords.json`) | 🟡 | A (policies from memory, not re-read) | The tile and Nominatim usage policies require attribution (shown), forbid heavy or bulk use, and point commercial products at a paid tile provider. Area centroids were geocoded once and committed | Before paid launch, move tiles to a provider whose terms allow commercial use |
| 1.15 | **Google Street View Static** (job-page photos, ADR-24) | 🟡 | V (ToS 2026-08-26, policies 2026-11-09) | No storing or caching (only `pano_id`); no Street View "and non-Google Maps on the same screen"; no content built from the images; show Google's attribution unmodified; the app must have public Terms of Use and a Privacy Policy that mention Google Maps content | Loaded live in the browser only; never beside the Leaflet map; `docs/IMAGERY.md`. **Open:** our public Terms and Privacy pages |
| 1.16 | Mapillary images | 🟡 not used | V (terms effective 2024-02-15) | Images CC BY-SA, but commercial use is "subject to the additional terms in Section 12", public display only "as expressly permitted", apps must "materially supplement" content | Ask Mapillary in writing, or counsel, before use |
| 1.17 | **Wake County parcels** (`wake-parcels`, connected 2026-11-14) | 🟢 for property facts / 🔴 for owner, ownership type, deed, sale and exemption fields | V (Actions runs 43593964325, 43594319991: ArcGIS item and Hub dataset metadata) | ArcGIS Hub dataset licence **CC BY 4.0**, source Wake County. The item's own text is a disclaimer: no liability, not a legal document, verify with primary sources. Attribution stored on the source row and shown with the property panel | Owner, mailing, `OWNERSHIP`, billing class, deed book/page/date, sale and exemption fields are never requested (`buildParcelQuery` refuses them). Sale date stays out until counsel review (DATA_ENGINE_PLAN 6.4) |
| 1.18 | **Texas Comptroller franchise-tax API** (`tx-comptroller`, connected 2026-11-14) | 🟡 | V (API documentation 2026-11-14) | Public data, key issued to the owner on registration. The documentation states no terms of use, redistribution rule or rate limit. Responses include officers and the registered agent (people) | Officers, agent, street addresses and FEIN are never stored. Status and SOS file number are shown only as business facts. Read any terms shown at registration and record them here |

#### Travis CAD use rules (2026-11-13)

These apply to the property-data join (ADR-14 step 3). The pipeline enforces
them at load time, not at display.

1. **Load only property facts**: parcel ID, year built, living area, land and
   improvement value, land use or state code, improvement type and class, and
   lot size (land-segment square feet, added 2026-11-14).
2. **Never load** owner name, owner ID, owner or mailing address, deed fields,
   exemption flags or amounts (homestead, over-65, disabled, veteran and the
   rest), sale prices, renditions, or any photo, sketch or floor plan.
   Over-65 status is barred from Internet posting outright (§25.027). Disability
   and veteran exemptions are sensitive personal data.
3. **Skip the whole parcel** when its Confidential Flag or Address Suppression
   Flag is `T`. That keeps us from adding facts to a §25.025 protected person's
   home.
4. **Attribution and freshness**: credit "Travis Central Appraisal District",
   and show the roll year (certified July, with supplements) next to every
   value. It is an appraisal estimate, not a sale price or a market quote.
5. Read the export's own header lines once when the loader is built. If an
   export ever carries sale price, drop the column.

### 2. Privacy: what the demo and exports can leak

| # | Item | Status | Basis | Finding | Next step |
| --- | --- | --- | --- | --- | --- |
| 2.1 | Owner and applicant fields | 🟢 | V (code, unit and integration tests) | `owner`, `applicant_name`, `applicant_phone` are stored but never selected by any API (`src/privacy.js`, `privacy.test.js`). No export endpoint exists | Keep the test as the guard |
| 2.1a | Austin application filers (ADR-19) | 🟡 | V (code, unit and integration tests) | Only `applicant_organization_name` and `other_organization_name` are read; owner fields, `*_full_name`, phones and addresses are not. An org equal to the owner org is dropped; a person-looking org name is withheld (`src/filers.js`, `test/integration/filers.test.js`). Business filers are shown with their role and evidence | A sole proprietor trading under a business-sounding name is shown; same exposure as contractor names today. The removal list (migration 009) is by phone, so a name removal needs a code change today |
| 2.2 | Person-looking contractor names and phones | 🟢 | V | Names that look like a person return "Individual (withheld)" with no phone on every pilot screen and in search (`partyKind`, ADR-12). It is a heuristic: "J Smith" style names fall to `unknown` and are also withheld. **Widened 2026-11-14 (`contractors-v3`, ADR-22, owner approved):** trade and firm words such as repair, foundation, interiors, permits, architecture, and "by"/"of" in a name now read as a business, so "Bluebonnet Foundation Repair" and "Renewal by Andersen" are shown. A plain first and last name ("Austin Smith", "Taylor Morrison") is still withheld (`src/contractors.test.js`). A business named after its owner ("Martha Nolan Interiors") is now shown with its phone, the same exposure as row 2.3 | Re-run `recon/party_kind_diff.js` (filer-check workflow, mode `party-kinds`) before any further widening and read its sample |
| 2.3 | **Sole proprietor cells under a business name** | 🟡 | A | "Smith Electric" may list the owner's cell. The law presumes a wireless number residential (*Chennette v. Porch.com*, 9th Cir. 2022, read for the outreach sheet). We show it as a business phone | Counsel Q1. Add a wireless flag before customers call at scale |
| 2.4 | Personal names in a company's alias list | 🟢 fixed in this PR | V (code) | A licence-keyed Miami-Dade contractor could list its licence holder's personal name among its spellings, and the profile showed every spelling. Person-looking spellings are now left out (`publicAliases`) | — |
| 2.5 | **Names inside permit descriptions** | 🟢 fixed in this PR (mask) / 🟡 (recall not proven) | V (measured, Actions run 43450167691) | Some Austin descriptions carry a name, often the customer's: "(John Smith) - INSTALLATION OF CIRCUIT FOR EV CHARGING", generator jobs ending "(Name)", "Smith Residence", "Owner: Jane Doe". Descriptions are now masked for display on every API path (`src/description_names.js`): "[name withheld]". The stored text is unchanged. Over 12 months (56,491 descriptions) the final mask fires on **217 (0.38%)**, 22 of 12,355 building permits. A first, looser version fired on 1.8%, mostly on ordinary words such as "single-family"; those are fixed and tested. It errs toward hiding: some business and product names in parentheses are hidden too. Recall is not measured against a hand-labelled sample, and a name in another shape can still slip through. Search (`q`) runs on the masked copy (`work_description_public`, migration 010), so typing a masked name finds nothing. Rows written before 010 become searchable by description after the next nightly resolve | Hand-label 200 descriptions once to measure recall. Re-run `recon/description_names.js` (feasibility workflow, input `descriptions`) after any vocabulary change |
| 2.6 | Search by contractor name | 🟡 | V (code) | `/api/permits?contractor=` matches withheld names too. The name and phone come back withheld, but the permits (addresses) of "John Smith" are still listed, which confirms where a named individual worked | Restrict the filter to shown names, or require an exact business match |
| 2.7 | Removal and correction | 🟢 fixed in this PR (mechanism) / 🟡 (intake) | V (integration test) | Before: none, and any hand edit was wiped by the nightly re-resolve. Now `suppressions` hides a phone or a company's phones on every read path, at once. There is still no public way to ask (no contact address on the site) | Publish a removal address on the sign-in page and footer before paid launch |
| 2.8 | Error messages | 🟢 fixed in this PR | V | The search API returned database error text to the client. It now returns a generic error, like the pilot API | — |
| 2.9 | Storage of owner names | 🟡 | V (code) | Owner names are kept in `permits.owner` and in raw payloads with no use yet. Data we never show still carries breach and data-broker exposure | Counsel Q5. Consider dropping `owner` from the mapped table until ADR-10's gate |
| 2.10 | Fixtures and validation files | 🟢 | V | `recon/capture_fixture.js` replaces person fields and phones. `docs/validation/*.csv` and `/mnt/project-files/validation/austin-targets-with-contacts.csv` hold business contacts and, in the second, the person named on the permit. They are internal outreach lists in a private repo | Never share the contacts file outside the team |

### 3. Outreach and telemarketing law

| # | Item | Status | Basis | Finding | Next step |
| --- | --- | --- | --- | --- | --- |
| 3.1 | Federal TCPA, autodialed or prerecorded calls and texts | 🟢 if hand-dialed | V (statute read for the outreach sheet) | Hand-dialing is not an ATDS call (*Facebook v. Duguid*). Texts count as calls | Founder: no dialers, voicemail drops or cold texts |
| 3.2 | National Do Not Call | 🟡 | V (rule) / A (application) | Covers residential subscribers; contractor cells are presumptively residential (2.3). A second call in 12 months to a registered number opens private suits at $500-$1,500 per call | Scrub cells; email first if registered |
| 3.3 | **Texas ch. 302 registration** | 🔴 before outreach scales | V (statute) / S | "Telephone solicitation" includes calls to induce someone to "receive" a service; there is no general B2B exemption. Registration costs a $10,000 security deposit. SB 140 (2025) added texts and DTPA private suits | Counsel Q6 before more than a handful of calls. Keep calls to discovery plus "may I email you?" (302.059(1)) |
| 3.4 | Texas calling hours (ch. 301) and no-call list (ch. 304) | 🟢 | V | Consumer-focused; B2B is arguably outside. Follow the hours anyway | — |
| 3.5 | CAN-SPAM | 🟢 with the footer | V (FTC guide) | Applies to B2B email. Needs a postal address and working opt-out | Footer on every email. Built for digests (ADR-20): the send refuses without `MAILING_ADDRESS`; opt-out is one click, at once, all emails. Still to do: a real postal address (a PO box or registered mailbox counts) |
| 3.6 | **Florida**: s. 501.059 (mini-TCPA) and the Florida Telemarketing Act (ch. 501 part IV, FDACS licence) | 🟡 | S (501.059) / A (licensing and its B2B exemption) | Miami-Dade outreach has not started. The Act requires commercial telephone sellers to hold an FDACS licence, with exemptions we have not read | Counsel Q7 before the first Florida call |
| 3.7 | FTC Telemarketing Sales Rule | 🟢 | V | B2B calls are exempt except the misrepresentation bans (2024 amendment) | Sales claims stay inside section 5 of the brief |
| 3.8 | **Customers calling our leads** (paid product) | 🟡 | A | We never dial (rule 5), but subscribers will cold-call numbers we supply. Liability for "assisting and facilitating" is a TSR concept; for TCPA it is the caller's | Customer terms: subscriber is responsible for TCPA, DNC and state law; no autodialing our numbers. Counsel Q8 |

### 4. State privacy and data-broker law

| # | Item | Status | Basis | Finding | Next step |
| --- | --- | --- | --- | --- | --- |
| 4.1 | **Texas data broker law (ch. 509)** | 🟡 | S + bill text | Since 2025-09-01 it covers a business that transfers personal data it did not collect directly, above 50% of revenue or data on 50,000+ individuals. Nearly all our revenue would come from such data. Whether business contacts of sole proprietors, or permit addresses, are "personal data" here, and whether public records are excluded, is open. Penalty $100/day, cap $10,000/yr | Counsel Q2. Registration is cheap relative to the penalty if counsel is unsure |
| 4.2 | Texas Data Privacy and Security Act (ch. 541) | 🟢 | A | Excludes publicly available information and people acting in a commercial context; small businesses are largely exempt | Re-check if we add appended (non-public) contacts |
| 4.3 | Florida Digital Bill of Rights | 🟢 | A | Applies only to companies with over $1B revenue | — |
| 4.4 | California (Delete Act, DROP), Oregon and Vermont broker registries | 🟢 now / 🟡 on expansion | A | Not triggered by Texas and Florida data. Oregon sources are off | Check before any CA, OR or VT market |
| 4.5 | FCRA | 🟢 | A | We report on businesses, not consumers' eligibility for credit, jobs or housing | Customer terms: no FCRA purposes |
| 4.6 | "Who works with whom" intelligence | 🟡 | A | Selling which subs a GC uses, built from public permits, could draw unfair-competition or interference claims | Counsel Q10 |

### 5. Sales claims

| # | Item | Status | Basis | Finding | Next step |
| --- | --- | --- | --- | --- | --- |
| 5.1 | Sales brief | 🟢 | V | Bans "verified", "unhired", "first", "real-time". Added: "open now", agency endorsement, personal details | Keep in step with the UI |
| 5.2 | Demo wording | 🟢 fixed in this PR | V | The header said "Live data", and the GC screen had "Jobs open now" and an "Open now" column, which implies the job is unhired. Now "From public permit records, synced daily" and "No trade permit yet" | — |
| 5.3 | Attribution and endorsement | 🟢 fixed in this PR | V | The contractor profile always credited Austin, even for Miami-Dade firms, and Permit search credited no source. Both now name the sources and say we are not affiliated with or endorsed by them | Add City of Miami's CC BY credit with its connector (1.4) |
| 5.4 | Numbers in the brief | 🟢 | V | Each figure traces to a measurement in the repo | — |

### 6. Demo access, retention, deletion

| # | Item | Status | Basis | Finding | Next step |
| --- | --- | --- | --- | --- | --- |
| 6.1 | Shared password | 🟡 | V (code, PR #26) | One password for everyone; no per-viewer accounts, log or terms. A prospect can share it, and nothing binds them to our data rules. PR #26 adds a branded sign-in page | Before broad sharing: a one-line terms notice on the sign-in page (no scraping, no resale, B2B use only), and per-prospect links (the signed-link decision) |
| 6.2 | Raw retention | 🟢 | V | Superseded payloads deleted after 90 days; the latest payload per permit is kept | Document a retention period for owner fields (2.9) |
| 6.3 | Deletion requests | 🟡 | V | Suppression hides; it does not delete. Raw payloads still hold the number, which is needed for provenance | Counsel Q5: is hiding enough for public-record data? |
| 6.4 | Our own terms and privacy notice | 🔴 before charging | V (none exist) | No customer terms, privacy notice or acceptable-use policy | Draft before the first paid customer; counsel reviews |

## Questions for counsel (one 1-2 hour consult, before charging money)

Ordered by impact. Each names what we would change on the answer.

1. **Sole-proprietor phones.** Can we show and sell a phone published on a
   building permit when the contractor trades under a business name but the
   number may be the owner's cell? Is a wireless flag plus customer terms
   enough? (If no: hide `unknown`-carrier wireless numbers by default.)
2. **Texas ch. 509.** Is a B2B product built from public permit records, with
   business names, permit-listed phones and job addresses, a "data broker"
   transferring "personal data"? Do the public-records or commercial-context
   carve-outs apply? Should we register anyway?
3. **Source terms.** Austin's terms put its data in the public domain. Does
   Miami-Dade's "rights not expressly granted are reserved" clause allow
   storing and showing its permit records in a paid product, or does Florida
   ch. 119 settle that? Must Raleigh's "may require termination" clause be in
   our customer terms?
4. **Census geocoder.** Does the Census API clause against using data "to
   identify any ... business or other entity" apply to geocoding permit
   addresses that we then tie to a contractor? If so we use another geocoder.
5. **Hidden personal data.** What do we owe for owner names we store but never
   show (security, retention, deletion)? Is hiding a number on request enough,
   or must we delete it from raw payloads too?
6. **Texas ch. 302.** Do discovery calls that offer a free pilot need
   registration ($10,000 deposit)? Does 302.059(1) cover us if nothing is sold
   by phone? What did SB 140 change about private suits?
7. **Florida.** Does the Florida Telemarketing Act's licence apply to calls to
   Miami-Dade subcontractors about a business product, and which exemption
   fits? Does s. 501.059 apply to B2B calls to cells?
8. **Customer calls.** Once subscribers cold-call our numbers, what must our
   terms and product provide (DNC or wireless flags, suppression feeds) to
   keep liability with the caller?
9. **Protected addresses.** How should we treat owners whose addresses are
   confidential under Texas Tax Code §25.027 or Florida s. 119.071(4)(d) when
   we join appraisal data by parcel?
10. **Relationship intelligence.** Any unfair-competition, tortious
    interference or trade-secret concern in selling "which subs this GC uses",
    derived only from public permits? Until answered, outreach names builders,
    never a competitor sub, in writing.

Homeowner track (ADR-10), only when that track starts:

11. Can subscribers use permit-derived owner names plus vendor-appended phones
    for calls and texts? What consent, Do Not Call scrubbing and calling-hour
    rules apply federally, in Texas and in Florida (s. 501.059)?
12. Does selling homeowner leads make us a data broker in Texas or California
    (Delete Act and DROP)? Is direct mail to a permit address lower risk than
    phone outreach?
