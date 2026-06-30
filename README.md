# luxe-lead-capture

Serverless backend for the Student Luxe + Stay Luxe enquiry/booking pipeline.
Receives form submissions, writes to Monday.com, sends transactional email via
Resend, and uploads conversions to Google Ads via the Data Manager API.

Live at `https://luxe-lead-capture.vercel.app`.

---

## What this stack does, end-to-end

```
Squarespace site
    │
    ├── /api/track          (page-view ping, 90d KV session journal)
    │
    └── /api/submit-enquiry (form submit)
            │
            ├── Duplicate detection (4 signals, 2+ match flags)
            ├── Monday Leads board write
            ├── Resend confirmation email (guest + team)
            ├── Google Ads upload via Data Manager API
            └── KV session attach + lookup indices

Monday webhooks
    │
    ├── status -> Confirmed Booking      -> /api/submit-booking
    ├── revenue column filled            -> /api/submit-booking
    └── potential -> High / Moderate     -> /api/submit-high-potential
            │
            └── Pull linked lead from Monday, upload event via Data Manager API

Cron + Routines
    │
    ├── Vercel cron Fri 09:00 UTC        -> /api/weekly-summary
    └── Claude routine daily 09:30 BST   -> /api/gads-daily-summary
```

Outbound monitoring:
- **Failure alerts** to `alex@studentluxe.co.uk` on any Google Ads upload fail
- **Daily digest** to `alex@studentluxe.co.uk` at 09:30 London (Claude routine)
- **Weekly PPC summary** to `alex@studentluxe.co.uk` every Friday

---

## File map

| File | Role |
|------|------|
| `api/submit-enquiry.js` | Student Luxe form handler. Duplicate detection -> Monday -> emails -> Data Manager upload (Step 1 NEW) |
| `api/submit-stayluxe.js` | Stay Luxe form handler. Parity with Student Luxe minus Google Ads upload |
| `api/submit-booking.js` | Monday webhook. Fires Data Manager event (Step 4 Confirmed Booking) with revenue value |
| `api/submit-high-potential.js` | Monday webhook. Fires Data Manager event (Step 2/3 Potential) |
| `api/submit-lead.js` | Legacy hero form endpoint, still live |
| `api/submit-whatsapp.js` | WhatsApp click tracker (Resend notification only) |
| `api/track.js` | Squarespace page-view ping. Writes 90d session record to Upstash Redis |
| `api/weekly-summary.js` | Friday cron. Reads PPC bookings from Monday, emails weekly summary |
| `api/gads-daily-summary.js` | Claude routine target. Reads `gads:events` KV log, emails daily digest |
| `api/test-alert.js` | Manual sample failure email for verifying alert path |
| `api/dashboard-monday.js` | JSON feed for the marketing dashboard |
| `api/dashboard-gads.js` | JSON feed for Google Ads campaign data |
| `api/dashboard-attribution.js` | JSON feed joining Monday leads + KV sessions |
| `api/dashboard-comments.js` | Comments persistence |
| `api/apartment-pages.js` / `university-pages.js` | Squarespace dynamic content endpoints |
| **Shared helpers** | |
| `api/_dataManager.js` | Google Data Manager API client (OAuth, hashing, destinations, events:ingest, audienceMembers:ingest) |
| `api/_attribution.js` | Cookie parse, touch builder, KV upsert, channel classification |
| `api/_alert.js` | Resend email on Google Ads upload failure |
| `api/_log.js` | KV-backed `gads:events` sorted set for daily digest |
| `api/_lead-qualified-*.js` | Lead Qualified email render + data fetch |
| **Public** | |
| `public/dashboard.html` | Marketing dashboard UI |
| `public/dashboard-attribution.html` | Attribution dashboard UI (also iframed inside `luxe-organic-content` PpcPage) |
| `public/squarespace-tracking-snippet.html` | Site-wide tracking snippet for Squarespace footer |

---

## Environment variables

All set in Vercel project settings. Never commit.

