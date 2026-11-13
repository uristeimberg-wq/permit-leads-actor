# Austin pilot validation (customer discovery)

Prepared 2026-11-13. Nothing here has been sent to anyone. The founder makes
every call and sends every email personally. Nothing in this folder is product
code or a product data source.

## The question

Milestone 1 found that trade permits follow residential building permits by a
median of 25–63 days. The timing analysis (PR #6) then found that when a builder
already has history in a trade, about 94% of its trade permits go to a sub it has
used before (98% for big builders). At most about 25% of trade jobs look open
to a new sub. So we test two pitches, leaning toward the second:

- **Pitch A, early leads:** jobs with a building permit and no trade permit yet.
- **Pitch B, builder–sub relationship intelligence:** which builders use which
  subs, which builders are new or small, and when a builder switches subs.

The goal is 5 active pilot subs (electrical, plumbing, HVAC), with interviews
scored separately for each pitch. Go and kill rules are in `outreach-kit.md`
section 6.

## Files

| File | What it is |
| --- | --- |
| `outreach-kit.md` | Cold email and follow-up, call script, voicemail, objections, a 12-minute interview guide covering both pitches, pilot offers, tracking-sheet spec, weekly plan and stop rules |
| `outreach-compliance.md` | TCPA, FTC TSR, Texas ch. 301/302/304, CAN-SPAM; do/don't checklist; suppression log format; questions for counsel. **Not legal advice** |
| `austin-targets.csv` | 30 Austin subs (10 per trade) from City of Austin permits (Socrata `3syk-w9eu`, fetched 2026-11-13), ranked toward subs who work for many small or new builders |
| `austin-targets-v1.csv` | The first ranking, by permit volume only, kept for comparison |
| `target-list-method.md` | Exact queries, selection rules, the trade-to-building permit link, GC weighting and caveats |
| `gc-links-sample.tsv` | Every sampled sub-to-builder link used in the weighting |
| `austin-communities.md` | Associations, supply houses, events and online groups for recruiting, with confidence labels |

## Read before dialing

1. **Call the strong fits first.** 12 of the 30 have a small or new builder
   share of 40% or more (`small_new_gc_share`). Three of those need care:
   JRV's "new" builder is Trophy, a large production builder new to Austin,
   and Wilkins and Quality Living have only 2 linked builders each. The rest
   fill out 10 per trade. Rows flagged `TIED_TO_ONE_GC` or `FEW_LINKED_JOBS`
   are weak.
2. **The shares come from samples** (9–18 recent jobs per sub, not all 90
   days). They come from WebFetch table transcriptions, not raw JSON.
   Spot-check before quoting a number to a contractor.
3. **Owner-operator flags.** Rows flagged `OWNER_*_IN_COMPANY_NAME` may list a
   personal cell. Treat those as residential for Do Not Call purposes: scrub
   them against the National DNC or email first (see the compliance sheet).
4. **Contact names are not committed.** The CSV here leaves out the
   permit-contact person (CLAUDE.md rule 5: individual contacts are not
   exported). The founder's working copy with names is kept outside git in the
   project files.
5. **Calling hours:** Tue–Thu, 9:00–10:30 am and 4:00–6:00 pm local. Never
   before 9 am.
6. **Biggest open legal risk:** Texas telephone-solicitation registration
   (Bus. & Com. Code ch. 302). Close nothing and take no payment on a call.
   Ask counsel before scaling past this pilot.
