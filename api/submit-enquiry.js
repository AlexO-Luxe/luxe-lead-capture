// ============================================================
//  Student Luxe — Enquiry Submit + Email Handler
//  Deploy to: /api/submit-enquiry.js in your Vercel project
// ============================================================

const RESEND_API   = 'https://api.resend.com/emails';
const MONDAY_API   = 'https://api.monday.com/v2';
const MONDAY_BOARD = 2171015719;

// ── IP BLOCKLIST ──────────────────────────────────────────────
// Add spammer IPs here. Returns fake success so they don't know they're blocked.
const BLOCKED_IPS = [
  '154.192.222.128',
];

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const p = req.body;

  // ── Get submitter IP ──────────────────────────────────────
  const submitterIp =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '';

  // ── IP block check ────────────────────────────────────────
  if (BLOCKED_IPS.includes(submitterIp)) {
    console.log('Blocked IP rejected:', submitterIp);
    return res.status(200).json({ success: true }); // silent — spammer sees normal success
  }

  // ── Duplicate check — query Monday for matching email ─────
  let duplicateOf = null;
  try {
    duplicateOf = await findExistingLead(p.email, submitterIp);
  } catch(err) {
    console.warn('Duplicate check failed (non-fatal):', err.message);
  }

  if (duplicateOf) {
    console.log('Duplicate detected — existing lead ID:', duplicateOf.id);
  }

  // ── Always push to Monday ─────────────────────────────────
  let mondayId    = null;
  let mondayError = null;
  try {
    mondayId = await pushToMonday(p, submitterIp, duplicateOf);
    console.log('Monday OK — pulse ID:', mondayId);
  } catch(err) {
    mondayError = err.message || 'Unknown error';
    console.error('Monday failed:', mondayError);
  }

  // Compute lead source for email
  const { leadSource, leadChannel } = computeLeadSource(p);

  const results = await Promise.allSettled([
    sendGuestConfirmation(p),
    sendTeamNotification(p, mondayId, mondayError, duplicateOf, submitterIp, leadSource, leadChannel)
  ]);

  results.forEach((r, i) => {
    const label = ['Guest email', 'Team email'][i];
    if(r.status === 'rejected') console.error(`${label} failed:`, r.reason?.message || r.reason);
    else console.log(`${label} OK`);
  });

  // ── GOOGLE ADS SERVER-SIDE CONVERSION ─────────────────────
  try {
    await uploadGoogleAdsConversion(p);
    console.log('Google Ads conversion uploaded OK');
  } catch(err) {
    console.error('Google Ads conversion failed (non-fatal):', err.message);
  }

  return res.status(200).json({ success: true });
};

