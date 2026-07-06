// ============================================================
//  Shared helper for Google Data Manager API v1.
//  Replaces all calls to googleads.googleapis.com:uploadClickConversions
//  (Google Ads API v21) which is being blocked for offline conversion +
//  Customer Match uploads in 2026.
//
//  Used by: submit-enquiry.js, submit-booking.js, submit-high-potential.js,
//           sync-customer-match.js
//
//  Env required:
//    GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN
//      (refresh token must have scope https://www.googleapis.com/auth/datamanager)
//    GOOGLE_ADS_CUSTOMER_ID         — child account, digits only
//    GOOGLE_ADS_LOGIN_CUSTOMER_ID   — MCC, '6046238343'
//    GCP_PROJECT_ID                 — GCP project where Data Manager API is enabled
// ============================================================

const crypto = require('crypto');

const DM_BASE = 'https://datamanager.googleapis.com/v1';

// ──────────────────────────────────────────────────────────────
//  OAuth — refresh → access token, cached per cold start
// ──────────────────────────────────────────────────────────────
let _tokenCache = { value: null, expiresAt: 0 };

async function getAccessToken () {
  if (_tokenCache.value && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.value;
  }
  const body = new URLSearchParams({
    client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    grant_type:    'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error('OAuth refresh failed: ' + r.status + ' ' + await r.text());
  const j = await r.json();
  if (!j.access_token) throw new Error('OAuth refresh: no access_token in response');
  _tokenCache = {
    value:     j.access_token,
    expiresAt: Date.now() + (j.expires_in * 1000)
  };
  return _tokenCache.value;
}

// ──────────────────────────────────────────────────────────────
//  Headers
//  No developer-token, no login-customer-id (Google Ads API concepts).
//  x-goog-user-project is REQUIRED — without it 403 PERMISSION_DENIED.
// ──────────────────────────────────────────────────────────────
async function dmHeaders () {
  return {
    'Authorization':       'Bearer ' + await getAccessToken(),
    'x-goog-user-project': process.env.GCP_PROJECT_ID,
    'Content-Type':        'application/json'
  };
}

// ──────────────────────────────────────────────────────────────
//  Hashing — SHA-256, hex, lowercased + trimmed
// ──────────────────────────────────────────────────────────────
function sha256Hex (s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}
function normEmail (e) {
  if (!e) return null;
  return String(e).trim().toLowerCase();
}
function normPhoneE164 (p) {
  if (!p) return null;
  const raw = String(p).replace(/[^\d+]/g, '');
  if (!raw) return null;
  if (raw.startsWith('+')) return raw;
  if (raw.startsWith('00')) return '+' + raw.slice(2);
  if (raw.startsWith('0'))  return '+44' + raw.slice(1);  // UK fallback
  return '+' + raw;
}
function normName (n) {
  if (!n) return null;
  return String(n).trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
function hashedEmail (e) { const v = normEmail(e);     return v ? sha256Hex(v) : null; }
function hashedPhone (p) { const v = normPhoneE164(p); return v ? sha256Hex(v) : null; }
function hashedName  (n) { const v = normName(n);      return v ? sha256Hex(v) : null; }

// Build userIdentifiers[] for either an event or an audience member.
// Each entry is a oneof of { emailAddress | phoneNumber | address }.
// Address requires firstName + lastName + regionCode + postalCode ALL present —
// Data Manager API rejects partial address with INVALID_ARGUMENT
// "address.postal_code required field is missing". Skip address entirely
// until the form collects postcode; email + phone are strong matchers alone.
function buildUserIdentifiers ({ email, phone, firstName, lastName, regionCode, postalCode } = {}) {
  const out = [];
  const he = hashedEmail(email);
  if (he) out.push({ emailAddress: he });
  const hp = hashedPhone(phone);
  if (hp) out.push({ phoneNumber: hp });
  const hf = hashedName(firstName);
  const hl = hashedName(lastName);
  if (hf && hl && regionCode && postalCode) {
    out.push({
      address: {
        givenName:  hf,
        familyName: hl,
        regionCode,
        postalCode: String(postalCode).toUpperCase().replace(/\s+/g, '')
      }
    });
  }
  return out.slice(0, 10);   // API max 10 identifiers per member/event
}

// ──────────────────────────────────────────────────────────────
//  Destination builders
//  MCC → child via destinations[].loginAccount / operatingAccount.
// ──────────────────────────────────────────────────────────────
function conversionDestination ({ conversionActionId, reference = 'sl-conv' }) {
  return {
    reference,
    loginAccount: {
      accountType: 'GOOGLE_ADS',
      accountId:   process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
    },
    operatingAccount: {
      accountType: 'GOOGLE_ADS',
      accountId:   (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '')
    },
    productDestinationId: String(conversionActionId)
  };
}

function userListDestination ({ userListId, reference = 'sl-cm' }) {
  return {
    reference,
    loginAccount: {
      accountType: 'GOOGLE_ADS',
      accountId:   process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
    },
    operatingAccount: {
      accountType: 'GOOGLE_ADS',
      accountId:   (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '')
    },
    productDestinationId: String(userListId)
  };
}

// ──────────────────────────────────────────────────────────────
//  Consent
//  Schema-optional, policy-required for EEA/UK. Anything other than
//  CONSENT_GRANTED on adUserData silently drops the row from matching.
// ──────────────────────────────────────────────────────────────
const CONSENT_GRANTED = Object.freeze({
  adUserData:        'CONSENT_GRANTED',
  adPersonalization: 'CONSENT_GRANTED'
});
const CONSENT_DENIED = Object.freeze({
  adUserData:        'CONSENT_DENIED',
  adPersonalization: 'CONSENT_DENIED'
});

// Map the form's marketingOptIn flag to a Data Manager consent block.
// marketingOptIn = false → user has opted OUT → CONSENT_DENIED.
function consentForLead (marketingOptIn) {
  return marketingOptIn === false ? CONSENT_DENIED : CONSENT_GRANTED;
}

// ──────────────────────────────────────────────────────────────
//  POST + retry on 5xx / 429
// ──────────────────────────────────────────────────────────────
// The Data Manager API intermittently returns a GENERIC 400 —
// fieldViolations[].field == "events.events[N]" with description
// "There was a problem with the request." and no named sub-field —
// on structurally valid requests. The identical payload succeeds on
// retry. Treat that specific signature as transient and retry it.
// A 400 that names a real sub-field (e.g. "...user_data.user_identifiers[2].address.postal_code")
// is deterministic and must NOT be retried.
function isTransient400 (text) {
  let j;
  try { j = JSON.parse(text); } catch { return false; }
  const viols = (j.error?.details || []).flatMap(d => d.fieldViolations || []);
  if (viols.length === 0) return false;
  // Transient only if EVERY violation is the bare top-level event field.
  return viols.every(v => /^events\.events\[\d+\]$/.test(v.field || ''));
}

async function dmPost (path, body, { retries = 4 } = {}) {
  const url = DM_BASE + '/' + path;
  const headers = await dmHeaders();
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const r = await fetch(url, {
      method:  'POST',
      headers,
      body:    JSON.stringify(body)
    });
    const text = await r.text();
    if (r.ok) {
      try { return JSON.parse(text); } catch { return { raw: text }; }
    }

    const retryable = r.status >= 500 || r.status === 429 || (r.status === 400 && isTransient400(text));
    if (retryable && i < retries - 1) {
      lastErr = new Error('DM ' + path + ' ' + r.status + ' (retryable): ' + text.slice(0, 400));
      // exponential backoff with jitter
      await new Promise(res => setTimeout(res, 400 * (2 ** i) + Math.floor(Math.random() * 250)));
      continue;
    }
    throw new Error('DM ' + path + ' ' + r.status + ': ' + text.slice(0, 2000));
  }
  throw lastErr;
}

// ──────────────────────────────────────────────────────────────
//  Events ingest (offline conversions + Enhanced Conversions for Leads)
// ──────────────────────────────────────────────────────────────
async function ingestEvents ({ destinations, events, consent = CONSENT_GRANTED, validateOnly = false }) {
  return dmPost('events:ingest', {
    destinations,
    encoding: 'HEX',
    consent,
    validateOnly,
    events
  });
}

// ──────────────────────────────────────────────────────────────
//  Audience members ingest (Customer Match)
// ──────────────────────────────────────────────────────────────
async function ingestAudienceMembers ({ destinations, audienceMembers, consent = CONSENT_GRANTED, validateOnly = false }) {
  return dmPost('audienceMembers:ingest', {
    destinations,
    encoding: 'HEX',
    termsOfService: { customerMatchTermsOfServiceStatus: 'ACCEPTED' },
    consent,
    validateOnly,
    audienceMembers
  });
}

module.exports = {
  getAccessToken,
  dmHeaders,
  dmPost,
  sha256Hex,
  hashedEmail,
  hashedPhone,
  hashedName,
  buildUserIdentifiers,
  conversionDestination,
  userListDestination,
  consentForLead,
  ingestEvents,
  ingestAudienceMembers,
  CONSENT_GRANTED,
  CONSENT_DENIED
};
