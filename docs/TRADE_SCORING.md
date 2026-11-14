# Trade scoring: electrical, plumbing, HVAC (ADR-17)

Approved 2026-11-14. The rules live in `src/scoring.js` (`scoreSubTrade`) and
apply in order; the first that matches decides. The timing bonus (+12 applied,
+5 issued) still applies on top. Tests: `src/scoring.test.js`.

1. **A trade permit is not a lead.** The permit type says electrical,
   mechanical or plumbing (Austin EP/MP/PP, Raleigh "DSINSP - Electrical", City
   of Miami MECHANICAL/PLUMBING), so that sub is already on the job: 0 for every
   trade.
2. **Not building work: 0.** Right of way, driveway, sign, fence, demolition,
   fire sprinkler and pool permit types. Raleigh copies the parent building
   permit's description onto these.
3. **New homes and units: 90.** New SFR/SFD/house/residence/duplex/condo,
   townhomes, "N units", accessory dwelling unit, "new construction of" a home.
   City of Miami's NEW CONSTRUCTION type alone does not count; it is used for
   every component of a new building.
4. **Site and envelope only: 0.** Fence, sign, driveway, parking lot, windows,
   doors, roof, trusses, railings, foundation, demolition, deck, porch, pool,
   unless the description names the trade, or is an addition with rooms or a
   build-out.
5. **Additions and build-outs: 65, or 85 naming the trade.** Remodel naming the
   trade 75; City of Miami itemized trade lines 50 (likely the sub's own
   permit); any other mention 50; a remodel naming no trade 35.

Commercial work is scored like residential for now.

## Before and after, on recorded permits

95 distinct permits from `test/fixtures/sources/` (captured 2026-11-13):
before, 18 had a lead score (25+) for some sub trade; after, 24, and 36 changed.
Scores are electrical / plumbing / HVAC with no timing bonus.

| Market | Permit type | Description (shortened) | Before | After |
| --- | --- | --- | --- | --- |
| City of Miami | NEW CONSTRUCTION | Surface parking lot | 95/95/95 | 0/0/0 |
| City of Miami | NEW CONSTRUCTION | Driveway approach | 95/95/95 | 0/0/0 |
| City of Miami | NEW CONSTRUCTION | Trusses | 95/95/95 | 0/0/0 |
| Austin | Building Permit | New construction accessory dumpster enclosure | 95/95/95 | 0/0/0 |
| Raleigh | Building | New SFD, lot 46 | 0/0/0 | 90/90/90 |
| Raleigh | Building | Townhomes, 6 units, 3 stories | 0/0/0 | 90/90/90 |
| Miami-Dade | NEW | New house | 0/0/0 | 90/90/90 |
| City of Miami | REMODELING/REPAIRS | Single family ancillary dwelling unit | 0/0/0 | 90/90/90 |
| Raleigh | Building | Renovate master bath: new plumbing, electrical, venting | 0/0/0 | 75/75/75 |
| Raleigh | Building | Addition: bathroom, closet, bedroom | 0/0/0 | 65/85/65 |
| Raleigh | Building | Build-out of an 80,000 sq ft fitness club | 0/0/0 | 65/65/65 |
| Raleigh | Building | Covered porch with lights and receptacles | 0/0/0 | 50/0/0 |
| Raleigh | DSENG - Right of Way | Townhomes (parent's description) | 0/0/0 | 0/0/0 |
| Austin | Plumbing Permit | Replace existing water heater | 0/55/0 | 0/0/0 |
| Miami-Dade | ADDITION - DETACHED | New swimming pool | 0/0/75 | 0/0/0 |

Known miss: a City of Miami "Owner identification signs (electrical)" permit
scores 0, because sign permits are excluded. 95 permits is a small sample; the
revisit trigger in ADR-17 asks for a production check of 30 hits and 30 misses
per market.