// ──────────────────────────────────────────────────────────────
//  DUPLICATE DETECTION
// ──────────────────────────────────────────────────────────────
async function findExistingLead(email, ip) {
  if (!email) return null;

  const query = `
    query {
      items_page_by_column_values(
        board_id: ${MONDAY_BOARD},
        limit: 5,
        columns: [{ column_id: "email", column_values: ["${email.toLowerCase().trim()}"] }]
      ) {
        items {
          id
          name
          created_at
          column_values(ids: ["people_1", "text_mm2y2ah2"]) {
            id
            text
            value
          }
        }
      }
    }
  `;

  const response = await fetch(MONDAY_API, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  if (data.errors) {
    console.error('Monday duplicate query errors:', JSON.stringify(data.errors));
    return null;
  }

  const items = data?.data?.items_page_by_column_values?.items || [];
  if (items.length === 0) return null;

  const match = items[0];

  let assignees   = [];
  let assigneeIds = [];
  const peopleCol = match.column_values?.find(c => c.id === 'people_1');
  if (peopleCol?.value) {
    try {
      const val        = JSON.parse(peopleCol.value);
      const personsArr = val?.personsAndTeams || [];
      assigneeIds = personsArr.filter(pt => pt.kind === 'person').map(pt => pt.id);
      const textVal = peopleCol.text || '';
      if (textVal) assignees = textVal.split(',').map(s => s.trim()).filter(Boolean);
    } catch(e) {
      if (peopleCol.text) assignees = [peopleCol.text];
    }
  }

  const ipCol      = match.column_values?.find(c => c.id === 'text_mm2y2ah2');
  const originalIp = ipCol?.text || '';

  return {
    id:          match.id,
    name:        match.name,
    created_at:  match.created_at,
    assignees,
    assigneeIds,
    originalIp,
    ipMatch: !!(originalIp && ip && originalIp === ip)
  };
}

// ──────────────────────────────────────────────────────────────
//  GOOGLE ADS — Server-side conversion upload
// ──────────────────────────────────────────────────────────────
async function uploadGoogleAdsConversion(p) {

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

  async function sha256(str) {
    const encoder    = new TextEncoder();
    const data       = encoder.encode(str.toLowerCase().trim());
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray  = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const hashedEmail = p.email ? await sha256(p.email) : null;
  const cleanPhone  = p.phone ? p.phone.replace(/[\s\-().]/g, '') : null;
  const hashedPhone = cleanPhone ? await sha256(cleanPhone) : null;

  const rawTime        = p.submitted_at ? new Date(p.submitted_at) : new Date();
  const conversionTime = rawTime.toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '+00:00');

  const customerId       = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  console.log('Google Ads customer ID:', customerId);
  console.log('Google Ads endpoint:', `https://googleads.googleapis.com/v21/customers/${customerId}:uploadClickConversions`);
  const conversionAction = `customers/${customerId}/conversionActions/${process.env.GOOGLE_ADS_CONVERSION_ACTION_ID}`;

  const conversion = {
    conversionAction,
    conversionDateTime: conversionTime,
    conversionValue:    1.0,
    currencyCode:       'GBP',
    userIdentifiers: [
      ...(hashedEmail ? [{ hashedEmail }] : []),
      ...(hashedPhone ? [{ hashedPhoneNumber: hashedPhone }] : [])
    ]
  };
  if (p.gclid) conversion.gclid = p.gclid;

  const payload = { conversions: [conversion], partialFailure: true };

  const gadsRes = await fetch(
    `https://googleads.googleapis.com/v21/customers/${customerId}:uploadClickConversions`,
    {
      method:  'POST',
      headers: {
        'Authorization':     `Bearer ${tokenData.access_token}`,
        'developer-token':   process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'login-customer-id': '6046238343',
        'Content-Type':      'application/json'
      },
      body: JSON.stringify(payload)
    }
  );

  const rawText = await gadsRes.text();
  console.log('Google Ads raw response (status ' + gadsRes.status + '):', rawText.substring(0, 500));

  if (!rawText.trim().startsWith('{') && !rawText.trim().startsWith('[')) {
    throw new Error('Google Ads returned non-JSON (status ' + gadsRes.status + '): ' + rawText.substring(0, 200));
  }

  const gadsData = JSON.parse(rawText);
  if (gadsData.partialFailureError) throw new Error('Partial failure: ' + JSON.stringify(gadsData.partialFailureError));
  if (gadsData.error) throw new Error('API error: ' + JSON.stringify(gadsData.error));

  console.log('Google Ads conversion uploaded successfully');
  return gadsData;
}

// ──────────────────────────────────────────────────────────────
//  EMAIL 1 — Guest confirmation
// ──────────────────────────────────────────────────────────────

// ── RESPONSE TIME LOGIC ──────────────────────────────────────
const CLOSURES = [
  // 2025
  { name:'Easter',                 closed:'2025-04-18', reopen:'2025-04-23' },
  { name:'Early May Bank Holiday', closed:'2025-05-05', reopen:'2025-05-06' },
  { name:'Spring Bank Holiday',    closed:'2025-05-26', reopen:'2025-05-27' },
  { name:'Summer Bank Holiday',    closed:'2025-08-25', reopen:'2025-08-26' },
  { name:'Christmas',              closed:'2025-12-25', reopen:'2025-12-29' },
  // 2026
  { name:'New Year',               closed:'2026-01-01', reopen:'2026-01-02' },
  { name:'Easter',                 closed:'2026-04-03', reopen:'2026-04-07' },
  { name:'Early May Bank Holiday', closed:'2026-05-04', reopen:'2026-05-05' },
  { name:'Spring Bank Holiday',    closed:'2026-05-25', reopen:'2026-05-26' },
  { name:'Summer Bank Holiday',    closed:'2026-08-31', reopen:'2026-09-01' },
  { name:'Christmas',              closed:'2026-12-25', reopen:'2026-12-29' },
  // 2027
  { name:'New Year',               closed:'2027-01-01', reopen:'2027-01-04' },
  { name:'Easter',                 closed:'2027-03-26', reopen:'2027-03-31' },
  { name:'Early May Bank Holiday', closed:'2027-05-03', reopen:'2027-05-04' },
  { name:'Spring Bank Holiday',    closed:'2027-05-31', reopen:'2027-06-01' },
  { name:'Summer Bank Holiday',    closed:'2027-08-30', reopen:'2027-08-31' },
  { name:'Christmas',              closed:'2027-12-27', reopen:'2027-12-30' },
];

function getResponseStatus(submittedAt) {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // Use submission time in UK timezone
  const now = submittedAt ? new Date(submittedAt) : new Date();
  const ukStr = now.toLocaleString('en-GB', { timeZone: 'Europe/London',
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12: false });
  // Parse "DD/MM/YYYY, HH:MM"
  const [datePart, timePart] = ukStr.split(', ');
  const [dd, mm, yyyy] = datePart.split('/').map(Number);
  const [hh, mi]       = timePart.split(':').map(Number);
  const dayOfWeek      = new Date(yyyy, mm - 1, dd).getDay(); // 0=Sun,6=Sat
  const minuteOfDay    = hh * 60 + mi;
  const inOffice       = minuteOfDay >= 10 * 60 && minuteOfDay < 18 * 60; // 10am–6pm

  // Today as YYYY-MM-DD string for closure comparison
  const todayStr = `${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;

  // Check bank holiday / closure
  for (const c of CLOSURES) {
    if (todayStr >= c.closed && todayStr < c.reopen) {
      const reopenDate  = new Date(c.reopen);
      const reopenDay   = reopenDate.getDate();
      const reopenMonth = MONTHS[reopenDate.getMonth()];
      return {
        state:       'holiday',
        color:       'amber',
        heading:     `From ${reopenDay} ${reopenMonth}`,
        body:        `Our offices are closed for the ${c.name} period. We\u2019ll respond to all enquiries as soon as we\u2019re back on ${reopenDay} ${reopenMonth}.`,
        bodyTextEnd: `from ${reopenDay} ${reopenMonth}`,
      };
    }
  }

  // Weekend (Sat=6, Sun=0) or Friday after 6pm
  const isFriAfter6  = dayOfWeek === 5 && minuteOfDay >= 18 * 60;
  const isSat        = dayOfWeek === 6;
  const isSun        = dayOfWeek === 0;
  if (isFriAfter6 || isSat || isSun) {
    return {
      state:       'weekend',
      color:       'amber',
      heading:     'Monday',
      body:        'Your enquiry came in over the weekend \u2014 we\u2019ll be back in touch first thing on Monday morning.',
      bodyTextEnd: 'on Monday',
    };
  }

  // Weekday in office hours
  if (inOffice) {
    return {
      state:       'inoffice',
      color:       'green',
      heading:     'Same day, or within one business day',
      body:        'Our team are in the office and will be in touch shortly.',
      bodyTextEnd: 'shortly',
    };
  }

  // Weekday out of hours — next business day
  const tomorrowName = DAYS[(dayOfWeek + 1) % 7];
  return {
    state:       'outofhours',
    color:       'green',
    heading:     'Within one business day',
    body:        `Your enquiry came in outside office hours and will be picked up first thing ${tomorrowName} morning.`,
    bodyTextEnd: 'within one business day',
  };
}

function responseStatusHtml(status) {
  const isAmber = status.color === 'amber';
  const bg      = isAmber ? '#FAEEDA' : '#EAF3DE';
  const dot     = isAmber ? '#BA7517' : '#639922';
  const text    = isAmber ? '#854F0B' : '#3B6D11';
  return `
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;">
    <tr><td>
      <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8966E;">Expected response time</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border-radius:8px;">
        <tr><td style="padding:13px 16px;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:top;padding-top:3px;padding-right:10px;">
              <span style="display:block;width:8px;height:8px;border-radius:50%;background:${dot};"></span>
            </td>
            <td style="font-size:13px;color:${text};line-height:1.5;">
              <strong>${status.heading}</strong> \u2014 ${status.body}
            </td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>`;
}

async function sendGuestConfirmation(p) {
  const firstName = (p.full_name || '').split(' ')[0] || 'there';
  const siteUrl   = process.env.SITE_URL || 'https://www.studentluxe.co.uk';
  const isTypeA   = p.enquiry_type === 'A';
  const status    = getResponseStatus(p.submitted_at);

  // Build summary rows
  const rows = [
    isTypeA && p.apartment_ref && ['Apartment',            p.apartment_ref],
    !isTypeA && p.city         && ['City',                 formatCity(p.city)],
    p.apartment_type           && ['Apartment type',       formatAptType(p.apartment_type)],
    !isTypeA && p.budget       && ['Budget per week',      formatBudget(p.budget)],
    p.check_in                 && ['Check-in',             formatDate(p.check_in)],
    p.check_out                && ['Check-out',            formatDate(p.check_out)],
    nights(p)                  && ['Stay length',          nights(p) + ' nights'],
    !isTypeA && p.areas        && ['Areas of interest',    p.areas],
    p.response_methods         && ["We\u2019ll try to respond via", p.response_methods],
  ].filter(Boolean);

  const summaryRows = rows.map(([label, value]) => `
    <tr>
      <td style="padding:9px 0;font-size:12px;color:#6b6b6b;border-bottom:0.5px solid #ede9e3;width:50%;">${label}</td>
      <td style="padding:9px 0;font-size:12px;color:#1a1a1a;font-weight:500;border-bottom:0.5px solid #ede9e3;text-align:right;">${escHtml(String(value))}</td>
    </tr>`).join('');

  // Greeting body copy — adapts per enquiry type and response state
  // "A member of our Reservations team..." removed — covered by Expected Response Time section
  const bodyTypeA = isTypeA
    ? `Thank you for your enquiry about <strong>${escHtml(p.apartment_ref || 'your chosen apartment')}</strong> \u2014 we\u2019re checking the latest availability and pricing for your chosen dates.`
    : `Thank you for your <strong>${escHtml(formatCity(p.city) || '')}</strong> apartment enquiry \u2014 we\u2019re curating the best available options for your dates and budget.`;

  const FOOTER_BG = 'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/dc5adc8f-739b-4db0-8698-c08a6e6b85d3/luxury-student-apartments.jpg?content-type=image%2Fjpeg';
  const LOGO_WHITE = 'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/b4112f3c-4153-4544-b7bd-2c93282a68a2/Logo+White+website.png?content-type=image%2Fpng';
  const LOGO_HEADER = 'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/4d6b8086-53ed-4d17-b8f7-20f67be76f41/luxe-white.png?content-type=image%2Fpng';

  const _submittedDate = new Date(p.submitted_at || Date.now()).toLocaleString('en-GB',{day:'numeric',month:'long',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true,timeZone:'Europe/London'});
  // Format: "21 May 2026, 4:57 pm" → "on 21 May 2026 at 4:57 pm"
  const _dateParts = _submittedDate.match(/^(\d+ \w+ \d+),?\s+(.+)$/);
  const _dateFormatted = _dateParts ? `on ${_dateParts[1]} at ${_dateParts[2]}` : _submittedDate;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your enquiry with us \u2014 Student Luxe</title>
<style>
@media only screen and (max-width:600px){
  .sl-outer-wrap { padding:0 !important; }
  .sl-card { border-radius:0 !important; border-left:none !important; border-right:none !important; }
  .sl-body-cell { padding:22px 20px 0 !important; }
  .sl-tick-td { display:block !important; width:100% !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" class="sl-outer-wrap" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" class="sl-card" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">

  <!-- HEADER -->
  <tr><td style="background:#B8966E;padding:22px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle;">
        <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:24px;font-weight:400;color:#ffffff;letter-spacing:-0.02em;line-height:1.2;">Your enquiry with us.</p>
        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.7);">${_dateFormatted}</p>
      </td>
      <td style="text-align:right;vertical-align:middle;">
        <img src="${LOGO_HEADER}" alt="Student Luxe" style="height:40px;width:auto;display:block;margin-left:auto;">
      </td>
    </tr></table>
  </td></tr>

  <!-- BODY -->
  <tr><td class="sl-body-cell" style="background:#ffffff;padding:28px 32px 0;">

    <p style="margin:0 0 14px;font-size:14px;color:#1a1a1a;line-height:1.5;">Dear ${escHtml(firstName)},</p>
    <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.5;">${bodyTypeA}</p>

    ${responseStatusHtml(status)}

    <!-- DIVIDER -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:0.5px solid #ede9e3;padding-top:0;margin-top:22px;display:block;height:22px;"></td></tr></table>

    <!-- ABOUT -->
    <p style="margin:0 0 10px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8966E;">About Student Luxe</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f2eb;border-radius:10px;">
      <tr><td style="padding:18px 20px;">
        <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:15px;font-weight:400;color:#1a1a1a;letter-spacing:-0.01em;">Simply unpack and <em style="color:#B8966E;">start living.</em></p>
        <p style="margin:0 0 16px;font-size:12.5px;color:#6b6b6b;line-height:1.5;">All of our professionally-managed apartments are private, furnished, set up and ready to move in. All bills, Wi-Fi, housekeeping and resident support are included as standard. No guarantors or credit checks required.</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="50%" class="sl-tick-td" style="padding:4px 0;font-size:12px;color:#1a1a1a;vertical-align:middle;">
              <span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:14px;font-size:8px;color:#B8966E;margin-right:7px;vertical-align:middle;">&#10003;</span>Fully furnished &amp; equipped</td>
            <td width="50%" class="sl-tick-td" style="padding:4px 0;font-size:12px;color:#1a1a1a;vertical-align:middle;">
              <span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:14px;font-size:8px;color:#B8966E;margin-right:7px;vertical-align:middle;">&#10003;</span>Weekly housekeeping</td>
          </tr>
          <tr>
            <td width="50%" class="sl-tick-td" style="padding:4px 0;font-size:12px;color:#1a1a1a;vertical-align:middle;">
              <span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:14px;font-size:8px;color:#B8966E;margin-right:7px;vertical-align:middle;">&#10003;</span>All bills &amp; everything included</td>
            <td width="50%" class="sl-tick-td" style="padding:4px 0;font-size:12px;color:#1a1a1a;vertical-align:middle;">
              <span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:14px;font-size:8px;color:#B8966E;margin-right:7px;vertical-align:middle;">&#10003;</span>Flexible lengths of stay</td>
          </tr>
          <tr>
            <td width="50%" class="sl-tick-td" style="padding:4px 0;font-size:12px;color:#1a1a1a;vertical-align:middle;">
              <span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:14px;font-size:8px;color:#B8966E;margin-right:7px;vertical-align:middle;">&#10003;</span>Hotel-style amenities</td>
            <td width="50%" class="sl-tick-td" style="padding:4px 0;font-size:12px;color:#1a1a1a;vertical-align:middle;">
              <span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:14px;font-size:8px;color:#B8966E;margin-right:7px;vertical-align:middle;">&#10003;</span>Ongoing resident support</td>
          </tr>
        </table>
      </td></tr>
    </table>

    <!-- DIVIDER -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;"><tr><td style="border-top:0.5px solid #ede9e3;"></td></tr></table>

    <!-- SUMMARY -->
    <p style="margin:18px 0 10px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8966E;">What you've told us so far</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tbody>${summaryRows}</tbody>
    </table>

    ${p.message ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;">
      <tr><td style="background:#f7f2eb;border-left:3px solid #B8966E;padding:12px 16px;">
        <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#B8966E;">Your message</p>
        <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.7;font-style:italic;">"${escHtml(p.message)}"</p>
      </td></tr>
    </table>` : ''}

    <div style="height:28px;"></div>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background-image:url('${FOOTER_BG}');background-size:cover;background-position:center top;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(139,107,69,0.90);">
      <tr><td style="padding:28px 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;"><tr>
          <td style="vertical-align:top;">
            <img src="${LOGO_WHITE}" alt="Student Luxe" style="height:22px;width:auto;display:block;margin-bottom:12px;opacity:0.95;">
            <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.65);line-height:1.85;">Dog &amp; Duck Yard, Princeton St<br>London, WC1R 4BH<br>+44 (0)203 007 0017<br>Mon\u2013Fri, 10am\u20136pm GMT</p>
          </td>
          <td style="text-align:right;vertical-align:top;padding-top:34px;">
            <a href="${siteUrl}/services" style="display:block;font-size:11px;color:rgba(255,255,255,0.75);text-decoration:none;line-height:2.1;">What\u2019s included</a>
            <a href="${siteUrl}/our-reviews" style="display:block;font-size:11px;color:rgba(255,255,255,0.75);text-decoration:none;line-height:2.1;">Reviews</a>
            <a href="${siteUrl}/faqs" style="display:block;font-size:11px;color:rgba(255,255,255,0.75);text-decoration:none;line-height:2.1;">FAQs</a>
            <a href="${siteUrl}/meet-the-team" style="display:block;font-size:11px;color:rgba(255,255,255,0.75);text-decoration:none;line-height:2.1;">Meet the team</a>
          </td>
        </tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-top:0.5px solid rgba(255,255,255,0.2);padding-top:16px;margin-top:0;"><tr>
          <td><p style="margin:0;font-size:10px;color:rgba(255,255,255,0.4);line-height:1.6;">&copy; 2026 Student Luxe Apartments. All rights reserved.</p></td>
          <td style="text-align:right;"><p style="margin:0;font-size:10px;color:rgba(255,255,255,0.4);line-height:1.6;">If you didn\u2019t submit this enquiry, please disregard.</p></td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  if (!p.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) {
    console.warn('Guest confirmation skipped — invalid email:', p.email);
    return;
  }

  const cityLabel = formatCity(p.city) || '';
  return resendSend({
    from:    `${process.env.FROM_NAME || 'Student Luxe'} <${process.env.FROM_EMAIL}>`,
    to:      [p.email],
    subject: isTypeA
      ? `Your enquiry about ${escHtml(p.apartment_ref || 'your apartment')}`
      : `Your ${cityLabel} apartment enquiry`.trim(),
    html
  });
}
// ──────────────────────────────────────────────────────────────
//  EMAIL 2 — Team notification
// ──────────────────────────────────────────────────────────────
async function sendTeamNotification(p, mondayId, mondayError, duplicateOf, submitterIp, leadSource, leadChannel) {
  const isTypeA    = p.enquiry_type === 'A';
  const guestName  = p.full_name || 'New enquiry';
  const nightCount = nights(p);

  const submittedFormatted = p.submitted_at
    ? new Date(p.submitted_at).toLocaleString('en-GB', {
        day:'numeric', month:'long', year:'numeric',
        hour:'numeric', minute:'2-digit', hour12:true,
        timeZone:'Europe/London'
      }).replace(', ', ' — ')
    : new Date().toLocaleString('en-GB', {
        day:'numeric', month:'long', year:'numeric',
        hour:'numeric', minute:'2-digit', hour12:true,
        timeZone:'Europe/London'
      }).replace(', ', ' — ');

  const crmUrl = mondayId
    ? `https://studentluxe.monday.com/boards/${MONDAY_BOARD}/pulses/${mondayId}`
    : `https://studentluxe.monday.com/boards/${MONDAY_BOARD}/views/205648977`;

  const mondayErrorBanner = mondayError ? `
  <tr><td style="padding:0 28px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff3cd;border:1px solid #f0ad4e;border-radius:8px;">
      <tr><td style="padding:12px 16px;">
        <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#856404;">⚠️ Monday CRM push failed — add this lead manually</p>
        <p style="margin:0;font-size:11px;color:#856404;line-height:1.5;">Error: <code style="font-size:10px;background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px;">${escHtml(mondayError)}</code></p>
      </td></tr>
    </table>
  </td></tr>` : '';

  const dupBannerHtml = duplicateOf ? (function() {
    const originalFormatted = duplicateOf.created_at
      ? new Date(duplicateOf.created_at).toLocaleString('en-GB', {
          day:'numeric', month:'long', year:'numeric',
          hour:'numeric', minute:'2-digit', hour12:true,
          timeZone:'Europe/London'
        })
      : '—';

    const ipMatchTag = duplicateOf.ipMatch
      ? `<span style="display:inline-block;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;background:#f7f2eb;color:#9b7540;border:0.5px solid rgba(184,150,110,0.35);border-radius:3px;padding:1px 6px;margin-left:5px;vertical-align:middle;">match</span>`
      : '';

    const assigneePills = duplicateOf.assignees && duplicateOf.assignees.length > 0
      ? duplicateOf.assignees.map(name => {
          const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0,2);
          return `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#1a1a1a;margin-right:8px;"><span style="width:24px;height:24px;border-radius:50%;background:#B8966E;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:500;color:#fff;">${initials}</span>${escHtml(name)}</span>`;
        }).join('')
      : '<span style="font-size:12px;color:#9b9b9b;">Unassigned</span>';

    const compareRow = (label, origVal, newVal, isMatch) => {
      const matchTag = isMatch
        ? `<span style="display:inline-block;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;background:#f7f2eb;color:#9b7540;border:0.5px solid rgba(184,150,110,0.35);border-radius:3px;padding:1px 6px;margin-left:5px;vertical-align:middle;">match</span>`
        : '';
      return `<tr>
        <td style="padding:12px 16px;border-top:0.5px solid #e8e4de;border-right:0.5px solid #e8e4de;vertical-align:top;width:50%;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b9b9b;">${label}</p>
          <p style="margin:0;font-size:13px;color:#1a1a1a;font-weight:500;">${escHtml(origVal)}</p>
        </td>
        <td style="padding:12px 16px;border-top:0.5px solid #e8e4de;vertical-align:top;width:50%;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b9b9b;">${label}</p>
          <p style="margin:0;font-size:13px;font-weight:500;color:${isMatch ? '#B8966E' : '#1a1a1a'};">${escHtml(newVal)}${matchTag}</p>
        </td>
      </tr>`;
    };

    return `
  <tr><td style="background:#fffcf2;border-top:3px solid #e8c96b;padding:14px 32px;font-size:13px;color:#5a4310;line-height:1.65;">
    ⚠️ &nbsp;This lead is a possible duplicate. It's been added to the Leads Board with 'Possible Duplicate' tagged — and the salesperson assigned to the original lead has been automatically assigned to it.
  </td></tr>
  <tr><td style="background:#ffffff;padding:20px 32px 0;">
    <p style="margin:0 0 14px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8966E;">Original Lead vs. New Lead</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:0.5px solid #e8e4de;border-radius:10px;overflow:hidden;border-collapse:separate;border-spacing:0;margin-bottom:14px;">
      <tr>
        <td width="50%" style="padding:8px 16px;background:#f7f2eb;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b7540;border-bottom:0.5px solid #e8e4de;">Original Lead</td>
        <td width="50%" style="padding:8px 16px;background:#0d1a2e;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.6);border-bottom:0.5px solid #e8e4de;border-left:0.5px solid #e8e4de;">New Lead</td>
      </tr>
      ${compareRow('Name', duplicateOf.name, p.full_name || '', duplicateOf.name.toLowerCase().trim() === (p.full_name||'').toLowerCase().trim())}
      ${compareRow('Email', p.email||'', p.email||'', true)}
      ${compareRow('Lead created', originalFormatted, submittedFormatted, false)}
      <tr>
        <td style="padding:12px 16px;border-top:0.5px solid #e8e4de;border-right:0.5px solid #e8e4de;vertical-align:top;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b9b9b;">IP address</p>
          <p style="margin:0;font-size:13px;color:#1a1a1a;font-weight:500;">${escHtml(duplicateOf.originalIp || '—')}</p>
        </td>
        <td style="padding:12px 16px;border-top:0.5px solid #e8e4de;vertical-align:top;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b9b9b;">IP address</p>
          <p style="margin:0;font-size:13px;font-weight:500;color:${duplicateOf.ipMatch ? '#B8966E' : '#1a1a1a'};">${escHtml(submitterIp||'—')}${ipMatchTag}</p>
        </td>
      </tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:0.5px solid #e8e4de;border-radius:10px;padding:12px 16px;margin-bottom:20px;">
      <tr>
        <td style="font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b9b9b;vertical-align:middle;width:160px;">Original lead assigned to</td>
        <td style="vertical-align:middle;">${assigneePills}</td>
      </tr>
    </table>
  </td></tr>`;
  })() : '';

  const field = (label, value) => value ? `
    <td style="padding:0 20px 14px 0;vertical-align:top;width:50%;">
      <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.1em;color:#9b9b9b;text-transform:uppercase;">${label}</p>
      <p style="margin:0;font-size:13px;color:#1a1a1a;font-weight:500;">${escHtml(String(value))}</p>
    </td>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>New enquiry — ${escHtml(guestName)}</title>
<style>
@media only screen and (max-width:600px){
  .sl-t-outer { padding:0 !important; }
  .sl-t-card { border-radius:0 !important; border-left:none !important; border-right:none !important; }
  .sl-t-body { padding:16px 20px 0 !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" class="sl-t-outer" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" class="sl-t-card" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">
  <tr><td style="background:#B8966E;padding:22px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle;">
        <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:22px;font-weight:400;color:#ffffff;letter-spacing:-0.02em;line-height:1.2;">${escHtml(guestName)}</p>
        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.75);">${submittedFormatted}</p>
      </td>
      <td style="text-align:right;vertical-align:middle;">
        <img src="https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/4d6b8086-53ed-4d17-b8f7-20f67be76f41/luxe-white.png?content-type=image%2Fpng" alt="Student Luxe" style="height:44px;width:auto;display:block;margin-left:auto;">
      </td>
    </tr></table>
  </td></tr>
  ${mondayErrorBanner}
  ${dupBannerHtml}
  <tr><td class="sl-t-body" style="background:#ffffff;padding:20px 32px 0;">
    <p style="margin:0 0 10px;"><span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:500;letter-spacing:0.06em;background:${isTypeA ? 'rgba(29,158,117,0.12)' : 'rgba(184,150,110,0.12)'};color:${isTypeA ? '#0F6E56' : '#8a6540'};border:0.5px solid ${isTypeA ? 'rgba(29,158,117,0.4)' : 'rgba(184,150,110,0.4)'};">${isTypeA ? 'Check apartment availability' : 'Send guest options'}</span></p>
    <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.75;">${isTypeA
      ? `${escHtml(p.apartment_ref || '')}${p.apartment_type ? ' — ' + formatAptType(p.apartment_type) : ''}${nightCount ? ' &nbsp;·&nbsp; ' + nightCount + ' nights' : ''}${p.check_in ? ' &nbsp;·&nbsp; ' + formatDate(p.check_in) + ' → ' + formatDate(p.check_out) : ''}`
      : `${formatCity(p.city) || ''}${p.apartment_type ? ' — ' + formatAptType(p.apartment_type) : ''}${nightCount ? ' &nbsp;·&nbsp; ' + nightCount + ' nights' : ''}${p.check_in ? ' &nbsp;·&nbsp; ' + formatDate(p.check_in) + ' → ' + formatDate(p.check_out) : ''}${p.budget && p.enquiry_type !== 'A' ? ' &nbsp;·&nbsp; ' + formatBudget(p.budget) + '/wk' : ''}`
    }</p>
  </td></tr>
  <tr><td style="background:#ffffff;padding:0 32px;"><hr style="border:none;border-top:0.5px solid #ede9e3;margin:18px 0;"></td></tr>
  <tr><td style="background:#ffffff;padding:0 32px 18px;">
    <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Contact</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>${field('Name', p.full_name)}${field('Email', p.email)}</tr>
      <tr>${field('Phone', p.phone)}${field('Respond via', p.response_methods)}</tr>
      <tr>${field('Timezone', p.timezone || '—')}</tr>
    </table>
  </td></tr>
  <tr><td style="background:#ffffff;padding:0 32px 18px;">
    <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Stay details</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${isTypeA
        ? `<tr>${field('Apartment', p.apartment_ref)}${field('Apartment type', formatAptType(p.apartment_type))}</tr>`
        : `<tr>${field('City', formatCity(p.city))}${field('Apartment type', formatAptType(p.apartment_type))}</tr>`}
      <tr>${field('Check-in', formatDate(p.check_in))}${field('Check-out', formatDate(p.check_out))}</tr>
      <tr>${field('Nights', nightCount)}${field('Budget / week', p.enquiry_type !== 'A' ? formatBudget(p.budget) : '')}</tr>
      <tr>${field('Areas', p.areas)}${field('Type of stay', formatStayType(p.stay_type, p.university))}</tr>
      <tr>${field('Country of residence', p.nationality)}${field('Lived in city before', p.lived_before)}</tr>
    </table>
  </td></tr>
  ${p.message ? `
  <tr><td style="background:#ffffff;padding:0 32px 18px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="background:#f7f2eb;border-left:3px solid #B8966E;border-radius:0 8px 8px 0;padding:12px 16px;">
        <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#B8966E;">Message from guest</p>
        <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.7;font-style:italic;">"${escHtml(p.message)}"</p>
      </td></tr>
    </table>
  </td></tr>` : ''}
  <tr><td style="background:#ffffff;padding:0 32px 24px;">
    <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Tracking</p>
    <table cellpadding="0" cellspacing="0" style="background:#f7f2eb;border-radius:8px;padding:10px 16px;width:100%;">
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;width:160px;">Lead Source (Where)</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(leadSource||'—')}</td></tr>
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;">Lead Source (How)</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(leadChannel||'—')}</td></tr>
    </table>
  </td></tr>
  <tr><td style="background:#f7f2eb;padding:16px 32px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:8px;"><a href="mailto:${p.email}" style="display:inline-block;padding:10px 20px;background:#B8966E;border-radius:8px;font-size:12px;font-weight:500;color:#ffffff;text-decoration:none;">Reply by email</a></td>
      <td style="padding-right:8px;"><a href="${crmUrl}" style="display:inline-block;padding:10px 20px;background:#ffffff;border:0.5px solid rgba(184,150,110,0.4);border-radius:8px;font-size:12px;font-weight:500;color:#1a1a1a;text-decoration:none;">View on Leads Board</a></td>
      ${isTypeA && p.apartment_ref ? `<td><a href="https://studentluxe.monday.com/boards/2388987554/views/87174774?term=${encodeURIComponent(p.apartment_ref)}" style="display:inline-block;padding:10px 20px;background:#ffffff;border:0.5px solid rgba(184,150,110,0.4);border-radius:8px;font-size:12px;font-weight:500;color:#1a1a1a;text-decoration:none;">View on Property Board</a></td>` : ''}
    </tr></table>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return resendSend({
    from:    `${process.env.FROM_NAME || 'Student Luxe'} <${process.env.FROM_EMAIL}>`,
    to:      [process.env.TEAM_EMAIL, process.env.TEAM_EMAIL_2].filter(Boolean),
    replyTo: p.email,
    subject: isTypeA
      ? `New Guest Enquiry — ${p.apartment_ref || 'Specific Apartment'}${nightCount ? ', ' + nightCount + ' Nights' : ''}`
      : `New Guest Enquiry — ${formatCity(p.city) || 'Unknown City'}${nightCount ? ', ' + nightCount + ' Nights' : ''}`,
    html
  });
}

// ──────────────────────────────────────────────────────────────
//  LEAD SOURCE
// ──────────────────────────────────────────────────────────────
function computeLeadSource(p) {
  const hasGclid     = !!p.gclid;
  const hasFbclid    = !!p.fbclid;
  const hasCampaign  = !!(p.utm_campaign || '').trim();
  const hasKeyword   = !!(p.utm_term || '').trim();
  const visitedPaths = (p.visited_paths || '').trim();
  const isDirect     = visitedPaths.startsWith('Direct');
  const isGoogleOrg  = visitedPaths.startsWith('Google Organic');
  const hasVisited   = !!(p.visited_paths || p.landing_page);

  // UTM-based social detection — must come before hasPpcSignal
  const utmSource = (p.utm_source || '').toLowerCase().trim();
  const utmMedium = (p.utm_medium || '').toLowerCase().trim();
  const SOCIAL_SOURCES = ['ig','instagram','facebook','fb','meta','tiktok','linkedin','twitter','x'];
  const SOCIAL_MEDIUMS = ['social','social-media','social_media','paid-social','paid_social','paidsocial'];
  const isUtmSocial = SOCIAL_SOURCES.includes(utmSource) || SOCIAL_MEDIUMS.includes(utmMedium);

  // Bing detection
  const hasMsclkid     = utmSource.includes('bing') && utmMedium.includes('cpc');
  const isBingOrg      = utmSource.includes('bing') && !utmMedium.includes('cpc');
  const visitedHasBing = (p.visited_paths || '').toLowerCase().includes('bing');

  const hasPpcSignal = (hasGclid || hasCampaign || hasKeyword) && !isUtmSocial;

  // Map UTM source to a specific channel label
  function utmSourceToChannel(src) {
    if (['ig','instagram'].includes(src))           return 'Instagram';
    if (['facebook','fb','meta'].includes(src))     return 'Meta Advert';
    if (['tiktok'].includes(src))                   return 'TikTok';
    if (['linkedin'].includes(src))                 return 'From a Friend';
    if (['twitter','x'].includes(src))              return 'Twitter / X';
    return 'Instagram'; // default for generic social medium
  }

  function extractChannel(referrer) {
    if(!referrer) return '';
    try {
      const host = new URL(referrer).hostname.replace('www.', '').replace('search.', '');
      const domainMap = {
        'google.com':'Google Advert','google.co.uk':'Google Advert',
        'bing.com':'Bing','yahoo.com':'Yahoo','duckduckgo.com':'DuckDuckGo',
        'instagram.com':'Instagram','facebook.com':'Meta Advert','meta.com':'Meta Advert',
        'linkedin.com':'From a Friend','tiktok.com':'TikTok',
        'studentluxe.co.uk':'Unknown'
      };
      return domainMap[host] || 'Unknown';
    } catch(e) { return 'Unknown'; }
  }

  let leadSource  = '';
  let leadChannel = '';
  if (hasMsclkid)                       { leadSource = 'PPC';      leadChannel = 'Bing Advert'; }
  else if (isBingOrg || visitedHasBing) { leadSource = 'SEO';      leadChannel = 'Bing'; }
  else if (hasPpcSignal)                { leadSource = 'PPC';      leadChannel = 'Google Advert'; }
  else if (hasFbclid)                   { leadSource = 'Socials';  leadChannel = extractChannel(p.referrer) || 'Instagram'; }
  else if (isUtmSocial)                 { leadSource = 'Socials';  leadChannel = utmSourceToChannel(utmSource); }
  else if (isDirect)                    { leadSource = 'Referral'; leadChannel = 'Direct'; }
  else if (isGoogleOrg)                 { leadSource = 'SEO';      leadChannel = 'Google Search (organic)'; }
  else if (hasVisited)                  { leadSource = 'SEO';      leadChannel = extractChannel(p.referrer); }

  return { leadSource, leadChannel };
}

// ──────────────────────────────────────────────────────────────
//  MONDAY
// ──────────────────────────────────────────────────────────────
function currencyForCity(city, otherCity) {
  const GBP = ['london','edinburgh','glasgow','manchester','cambridge','durham','bristol','birmingham','brighton','liverpool','nottingham'];
  const EUR = ['dublin','paris','milan','amsterdam','rome','florence','helsinki','barcelona','madrid','lisbon','porto','valencia'];
  const USD = ['new-york','boston','chicago','washington','philadelphia'];
  const c = (city || '').toLowerCase().trim();
  if (GBP.includes(c)) return '£';
  if (EUR.includes(c)) return '€';
  if (USD.includes(c)) return '$';
  if (c === 'other' && otherCity) {
    const o = otherCity.toLowerCase();
    const currencyKeywords = {
      '£':['uk','united kingdom','england','scotland','wales','london','manchester','birmingham','edinburgh'],
      '€':['france','paris','germany','berlin','spain','madrid','barcelona','italy','rome','milan','netherlands','amsterdam','portugal','lisbon'],
      '$':['usa','united states','america','new york','los angeles','chicago','boston','washington'],
    };
    for (const [symbol, keywords] of Object.entries(currencyKeywords)) {
      if (keywords.some(k => o.includes(k))) return symbol;
    }
  }
  return '';
}

const CAMPAIGN_MAP = {
  '23593406109':'jf17_search_generic_os_tablet_phrase_in_row_destination_london','23676288424':'jf14_search_generic_os_tablet_broad_in_us_destination_london - £150 tCPA Test','23671659281':'jf3_search_generic_os_desktop_broad_in_us_destination_london - £150 tCPA Test','23598174873':'jf19_search_brand_global_exact','21918787893':'rentals-short-stay-os','23512016561':'cambridge-os','20356089756':'london-student-os','23603515408':'jf10_search_generic_os_mobile_exact_in_us_destination_london','23593407051':'jf9_search_generic_os_mobile_exact_in_row_destination_london','22561087901':'core-luxe-perf-max','23392672745':'new-york-os','21429830124':'lse-summer-uni-campus','23676301570':'jf9_search_generic_os_mobile_exact_in_row_destination_london - £150 tCPA Test','21973944922':'core-luxe-os','23671673024':'jf4_search_generic_os_desktop_exact_in_row_destination_london - £150 tCPA Test','23593406838':'jf12_search_generic_os_mobile_phrase_in_us_destination_london','23666278518':'jf13_search_generic_os_tablet_broad_in_row_destination_london - £150 tCPA Test','21902352633':'lse-summer-all-us','21499603565':'paris-os','23676319627':'jf15_search_generic_os_tablet_exact_in_row_destination_london - £150 tCPA Test','23593627429':'jf16_search_generic_os_tablet_exact_in_us_destination_london','23452513132':'lse-summer-perf-max','23642461894':'paris-os-exp','23666244384':'jf8_search_generic_os_mobile_broad_in_us_destination_london - £150 tCPA Test','23666254497':'jf5_search_generic_os_desktop_exact_in_us_destination_london - £150 tCPA Test','22082273952':'rentals-os','22120262100':'hnwi-pb-zip-os','23588980553':'jf3_search_generic_os_desktop_broad_in_us_destination_london','23671661003':'jf6_search_generic_os_desktop_phrase_in_us_destination_london - £150 tCPA Test','23593627561':'jf18_search_generic_os_tablet_phrase_in_us_destination_london','23676326599':'jf17_search_generic_os_tablet_phrase_in_row_destination_london - £150 tCPA Test','23588981654':'jf14_search_generic_os_tablet_broad_in_us_destination_london','23671688303':'jf18_search_generic_os_tablet_phrase_in_us_destination_london - £150 tCPA Test','23666271564':'jf10_search_generic_os_mobile_exact_in_us_destination_london - £150 tCPA Test','23593406301':'jf7_search_generic_os_mobile_broad_in_row_destination_london','23598893477':'jf2_search_generic_os_desktop_broad_in_row_destination_london','23676311422':'jf2_search_generic_os_desktop_broad_in_row_destination_london - £150 tCPA Test','23666273505':'jf12_search_generic_os_mobile_phrase_in_us_destination_london - £150 tCPA Test','23666255946':'jf11_search_generic_os_mobile_phrase_in_row_destination_london - £150 tCPA Test','23603514478':'jf13_search_generic_os_tablet_broad_in_row_destination_london','23598893927':'jf11_search_generic_os_mobile_phrase_in_row_destination_london','23598893684':'jf1_search_generic_os_desktop_phrase_in_row_destination_london','23642456119':'lse-summer-all-us-exp','23593406142':'jf15_search_generic_os_tablet_exact_in_row_destination_london','23671689740':'jf16_search_generic_os_tablet_exact_in_us_destination_london - £150 tCPA Test','23593406559':'jf8_search_generic_os_mobile_broad_in_us_destination_london',
};

function resolveCampaign(val) {
  if (!val) return '';
  const trimmed = val.trim();
  return /^\d+$/.test(trimmed) ? (CAMPAIGN_MAP[trimmed] || trimmed) : trimmed;
}

function extractCampaignFromPaths(visitedPaths) {
  if (!visitedPaths) return '';
  try {
    const segments = visitedPaths.split('👉');
    for (const seg of segments) {
      const match = seg.match(/utm_campaign=([^&\s]+)/);
      if (match && match[1]) return match[1].trim();
    }
  } catch(e) {}
  return '';
}

function bestCampaign(p) {
  const fromCookie = (p.utm_campaign || '').trim();
  const fromPaths  = extractCampaignFromPaths(p.visited_paths);
  if (fromCookie) {
    const resolved = resolveCampaign(fromCookie);
    if (!/^\d+$/.test(fromCookie) || CAMPAIGN_MAP[fromCookie]) return resolved;
  }
  if (fromPaths) return resolveCampaign(fromPaths);
  return resolveCampaign(fromCookie);
}

async function pushToMonday(p, submitterIp, duplicateOf) {
  const nameParts = (p.full_name || '').trim().split(' ');
  const firstname = nameParts[0] || '';
  const lastname  = nameParts.slice(1).join(' ') || '';
  const itemName  = p.full_name || 'New Enquiry';

  const { leadSource, leadChannel } = computeLeadSource(p);

  const columnValues = {
    text37:           firstname,
    text60:           lastname,
    email:            p.email ? { email: p.email, text: p.email } : {},
    phone_1: p.phone ? (function(){
      const raw = p.phone.replace(/[\s\-().]/g, '');
      const dialMap = {'+44':'GB','+1':'US','+33':'FR','+49':'DE','+39':'IT','+34':'ES','+351':'PT','+31':'NL','+32':'BE','+41':'CH','+43':'AT','+46':'SE','+47':'NO','+45':'DK','+358':'FI','+48':'PL','+420':'CZ','+36':'HU','+40':'RO','+380':'UA','+7':'RU','+86':'CN','+81':'JP','+82':'KR','+91':'IN','+61':'AU','+64':'NZ','+27':'ZA','+55':'BR','+52':'MX','+971':'AE','+966':'SA','+974':'QA','+852':'HK','+65':'SG','+60':'MY','+66':'TH','+62':'ID'};
      let countryShortName = 'GB';
      for (const [prefix, code] of Object.entries(dialMap)) {
        if (raw.startsWith(prefix)) { countryShortName = code; break; }
      }
      return { phone: raw, countryShortName };
    })() : {},
    date47:            p.check_in  ? { date: p.check_in  } : {},
    date_1:            p.check_out ? { date: p.check_out } : {},
    budget_per_week:   p.budget ? formatBudget(p.budget) : '',
    text8:             p.city === 'other' ? (p.other_city || '') : (formatCity(p.city) || ''),
    dropdown6:         p.apartment_ref     || '',
    apt_type_mkmn4bgg: formatAptType(p.apartment_type) || '',
    dropdown19:        p.areas || '',
    dropdown40: p.response_methods ? {
      labels: p.response_methods.split(',').map(s => {
        const v = s.trim().toLowerCase();
        if(v === 'phone')    return 'Phone Call (preferred option)';
        if(v === 'whatsapp') return 'WhatsApp (preferred option)';
        if(v === 'email')    return 'Email';
        return s.trim();
      })
    } : {},
    color_mktcnwyb: p.stay_type ? { label: {
      'student':'Student','parent':'Parent or guardian (on behalf of student)',
      'working-professional':'Working professional','corporate':'Corporate',
      'medical':'Medical','tourism':'Tourism','agent':'Agent (on behalf of client)'
    }[p.stay_type] || p.stay_type } : {},
    text_mknfnmsb: p.university  || '',
    text9__1:      p.nationality || '',
    long_text7:    p.message     || '',
    text_mm1c3b5w: bestCampaign(p),
    text43__1:     p.utm_adgroup   || '',
    text3__1:      p.utm_term      || '',
    text_mm1d87rp: p.utm_matchtype || '',
    text4__1:      p.gclid || p.fbclid || '',
    text_mm1jhhe7: p.landing_page  || '',
    long_text__1:  p.visited_paths || '',
    text_mm2y2ah2: submitterIp     || '',
    ...(duplicateOf && { color_mknqvzde: { label: 'Possible Duplicate' } }),
    ...(duplicateOf?.assigneeIds?.length > 0 && {
      people_1: { personsAndTeams: duplicateOf.assigneeIds.map(id => ({ id, kind: 'person' })) }
    }),
    ...(leadSource  && { color_mkxk8y67: { label: leadSource } }),
    ...(leadChannel && leadChannel !== 'Unknown' && { dropdown_mkxkfbff: { labels: [leadChannel] } }),
    dropdown_mm1v31yb: { labels: ['/Reservations Form'] },
    ...(p.city && currencyForCity(p.city, p.other_city) && { status0__1: { label: currencyForCity(p.city, p.other_city) } }),
  };

  const mutation = `
    mutation {
      create_item(
        board_id: ${MONDAY_BOARD},
        item_name: ${JSON.stringify(itemName)},
        column_values: ${JSON.stringify(JSON.stringify(columnValues))}
      ) { id }
    }
  `;

  const response = await fetch(MONDAY_API, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
    body: JSON.stringify({ query: mutation })
  });

  const data = await response.json();
  if (!response.ok) throw new Error('Monday HTTP ' + response.status);
  if (data.errors) {
    console.error('Monday API errors:', JSON.stringify(data.errors, null, 2));
    throw new Error('Monday API error: ' + JSON.stringify(data.errors));
  }
  return data?.data?.create_item?.id;
}

// ──────────────────────────────────────────────────────────────
//  RESEND
// ──────────────────────────────────────────────────────────────
async function resendSend(payload) {
  const res = await fetch(RESEND_API, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Resend error ${res.status}: ${err}`); }
  return res.json();
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); } catch { return d; }
}
function nights(p) {
  if (!p.check_in || !p.check_out) return null;
  const n = Math.round((new Date(p.check_out) - new Date(p.check_in)) / 86400000);
  return n > 0 ? n : null;
}
function formatCity(city) {
  if (!city) return '';
  const map = {'london':'London','new-york':'New York','paris':'Paris','edinburgh':'Edinburgh','glasgow':'Glasgow','manchester':'Manchester','cambridge':'Cambridge','durham':'Durham','bristol':'Bristol','barcelona':'Barcelona','madrid':'Madrid','lisbon':'Lisbon','boston':'Boston','chicago':'Chicago','washington':'Washington DC','amsterdam':'Amsterdam','milan':'Milan','rome':'Rome','florence':'Florence','helsinki':'Helsinki','porto':'Porto','valencia':'Valencia','birmingham':'Birmingham','brighton':'Brighton','liverpool':'Liverpool','nottingham':'Nottingham','dublin':'Dublin','philadelphia':'Philadelphia'};
  return map[city] || city;
}
function formatAptType(t) {
  if (!t) return '';
  const map = {'studio':'Studio','1bed':'1 bedroom','2bed':'2 bedroom','3bed':'3 bedroom','penthouse':'Penthouse','flexible':'Flexible'};
  return map[t] || t;
}
function formatBudget(b) {
  if (!b) return '';
  const map = {'under-650':'Under £650','650-1000':'£650 – £1,000','1000-2000':'£1,000 – £2,000','2000-4000':'£2,000 – £4,000','5000+':'£5,000+','under-550':'Under £550','550-900':'£550 – £900','900-1350':'£900 – £1,350','1350-2000':'£1,350 – £2,000','2000+':'£2,000+','850-1200':'£850 – £1,200','1200-2000':'£1,200 – £2,000','2000-3500':'£2,000 – £3,500','3500-5000':'£3,500 – £5,000','under-1250':'Under £1,250','1250-1800':'£1,250 – £1,800','1800-2500':'£1,800 – £2,500','2500-4000':'£2,500 – £4,000'};
  return map[b] || b;
}
function formatStayType(type, university) {
  if (!type) return '';
  const map = {'student':'Student','parent':'Parent or guardian (on behalf of student)','working-professional':'Working professional','corporate':'Corporate','medical':'Medical','tourism':'Tourism','agent':'Agent (on behalf of client)'};
  const label = map[type] || type;
  return university ? `${label} · ${university}` : label;
}