| Key | What |
|-----|------|
| **Monday** | |
| `MONDAY_API_KEY` | Monday.com personal access token |
| **Resend (email)** | |
| `RESEND_API_KEY` | Resend API key |
| `TEAM_EMAIL` | `reservations@studentluxe.co.uk` |
| `TEAM_EMAIL_2` | `alex@studentluxe.co.uk` |
| `FROM_EMAIL` | `reservations@studentluxe.co.uk` |
| `FROM_NAME` | `Student Luxe Apartments` |
| `SITE_URL` | `https://www.studentluxe.co.uk` |
| **Google Ads (Data Manager API)** | |
| `GOOGLE_ADS_CLIENT_ID` | OAuth client id |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_ADS_REFRESH_TOKEN` | Refresh token with `adwords + datamanager` scopes |
| `GOOGLE_ADS_CUSTOMER_ID` | Child Ads account, digits only |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | `6046238343` (MCC) |
| `GCP_PROJECT_ID` | `student-luxe-ads` (the GCP project where Data Manager API is enabled) |
| `GOOGLE_ADS_CONVERSION_ACTION_ID` | Step 1 NEW conversion action id (bare integer) |
| `GOOGLE_ADS_BOOKING_ACTION_ID` | Step 4 Confirmed Booking conversion action id |
| `GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID` | Step 3 conversion action id |
| `GOOGLE_ADS_MODERATE_POTENTIAL_ACTION_ID` | Step 2 conversion action id |
| **Upstash Redis (KV)** | |
| `KV_REST_API_URL` | Set by Vercel Marketplace Upstash integration |
| `KV_REST_API_TOKEN` | Set by Vercel Marketplace Upstash integration |
| **Misc** | |
| `CRON_SECRET` | Guards `/api/gads-daily-summary`, `/api/test-alert`, `/api/weekly-summary?days=N` manual triggers |

To pull the live set locally: `vercel env pull .env.local`.

---

## Monday.com IDs

### Boards
- **Leads board**: `2171015719`
- **Bookings board**: `2171015589`

### Lead columns
| Column id | Field |
|-----------|-------|
| `text37` | First name |
| `text60` | Last name |
| `email` | Email |
| `phone_1` | Phone |
| `text_mm2y2ah2` | Submitter IP |
| `text_mm1c3b5w` | Campaign (friendly name) |
| `text43__1` | UTM adgroup |
| `text3__1` | UTM term |
| `text_mm1d87rp` | UTM matchtype |
| `text4__1` | gclid / gbraid / wbraid / fbclid |
| `text_mm1jhhe7` | Landing page |
| `long_text__1` | Visited paths |
| `color_mkxk8y67` | Lead Source (WHERE) — status column. Values: PPC, SEO, Socials, Referral, Stay Luxe, etc. |
| `dropdown_mkxkfbff` | Lead Channel (HOW) — Google Advert, Bing Advert, Instagram, Meta Advert, TikTok, etc. |
| `color_mkt29g1r` | Lead potential — High Potential / Moderate Potential |
| `status` | Lead status |
| `color_mknqvzde` | Duplicate flag |
| `dropdown_mm1v31yb` | Source form |
| `status0__1` | Currency (city-based) |
| `text8` | City |
| `dropdown6` | Apartment ref |
| `apt_type_mkmn4bgg` | Apartment type |
| `dropdown19` | Areas |
| **Attribution (added 2026-06)** | |
| `text_mm4n6987` | Device (mobile / desktop / tablet) |
| `text_mm4n61bc` | Country (GB / US / etc) |
| `text_mm4nkhk0` | First channel (classified from first touch) |
| `text_mm4ntp4n` | First campaign |
| `text_mm4ncd41` | gbraid |
| `text_mm4n9t2x` | wbraid |
| `text_mm4n9415` | session_id (joins lead to KV attribution dashboard) |

### Booking columns
| Column id | Field |
|-----------|-------|
| `numeric_mm1ge9h4` | Revenue Submitted to Google |
| `numeric_mm34wesr` | Uplift |
| `date9` | Booking close / check-in date (used by weekly summary) |
| `status` | Booking status |
| `mirror21__1` | gclid mirror from linked lead |
| `mirror28__1` | Lead created_at mirror |
| `lookup_mkxtxk48` | Source lookup (PPC / SEO / Socials / etc) from linked lead |
| `link_to_leads26` | Relation to Leads board |
| `people98` | Salesperson |

---

## Lead flow (`/api/submit-enquiry`)

In order, never skip a step:

1. **IP blocklist** — reject spammer IPs silently (returns fake 200)
2. **Attribution capture** — `buildTouch(req, p)` pulls gclid/gbraid/wbraid/utm/device/browser/geo from cookies + headers + body. Loads existing KV session by `sl_session_id` cookie.
3. **Duplicate detection** — `findDuplicateLead` scores 4 signals (email, phone, IP, name). 2+ matches flags the Monday row.
4. **Monday Leads board write** — full column map; flags + assignee fallback if duplicate
5. **Lead source classification** — `computeLeadSource(p)` resolves source/channel. Priority: msclkid (Bing Ads) > Bing organic > gclid/utm_campaign (Google Ads) > fbclid (Socials, default Instagram since we don't run Meta ads) > utm social > direct > Google organic > visited
6. **Resend confirmation + team email** — fired in parallel via `Promise.allSettled`
7. **Google Ads upload (Data Manager API events:ingest)** — non-fatal, alerts on fail, logs to KV `gads:events`
8. **KV session attach** — links Monday id + email to the session record

`api/submit-stayluxe.js` mirrors steps 1-6 (no Google Ads upload — Stay Luxe doesn't run ads).

---

## Conversion actions + Google Ads counting

| Step | Action env var | Count | Window | Source |
|------|---------------|-------|--------|--------|
| 1 NEW (server-side enquiry) | `GOOGLE_ADS_CONVERSION_ACTION_ID` | Every | 30d | Click-based via Data Manager |
| 2 Moderate Potential | `GOOGLE_ADS_MODERATE_POTENTIAL_ACTION_ID` | Every | 90d | EC for Leads via Data Manager |
| 3 High Potential | `GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID` | Every | 90d | EC for Leads via Data Manager |
| 4 Confirmed Booking (real value) | `GOOGLE_ADS_BOOKING_ACTION_ID` | Every | 90d | EC for Leads via Data Manager |

All 4 are set to **Every** counting (not "One"). gbraid/wbraid only work with Every counting — that's a Google API restriction.

Enhanced Conversions for Leads is enabled account-wide. Step 2/3/4 omit `adIdentifiers` and rely on hashed email + phone to match. This lets bookings attribute beyond the 90-day click window — exactly the case where the booking confirms months after the click.

Click-through window on Step 4 raised to 90 days (Google max). Cannot be extended further.

---

## Google Data Manager API migration (2026-06)

Old uploads via `googleads.googleapis.com/v21/customers/{cid}:uploadClickConversions` are being blocked in 2026. All conversion + EC-for-Leads uploads moved to:

- **Endpoint**: `https://datamanager.googleapis.com/v1/events:ingest`
- **Scope**: `https://www.googleapis.com/auth/datamanager`
- **Helper**: `api/_dataManager.js` (ingestEvents, conversionDestination, buildUserIdentifiers, consent, hashing)

