// ============================================================
//  Student Luxe — Confirmed Booking Conversion Upload
//  Deploy to: /api/submit-booking.js
// ============================================================

const MONDAY_API = 'https://api.monday.com/v2';
const { sendGadsAlert, sendGadsSuccess } = require('./_alert.js');
const { logGadsEvent }  = require('./_log.js');

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    console.log('Booking webhook received:', JSON.stringify(body));

    if (body.challenge) {
      return res.status(200).json({ challenge: body.challenge });
    }

    const event = body.event;
    if (!event) return res.status(200).json({ skipped: true, reason: 'no event' });

    const itemId   = event.pulseId || event.itemId;
    const columnId = event.columnId;
    if (!itemId) return res.status(200).json({ skipped: true, reason: 'no item id' });

    const isStatusTrigger  = columnId === 'status';
    const isRevenueTrigger = columnId === 'numeric_mm1ge9h4';
    if (!isStatusTrigger && !isRevenueTrigger) {
      return res.status(200).json({ skipped: true, reason: 'unrecognised column' });
    }

    // ── FETCH BOOKING + LINKED LEAD DATA FROM MONDAY ─────────
    const query = `
      query {
        items(ids: [${itemId}]) {
          id name created_at
          column_values(ids: ["status", "mirror21__1", "lookup_mkxtxk48", "numeric_mm1ge9h4"]) {
            id text value
            ... on MirrorValue { display_value }
            ... on BoardRelationValue { display_value }
            ... on StatusValue { label }
          }
          relation: column_values(ids: ["link_to_leads26"]) {
            id
            ... on BoardRelationValue {
              linked_items {
                id
                column_values(ids: ["email", "phone_1", "text_mm4ncd41", "text_mm4n9t2x", "text37", "text60"]) { id text }
              }
            }
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
    item.column_values.forEach(c => { cols[c.id] = c.display_value || c.label || c.text || ''; });

    const bookingName = item.name;
    const status      = cols['status'];
    const gclid       = cols['mirror21__1'];
    const leadSource  = cols['lookup_mkxtxk48'];
    const revenueRaw  = cols['numeric_mm1ge9h4'];
    const timestamp   = item.created_at;
    const isPPC       = (leadSource || '').toLowerCase().includes('ppc');
    const hasGclid    = !!gclid;

    // Extract email + phone + click IDs from linked lead for enhanced matching
    const relationCol  = (item.relation || []).find(c => c.id === 'link_to_leads26');
    const linkedLead   = relationCol?.linked_items?.[0];
    let leadEmail = '', leadPhone = '', leadGbraid = '', leadWbraid = '', leadFirst = '', leadLast = '';
    if (linkedLead) {
      linkedLead.column_values.forEach(c => {
        if (c.id === 'email')          leadEmail  = c.text || '';
        if (c.id === 'phone_1')        leadPhone  = c.text || '';
        if (c.id === 'text_mm4ncd41')  leadGbraid = c.text || '';
        if (c.id === 'text_mm4n9t2x')  leadWbraid = c.text || '';
        if (c.id === 'text37')         leadFirst  = c.text || '';
        if (c.id === 'text60')         leadLast   = c.text || '';
      });
    }
    const leadName = [leadFirst, leadLast].filter(Boolean).join(' ').trim();

    console.log('Item data:', { itemId, bookingName, status, gclid, leadSource, revenueRaw, leadEmail: leadEmail ? '✓' : '✗', leadPhone: leadPhone ? '✓' : '✗', leadGbraid: leadGbraid ? '✓' : '✗', leadWbraid: leadWbraid ? '✓' : '✗' });

    // ── TRIGGER A: Status changed to Confirmed Booking ────────
    if (isStatusTrigger) {
      const newValue = (
        event.value?.label?.text ||
        (typeof event.value?.label === 'string' ? event.value.label : '') || ''
      ).toString();

      if (!newValue.toLowerCase().includes('confirmed booking')) {
        return res.status(200).json({ skipped: true, reason: 'not confirmed booking' });
      }

      const cleanValue = parseFloat((revenueRaw || '').toString().replace(/[£$€,\s]/g, ''));

      if (cleanValue > 0 && isPPC) {
        console.log('Status confirmed + revenue present, uploading. Value: £' + cleanValue);
        // Own try/catch so a failure alert carries full lead context
        // (email, name, click ids) instead of falling through to the
        // outer catch, which only has mondayId in scope.
        try {
          const result = await uploadConversion({ gclid, gbraid: leadGbraid, wbraid: leadWbraid, email: leadEmail, phone: leadPhone, name: leadName, timestamp, value: cleanValue, currency: 'GBP', actionId: process.env.GOOGLE_ADS_BOOKING_ACTION_ID });
          await logGadsEvent({ source: 'Student Luxe booking', action: 'Confirmed Booking', ok: !result?.skipped, reason: result?.reason || 'uploaded', email: leadEmail, value: cleanValue, hasGclid: !!gclid, hasGbraid: !!leadGbraid, hasWbraid: !!leadWbraid, mondayId: itemId });
          if (!result?.skipped) {
            await sendGadsSuccess({ source: 'Student Luxe booking', action: 'Confirmed Booking', payload: { email: leadEmail, name: leadName, mondayId: itemId, value: cleanValue, hasGclid: !!gclid, hasGbraid: !!leadGbraid, requestId: result?.requestId } });
          }
          await sendSuccessEmail({ bookingName, itemId, value: cleanValue, gclid, skipped: result?.skipped });
          return res.status(200).json({ success: true, itemId, value: cleanValue });
        } catch (uploadErr) {
          console.error('submit-booking upload error:', uploadErr.message);
          await logGadsEvent({ source: 'Student Luxe booking', action: 'Confirmed Booking', ok: false, reason: 'exception', error: uploadErr.message, email: leadEmail, value: cleanValue, mondayId: itemId, hasGclid: !!gclid, hasGbraid: !!leadGbraid, hasWbraid: !!leadWbraid });
          await sendGadsAlert({
            source:  'Student Luxe booking',
            action:  'Confirmed Booking',
            payload: { email: leadEmail, name: leadName, mondayId: itemId, value: cleanValue, hasGclid: !!gclid, hasGbraid: !!leadGbraid },
            error:   uploadErr.message
          });
          return res.status(200).json({ error: uploadErr.message, itemId });
        }
      }

      console.log('Confirmed Booking — revenue not yet filled, sending notification');
      await sendNotificationEmail({ bookingName, itemId, gclid, leadSource, isPPC, hasGclid });
      return res.status(200).json({ notified: true, itemId });
    }

    // ── TRIGGER B: Revenue column filled ─────────────────────
    if (isRevenueTrigger) {
      if (!isPPC) return res.status(200).json({ skipped: true, reason: 'not ppc' });

      const eventValue = event.value?.value ?? event.value ?? '';
      const cleanValue = parseFloat((String(eventValue || revenueRaw || '0')).replace(/[£$€,\s]/g, ''));

      if (!cleanValue || cleanValue <= 0) {
        return res.status(200).json({ skipped: true, reason: 'invalid value' });
      }

      console.log('Revenue filled for PPC booking, uploading. Value: £' + cleanValue);
      try {
        const result = await uploadConversion({ gclid, gbraid: leadGbraid, wbraid: leadWbraid, email: leadEmail, phone: leadPhone, name: leadName, timestamp, value: cleanValue, currency: 'GBP', actionId: process.env.GOOGLE_ADS_BOOKING_ACTION_ID });
        await logGadsEvent({ source: 'Student Luxe booking', action: 'Confirmed Booking', ok: !result?.skipped, reason: result?.reason || 'uploaded', email: leadEmail, value: cleanValue, hasGclid: !!gclid, hasGbraid: !!leadGbraid, hasWbraid: !!leadWbraid, mondayId: itemId });
        if (!result?.skipped) {
          await sendGadsSuccess({ source: 'Student Luxe booking', action: 'Confirmed Booking', payload: { email: leadEmail, name: leadName, mondayId: itemId, value: cleanValue, hasGclid: !!gclid, hasGbraid: !!leadGbraid, requestId: result?.requestId } });
        }
        await sendSuccessEmail({ bookingName, itemId, value: cleanValue, gclid, skipped: result?.skipped });
        return res.status(200).json({ success: true, itemId, value: cleanValue });
      } catch (uploadErr) {
        console.error('submit-booking upload error:', uploadErr.message);
        await logGadsEvent({ source: 'Student Luxe booking', action: 'Confirmed Booking', ok: false, reason: 'exception', error: uploadErr.message, email: leadEmail, value: cleanValue, mondayId: itemId, hasGclid: !!gclid, hasGbraid: !!leadGbraid, hasWbraid: !!leadWbraid });
        await sendGadsAlert({
          source:  'Student Luxe booking',
          action:  'Confirmed Booking',
          payload: { email: leadEmail, name: leadName, mondayId: itemId, value: cleanValue, hasGclid: !!gclid, hasGbraid: !!leadGbraid },
          error:   uploadErr.message
        });
        return res.status(200).json({ error: uploadErr.message, itemId });
      }
    }

  } catch (err) {
    console.error('submit-booking error:', err.message);
    const mid = req.body?.event?.pulseId || req.body?.event?.itemId;
    await logGadsEvent({ source: 'Student Luxe booking', action: 'Confirmed Booking', ok: false, reason: 'exception', error: err.message, mondayId: mid });
    await sendGadsAlert({
      source:  'Student Luxe booking',
      action:  'Confirmed Booking',
      payload: { mondayId: mid },
      error:   err.message
    });
    return res.status(200).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────────────────────
//  GOOGLE ADS CONVERSION UPLOAD (Data Manager API)
//  Enhanced Conversions for Leads path: emails / phones match
//  bookings to the original click without needing the click ID
//  (which is usually expired 90+ days after the booking confirms).
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

  // The conversion happens NOW, when the Monday status flips and this webhook
  // fires — not when the booking row was first created (which can be months
  // ago, outside Google's acceptable event-time window -> EVENT_TIME_INVALID).
  // The original `timestamp` is still used below for a stable transactionId.
  const eventTimestamp = new Date().toISOString();

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
    destinationReferences: ['sl-booking'],
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
        reference:          'sl-booking'
      })
    ],
    events:  [event],
    consent: CONSENT_GRANTED
  };

  console.log('Data Manager booking ingest:', {
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
    console.log('Data Manager booking ingest OK — requestId:', result?.requestId || '(no id)');
    return result;
  } catch (err) {
    const msg = String(err.message || err);
    // Map "click outside window" style errors to a skip so the daily summary
    // shows them as expected gaps instead of failures.
    if (/EXPIRED|TOO_OLD|click.*window|EVENT_TIME_INVALID|acceptable time window/i.test(msg)) {
      console.log('Data Manager booking ingest skipped (click outside window):', msg.slice(0, 200));
      return { skipped: true, reason: 'expired_event' };
    }
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────
//  EMAILS
// ──────────────────────────────────────────────────────────────
async function sendNotificationEmail({ bookingName, itemId, gclid, leadSource, isPPC, hasGclid }) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from:    'Student Luxe <noreply@studentluxe.co.uk>',
      to:      ['alex@studentluxe.co.uk'],
      subject: `🏠 New Confirmed Booking — Add Commission Value`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#0d1a2e;">New Confirmed Booking</h2>
        <p>Marked as <strong>Confirmed Booking</strong> in Monday.com.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;">
          <tr style="background:#f7f2eb;"><td style="padding:10px;border:1px solid #e5e3dd;"><strong>Booking</strong></td><td style="padding:10px;border:1px solid #e5e3dd;">${bookingName}</td></tr>
          <tr><td style="padding:10px;border:1px solid #e5e3dd;"><strong>Monday Item ID</strong></td><td style="padding:10px;border:1px solid #e5e3dd;">${itemId}</td></tr>
          <tr style="background:#f7f2eb;"><td style="padding:10px;border:1px solid #e5e3dd;"><strong>PPC Lead</strong></td><td style="padding:10px;border:1px solid #e5e3dd;">${isPPC ? '✅ Yes' : '❌ No'}</td></tr>
          <tr><td style="padding:10px;border:1px solid #e5e3dd;"><strong>GCLID</strong></td><td style="padding:10px;border:1px solid #e5e3dd;">${hasGclid ? '✅ Present' : '❌ None — will match via email/phone'}</td></tr>
        </table>
        ${isPPC ? `<div style="background:#fff3cd;border:1px solid #B8966E;padding:15px;border-radius:4px;margin:20px 0;"><strong>Action required:</strong> Please add the <strong>Revenue Submitted to Google</strong> value in Monday.com to trigger the conversion upload.</div>` : `<div style="background:#f8f9fa;border:1px solid #e5e3dd;padding:15px;border-radius:4px;margin:20px 0;">Not a PPC lead — no Google Ads conversion will be sent.</div>`}
        <p><a href="https://studentluxe.monday.com/boards/2171015589/views/149480482" style="color:#B8966E;">Open Booking Flow Board →</a></p>
      </div>`
    })
  });
}

