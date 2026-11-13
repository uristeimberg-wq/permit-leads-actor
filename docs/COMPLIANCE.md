# Compliance

**This is not legal advice.** It records what we found, the rules the product
follows, and the questions that need qualified counsel. Review it before any
outbound feature ships and before adding a state.

## Rules the product follows (v1)

1. **B2B first; homeowner leads are gated** (ADR-10). No display or export of
   owner names or individual contacts until the homeowner gate passes. The
   gate needs: counsel's answers to questions 6 to 9 below, a contact vendor
   whose terms permit marketing use, Do Not Call scrubbing, and working
   suppression.
2. **Never bypass access controls.** That means no CAPTCHA solving, no logging
   in with someone else's credentials, and no evading rate limits or blocks.
   If a source signals no automation (CAPTCHA, terms, `robots.txt`), it stays
   off. We use an official API or a bulk request instead.
3. **Every source records its terms review** in `sources`: URL, date,
   reviewer, automated-access verdict, redistribution verdict. A source with
   `automated_access = 'no'` cannot be scheduled.
4. **Contacts carry provenance and a display policy.** Business contacts on
   the permit are shown. Anything that looks like an individual, such as an
   applicant's personal phone or a sole proprietor's cell, defaults to
   `review` or `hide`.
5. **We never contact anyone on a user's behalf.** No dialing, texting or
   emailing contractors from the platform. Users get a number and make their
   own call.
6. **Suppression and correction.** Removal and correction requests are logged
   and honoured. Suppressions apply to digests, the API and exports.
7. **Retention.** Raw payloads are kept for traceability unless a source's
   terms set a limit (`raw_retention_days`).

## Findings so far

| Topic | Finding | Confidence | Source |
| --- | --- | --- | --- |
| Austin dataset licence | Tagged `USGOV_WORKS` (public-domain government work) | Verified tag; Terms of Use page not read | dataset metadata |
| Miami-Dade layer terms | None stated on the service | Verified absence; portal terms not read | service JSON |
| Federal Do Not Call | Protects residential subscribers. Business lines are generally outside it, but a sole proprietor's cell may count as residential | General understanding; **counsel** | FTC and FCC guidance |
| Federal TCPA | Autodialed or prerecorded calls and texts to cell phones need consent, B2B included | General understanding; **counsel** | |
| Florida mini-TCPA (s. 501.059) | The 2023 amendments narrowed "autodialer" to systems that both select and dial, and added a 15-day cure after a "STOP" text | Secondary source | [McGuireWoods, May 2023](https://www.mcguirewoods.com/client-resources/alerts/2023/5/pro-business-amendments-to-floridas-mini-tcpa-now-in-effect) |
| Texas data broker law (ch. 509) | Since 2025-09-01 it covers a business that transfers personal data it did not collect directly. It applies above thresholds: more than 50% of revenue, or data on more than 50,000 individuals. Penalty $100/day, capped at $10,000/yr | Secondary source plus bill text | [WilmerHale](https://www.wilmerhale.com/en/insights/blogs/wilmerhale-privacy-and-cybersecurity-law/20250904-texas-expands-and-modifies-data-broker-registration-law), [SB 1343](https://capitol.texas.gov/tlodocs/89R/billtext/html/SB01343F.htm) |
| Florida protected addresses (s. 119.071(4)(d)) | Home addresses of certain protected people (law enforcement, judges and others) are exempt from public records. Permit data may still contain them | General; **counsel** | |

## Questions for counsel (one 1-hour consult, before M4)

1. Can we show and export a contractor phone published on a permit, when the
   contractor is a sole proprietor and the number may be a personal cell?
2. Does a B2B platform built on public-record contractor data trigger Texas
   data-broker registration? What about Florida's or California's rules if we
   expand?
3. Do the Austin and Miami-Dade terms allow commercial redistribution of
   permit records in a paid product, and what attribution do they require?
4. What is the minimum suppression and correction process we should offer?
5. Any obligations from storing owner names that we never display?

Homeowner track (ADR-10):

6. Can subscribers use permit-derived owner names plus vendor-appended phones
   for calls and texts? What consent, Do Not Call scrubbing and calling-hour
   rules apply federally, in Texas and in Florida (s. 501.059)?
7. Does selling homeowner leads make us a data broker in Texas (ch. 509) or
   California (Delete Act and its deletion mechanism)? Do we have to register?
8. Is direct mail to a permit address treated differently from phone
   outreach? Mail may be the lower-risk first channel.
9. How do we handle owners whose addresses are exempt under Florida
   s. 119.071(4)(d)?
