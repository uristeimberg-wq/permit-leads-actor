# Property photos (ADR-24)

The job page shows a Google Street View photo turned toward the job site,
loaded live in the viewer's browser. Nothing is downloaded, stored or cached
by our server. Without a key the photo card is not shown at all.

Code: `web/public/pilot/live/photos.js` (rules, browser card),
`web/imagery.js` (`/api/pilot/imagery`, reads the key), tests beside each.

## How a photo is chosen and labelled

1. The job's map point (`permit_locations`: the source's point, the
   appraiser parcel, or the Census geocoder) is the target.
2. The browser calls the Street View **metadata** endpoint (free, no image
   quota) for an outdoor panorama within 60 m. `ZERO_RESULTS` or any other
   status shows "no photo" with the reason. No grey placeholder, no
   neighbouring panorama passed off as the house.
3. Distance from the panorama to the target sets the starting tier: up to
   25 m **high**, 25-40 m **medium**, 40-60 m **low** (with "may show a
   neighbouring building"), beyond 60 m nothing.
4. Doubts lower it: a Census point caps at medium (exact match) or low
   (approximate); a missing capture date or one over 36 months old caps at
   medium. A capture before the permit's issue month is said in words.
5. Only then is the one billed **image** request made, by `pano` id, with
   `heading` = bearing from the panorama to the target, `return_error_code`
   so a missing image is a 404, not a grey tile. A failed load is replaced by
   a line saying so.
6. Each photo shows its tier, capture date as Google gives it (year-month or
   year), distance, the caveats, "Google Maps" with the metadata `copyright`,
   a link to open the panorama on Google Maps, and a line that the page
   includes Google Maps content under Google's terms and privacy policy.

Wording rule: never "photo of the property". The tiers read "likely",
"probably" or "may not be" the job site.

## Terms checked (2026-11-14, not legal advice)

Google Maps Platform Terms (page dated 2026-08-26), Service Specific Terms
(2026-10-15), Street View policies, metadata and billing pages (2026-11-09),
pricing (2026-11-11):

- **No storing or caching** of Google Maps Content (ToS 3.2.3(a)(i), (b));
  only `pano_id` may be stored. We store nothing.
- **No use with a non-Google map**: ToS 3.2.3(e), example "(ii) display
  Street View imagery and non-Google Maps on the same screen". The job page
  has no map, only a text link to the point on OpenStreetMap. **Never put
  the Leaflet map, or any aerial image, on the same screen as a Street View
  photo.**
- **No content built from it** (ToS 3.2.3(c)): we don't index, classify or
  extract anything from the images.
- **Attribution**: show what Google provides, unmodified; "Google Maps" text
  is acceptable where the logo doesn't fit; keep it in the same container.
- **Our own Terms of Use and Privacy Policy must be publicly reachable**
  (Street View policies), and must say the app includes Google Maps content
  subject to Google's terms. **Open:** the demo has neither page yet. Add
  both before customers outside the pilot see photos.
- **Cost**: metadata free and unlimited. Static Street View: 10,000 free a
  month, then $7.00 per 1,000 up to 100k. One image per job-page open (the
  browser may reuse it within a visit). The old $200 monthly credit is gone.

## Other photo sources considered

| Source | Verdict | Why |
| --- | --- | --- |
| Mapillary (CC BY-SA images) | **Not used yet** | The images are CC BY-SA, but the Mapillary terms (effective 2024-02-15) say commercial use is "subject to the additional terms in Section 12", bar publicly displaying the services "except as expressly permitted", and require apps to "materially supplement" rather than redistribute content. Whether a paid permit product fits is unclear. Needs Mapillary's written OK or counsel |
| Travis CAD photos and sketches | **Never** | Texas Tax Code §25.027 bars posting residential appraisal photos or sketches online (COMPLIANCE 1.11) |
| Miami-Dade Property Appraiser | **No** | Site offers aerials and sketches, no building photos; "all rights not expressly granted herein are reserved" |
| Wake County real estate | **No** | No reuse grant in the disclaimer; photos not confirmed |
| USGS The National Map imagery (public domain) | **Not used** | Cached only to about 2.4 m per pixel (`maxScale` 9028), too coarse to show a house; no capture date per spot (service lists NAIP as 2017-2021). Also an aerial beside Street View risks the non-Google-map clause |
| TxGIO StratMap, NC and Miami-Dade orthos | **To check** | Likely public, sharper (15-30 cm), dated per flight. Government hosts are only reachable from GitHub Actions; verify the endpoint, licence and date there before adding. Would go on a screen without Street View |
| Nearmap, EagleView, Esri World Imagery | **No** | Licensed, paid, no redistribution |

## Setting up the Google key (owner)

The key ends up in every viewer's browser, so its restrictions are what keep
it safe. Use a Google account you control.

1. **Project.** Go to https://console.cloud.google.com/projectcreate, name it
   `contractos-imagery`, create it, and select it.
2. **Billing.** https://console.cloud.google.com/billing: link a billing
   account (Google requires one even inside the free 10,000 a month).
3. **Budget alert.** Billing → *Budgets & alerts* → *Create budget*: scope
   the project, amount **$10**/month, alerts at 50%, 90% and 100% to your
   email. A budget alerts; it does not stop spending, so also do step 6.
4. **Enable the API.** https://console.cloud.google.com/apis/library/street-view-image-backend.googleapis.com
   → *Enable* ("Street View Static API"). Enable nothing else.
5. **Create and restrict the key.** APIs & Services → *Credentials* →
   *Create credentials* → *API key*. Open the key:
   - *Application restrictions*: **Websites**. Add
     `https://permits-production-9581a3c0.up.railway.app/*` (and your own
     domain later; `http://localhost:3000/*` only on a separate dev key).
   - *API restrictions*: **Restrict key** → only **Street View Static API**.
   - Save.
6. **Daily cap.** APIs & Services → *Enabled APIs* → Street View Static API →
   *Quotas & system limits*. Edit the per-day request quota to **300**
   (about 9,000 a month, under the 10,000 free). If only a per-minute quota
   is listed, set that to 10 and rely on the budget alert; tell Claude which
   limits the page shows. Requests over the cap fail, and the
   page shows "no photo (the image did not load)".
7. **Railway.** In the `permits` service → *Variables*, add
   `GOOGLE_MAPS_BROWSER_KEY` = the key (starts `AIza`, 39 characters). Railway
   redeploys; open any job page and the Photos card appears.

To turn photos off, delete the variable. A malformed value is ignored.
Spending beyond the free 10,000 a month needs the owner's go first.
