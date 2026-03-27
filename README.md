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