Key field renames vs old API:
- `conversionDateTime` -> `eventTimestamp` (RFC3339, not the old `yyyy-MM-dd HH:mm:ss+zz:zz`)
- `currencyCode` -> `currency`
- `conversion_action` (resource name) -> `destinations[].productDestinationId` (bare integer)
- `userIdentifiers` moves into `events[].userData.userIdentifiers`
- `hashedEmail` / `hashedPhoneNumber` -> oneof union `emailAddress` / `phoneNumber` / `address`

Headers changed:
- DROP `developer-token`
- DROP `login-customer-id` (now in body as `destinations[].loginAccount.accountId`)
- ADD `x-goog-user-project: <GCP_PROJECT_ID>` (REQUIRED, or 403 with no clue)

Address gotcha:
- Sending an `address` identifier requires ALL of `givenName + familyName + regionCode + postalCode` together. Partial address = 400 INVALID_ARGUMENT. We don't collect postcode on the form, so `buildUserIdentifiers` skips the address block entirely and relies on email + phone only.

Customer Match (audienceMembers:ingest) deferred to a separate project. The helper exposes `ingestAudienceMembers` ready to wire.

---

## Squarespace integration

### Reservations page

Form repo: [AlexO-Luxe/luxe-enquiry-form](https://github.com/AlexO-Luxe/luxe-enquiry-form). The production form lives in a single Squarespace Code Block on `/reservations`. Code is split into sections + scripts; redeploy any section by pasting the matching file's content into the Code Block.

The form's `slGetTrackingData()` + URL-capture IIFE + the form-mirror in the footer snippet collect: `gclid, gbraid, wbraid, fbclid, utm_*, session_id`, plus first-touch twins of all of those + first_referrer + first_landing_page + first_seen. All 90d cookies.

### Site-wide footer snippet

`public/squarespace-tracking-snippet.html` is the canonical footer code injection. Drop into Squarespace -> Settings -> Advanced -> Code Injection -> Footer. Responsibilities:

1. Mint and persist `sl_session_id` (UUID, 90d cookie)
2. Capture URL params -> `sl_*` cookies + `sl_first_*` first-touch twins (90d)
3. Capture `document.referrer` once -> `sl_first_referrer`
4. POST to `/api/track` on every page (fire-and-forget, `credentials: 'omit'` to avoid wildcard-CORS preflight rejection)
5. Mirror cookies into hidden inputs on every form submit

---

## Monitoring

### Failure alerts
Every catch block in submit-enquiry / submit-booking / submit-high-potential calls `sendGadsAlert` -> Resend email to alex@studentluxe.co.uk with subject `Google Ads upload failed — <source>`. Red header card with payload + raw error.

Helper: `api/_alert.js`. Test endpoint: `/api/test-alert?secret=<CRON_SECRET>`.

### Daily digest
Every upload attempt also goes to `logGadsEvent` -> Redis sorted set `gads:events` (35d retention). The endpoint `/api/gads-daily-summary?secret=<CRON_SECRET>&hours=24` aggregates the last N hours and emails alex@ a navy/gold card with per-action OK/fail/value/click-ID coverage + last 5 failures.

Triggered by a Claude routine (`gads-daily-summary-email`) at 09:30 London daily. The routine only fires when the Claude Code app is open — if you need bulletproof firing, mirror it as a Vercel cron in `vercel.json`.

Helper: `api/_log.js` (logGadsEvent, readGadsEvents).

### Weekly PPC summary
`api/weekly-summary.js`, Vercel cron Friday 09:00 UTC (10:00 BST). Reads PPC bookings from Monday Bookings board filtered by `date9` (close date), groups by campaign, emails alex@ with a navy header card. Manual trigger: `?secret=<CRON_SECRET>&days=N&dryRun=1`.

---

## Attribution dashboard

- API: `GET /api/dashboard-attribution?days=7` — joins recent Monday leads with their KV session records, returns first/last touch + multi-touch path per lead.
- UI: `/dashboard-attribution.html` (standalone) and also iframed/embedded inside the PPC dashboard in [luxe-organic-content](https://github.com/AlexO-Luxe/luxe-organic-content) via the `AttributionView` React component in `components/PpcPage.js`.

KV data shape:
```
session:<uuid>          90d   { first, last, touches[], submission }
lookup:monday:<id>      90d   sessionId
lookup:email:<email>    90d   sessionId
```

---

## Setup from scratch

If standing this up on a fresh Vercel project:

1. Clone repo, `npm install`
2. `vercel link` to attach to project
3. Vercel Marketplace -> install **Upstash Redis** integration (free tier is fine)
4. Set all env vars from the table above
5. Generate Data Manager OAuth refresh token (see `OAUTH_REFRESH.md` history or run a fresh OAuth consent flow with scope `https://www.googleapis.com/auth/datamanager + https://www.googleapis.com/auth/adwords`)
6. In Google Cloud Console: enable Data Manager API on `student-luxe-ads` project, add `http://localhost:8080` to OAuth client authorized redirect URIs
7. In Google Ads UI: set all 4 conversion actions to Count = Every, Step 4 click-through window = 90d, Enhanced Conversions for Leads ON (account-wide)
8. Push -> Vercel auto-deploy
9. Paste `public/squarespace-tracking-snippet.html` into Squarespace footer, edit TRACK_URL to your Vercel domain

## Setup Claude routine for daily digest

In Claude Code:
```
/schedule create a routine that fires daily at 09:30 Europe/London. Runs:
  curl -fsS "https://luxe-lead-capture.vercel.app/api/gads-daily-summary?secret=<CRON_SECRET>&hours=24"
```

The routine only fires when the Claude app is open. For bulletproof firing, add a Vercel cron entry instead.

---

## Verify after any change

1. `node --check api/<file>.js` syntax-check before push
2. `curl https://luxe-lead-capture.vercel.app/api/test-alert?secret=<CRON_SECRET>` -> sample failure email arrives
3. Submit a test enquiry on `/reservations?gbraid=TEST_xyz` -> Vercel logs show `Data Manager events:ingest OK` -> Monday row appears with all attribution columns populated -> dashboard `/dashboard-attribution.html` shows the lead within seconds
4. `curl ".../api/weekly-summary?secret=<CRON_SECRET>&days=7&dryRun=1"` -> JSON preview of last week's bookings + month total

Check Vercel logs:
```
vercel logs https://luxe-lead-capture.vercel.app --follow
```

---

## Migration history

| Date | Change |
|------|--------|
| 2026-06-30 | Migrated all offline conversion uploads from Google Ads API v21 `uploadClickConversions` to Google Data Manager API `events:ingest`. Reason: Google deprecated the old path starting 15 Jun 2026. |
| 2026-06-30 | Removed `sync-customer-match.js` and its cron. Customer Match flow moves to a separate project. |
| 2026-06-30 | Flipped all conversion actions to Count = Every (gbraid/wbraid require it). EC for Leads enabled account-wide. Step 4 click window = 90d max. |
| 2026-06-30 | `submit-booking.js` + `submit-high-potential.js` now pull linked lead's first name + last name (text37 + text60) so name hashes contribute to EC for Leads matching. |
| 2026-06-26 | Weekly PPC summary fixed: was always £0 because the Monday query missed `display_value` on the mirror column. Now uses `date9` close date for accounting, with campaign name per booking. |
| 2026-06-26 | fbclid default channel changed from "Meta Advert" to "Instagram" — we don't run Meta ads, fbclid is auto-injected on any IG outbound link. |
| 2026-06-25 | Added 7 attribution columns to Monday Leads board (device, country, first_channel, first_campaign, gbraid, wbraid, session_id). |
| 2026-06-25 | Built attribution dashboard endpoint + iframe-replaced native React `AttributionView` in `luxe-organic-content/components/PpcPage.js`. |
| 2026-06-25 | Built `/api/track` + Upstash Redis KV session journal. |
| 2026-06-25 | Daily Google Ads upload digest + per-failure email alerts wired across all 3 conversion handlers. |
| 2026-06-25 | Squarespace footer snippet swapped `credentials: 'include'` -> `'omit'` to dodge wildcard-CORS preflight rejection. |

---

## Conventions (must follow)

- **Complete files always** — no snippets in chat, no partial edits referenced separately. Edit in place.
- **No em dashes anywhere** in code, comments, UI strings, docs. Use commas, colons, or restructure.
- **Stay Luxe handler parity** — `submit-stayluxe.js` mirrors `submit-enquiry.js` for everything except the Google Ads upload (Stay Luxe doesn't run ads).
- **Duplicate detection is not optional** — runs before every Monday write.
- **Retry on Monday API errors** — every Monday call needs retry logic.
- **Never commit secrets** — all keys in Vercel env, never in repo.
- **Vercel auto-deploys main** — pushing to GitHub deploys. No staging branch.

---

## Known issues / future work

- Customer Match upload (`sync-customer-match.js`) deferred to a separate project. The Data Manager helper exposes `ingestAudienceMembers` ready to wire.
- Reservations form does not collect postcode. Once it does, the `address` identifier path in `buildUserIdentifiers` will start contributing to EC for Leads matching automatically.
- Daily Claude routine only fires when the laptop is awake. For bulletproof firing, add to `vercel.json` crons (timezone is UTC).
- `utmSourceToChannel` still emits "Meta Advert" if `utm_source=facebook/fb/meta` arrives explicitly. Rare but worth flipping to "Instagram" or adding a "Facebook" label in Monday if you want to differentiate organic from ads.
- `_lead-qualified-data.js` + `_lead-qualified-email.js` are from a separate webhook PR (Lead Qualified email redesign). Untouched by this attribution work.
