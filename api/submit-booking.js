// ============================================================
//  Student Luxe — Confirmed Booking Conversion Upload
//  Deploy to: /api/submit-booking.js
//
//  TWO TRIGGERS on Booking Flow board (2171015589):
//
//  Trigger A: 'status' changes to 'Confirmed Booking'
//  → If 'Revenue Submitted to Google' (numeric_mm1ge9h4) is empty:
//    sends internal notification email to alex@studentluxe.co.uk
//  → If already filled + PPC + gclid: uploads conversion immediately
//
//  Trigger B: 'numeric_mm1ge9h4' changes (Revenue Submitted to Google)
//  → Checks status = 'Confirmed Booking' AND gclid present AND PPC
//  → Uploads conversion to Google Ads + sends success email
//
//  Environment variables required:
//    MONDAY_API_KEY
//    GOOGLE_ADS_CLIENT_ID
//    GOOGLE_ADS_CLIENT_SECRET
//    GOOGLE_ADS_REFRESH_TOKEN
//    GOOGLE_ADS_CUSTOMER_ID
//    GOOGLE_ADS_DEVELOPER_TOKEN
//    GOOGLE_ADS_BOOKING_ACTION_ID
//    RESEND_API_KEY
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

    // ── MONDAY WEBHOOK CHALLENGE ──────────────────────────────
    if (body.challenge) {
      console.log('Monday challenge received, responding');
      return res.status(200).json({ challenge: body.challenge });
    }

    const event = body.event;
    if (!event) {
      console.log('No event in payload, skipping');
      return res.status(200).json({ skipped: true, reason: 'no event' });
    }

    const itemId   = event.pulseId || event.itemId;
    const columnId = event.columnId;

    if (!itemId) {
      console.log('No item ID in event, skipping');
      return res.status(200).json({ skipped: true, reason: 'no item id' });
    }

    // ── DETERMINE WHICH TRIGGER FIRED ────────────────────────
    const isStatusTrigger  = columnId === 'status';
    const isRevenueTrigger = columnId === 'numeric_mm1ge9h4';

    if (!isStatusTrigger && !isRevenueTrigger) {
      console.log('Unrecognised column trigger:', columnId);
      return res.status(200).json({ skipped: true, reason: 'unrecognised column' });
    }

    // ── FETCH ITEM DATA FROM MONDAY ───────────────────────────
    const query = `
      query {
        items(ids: [${itemId}]) {
          id
          name
          created_at
          column_values(ids: ["status", "mirror21__1", "lookup_mkxtxk48", "numeric_mm1ge9h4"]) {
            id
            text
            value
            ... on MirrorValue {
              display_value
            }
            ... on BoardRelationValue {
              display_value
            }
            ... on StatusValue {
              label
            }
          }
        }
      }
    `;

    const mondayRes = await fetch(MONDAY_API, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': process.env.MONDAY_API_KEY
      },
      body: JSON.stringify({ query })
    });

    const mondayData = await mondayRes.json();
    const item = mondayData?.data?.items?.[0];

    if (!item) {
      console.error('Item not found in Monday:', itemId);
      return res.status(200).json({ skipped: true, reason: 'item not found' });
    }

    // Extract column values
    const cols = {};
    item.column_values.forEach(c => {
      cols[c.id] = c.display_value || c.label || c.text || '';
    });

    const bookingName  = item.name;
    const status       = cols['status'];
    const gclid        = cols['mirror21__1'];
    const leadSource   = cols['lookup_mkxtxk48'];
    const revenueRaw   = cols['numeric_mm1ge9h4'];
    const timestamp    = item.created_at;
    const isPPC        = (leadSource || '').toLowerCase().includes('ppc');
    const hasGclid     = !!gclid;

    console.log('Item data:', { itemId, bookingName, status, gclid, leadSource, revenueRaw });

    // ── TRIGGER A: Status changed to Confirmed Booking ────────
    if (isStatusTrigger) {
      const newValue = (
        event.value?.label?.text ||
        (typeof event.value?.label === 'string' ? event.value.label : '') ||
        ''
      ).toString();

      if (!newValue.toLowerCase().includes('confirmed booking')) {
        console.log('Not Confirmed Booking status, skipping. Value was:', newValue);
        return res.status(200).json({ skipped: true, reason: 'not confirmed booking' });
      }

      // Check if revenue already filled
      const cleanValue = parseFloat((revenueRaw || '').toString().replace(/[£$€,\s]/g, ''));

      if (cleanValue > 0 && isPPC && hasGclid) {
        // Revenue already there — upload immediately
        console.log('Status confirmed + revenue present, uploading conversion. Value: £' + cleanValue);
        await uploadConversion({ gclid, timestamp, value: cleanValue, currency: 'GBP', actionId: process.env.GOOGLE_ADS_BOOKING_ACTION_ID });
        await sendSuccessEmail({ bookingName, itemId, value: cleanValue, gclid });
        return res.status(200).json({ success: true, itemId, gclid, value: cleanValue });
      }

      // Revenue not yet filled — send notification
      console.log('Confirmed Booking — revenue not yet filled, sending notification email');
      await sendNotificationEmail({ bookingName, itemId, gclid, leadSource, isPPC, hasGclid });
      return res.status(200).json({ notified: true, itemId });
    }

    // ── TRIGGER B: Revenue Submitted to Google column filled ──
    // Note: No status check here — if revenue is manually entered, the conversion
    // should be uploaded regardless of booking status. The ad did its job.
    if (isRevenueTrigger) {

      // Must be PPC with gclid
      if (!hasGclid) {
        console.log('No gclid, skipping');
        return res.status(200).json({ skipped: true, reason: 'no gclid' });
      }

      if (!isPPC) {
        console.log('Not PPC lead, skipping. Source:', leadSource);
        return res.status(200).json({ skipped: true, reason: 'not ppc' });
      }

      // Parse value — try event payload first, fall back to Monday column value
      const eventValue  = event.value?.value ?? event.value ?? '';
      const cleanValue  = parseFloat(
        (String(eventValue || revenueRaw || '0')).replace(/[£$€,\s]/g, '')
      );

      if (!cleanValue || cleanValue <= 0) {
        console.log('Invalid revenue value:', eventValue, revenueRaw);
        return res.status(200).json({ skipped: true, reason: 'invalid value' });
      }

      console.log('Revenue filled for confirmed PPC booking, uploading. Value: £' + cleanValue);
      await uploadConversion({ gclid, timestamp, value: cleanValue, currency: 'GBP', actionId: process.env.GOOGLE_ADS_BOOKING_ACTION_ID });
      await sendSuccessEmail({ bookingName, itemId, value: cleanValue, gclid });
      return res.status(200).json({ success: true, itemId, gclid, value: cleanValue });
    }

  } catch (err) {
    console.error('submit-booking error:', err.message);
    return res.status(200).json({ error: err.message });
  }
};

