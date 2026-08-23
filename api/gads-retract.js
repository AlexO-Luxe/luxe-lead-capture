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
//  Timing: Google can only adjust a conversion it has already PROCESSED,
//  which takes up to 24 hours. The team often marks budget-too-low the same
//  day the enquiry lands, so retracting on the spot fails with "conversion
//  not found". Leads whose Step 1 upload is younger than RIPEN_HOURS are
//  therefore queued in the KV sorted set gads:retract:pending (score = the
//  time they become adjustable) and retracted by the cron pass:
//  GET /api/gads-retract?retryPending=1&secret=<CRON_SECRET>
//
//  Guards:
//  - PPC leads only (Source column), others never had a Step 1 upload
//  - lead must be under MAX_AGE_DAYS old (Google's adjustment window is
//    55 days from the conversion, leads unqualified later are skipped)
//  - KV set gads:retracted dedupes, one retraction per lead ever
//  - the queued reason is re-checked at retraction time, so a lead
//    re-labelled in the meantime is dropped instead of retracted
//
//  Order id lookup: Step 1 uploads use transaction id
//  session_id || monday item id (api/submit-enquiry.js). Both candidates
//  are sent as separate adjustment ops with partialFailure, whichever
//  matches wins, the other op failing is expected and ignored.
// ============================================================

const MONDAY_API   = 'https://api.monday.com/v2';
const LEADS_BOARD  = 2171015719;
const MAX_AGE_DAYS = 50;
// 24h is Google's stated processing ceiling; the extra 2h is margin, a
// retraction one minute too early simply fails and wastes a cron pass.
const RIPEN_HOURS  = 26;

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
const PENDING_KEY   = 'gads:retract:pending';

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

// Reads the lead, applies every guard, and either retracts now or says why
// not. Shared by the webhook and the cron pass so the rules live once.
// Returns { done, queued, skipped, reason, name, readyAt }.
async function retractLead (itemId, k, { expectReason = null } = {}) {
  const data = await mondayQuery(`
    query {
      items(ids: [${itemId}]) {
        id name created_at
        column_values(ids: ["color_mkxk8y67", "text_mm4n9415", "status_11"]) { id text }
      }
    }`);
  const item = data.items?.[0];
  // The row can vanish between queueing and retraction: duplicates get
  // merged and the surviving row keeps its own id, so the queued one is gone.
  if (!item) return { skipped: true, notify: true,
                      reason: 'lead row is no longer on the Leads board, merged or deleted' };

  const cols = {};
  (item.column_values || []).forEach(c => { cols[c.id] = (c.text || '').trim(); });
  const source    = cols.color_mkxk8y67;
  const sessionId = cols.text_mm4n9415;
  const reason    = (cols.status_11 || '').toLowerCase();

  // The label is re-read from the board rather than trusted from the queue:
  // a lead re-labelled between queueing and retraction must not be retracted.
  if (!RETRACT_REASONS.includes(reason)) {
    return { skipped: true, name: item.name,
             reason: `not retracted, Reason not Qualified is now "${cols.status_11 || 'blank'}"` };
  }
  if (expectReason && reason !== expectReason) {
    return { skipped: true, name: item.name,
             reason: `not retracted, Reason not Qualified changed to "${cols.status_11}"` };
  }
  if (source !== 'PPC') {
    return { skipped: true, name: item.name,
             reason: `not a PPC lead (source is ${source || 'blank'}), so no Step 1 conversion was ever uploaded` };
  }

  const createdMs = new Date(item.created_at).getTime();
  const ageDays   = (Date.now() - createdMs) / 86400000;
  if (ageDays > MAX_AGE_DAYS) {
    return { skipped: true, name: item.name, expired: true,
             reason: `lead is ${Math.round(ageDays)} days old, past Google's 55 day adjustment window` };
  }

  // Google cannot adjust a conversion it has not finished processing, so a
  // fresh lead waits in the queue until its Step 1 upload has ripened.
  const readyAt = createdMs + RIPEN_HOURS * 3600000;
  if (Date.now() < readyAt) {
    return { queued: true, name: item.name, readyAt,
             reason: `Step 1 conversion not processed yet, retracting after ${new Date(readyAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` };
  }

  // Candidate order ids matching submit-enquiry's transaction id rule.
  const orderIds = [...new Set([sessionId, String(itemId)].filter(Boolean))];
  const { landed, partialMsg } = await uploadRetraction(orderIds);

  if (landed.length > 0) {
    await k.sadd(RETRACTED_KEY, String(itemId));
    await k.zrem(PENDING_KEY, String(itemId));
    return { done: true, name: item.name, orderId: landed[0],
             reason: `retracted (${reason}), order_id ${landed[0]}` };
  }

  // Google accepted the original Step 1 ingest but never recorded a
  // conversion for it, so neither the order id nor a gclid lookup can find
  // one (verified against both on 2026-08-22). Retrying can only fail, so
  // the lead is marked done and reported once rather than every day.
  const notFound = /can't be found|CONVERSION_NOT_FOUND/i.test(partialMsg);
  if (notFound) await k.sadd(RETRACTED_KEY, String(itemId));
  return { failed: true, name: item.name, tried: orderIds, terminal: notFound,
           reason: notFound
             ? 'Google never recorded a Step 1 conversion for this lead, nothing to retract'
             : `no matching conversion for ${orderIds.join(' / ')}`,
           detail: partialMsg };
}

