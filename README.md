# luxe-lead-capture

Vercel serverless function that receives hero form submissions and creates items on the Student Luxe Monday.com leads board.

## Endpoint

`POST https://your-vercel-url.vercel.app/api/submit-lead`

### Request body (JSON)

```json
{
  "firstname":      "James",
  "lastname":       "Smith",
  "movein":         "2025-09-01",
  "checkout":       "2025-12-01",
  "budget":         "£900/week",
  "contact_phone":  "+44 7700 000000",
  "contact_email":  "",
  "utm_source":     "google-ads",
  "utm_medium":     "cpc",
  "utm_campaign":   "london-sept-2025",
  "utm_content":    "rentals-os",
  "utm_term":       "luxury student apartments london",
  "gclid":          "abc123",
  "user_journey":   "/luxury-student-apartments-london → /marylebone-apartments → hero form"
}
```

### Response

```json
{ "success": true, "id": "12345678" }
```

## Setup

### 1. Vercel environment variable
In Vercel project settings → Environment Variables, add:
```
MONDAY_API_KEY = your_api_key_here
```

### 2. Monday board
Board ID: `2171015719`
Column mapping is defined in `api/submit-lead.js`.

### 3. Deploy
Push to GitHub, connect to Vercel. Deploys automatically on every commit.

---

## Attribution stack (added 2026-06)

Adds first-touch + last-touch attribution, multi-touch path, gbraid/wbraid
capture for iOS, and a stand-alone attribution dashboard.

### Files

- `api/_attribution.js` — shared helpers (cookie parse, touch builder, KV upsert, lookup index)
- `api/track.js` — `POST /api/track`, called from Squarespace on every page view, writes to KV
- `api/dashboard-attribution.js` — `GET /api/dashboard-attribution?days=7` joins Monday leads with KV sessions
- `public/dashboard-attribution.html` — UI rendered at `/dashboard-attribution.html`
- `public/squarespace-tracking-snippet.html` — paste-into-Squarespace footer injection

### Vercel KV setup

Install Marketplace integration (Upstash KV) and set env vars:

```
KV_REST_API_URL
KV_REST_API_TOKEN
```

The `@vercel/kv` SDK reads these automatically.

### Data shape (KV)

```
session:<uuid>          90d   { first, last, touches, submission }
lookup:monday:<id>      90d   sessionId
lookup:email:<email>    90d   sessionId
```

### Squarespace setup

Paste the contents of `public/squarespace-tracking-snippet.html` into
Squarespace → Settings → Advanced → Code Injection → Footer. Edit the
`TRACK_URL` constant to your Vercel domain. Site-wide, runs on every page.

### Google Ads upload — what changed

`api/submit-enquiry.js` `uploadGoogleAdsConversion` now sends:

- `conversionEnvironment: 'WEB'`
- `userAgent` (raw)
- `gbraid` / `wbraid` (when no `gclid`) — recovers iOS/Safari clicks Apple ITP strips
- `gclid` / `gbraid` / `wbraid` are mutually exclusive — priority order in code

To extend the same upgrade to `submit-booking.js` and `submit-high-potential.js`
(both fire from Monday webhooks, not the user form): add Monday columns for
`gbraid` / `wbraid` / `user_agent`, write them at enquiry time, then pull them
in those handlers' GraphQL queries and forward to `uploadConversion`.

### What it costs

KV: ~50 writes per visitor per session. At 5k pageviews/day = 5k KV writes,
well inside the Upstash free tier.
