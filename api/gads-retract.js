// ============================================================
//  Student Luxe, Step 1 conversion retraction on junk leads.
//  Deploy to: /api/gads-retract.js
//
//  Monday webhook: fires when "Reason not Qualified" (status_11) changes
//  on the Leads board. If the reason is on the RETRACT_REASONS list, the
//  lead's Step 1 enquiry conversion is retracted in Google Ads via
//  uploadConversionAdjustments, so Smart Bidding stops counting junk
//  enquiries as wins. Step 1 is primary_for_goal, so retractions feed
//  straight into bidding.
//
//  Scope (agreed with Alex, 2026-08-18): Budget too low + Spam enquiry
//  only. Ghost leads (no response, gone quiet) are NOT retracted, they
//  are worked via email remarketing. Lost-good-lead reasons (booked
//  elsewhere etc.) must never be retracted.
//
//  Guards:
//  - PPC leads only (Source column), others never had a Step 1 upload
//  - lead must be under MAX_AGE_DAYS old (Google's adjustment window is
//    55 days from the conversion, leads unqualified later are skipped)
//  - KV set gads:retracted dedupes, one retraction per lead ever
//
//  Order id lookup: Step 1 uploads use transaction id
//  session_id || monday item id (api/submit-enquiry.js). Both candidates
//  are sent as separate adjustment ops with partialFailure, whichever
//  matches wins, the other op failing is expected and ignored.
// ============================================================

const MONDAY_API   = 'https://api.monday.com/v2';
const LEADS_BOARD  = 2171015719;
const MAX_AGE_DAYS = 50;

// Lowercased "Reason not Qualified" labels that mean true junk.
// Extend deliberately: never add reasons that describe a real prospect
// we failed to close (Booked Elsewhere, Don't like our options, ghosts).
const RETRACT_REASONS = [
  'budget too low',
  'spam enquiry'
];

const { logGadsEvent } = require('./_log.js');
const { logError }     = require('./_errlog.js');

let _kv = null;
async function kv () {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}
const RETRACTED_KEY = 'gads:retracted';

async function getAccessToken () {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Token failed: ' + JSON.stringify(d).slice(0, 160));
  return d.access_token;
}

async function mondayQuery (query, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(MONDAY_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
        body: JSON.stringify({ query })
      });
      const d = await r.json();
      if (d.errors) throw new Error('Monday: ' + JSON.stringify(d.errors).slice(0, 200));
      return d.data;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise(s => setTimeout(s, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

// One retraction op per candidate order id. adjustmentDateTime is "now"
// in Google's expected "yyyy-MM-dd HH:mm:ss+00:00" shape.
function buildAdjustments (customerId, orderIds) {
  const dt = new Date().toISOString().slice(0, 19).replace('T', ' ') + '+00:00';
  return orderIds.map(orderId => ({
    conversionAction: `customers/${customerId}/conversionActions/${process.env.GOOGLE_ADS_CONVERSION_ACTION_ID}`,
    adjustmentType: 'RETRACTION',
    orderId: String(orderId),
    adjustmentDateTime: dt
  }));
}

async function uploadRetraction (orderIds) {
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID.replace(/-/g, '');
  const loginId = ((process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '6046238343').replace(/-/g, '')) || '6046238343';
  const token = await getAccessToken();

  const r = await fetch(`https://googleads.googleapis.com/v24/customers/${customerId}:uploadConversionAdjustments`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'login-customer-id': loginId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      conversionAdjustments: buildAdjustments(customerId, orderIds),
      partialFailure: true
    })
  });
  const text = await r.text();
  if (!text.trim().startsWith('{')) throw new Error('GAds non-JSON: ' + text.slice(0, 160));
  const data = JSON.parse(text);
  if (data.error) throw new Error('GAds: ' + JSON.stringify(data.error).slice(0, 300));

  // With partialFailure, per-op failures land in partialFailureError and
  // successful ops appear in results with their orderId echoed back.
  const landed = (data.results || []).filter(x => x && x.orderId).map(x => x.orderId);
  const partialMsg = data.partialFailureError
    ? JSON.stringify(data.partialFailureError).slice(0, 400)
    : '';
  return { landed, partialMsg };
}

module.exports = async function handler (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    if (body.challenge) return res.status(200).json({ challenge: body.challenge });

    const event = body.event;
    if (!event) return res.status(200).json({ skipped: true, reason: 'no event' });

    const reason = (
      event.value?.label?.text ||
      (typeof event.value?.label === 'string' ? event.value.label : '') || ''
    ).toString().toLowerCase().trim();

    if (!RETRACT_REASONS.includes(reason)) {
      return res.status(200).json({ skipped: true, reason: 'reason not on retract list', value: reason });
    }

    const itemId = event.pulseId || event.itemId;
    if (!itemId) return res.status(200).json({ skipped: true, reason: 'no item id' });

    // Dedupe: one retraction per lead, ever. Google keeps the first
    // adjustment anyway, this just keeps the logs and API calls clean.
    const k = await kv();
    if (await k.sismember(RETRACTED_KEY, String(itemId)) === 1) {
      return res.status(200).json({ skipped: true, reason: 'already retracted', itemId });
    }

    const data = await mondayQuery(`
      query {
        items(ids: [${itemId}]) {
          id name created_at
          column_values(ids: ["color_mkxk8y67", "text_mm4n9415"]) { id text }
        }
      }`);
    const item = data.items?.[0];
    if (!item) return res.status(200).json({ skipped: true, reason: 'item not found', itemId });

    const cols = {};
    (item.column_values || []).forEach(c => { cols[c.id] = (c.text || '').trim(); });
    const source    = cols.color_mkxk8y67;
    const sessionId = cols.text_mm4n9415;

    if (source !== 'PPC') {
      return res.status(200).json({ skipped: true, reason: 'not a PPC lead', source, itemId });
    }

    const ageDays = (Date.now() - new Date(item.created_at).getTime()) / 86400000;
    if (ageDays > MAX_AGE_DAYS) {
      await logGadsEvent({
        source: 'gads-retract', action: 'Step 1 retraction', name: item.name,
        ok: false, reason: `lead ${Math.round(ageDays)}d old, outside adjustment window`
      });
      return res.status(200).json({ skipped: true, reason: 'outside 55-day adjustment window', ageDays: Math.round(ageDays) });
    }

    // Candidate order ids matching submit-enquiry's transaction id rule.
    const orderIds = [...new Set([sessionId, String(itemId)].filter(Boolean))];
    const { landed, partialMsg } = await uploadRetraction(orderIds);

    if (landed.length > 0) {
      await k.sadd(RETRACTED_KEY, String(itemId));
      await logGadsEvent({
        source: 'gads-retract', action: 'Step 1 retraction', name: item.name,
        ok: true, reason: `retracted (${reason}), order_id ${landed[0]}`
      });
      return res.status(200).json({ retracted: true, itemId, orderId: landed[0] });
    }

    // No candidate matched: lead most likely never had a successful Step 1
    // upload (pre-fix transaction id, or the upload failed). Expected for
    // some leads, logged but not alerted.
    await logGadsEvent({
      source: 'gads-retract', action: 'Step 1 retraction', name: item.name,
      ok: false, reason: 'no matching conversion for ' + orderIds.join(' / ')
    });
    return res.status(200).json({ retracted: false, itemId, tried: orderIds, detail: partialMsg });

  } catch (err) {
    console.error('gads-retract error:', err.message);
    await logError('gads-retract', err);
    return res.status(200).json({ error: err.message });
  }
};
