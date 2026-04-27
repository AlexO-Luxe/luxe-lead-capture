// ============================================================
//  Student Luxe — Confirmed Booking Conversion Upload
//  Deploy to: /api/submit-booking.js
// ============================================================

const MONDAY_API = 'https://api.monday.com/v2';

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
                column_values(ids: ["email", "phone_1"]) { id text }
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

    // Extract email + phone from linked lead for enhanced matching
    const relationCol  = (item.relation || []).find(c => c.id === 'link_to_leads26');
    const linkedLead   = relationCol?.linked_items?.[0];
    let leadEmail = '', leadPhone = '';
    if (linkedLead) {
      linkedLead.column_values.forEach(c => {
        if (c.id === 'email')   leadEmail = c.text || '';
        if (c.id === 'phone_1') leadPhone = c.text || '';
      });
    }

    console.log('Item data:', { itemId, bookingName, status, gclid, leadSource, revenueRaw, leadEmail: leadEmail ? '✓' : '✗', leadPhone: leadPhone ? '✓' : '✗' });

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
        const result = await uploadConversion({ gclid, email: leadEmail, phone: leadPhone, timestamp, value: cleanValue, currency: 'GBP', actionId: process.env.GOOGLE_ADS_BOOKING_ACTION_ID });
        await sendSuccessEmail({ bookingName, itemId, value: cleanValue, gclid, skipped: result?.skipped });
        return res.status(200).json({ success: true, itemId, value: cleanValue });
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
      const result = await uploadConversion({ gclid, email: leadEmail, phone: leadPhone, timestamp, value: cleanValue, currency: 'GBP', actionId: process.env.GOOGLE_ADS_BOOKING_ACTION_ID });
      await sendSuccessEmail({ bookingName, itemId, value: cleanValue, gclid, skipped: result?.skipped });
      return res.status(200).json({ success: true, itemId, value: cleanValue });
    }

  } catch (err) {
    console.error('submit-booking error:', err.message);
    return res.status(200).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────────────────────
//  GOOGLE ADS CONVERSION UPLOAD
// ──────────────────────────────────────────────────────────────
async function uploadConversion({ gclid, email, phone, timestamp, value, currency, actionId }) {

  // Get fresh access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(tokenData));

  // Hash email and phone for enhanced matching
  async function sha256(str) {
    const encoder    = new TextEncoder();
    const data       = encoder.encode(str.toLowerCase().trim());
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const hashedEmail = email ? await sha256(email) : null;
  const cleanPhone  = phone ? phone.replace(/[\s\-().]/g, '') : null;
  const hashedPhone = cleanPhone ? await sha256(cleanPhone) : null;

  // Format timestamp
  const rawTime        = timestamp ? new Date(timestamp) : new Date();
  const conversionTime = rawTime.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '+00:00');

  const customerId       = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  const conversionAction = `customers/${customerId}/conversionActions/${actionId}`;
  const endpoint         = `https://googleads.googleapis.com/v20/customers/${customerId}:uploadClickConversions`;

  // Build conversion — gclid optional, matched via email/phone when absent
  const conversion = {
    conversionAction,
    conversionDateTime: conversionTime,
    conversionValue:    value,
    currencyCode:       currency,
    userIdentifiers: [
      ...(hashedEmail ? [{ hashedEmail }] : []),
      ...(hashedPhone ? [{ hashedPhoneNumber: hashedPhone }] : [])
    ]
  };
  if (gclid) conversion.gclid = gclid;

  console.log('Uploading conversion:', { endpoint, conversionAction, hasGclid: !!gclid, hasEmail: !!hashedEmail, hasPhone: !!hashedPhone, conversionTime, value });

  const gadsRes = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Authorization':     `Bearer ${tokenData.access_token}`,
      'developer-token':   process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'login-customer-id': '6046238343',
      'Content-Type':      'application/json'
    },
    body: JSON.stringify({ conversions: [conversion], partialFailure: true })
  });

  const rawText = await gadsRes.text();
  console.log('Google Ads response (status ' + gadsRes.status + '):', rawText.substring(0, 500));

  if (!rawText.trim().startsWith('{') && !rawText.trim().startsWith('[')) {
    throw new Error('Google Ads returned non-JSON (status ' + gadsRes.status + '): ' + rawText.substring(0, 200));
  }

  const gadsData = JSON.parse(rawText);

  if (gadsData.partialFailureError) {
    const errStr = JSON.stringify(gadsData.partialFailureError);
    if (errStr.includes('EXPIRED_EVENT') || errStr.includes('TOO_RECENT_CONVERSION_ACTION')) {
      console.log('Google Ads upload skipped (expected):', errStr.substring(0, 200));
      return { skipped: true, reason: 'expired_event' };
    }
    throw new Error('Partial failure: ' + errStr);
  }
  if (gadsData.error) throw new Error('API error: ' + JSON.stringify(gadsData.error));

  console.log('Google Ads conversion uploaded successfully');
  return gadsData;
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
