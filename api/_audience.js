// _audience.js
//
// Shared Customer Match helper: add a booker to the Google Ads customer list
// via the Data Manager API (audienceMembers:ingest).
//
// The list shell was created by hand in Audience Manager on 11 Aug 2026
// ("All Bookings", membership 540 days). Everything else is automatic:
// api/submit-booking.js adds each booker the moment the booking confirms, and
// api/audience-sync.js re-sweeps the whole Bookings board nightly so any
// webhook miss heals itself. Ingesting the same member twice is harmless,
// Google dedupes on the hashed identifiers.
//
// Consent: guests who toggled marketing off at enquiry time are recorded in
// the KV set cm:optout (hashed email, never the raw address) by
// submit-enquiry, and both ingest paths skip them here.

const {
  hashedEmail,
  buildUserIdentifiers,
  userListDestination,
  ingestAudienceMembers,
  CONSENT_GRANTED
} = require('./_dataManager.js');

// List ids are visible in the Audience Manager URL and are not secrets.
// Env vars win so a list can be swapped without a deploy.
function customerListId () {
  return process.env.GOOGLE_ADS_CUSTOMER_LIST_ID || '9451577693';
}

// "High Value Bookers £5k+ (auto, Data Manager)", created via the API on
// 2026-09-08. Members are bookers whose single booking value (the commission
// figure the whole stack calls booking value) reached HIGH_VALUE_THRESHOLD.
// A sharper seed than All Bookings for wealth-targeted audience signals:
// All Bookings teaches Google "people who book anything", this list teaches
// it "people who spend a lot".
const HIGH_VALUE_THRESHOLD = 5000;
function highValueListId () {
  return process.env.GOOGLE_ADS_HV_LIST_ID || '9467837898';
}

let _kv = null;
async function kv () {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}

const OPTOUT_KEY = 'cm:optout';

async function recordOptOut (email) {
  const he = hashedEmail(email);
  if (!he) return;
  try { const k = await kv(); await k.sadd(OPTOUT_KEY, he); }
  catch (err) { console.warn('cm optout record failed (non-fatal):', err.message); }
}

async function isOptedOut (email) {
  const he = hashedEmail(email);
  if (!he) return false;
  try { const k = await kv(); return (await k.sismember(OPTOUT_KEY, he)) === 1; }
  catch (err) { console.warn('cm optout check failed (non-fatal):', err.message); return false; }
}

// members: [{ email, phone }] — raw values in, hashed on the way out.
// Skips opt-outs and rows with no usable identifier. Returns counts.
// listId defaults to All Bookings; pass highValueListId() for the £5k+ list.
async function ingestBookers (members, { listId } = {}) {
  const audienceMembers = [];
  let skippedOptOut = 0, skippedNoId = 0;

  for (const m of members) {
    if (await isOptedOut(m.email)) { skippedOptOut++; continue; }
    const ids = buildUserIdentifiers({ email: m.email, phone: m.phone });
    if (!ids.length) { skippedNoId++; continue; }
    audienceMembers.push({ userData: { userIdentifiers: ids } });
  }

  let ingested = 0;
  // Data Manager caps audienceMembers at 10,000 per request; batch well under.
  for (let i = 0; i < audienceMembers.length; i += 500) {
    const batch = audienceMembers.slice(i, i + 500);
    await ingestAudienceMembers({
      destinations: [ userListDestination({ userListId: listId || customerListId(), reference: 'sl-cm' }) ],
      audienceMembers: batch.map(b => ({ ...b, destinationReferences: ['sl-cm'] })),
      consent: CONSENT_GRANTED
    });
    ingested += batch.length;
  }

  return { ingested, skippedOptOut, skippedNoId };
}

module.exports = {
  highValueListId,
  HIGH_VALUE_THRESHOLD, customerListId, recordOptOut, isOptedOut, ingestBookers, OPTOUT_KEY };
