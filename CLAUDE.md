# luxe-lead-capture — Enquiry Capture and Lead Routing

## Purpose
Serverless enquiry handlers for both Student Luxe and Stay Luxe brands. Captures leads from Squarespace, writes to Monday, sends Resend emails, and uploads conversions to Google Ads.

## Key files
- submit-stayluxe.js — Stay Luxe enquiry handler
- submit-studentluxe.js — Student Luxe enquiry handler

The Stay Luxe handler must always remain in parity with the Student Luxe handler.

## Lead flow (in order)
1. Squarespace form submission triggers serverless function
2. Duplicate detection runs first — always, before any Monday write
3. If duplicate: return early, do not write to Monday, do not send email
4. If new lead: write to Monday Leads board (2171015719)
5. Send Resend confirmation email
6. Upload conversion to Google Ads (v21 API)

## UTM capture
- Cookies prefixed sl_: sl_campaign, sl_adgroup, sl_term, sl_matchtype, sl_gclid
- Always read from cookies on submission — do not rely on URL params alone

## Stack
- Vercel serverless functions (Node.js)
- Monday.com GraphQL API
- Resend (transactional email)
- Google Ads conversion upload (v21)

## Monday.com
- Leads board: 2171015719
- GraphQL only (never REST)
- Retry logic required on all Monday API calls
- Never skip duplicate detection before a Monday write

## Google Ads
- v21 API
- Never upload gclid-only events
- Conversion upload happens after successful Monday write

## Deployment
- Vercel auto-deploy on push to main
- Secrets in Vercel dashboard — never commit

## Conventions
- Complete files always
- No em dashes anywhere
- Parity between Student Luxe and Stay Luxe handlers is mandatory
- Duplicate detection is not optional