// Cron pass: retract everything whose conversion has now ripened. Anything
// still too fresh keeps its slot; anything past the adjustment window is
// dropped with one loud log so it shows in the daily digest.
async function runPending (k) {
  const due = await k.zrange(PENDING_KEY, 0, Date.now(), { byScore: true });
  const out = { due: due.length, retracted: 0, failed: 0, dropped: 0 };

  for (const member of due) {
    const itemId = String(member);
    if (await k.sismember(RETRACTED_KEY, itemId) === 1) { await k.zrem(PENDING_KEY, itemId); continue; }

    let r;
    try { r = await retractLead(itemId, k); }
    catch (err) { await logError('gads-retract', err); continue; }

    if (r.done) {
      out.retracted++;
      await logGadsEvent({ source: 'gads-retract', action: 'Step 1 retraction', name: r.name, ok: true, reason: r.reason });
    } else if (r.queued) {
      // Still green. Re-score to the real ready time instead of retrying blind.
      await k.zadd(PENDING_KEY, { score: r.readyAt, member: itemId });
    } else if (r.skipped) {
      out.dropped++;
      await k.zrem(PENDING_KEY, itemId);
      // A relabelled or non-PPC lead is a normal skip and stays quiet. An
      // expired lead or a vanished row is worth seeing in the digest.
      if (r.expired || r.notify) {
        await logGadsEvent({ source: 'gads-retract', action: 'Step 1 retraction', name: r.name || itemId, ok: false, reason: r.reason });
      }
    } else {
      out.failed++;
      await k.zrem(PENDING_KEY, itemId);
      await logGadsEvent({
        source: 'gads-retract', action: 'Step 1 retraction', name: r.name, ok: false,
        reason: r.reason + (r.detail ? ' | ' + r.detail.slice(0, 200) : '')
      });
    }
  }
  return out;
}

module.exports = async function handler (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── Cron pass ─────────────────────────────────────────────
    if (req.query?.retryPending === '1') {
      const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      if (req.query?.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      return res.status(200).json(await runPending(await kv()));
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ── Monday webhook ────────────────────────────────────────
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

    const r = await retractLead(itemId, k, { expectReason: reason });

    if (r.queued) {
      await k.zadd(PENDING_KEY, { score: r.readyAt, member: String(itemId) });
      return res.status(200).json({ queued: true, itemId, retractAfter: new Date(r.readyAt).toISOString(), reason: r.reason });
    }
    if (r.done) {
      await logGadsEvent({ source: 'gads-retract', action: 'Step 1 retraction', name: r.name, ok: true, reason: r.reason });
      return res.status(200).json({ retracted: true, itemId, orderId: r.orderId });
    }
    if (r.skipped) {
      if (r.expired) {
        await logGadsEvent({ source: 'gads-retract', action: 'Step 1 retraction', name: r.name, ok: false, reason: r.reason });
      }
      return res.status(200).json({ skipped: true, itemId, reason: r.reason });
    }

    // Ripe but unmatched: the lead most likely never had a successful Step 1
    // upload (pre-fix transaction id, or the upload itself failed).
    await logGadsEvent({
      source: 'gads-retract', action: 'Step 1 retraction', name: r.name, ok: false,
      reason: r.reason + (r.detail ? ' | ' + r.detail.slice(0, 200) : '')
    });
    return res.status(200).json({ retracted: false, itemId, tried: r.tried, detail: r.detail });

  } catch (err) {
    console.error('gads-retract error:', err.message);
    await logError('gads-retract', err);
    return res.status(200).json({ error: err.message });
  }
};