// ──────────────────────────────────────────────────────────────
//  EMAIL — Internal notification (revenue not yet filled)
// ──────────────────────────────────────────────────────────────
async function sendNotificationEmail({ bookingName, itemId, gclid, leadSource, isPPC, hasGclid }) {
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from:    'Student Luxe <noreply@studentluxe.co.uk>',
      to:      ['alex@studentluxe.co.uk'],
      subject: `🏠 New Confirmed Booking — Add Commission Value`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #0d1a2e;">New Confirmed Booking</h2>
          <p>A booking has been marked as <strong>Confirmed Booking</strong> in Monday.com.</p>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr style="background: #f7f2eb;">
              <td style="padding: 10px; border: 1px solid #e5e3dd;"><strong>Booking</strong></td>
              <td style="padding: 10px; border: 1px solid #e5e3dd;">${bookingName}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e5e3dd;"><strong>Monday Item ID</strong></td>
              <td style="padding: 10px; border: 1px solid #e5e3dd;">${itemId}</td>
            </tr>
            <tr style="background: #f7f2eb;">
              <td style="padding: 10px; border: 1px solid #e5e3dd;"><strong>PPC Lead</strong></td>
              <td style="padding: 10px; border: 1px solid #e5e3dd;">${isPPC ? '✅ Yes' : '❌ No'}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e5e3dd;"><strong>GCLID Present</strong></td>
              <td style="padding: 10px; border: 1px solid #e5e3dd;">${hasGclid ? '✅ Yes' : '❌ No — no Google Ads conversion will be sent'}</td>
            </tr>
          </table>
          ${isPPC && hasGclid ? `
          <div style="background: #fff3cd; border: 1px solid #B8966E; padding: 15px; border-radius: 4px; margin: 20px 0;">
            <strong>Action required:</strong> This is a PPC lead with a valid GCLID.
            Please add the <strong>Revenue Submitted to Google</strong> value in Monday.com
            to trigger the offline conversion upload to Google Ads.
          </div>
          ` : `
          <div style="background: #f8f9fa; border: 1px solid #e5e3dd; padding: 15px; border-radius: 4px; margin: 20px 0;">
            <strong>Note:</strong> This booking is not from a PPC lead or has no GCLID —
            no Google Ads conversion will be sent.
          </div>
          `}
          <p><a href="https://studentluxe.monday.com/boards/2171015589/views/149480482" style="color: #B8966E;">Open Booking Flow Board →</a></p>
        </div>
      `
    })
  });

  const emailData = await emailRes.json();
  console.log('Notification email sent:', emailData.id || emailData.error);
}

// ──────────────────────────────────────────────────────────────
//  EMAIL — Success notification (conversion uploaded)
// ──────────────────────────────────────────────────────────────
async function sendSuccessEmail({ bookingName, itemId, value, gclid }) {
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from:    'Student Luxe <noreply@studentluxe.co.uk>',
      to:      ['alex@studentluxe.co.uk'],
      subject: `✅ Google Ads Offline Conversion Submitted — £${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #0d1a2e;">Offline Conversion Submitted to Google Ads</h2>
          <p>A confirmed booking conversion has been successfully uploaded to Google Ads.</p>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr style="background: #f7f2eb;">
              <td style="padding: 10px; border: 1px solid #e5e3dd;"><strong>Booking</strong></td>
              <td style="padding: 10px; border: 1px solid #e5e3dd;">${bookingName}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e5e3dd;"><strong>Conversion Value</strong></td>
              <td style="padding: 10px; border: 1px solid #e5e3dd; font-size: 18px; color: #0d1a2e;"><strong>£${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
            </tr>
            <tr style="background: #f7f2eb;">
              <td style="padding: 10px; border: 1px solid #e5e3dd;"><strong>GCLID</strong></td>
              <td style="padding: 10px; border: 1px solid #e5e3dd; font-size: 11px; color: #666;">${gclid}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e5e3dd;"><strong>Monday Item ID</strong></td>
              <td style="padding: 10px; border: 1px solid #e5e3dd;">${itemId}</td>
            </tr>
            <tr style="background: #f7f2eb;">
              <td style="padding: 10px; border: 1px solid #e5e3dd;"><strong>Submitted at</strong></td>
              <td style="padding: 10px; border: 1px solid #e5e3dd;">${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}</td>
            </tr>
          </table>
          <div style="background: #d4edda; border: 1px solid #28a745; padding: 15px; border-radius: 4px; margin: 20px 0;">
            This conversion will appear in Google Ads within 24–48 hours and will be used
            by Smart Bidding to optimise for similar high-value bookings.
          </div>
          <p><a href="https://studentluxe.monday.com/boards/2171015589" style="color: #B8966E;">Open Booking Flow Board →</a></p>
        </div>
      `
    })
  });

  const emailData = await emailRes.json();
  console.log('Success email sent:', emailData.id || emailData.error);
}

// ──────────────────────────────────────────────────────────────
//  GOOGLE ADS CONVERSION UPLOAD
// ──────────────────────────────────────────────────────────────
async function uploadConversion({ gclid, timestamp, value, currency, actionId }) {

  // Step 1 — Get fresh access token
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
  if (!tokenData.access_token) {
    throw new Error('Failed to get access token: ' + JSON.stringify(tokenData));
  }

  // Step 2 — Format timestamp
  const rawTime        = timestamp ? new Date(timestamp) : new Date();
  const conversionTime = rawTime.toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '+00:00');

  const customerId       = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  const conversionAction = `customers/${customerId}/conversionActions/${actionId}`;
  const endpoint         = `https://googleads.googleapis.com/v20/customers/${customerId}:uploadClickConversions`;

  console.log('Uploading conversion:', { endpoint, conversionAction, gclid, conversionTime, value });

  // Step 3 — Upload to Google Ads Conversions API
  const gadsRes = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Authorization':     `Bearer ${tokenData.access_token}`,
      'developer-token':   process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'login-customer-id': '6046238343',
      'Content-Type':      'application/json'
    },
    body: JSON.stringify({
      conversions: [{
        gclid,
        conversionAction,
        conversionDateTime: conversionTime,
        conversionValue:    value,
        currencyCode:       currency
      }],
      partialFailure: true
    })
  });

  const rawText = await gadsRes.text();
  console.log('Google Ads raw response (status ' + gadsRes.status + '):', rawText.substring(0, 500));

  if (!rawText.trim().startsWith('{') && !rawText.trim().startsWith('[')) {
    throw new Error('Google Ads returned non-JSON (status ' + gadsRes.status + '): ' + rawText.substring(0, 200));
  }

  const gadsData = JSON.parse(rawText);

  if (gadsData.partialFailureError) {
    throw new Error('Partial failure: ' + JSON.stringify(gadsData.partialFailureError));
  }
  if (gadsData.error) {
    throw new Error('API error: ' + JSON.stringify(gadsData.error));
  }

  console.log('Google Ads conversion uploaded successfully');
  return gadsData;
}