async function sendSuccessEmail({ bookingName, itemId, value, gclid, skipped }) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from:    'Student Luxe <noreply@studentluxe.co.uk>',
      to:      ['alex@studentluxe.co.uk'],
      subject: skipped
        ? `📋 Confirmed Booking Logged — £${value.toLocaleString('en-GB', { minimumFractionDigits: 2 })} (Google Ads skipped)`
        : `✅ Google Ads Conversion Submitted — £${value.toLocaleString('en-GB', { minimumFractionDigits: 2 })}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#0d1a2e;">${skipped ? 'Booking Logged' : 'Offline Conversion Submitted'}</h2>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;">
          <tr style="background:#f7f2eb;"><td style="padding:10px;border:1px solid #e5e3dd;"><strong>Booking</strong></td><td style="padding:10px;border:1px solid #e5e3dd;">${bookingName}</td></tr>
          <tr><td style="padding:10px;border:1px solid #e5e3dd;"><strong>Value</strong></td><td style="padding:10px;border:1px solid #e5e3dd;font-size:18px;color:#0d1a2e;"><strong>£${value.toLocaleString('en-GB', { minimumFractionDigits: 2 })}</strong></td></tr>
          <tr style="background:#f7f2eb;"><td style="padding:10px;border:1px solid #e5e3dd;"><strong>GCLID</strong></td><td style="padding:10px;border:1px solid #e5e3dd;font-size:11px;color:#666;">${gclid || 'None — matched via email/phone'}</td></tr>
          <tr><td style="padding:10px;border:1px solid #e5e3dd;"><strong>Item ID</strong></td><td style="padding:10px;border:1px solid #e5e3dd;">${itemId}</td></tr>
          <tr style="background:#f7f2eb;"><td style="padding:10px;border:1px solid #e5e3dd;"><strong>Submitted at</strong></td><td style="padding:10px;border:1px solid #e5e3dd;">${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}</td></tr>
        </table>
        ${skipped
          ? `<div style="background:#fff3cd;border:1px solid #e6a817;padding:15px;border-radius:4px;margin:20px 0;"><strong>Note:</strong> Google Ads upload skipped — lead click is outside the conversion window.</div>`
          : `<div style="background:#d4edda;border:1px solid #28a745;padding:15px;border-radius:4px;margin:20px 0;">Conversion will appear in Google Ads within 24–48 hours.</div>`
        }
        <p><a href="https://studentluxe.monday.com/boards/2171015589" style="color:#B8966E;">Open Booking Flow Board →</a></p>
      </div>`
    })
  });
}
