# luxe-lead-capture, Enquiry Capture and Lead Routing

## Purpose
Serverless backend for both Student Luxe and Stay Luxe brands. Captures leads from Squarespace, runs duplicate detection, writes to Monday.com, sends Resend emails, uploads conversions to Google Ads via the Data Manager API, and powers the attribution dashboard.

Full architecture, env vars, Monday column IDs, and migration history live in [README.md](README.md). Start there.

## Key files
- `api/submit-enquiry.js` — Student Luxe form handler
- `api/submit-stayluxe.js` — Stay Luxe form handler (must remain in parity with the Student Luxe handler minus the Google Ads upload)
- `api/submit-booking.js` — Monday webhook for Confirmed Booking + revenue events
- `api/submit-high-potential.js` — Monday webhook for High/Moderate Potential events
- `api/_dataManager.js` — Google Data Manager API client (replaces the deprecated `uploadClickConversions` path)
- `api/_attribution.js` — KV session journal, touch builder, channel classifier
- `api/_alert.js` — Resend email on conversion-upload failure
- `api/gads-retract.js` — Monday webhook (status_11 changes): retracts the Step 1 conversion when a PPC lead's Reason not Qualified is Budget too low or Spam enquiry. Never add lost-good-lead or ghost reasons to its whitelist. Google cannot adjust a conversion it has not processed (up to 24h), so leads younger than 26h queue in KV `gads:retract:pending` and the 6-hourly cron pass (`?retryPending=1`) retracts them once ripe.
- `api/_log.js` — Redis sorted-set log feeding the daily digest. Every Step 1 upload records the `txn` and `clickId` it actually sent, so a later retraction addresses the real conversion instead of guessing from the Monday row (whose gclid column holds the FIRST-touch click id, not the uploaded one).
- `api/_landing-check.js` — follows every Step 1 upload through to a recorded conversion (`checkLandingWindow`, rolling 7 days, each day judged 3 days after upload so Google has settled). Feeds the Conversion follow up section of the daily digest with a running verified/waiting/missing total. Reconciles uploads against the conversions Google actually recorded (`all_conversions_by_conversion_date`, judged 3 days back). "Uploaded" only means the API accepted the request; Google validates asynchronously and can drop an event silently. Uploads with no click id are excluded from the rate, they carry a hashed email only and mostly cannot match a click.
- `api/track.js` — `/api/track` page-view ping from Squarespace
- `api/weekly-summary.js` — Friday cron, PPC bookings digest
- `api/gads-daily-summary.js` — Daily digest, fired by a Claude routine at 09:30 London

## Lead flow (in order, never skip)
1. Squarespace form POSTs to `/api/submit-enquiry`
2. IP blocklist check
3. `buildTouch(req, p)` captures attribution (gclid, gbraid, wbraid, utm, geo, device, browser, KV session)
4. Duplicate detection (4 signals: email, phone, IP, name). 2+ match flags the Monday row. Exception: an IP-only match also flags when the original lead is under 14 days old (same-household detection, e.g. parent + student on home wifi).
5. Monday Leads board write (board id `2171015719`)
6. Lead source + channel classification (`computeLeadSource`)
7. Resend confirmation email (guest + team) in parallel
8. Google Ads upload via Data Manager API (`events:ingest`)
9. KV session attach + email/Monday lookup indices

## Google Ads (Data Manager API)
- Endpoint: `https://datamanager.googleapis.com/v1/events:ingest`
- Scope: `https://www.googleapis.com/auth/datamanager`
- Helper: `api/_dataManager.js`
- DO NOT use the old `googleads.googleapis.com` `uploadClickConversions` path — deprecated, will return ALLOWLIST errors.
- GAQL read queries (click_view, conversion_action, dashboard stats) use `googleads.googleapis.com/v24/.../googleAds:search`. v21 sunsets 05 Aug 2026; when Google deprecates the current version, bump the version segment in `gads-dissonance.js`, `enrich-attribution.js`, `dashboard-gads.js` and smoke-test all three query shapes.
- `developer-token` and `login-customer-id` headers are GONE. MCC mapping moves to `destinations[].loginAccount.accountId` in the body. `x-goog-user-project` header is required.
- Step 1 NEW uses click-based path (gclid/gbraid/wbraid in `adIdentifiers`).
- Step 2/3/4 use Enhanced Conversions for Leads (omit `adIdentifiers`, rely on hashed email + phone).
- All 4 conversion actions must be set to Count = Every (gbraid/wbraid require it).
- Address identifier requires firstName + lastName + regionCode + postalCode ALL present, or the whole request 400s. We don't collect postcode, so `buildUserIdentifiers` skips the address block.

## UTM and cookie capture
- Cookies prefixed `sl_`: `sl_gclid, sl_gbraid, sl_wbraid, sl_campaign, sl_adgroup, sl_term, sl_matchtype, sl_session_id, sl_first_*`
- 90-day TTL on all of them (matches Google Ads click attribution window)
- Read from cookies on submission, not URL params alone
- First-touch twins (`sl_first_*`) write once, never overwrite

## Monday.com
- Leads board: `2171015719`
- Bookings board: `2171015589`
- GraphQL only (never REST)
- Retry logic required on every API call
- Mirror + lookup columns return `display_value`, not `text` — always include both fragments in queries
- Formula columns (e.g. `formula2` Total Luxe Commission) are readable too, but ONLY via `... on FormulaValue { display_value }`. Without that fragment they silently read as null, which is why the JS recompute in `_booking-value.js` was built. Use `bookingValue()` from that module for any booking value: formula2 first (live, handles non-GBP and split bookings), `numeric_mm1ge9h4` as fallback
- Full column-ID map in README

## Monitoring
- Failure alerts to alex@studentluxe.co.uk on any Google Ads upload fail (`sendGadsAlert`)
- Daily digest at 09:30 London (Claude routine -> `/api/gads-daily-summary`)
- Weekly PPC summary Friday 09:00 UTC (Vercel cron -> `/api/weekly-summary`)
- KV `gads:events` sorted set retains 35 days of upload attempts

## Deployment
- Vercel auto-deploy on push to `main`
- Secrets in Vercel dashboard, never commit
- After env var changes, redeploy from Deployments tab so functions pick up the new values

## Conventions
- **Complete files always** — never snippets, never partial edits, never "replace X with Y" instructions. Every code response must be ready to copy-paste in full.
- **No em dashes anywhere** in code, comments, UI strings, or docs. Use commas, colons, or restructure.
- **Stay Luxe parity is mandatory** — `submit-stayluxe.js` mirrors `submit-enquiry.js` except for the Google Ads upload (Stay Luxe doesn't run ads).
- **Duplicate detection is not optional** — runs before every Monday write.
- **Retry on Monday API errors** — every Monday call needs retry logic.
- Brand palette: Navy `#0d1a2e`, Gold `#B8966E`, Cream `#FBF8F2`. Body font DM Sans. Heading font Baskerville / Georgia.

## Related repos
- [AlexO-Luxe/luxe-enquiry-form](https://github.com/AlexO-Luxe/luxe-enquiry-form) — Squarespace reservation form code split into sections + scripts
- [AlexO-Luxe/luxe-organic-content](https://github.com/AlexO-Luxe/luxe-organic-content) — Next.js marketing dashboard. PPC page embeds the Attribution view via React component, also iframes `dashboard-attribution.html` if needed.
