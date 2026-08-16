// ============================================================
//  Student Luxe — Confirmed Booking Conversion Upload
//  Deploy to: /api/submit-booking.js
// ============================================================

const MONDAY_API = 'https://api.monday.com/v2';
const { logGadsEvent }  = require('./_log.js');
const { bookingValue }  = require('./_booking-value.js');
const { ingestBookers }  = require('./_audience.js');

// The only booking status that must NOT upload to Google. Every other status
// (Confirmed, Paying/Approved, Payment Complete, Extensions, Awaiting
// Commission, Shortened, even Lost/Cancelled) can carry real revenue and is
// allowed to upload once a value is present.
function isPendingStatus (s) {
  return (s || '').toString().toLowerCase().trim() === 'pending booking';
}

const { logError } = require('./_errlog.js');

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
          column_values(ids: ["status", "mirror21__1", "lookup_mkxtxk48", "numeric_mm1ge9h4", "formula2"]) {
            id text value
            ... on FormulaValue { display_value }
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
    const leadSource  = cols['lookup_mkxtxk48'];
    // formula2 (Monday's live Total Luxe Commission) is the source of truth;
    // Rev to Google is only the fallback. Rev to Google is a snapshot written
    // by the daily sync, which only scans the current month plus future close
    // dates, so older rows freeze and drift below the real figure.
    let { value: bookingVal, source: valueSource } = bookingValue(cols);

    // formula2 blips null occasionally (observed in production). Google keeps
    // the FIRST value it receives for a conversion forever, so falling back to
    // a stale Rev to Google on a blip would bake in the wrong number
    // permanently. One cheap re-read before accepting the fallback.
    if (valueSource !== 'formula2') {
      try {
        const retryRes = await fetch(MONDAY_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
          body: JSON.stringify({ query: `query { items(ids: [${itemId}]) { column_values(ids: ["formula2"]) { id text ... on FormulaValue { display_value } } } }` })
        });
        const retryData = await retryRes.json();
        const rc = retryData?.data?.items?.[0]?.column_values?.[0];
        const retryVal = rc?.display_value || rc?.text || '';
        const retried  = bookingValue({ formula2: retryVal, numeric_mm1ge9h4: cols['numeric_mm1ge9h4'] });
        if (retried.source === 'formula2') {
          bookingVal  = retried.value;
          valueSource = 'formula2 (retry)';
        }
      } catch (e) {
        console.warn('formula2 re-read failed (non-fatal):', e.message);
      }
    }

    const revenueRaw  = bookingVal !== null ? String(bookingVal) : cols['numeric_mm1ge9h4'];
    const timestamp   = item.created_at;
    const isPPC       = (leadSource || '').toLowerCase().includes('ppc');

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
    // The mirror can surface a braid or fbclid; never ship those as a gclid.
    const gclid    = cleanGclid(cols['mirror21__1'], leadGbraid, leadWbraid);
    const hasGclid = !!gclid;

    console.log('Item data:', { itemId, bookingName, status, gclid, leadSource, revenueRaw, valueSource, leadEmail: leadEmail ? '✓' : '✗', leadPhone: leadPhone ? '✓' : '✗', leadGbraid: leadGbraid ? '✓' : '✗', leadWbraid: leadWbraid ? '✓' : '✗' });

    // ── TRIGGER A: Status changed ─────────────────────────────
    // Any status uploads once revenue is present, EXCEPT "Pending Booking"
    // (not yet real). Lost / Cancelled are allowed: they can still carry
    // revenue (e.g. a retained cancellation fee).
    if (isStatusTrigger) {
      const newValue = (
        event.value?.label?.text ||
        (typeof event.value?.label === 'string' ? event.value.label : '') || ''
      ).toString();

      if (isPendingStatus(newValue)) {
        return res.status(200).json({ skipped: true, reason: 'pending booking, not uploading' });
      }

      const cleanValue = parseFloat((revenueRaw || '').toString().replace(/[£$€,\s]/g, ''));

      if (cleanValue > 0 && isPPC) {
        console.log('Confirmed status + revenue present, uploading. Value: £' + cleanValue);
        // Own try/catch so a failure alert carries full lead context
        // (email, name, click ids) instead of falling through to the
        // outer catch, which only has mondayId in scope.
        try {
          const result = await uploadConversion({ gclid, gbraid: leadGbraid, wbraid: leadWbraid, email: leadEmail, phone: leadPhone, name: leadName, itemId, value: cleanValue, currency: 'GBP', actionId: process.env.GOOGLE_ADS_BOOKING_ACTION_ID });
          await logGadsEvent({ source: 'Student Luxe booking', action: 'Confirmed Booking', ok: !result?.skipped, reason: result?.reason || 'uploaded', email: leadEmail, value: cleanValue, hasGclid: !!gclid, hasGbraid: !!leadGbraid, hasWbraid: !!leadWbraid, mondayId: itemId });

          // Customer Match: add the booker to the Google Ads customer list.
          // Non-fatal, the nightly audience-sync sweep heals any miss.
          if (!result?.skipped && (leadEmail || leadPhone)) {
            try { await ingestBookers([{ email: leadEmail, phone: leadPhone }]); }
            catch (e) { console.warn('customer list add failed (non-fatal):', e.message); }
          }
          return res.status(200).json({ success: true, itemId, value: cleanValue });
        } catch (uploadErr) {
          console.error('submit-booking upload error:', uploadErr.message);
          // Log only. Alerting is owned by /api/replay-failed-events, which
          // emails once a fail has not self-healed after STUCK_MS.
          await logGadsEvent({ source: 'Student Luxe booking', action: 'Confirmed Booking', ok: false, reason: 'exception', error: uploadErr.message, email: leadEmail, value: cleanValue, mondayId: itemId, hasGclid: !!gclid, hasGbraid: !!leadGbraid, hasWbraid: !!leadWbraid });
          return res.status(200).json({ error: uploadErr.message, itemId });
        }
      }

      // Nudge the team to fill revenue, but only at the first confirmation,
      // not on every later status change (avoids repeat emails).
      if (newValue.toLowerCase().includes('confirmed booking')) {
        console.log('Confirmed Booking — revenue not yet filled, sending notification');
        return res.status(200).json({ notified: true, itemId });
      }
      return res.status(200).json({ skipped: true, reason: 'no revenue yet' });
    }

    // ── TRIGGER B: Revenue column filled ─────────────────────
    if (isRevenueTrigger) {
      if (!isPPC) return res.status(200).json({ skipped: true, reason: 'not ppc' });
      if (isPendingStatus(status)) return res.status(200).json({ skipped: true, reason: 'pending booking, not uploading' });

      const eventValue = event.value?.value ?? event.value ?? '';
      const cleanValue = parseFloat((String(eventValue || revenueRaw || '0')).replace(/[£$€,\s]/g, ''));

      if (!cleanValue || cleanValue <= 0) {
        return res.status(200).json({ skipped: true, reason: 'invalid value' });
      }

      console.log('Revenue filled for PPC booking, uploading. Value: £' + cleanValue);
      try {
        const result = await uploadConversion({ gclid, gbraid: leadGbraid, wbraid: leadWbraid, email: leadEmail, phone: leadPhone, name: leadName, itemId, value: cleanValue, currency: 'GBP', actionId: process.env.GOOGLE_ADS_BOOKING_ACTION_ID });
        await logGadsEvent({ source: 'Student Luxe booking', action: 'Confirmed Booking', ok: !result?.skipped, reason: result?.reason || 'uploaded', email: leadEmail, value: cleanValue, hasGclid: !!gclid, hasGbraid: !!leadGbraid, hasWbraid: !!leadWbraid, mondayId: itemId });

          // Customer Match: add the booker to the Google Ads customer list.
          // Non-fatal, the nightly audience-sync sweep heals any miss.
          if (!result?.skipped && (leadEmail || leadPhone)) {
            try { await ingestBookers([{ email: leadEmail, phone: leadPhone }]); }
            catch (e) { console.warn('customer list add failed (non-fatal):', e.message); }
          }
        return res.status(200).json({ success: true, itemId, value: cleanValue });
      } catch (uploadErr) {
        console.error('submit-booking upload error:', uploadErr.message);
        // Log only. Replay cron owns alerting once a fail fails to self-heal.
        await logGadsEvent({ source: 'Student Luxe booking', action: 'Confirmed Booking', ok: false, reason: 'exception', error: uploadErr.message, email: leadEmail, value: cleanValue, mondayId: itemId, hasGclid: !!gclid, hasGbraid: !!leadGbraid, hasWbraid: !!leadWbraid });
        return res.status(200).json({ error: uploadErr.message, itemId });
      }
    }

  } catch (err) {
    console.error('submit-booking error:', err.message);
    await logError('submit-booking', err);
    const mid = req.body?.event?.pulseId || req.body?.event?.itemId;
    await logGadsEvent({ source: 'Student Luxe booking', action: 'Confirmed Booking', ok: false, reason: 'exception', error: err.message, mondayId: mid });
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
  cleanGclid,
  CONSENT_GRANTED
} = require('./_dataManager.js');

async function uploadConversion ({ gclid, gbraid, wbraid, email, phone, name, itemId, value, currency, actionId }) {
  const nameParts = (name || '').trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ');

  // The conversion happens NOW, when the Monday status flips and this webhook
  // fires — not when the booking row was first created (which can be months
  // ago, outside Google's acceptable event-time window -> EVENT_TIME_INVALID).
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
    // Canonical txn, same convention as replay-failed-events and the
    // dissonance fix mode, so every path dedupes against every other.
    // Never put the raw email in here: Google started rejecting
    // transaction ids containing it (bare events.events[0] 400s) around
    // 27 Jul 2026, which made every first-attempt webhook upload fail.
    transactionId:         'replay:' + (itemId || Date.now()) + ':' + String(actionId),
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
