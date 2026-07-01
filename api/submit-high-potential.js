// ============================================================
//  Student Luxe — Lead Potential Conversion Upload
//  Deploy to: /api/submit-high-potential.js
// ============================================================

const MONDAY_API = 'https://api.monday.com/v2';
const { sendGadsAlert, sendGadsSuccess } = require('./_alert.js');
const { logGadsEvent }  = require('./_log.js');

const POTENTIAL_CONFIG = {
  'high potential': {
    value:    300.0,
    actionId: () => process.env.GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID,
    label:    'High Potential'
  },
  'moderate potential': {
    value:    150.0,
    actionId: () => process.env.GOOGLE_ADS_MODERATE_POTENTIAL_ACTION_ID,
    label:    'Moderate Potential'
  }
};

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    console.log('Potential webhook received:', JSON.stringify(body));

    if (body.challenge) return res.status(200).json({ challenge: body.challenge });

    const event = body.event;
    if (!event) return res.status(200).json({ skipped: true, reason: 'no event' });

    const newValue = (
      event.value?.label?.text ||
      (typeof event.value?.label === 'string' ? event.value.label : '') || ''
    ).toString().toLowerCase().trim();

    const config = POTENTIAL_CONFIG[newValue];
    if (!config) {
      return res.status(200).json({ skipped: true, reason: 'not a tracked potential status', value: newValue });
    }

    const itemId = event.pulseId || event.itemId;
    if (!itemId) return res.status(200).json({ skipped: true, reason: 'no item id' });

    // ── FETCH LEAD DATA FROM MONDAY ───────────────────────────
    // Fetch gclid, source, timestamp, email and phone directly from leads board
    const query = `
      query {
        items(ids: [${itemId}]) {
          id name created_at
          column_values(ids: ["text4__1", "color_mkxk8y67", "mirror28__1", "email", "phone_1", "text_mm4ncd41", "text_mm4n9t2x", "text37", "text60"]) {
            id text value
          }
        }
      }
    `;

    const mondayRes  = await fetch(MONDAY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
      body: JSON.stringify({ query })
    });

    const mondayData = await mondayRes.json();
    const item       = mondayData?.data?.items?.[0];
    if (!item) return res.status(200).json({ skipped: true, reason: 'item not found' });

    const cols = {};
    item.column_values.forEach(c => { cols[c.id] = c.text || ''; });

    const gclid      = cols['text4__1'];
    const leadSource = cols['color_mkxk8y67'];
    const timestamp  = cols['mirror28__1'] || item.created_at;
    const email      = cols['email'];
    const phone      = cols['phone_1'];
    const gbraid     = cols['text_mm4ncd41'];
    const wbraid     = cols['text_mm4n9t2x'];
    const leadFirst  = cols['text37'] || '';
    const leadLast   = cols['text60'] || '';
    const name       = [leadFirst, leadLast].filter(Boolean).join(' ').trim();

    console.log('Item data:', { itemId, gclid, gbraid, wbraid, leadSource, timestamp, hasEmail: !!email, hasPhone: !!phone });

    // ── GUARD: Only fire for PPC leads ────────────────────────
    if (!leadSource.toLowerCase().includes('ppc')) {
      console.log('Not PPC, skipping. Source:', leadSource);
      return res.status(200).json({ skipped: true, reason: 'not ppc' });
    }

    // Upload via Data Manager API — Enhanced Conversions for Leads.
    // Email + phone + hashed name match the lead back to the original click
    // without needing the click ID (which usually expires 90+ days later).
    const result = await uploadConversion({
      gclid,
      gbraid,
      wbraid,
      email,
      phone,
      name,
      timestamp,
      value:    config.value,
      currency: 'GBP',
      actionId: config.actionId()
    });

    logGadsEvent({
      source:    'Student Luxe lead-potential',
      action:    config.label,
      ok:        !result?.skipped,
      reason:    result?.reason || 'uploaded',
      email,
      value:     config.value,
      hasGclid:  !!gclid,
      hasGbraid: !!gbraid,
      hasWbraid: !!wbraid,
      mondayId:  itemId
    });
    if (!result?.skipped) {
      sendGadsSuccess({
        source:  'Student Luxe lead-potential',
        action:  config.label,
        payload: { email, mondayId: itemId, value: config.value, hasGclid: !!gclid, hasGbraid: !!gbraid, requestId: result?.requestId }
      });
    }
    console.log(`${config.label} conversion uploaded for item:`, itemId);
    return res.status(200).json({ success: true, itemId, gclid, potential: config.label, value: config.value });

  } catch (err) {
    console.error('submit-high-potential error:', err.message);
    const mid = req.body?.event?.pulseId || req.body?.event?.itemId;
    logGadsEvent({ source: 'Student Luxe lead-potential', action: 'High / Moderate Potential', ok: false, reason: 'exception', error: err.message, mondayId: mid });
    sendGadsAlert({
      source:  'Student Luxe lead-potential',
      action:  'High / Moderate Potential',
      payload: { mondayId: mid },
      error:   err.message
    });
    return res.status(200).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────────────────────
//  GOOGLE ADS CONVERSION UPLOAD
// ──────────────────────────────────────────────────────────────
const {
  conversionDestination,
  buildUserIdentifiers,
  ingestEvents,
  CONSENT_GRANTED
} = require('./_dataManager.js');

async function uploadConversion ({ gclid, gbraid, wbraid, email, phone, name, timestamp, value, currency, actionId }) {
  const nameParts = (name || '').trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ');

  const eventTimestamp = (timestamp ? new Date(timestamp) : new Date()).toISOString();

  const adIdentifiers = {};
  if      (gclid)  adIdentifiers.gclid  = gclid;
  else if (gbraid) adIdentifiers.gbraid = gbraid;
  else if (wbraid) adIdentifiers.wbraid = wbraid;

  const userIdentifiers = buildUserIdentifiers({ email, phone, firstName, lastName, regionCode: 'GB' });

  // Google rejects an event with neither a click id nor a user identifier —
  // there is nothing to match it to. Skip rather than send a doomed request.
  if (!Object.keys(adIdentifiers).length && !userIdentifiers.length) {
    console.log('Skipping upload — no click id and no email/phone to match on');
    return { skipped: true, reason: 'no_identifiers' };
  }

  const event = {
    destinationReferences: ['sl-lead-potential'],
    transactionId:         String(timestamp || Date.now()) + ':' + (email || ''),
    eventTimestamp,
    eventSource:           'WEB',
    ...(Object.keys(adIdentifiers).length ? { adIdentifiers } : {}),
    userData: { userIdentifiers },
    currency:        currency || 'GBP',
    conversionValue: value
  };

  const body = {
    destinations: [
      conversionDestination({
        conversionActionId: actionId,
        reference:          'sl-lead-potential'
      })
    ],
    events:  [event],
    consent: CONSENT_GRANTED
  };

  console.log('Data Manager lead-potential ingest:', {
    actionId,
    hasGclid:        !!gclid,
    hasGbraid:       !!gbraid,
    hasWbraid:       !!wbraid,
    identifierCount: event.userData.userIdentifiers.length,
    eventTimestamp,
    value
  });

  try {
    const result = await ingestEvents(body);
    console.log('Data Manager lead-potential ingest OK — requestId:', result?.requestId || '(no id)');
    return result;
  } catch (err) {
    const msg = String(err.message || err);
    if (/EXPIRED|TOO_OLD|click.*window/i.test(msg)) {
      console.log('Data Manager lead-potential skipped (click outside window):', msg.slice(0, 200));
      return { skipped: true, reason: 'expired_event' };
    }
    throw err;
  }
}
