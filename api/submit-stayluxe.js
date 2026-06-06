// ============================================================
//  Stay Luxe — Enquiry Submit + Email Handler
//  Deploy to: /api/submit-stayluxe.js in your Vercel project
//
//  Environment variables required (set in Vercel dashboard):
//    RESEND_API_KEY      = re_KKJUoUXw_NDrM1CQmCFyJfCSWjeLdNWqQ
//    TEAM_EMAIL          = reservations@studentluxe.co.uk
//    TEAM_EMAIL_2        = alex@studentluxe.co.uk
//    FROM_EMAIL          = reservations@studentluxe.co.uk
//    FROM_NAME           = Student Luxe Apartments
//    SITE_URL            = https://www.studentluxe.co.uk
//    MONDAY_API_KEY      = (your Monday API key from monday.com/developers)
// ============================================================

const RESEND_API  = 'https://api.resend.com/emails';
const MONDAY_API  = 'https://api.monday.com/v2';
const MONDAY_BOARD = 2171015719;

// ──────────────────────────────────────────────────────────────
//  STAY LUXE BRAND CONFIG  (edit here only)
// ──────────────────────────────────────────────────────────────
// White Stay Luxe logo — used in both email header and footer.
const STAY_LUXE_LOGO = 'https://images.squarespace-cdn.com/content/v1/67694b623332340e0efb92c0/2a827f07-2c9e-4399-ae78-b9193371abe1/stayluxewhite.png?format=750w';

// Dark header/footer band. Solid colour is the Outlook fallback;
// the gradient renders in Apple Mail, Gmail and most modern clients.
const DARK_BG       = '#1a1a1a';
const DARK_GRADIENT = 'linear-gradient(135deg,#1a1a1a 0%,#333333 100%)';

// Public Stay Luxe site (used in the team-notification NB line).
const STAY_LUXE_URL = 'https://www.stayluxe.co.uk/';

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const p = req.body;

  // Push to Monday first so we get the pulse ID for the team email link
  let mondayId = null;
  let mondayError = null;
  try {
    mondayId = await pushToMonday(p);
    console.log('Monday OK — pulse ID:', mondayId);
  } catch(err) {
    mondayError = err.message || 'Unknown error';
    console.error('Monday failed:', mondayError);
  }

  // Fire both emails in parallel, passing the pulse ID and any error to the team email
  const results = await Promise.allSettled([
    sendGuestConfirmation(p),
    sendTeamNotification(p, mondayId, mondayError)
  ]);

  results.forEach((r, i) => {
    const label = ['Guest email', 'Team email'][i];
    if(r.status === 'rejected') console.error(`${label} failed:`, r.reason?.message || r.reason);
    else console.log(`${label} OK`);
  });

  return res.status(200).json({ success: true });
}

// ──────────────────────────────────────────────────────────────
//  RESPONSE TIME LOGIC  (drives the "Expected response time" box)
// ──────────────────────────────────────────────────────────────
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

  const now = submittedAt ? new Date(submittedAt) : new Date();
  const ukStr = now.toLocaleString('en-GB', { timeZone: 'Europe/London',
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12: false });
  const [datePart, timePart] = ukStr.split(', ');
  const [dd, mm, yyyy] = datePart.split('/').map(Number);
  const [hh, mi]       = timePart.split(':').map(Number);
  const dayOfWeek      = new Date(yyyy, mm - 1, dd).getDay(); // 0=Sun,6=Sat
  const minuteOfDay    = hh * 60 + mi;
  const inOffice       = minuteOfDay >= 10 * 60 && minuteOfDay < 18 * 60; // 10am–6pm

  const todayStr = `${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;

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

  if (inOffice) {
    return {
      state:       'inoffice',
      color:       'green',
      heading:     'Same day, or within one business day',
      body:        'Our team are in the office and will be in touch shortly.',
      bodyTextEnd: 'shortly',
    };
  }

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

// ──────────────────────────────────────────────────────────────
//  EMAIL 1 — Guest confirmation  (Stay Luxe)
//  Design ported from the Student Luxe "Your enquiry with us" email.
//  Stay Luxe tweaks: dark header/footer, Stay Luxe logo, no footer
//  nav, two-brand About section, updated copyright.
// ──────────────────────────────────────────────────────────────
async function sendGuestConfirmation(p) {
  const firstName = (p.full_name || '').split(' ')[0] || 'there';
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

  // Greeting body copy — adapts per enquiry type
  const bodyTypeA = isTypeA
    ? `Thank you for your enquiry about <strong>${escHtml(p.apartment_ref || 'your chosen apartment')}</strong> \u2014 we\u2019re checking the latest availability and pricing for your chosen dates.`
    : `Thank you for your <strong>${escHtml(formatCity(p.city) || '')}</strong> apartment enquiry \u2014 we\u2019re curating the best available options for your dates and budget.`;

  const _submittedDate = new Date(p.submitted_at || Date.now()).toLocaleString('en-GB',{day:'numeric',month:'long',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true,timeZone:'Europe/London'});
  const _dateParts = _submittedDate.match(/^(\d+ \w+ \d+),?\s+(.+)$/);
  const _dateFormatted = _dateParts ? `on ${_dateParts[1]} at ${_dateParts[2]}` : _submittedDate;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your enquiry with us \u2014 Stay Luxe</title>
<style>
@media only screen and (max-width:600px){
  .sl-outer-wrap { padding:0 !important; }
  .sl-card { border-radius:0 !important; border-left:none !important; border-right:none !important; }
  .sl-body-cell { padding:22px 20px 0 !important; }
  .sl-tick-td { display:block !important; width:100% !important; }
  .sl-h-text, .sl-h-logo { display:block !important; width:100% !important; text-align:center !important; }
  .sl-h-logo { padding:0 0 14px !important; }
  .sl-h-logo-img { margin:0 auto !important; height:28px !important; }
  .sl-f-logo { margin-left:-27px !important; margin-bottom:28px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" class="sl-outer-wrap" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" class="sl-card" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">

  <!-- HEADER -->
  <tr><td style="background:${DARK_BG};background-image:${DARK_GRADIENT};padding:22px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" dir="rtl"><tr>
      <td class="sl-h-logo" dir="ltr" style="text-align:right;vertical-align:middle;">
        <img class="sl-h-logo-img" src="${STAY_LUXE_LOGO}" alt="Stay Luxe" style="height:30px;width:auto;display:block;margin-left:auto;">
      </td>
      <td class="sl-h-text" dir="ltr" style="vertical-align:middle;text-align:left;">
        <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:24px;font-weight:400;color:#ffffff;letter-spacing:-0.02em;line-height:1.2;">Your enquiry with us.</p>
        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.7);">${_dateFormatted}</p>
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
    <p style="margin:0 0 10px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8966E;">About us: Stay Luxe &amp; Student Luxe</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f2eb;border-radius:10px;">
      <tr><td style="padding:18px 20px;">
        <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:15px;font-weight:400;color:#1a1a1a;letter-spacing:-0.01em;">Two brands, <em style="color:#B8966E;">one philosophy.</em></p>
        <p style="margin:0 0 16px;font-size:12.5px;color:#6b6b6b;line-height:1.5;">We began in 2019, offering superior stays for students, and have since extended into luxury serviced apartments for discerning guests. Trusted by high-net-worth families for our comfort, flexibility and five-star service.</p>
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
  <tr><td style="background:${DARK_BG};background-image:${DARK_GRADIENT};padding:28px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr>
      <td style="vertical-align:top;">
        <img class="sl-f-logo" src="${STAY_LUXE_LOGO}" alt="Stay Luxe" style="height:24px;width:auto;display:block;margin:0 0 20px -14px;opacity:0.95;">
        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.6);line-height:1.85;">Dog &amp; Duck Yard, Princeton St<br>London, WC1R 4BH<br>+44 (0)203 007 0017<br>Mon\u2013Fri, 10am\u20136pm GMT</p>
      </td>
    </tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:0.5px solid rgba(255,255,255,0.18);padding-top:16px;"><tr>
      <td><p style="margin:0;font-size:10px;color:rgba(255,255,255,0.5);line-height:1.6;">&copy; 2026 Stay Luxe - a trading name of <a href="https://www.studentluxe.co.uk/" style="color:#D4B896;text-decoration:underline;">Student Luxe</a>. All rights reserved.</p></td>
      <td style="text-align:right;"><p style="margin:0;font-size:10px;color:rgba(255,255,255,0.5);line-height:1.6;">If you didn\u2019t submit this enquiry, please disregard.</p></td>
    </tr></table>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  // Guard — skip if email missing or malformed
  if(!p.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)){
    console.warn('Guest confirmation skipped — invalid email:', p.email);
    return;
  }

  return resendSend({
    from:    `${process.env.FROM_NAME || 'Student Luxe'} <${process.env.FROM_EMAIL}>`,
    to:      [p.email],
    subject: isTypeA
      ? `Your Stay Luxe enquiry about ${p.apartment_ref || 'your apartment'}`
      : `Your ${formatCity(p.city) || ''} apartment enquiry — Stay Luxe`.trim(),
    html
  });
}

// ──────────────────────────────────────────────────────────────
//  EMAIL 2 — Team notification  (Stay Luxe)
//  Tweaks: dark header + footer band, plus the "not a student" NB
//  notice above the status pill.
// ──────────────────────────────────────────────────────────────
async function sendTeamNotification(p, mondayId, mondayError) {
  const isTypeA   = p.enquiry_type === 'A';
  const guestName = p.full_name || 'New enquiry';
  const nightCount = nights(p);

  // Format submitted time as "2 April 2026 — 2:45pm"
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

  // Monday CRM link — direct to pulse if we have the ID, otherwise leads board
  const crmUrl = mondayId
    ? `https://studentluxe.monday.com/boards/${MONDAY_BOARD}/pulses/${mondayId}`
    : `https://studentluxe.monday.com/boards/${MONDAY_BOARD}/views/205648977`;

  // Monday error banner — shown when push failed
  const mondayErrorBanner = mondayError ? `
  <tr><td style="padding:0 28px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff3cd;border:1px solid #f0ad4e;border-radius:8px;">
      <tr><td style="padding:12px 16px;">
        <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#856404;">⚠️ Monday CRM push failed — add this lead manually</p>
        <p style="margin:0;font-size:11px;color:#856404;line-height:1.5;">This enquiry was <strong>not</strong> saved to the Leads board automatically. Please add it manually. Error: <code style="font-size:10px;background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px;">${escHtml(mondayError)}</code></p>
      </td></tr>
    </table>
  </td></tr>` : '';

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
  .sl-h-text, .sl-h-logo { display:block !important; width:100% !important; text-align:center !important; }
  .sl-h-logo { padding:0 0 14px !important; }
  .sl-h-logo-img { margin:0 auto !important; height:28px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">

  <!-- HEADER -->
  <tr><td style="background:${DARK_BG};background-image:${DARK_GRADIENT};padding:22px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" dir="rtl"><tr>
      <td class="sl-h-logo" dir="ltr" style="text-align:right;vertical-align:middle;">
        <img class="sl-h-logo-img" src="${STAY_LUXE_LOGO}" alt="Stay Luxe" style="height:30px;width:auto;display:block;margin-left:auto;">
      </td>
      <td class="sl-h-text" dir="ltr" style="vertical-align:middle;text-align:left;">
        <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:22px;font-weight:400;color:#ffffff;letter-spacing:-0.02em;line-height:1.2;">${escHtml(guestName)}</p>
        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.75);">${submittedFormatted}</p>
      </td>
    </tr></table>
  </td></tr>

  <!-- MONDAY ERROR BANNER -->
  ${mondayErrorBanner}

  <!-- NB + SUMMARY LINE + PILL -->
  <tr><td style="background:#ffffff;padding:20px 32px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
      <tr><td style="background:#f4f0ea;border-left:3px solid #1a1a1a;border-radius:0 8px 8px 0;padding:11px 16px;">
        <p style="margin:0;font-size:12px;color:#3a3a3a;line-height:1.6;"><strong>NB:</strong> This is an enquiry from <a href="${STAY_LUXE_URL}" style="color:#8a6540;text-decoration:underline;">Stay Luxe</a>'s website - and it's likely this guest is not a student.</p>
      </td></tr>
    </table>
    <p style="margin:0 0 10px;"><span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:500;letter-spacing:0.06em;background:${isTypeA ? 'rgba(29,158,117,0.12)' : 'rgba(184,150,110,0.12)'};color:${isTypeA ? '#0F6E56' : '#8a6540'};border:0.5px solid ${isTypeA ? 'rgba(29,158,117,0.4)' : 'rgba(184,150,110,0.4)'};">${isTypeA ? 'Check apartment availability' : 'Send guest options'}</span></p>
    <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.75;">${isTypeA
      ? `${escHtml(p.apartment_ref || '')}${p.apartment_type ? ' — ' + formatAptType(p.apartment_type) : ''}${nightCount ? ' &nbsp;·&nbsp; ' + nightCount + ' nights' : ''}${p.check_in ? ' &nbsp;·&nbsp; ' + formatDate(p.check_in) + ' → ' + formatDate(p.check_out) : ''}`
      : `${formatCity(p.city) || ''}${p.apartment_type ? ' — ' + formatAptType(p.apartment_type) : ''}${nightCount ? ' &nbsp;·&nbsp; ' + nightCount + ' nights' : ''}${p.check_in ? ' &nbsp;·&nbsp; ' + formatDate(p.check_in) + ' → ' + formatDate(p.check_out) : ''}${p.budget && p.enquiry_type !== 'A' ? ' &nbsp;·&nbsp; ' + formatBudget(p.budget) + '/wk' : ''}`
    }</p>
  </td></tr>

  <!-- DIVIDER -->
  <tr><td style="background:#ffffff;padding:0 32px;"><hr style="border:none;border-top:0.5px solid #ede9e3;margin:18px 0;"></td></tr>

  <!-- CONTACT -->
  <tr><td style="background:#ffffff;padding:0 32px 18px;">
    <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Contact</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${field('Name', p.full_name)}
        ${field('Email', p.email)}
      </tr><tr>
        ${field('Phone', p.phone)}
        ${field('Respond via', p.response_methods)}
      </tr><tr>
        ${field('Poss. timezone', p.timezone || '—')}
    </table>
  </td></tr>

  <!-- STAY DETAILS -->
  <tr><td style="background:#ffffff;padding:0 32px 18px;">
    <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Stay details</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${isTypeA ? `<tr>${field('Apartment', p.apartment_ref)}${field('Apartment type', formatAptType(p.apartment_type))}</tr>` : `<tr>${field('City', formatCity(p.city))}${field('Apartment type', formatAptType(p.apartment_type))}</tr>`}
      <tr>
        ${field('Check-in', formatDate(p.check_in))}
        ${field('Check-out', formatDate(p.check_out))}
      </tr><tr>
        ${field('Nights', nightCount)}
        ${field('Budget / week', p.enquiry_type !== 'A' ? formatBudget(p.budget) : '')}
      </tr><tr>
        ${field('Areas', p.areas)}
        ${field('Type of stay', formatStayType(p.stay_type, p.university))}
      </tr><tr>
        ${field('Country of residence', p.nationality)}
        ${field('Lived in city before', p.lived_before)}
      </tr>
    </table>
  </td></tr>

  <!-- MESSAGE -->
  ${p.message ? `
  <tr><td style="background:#ffffff;padding:0 32px 18px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="background:#f7f2eb;border-left:3px solid #B8966E;border-radius:0 8px 8px 0;padding:12px 16px;">
        <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#B8966E;">Message from guest</p>
        <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.7;font-style:italic;">"${escHtml(p.message)}"</p>
      </td></tr>
    </table>
  </td></tr>` : ''}

  <!-- TRACKING -->
  <tr><td style="background:#ffffff;padding:0 32px 24px;">
    <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Tracking</p>
    <table cellpadding="0" cellspacing="0" style="background:#f7f2eb;border-radius:8px;padding:10px 16px;width:100%;">
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;width:110px;">Source</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(p.utm_source||'—')}</td></tr>
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;">Campaign</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(resolveCampaign(p.utm_campaign)||'—')}</td></tr>
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;">Search term</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(p.utm_term||'—')}</td></tr>
    </table>
  </td></tr>

  <!-- CTA BUTTONS (footer band) -->
  <tr><td style="background:${DARK_BG};background-image:${DARK_GRADIENT};padding:18px 32px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:8px;"><a href="mailto:${p.email}" style="display:inline-block;padding:10px 20px;background:#B8966E;border-radius:8px;font-size:12px;font-weight:500;color:#ffffff;text-decoration:none;">Reply by email</a></td>
      <td style="padding-right:8px;"><a href="${crmUrl}" style="display:inline-block;padding:10px 20px;background:#ffffff;border:0.5px solid rgba(255,255,255,0.25);border-radius:8px;font-size:12px;font-weight:500;color:#1a1a1a;text-decoration:none;">View on Leads Board</a></td>
      ${isTypeA && p.apartment_ref ? `<td><a href="https://studentluxe.monday.com/boards/2388987554/views/87174774?term=${encodeURIComponent(p.apartment_ref)}" style="display:inline-block;padding:10px 20px;background:#ffffff;border:0.5px solid rgba(255,255,255,0.25);border-radius:8px;font-size:12px;font-weight:500;color:#1a1a1a;text-decoration:none;">View on Property Board</a></td>` : ''}
    </tr></table>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  return resendSend({
    from:    `${process.env.FROM_NAME || 'Student Luxe'} <${process.env.FROM_EMAIL}>`,
    to:      p.test_mode
      ? ['alex@studentluxe.co.uk']
      : [process.env.TEAM_EMAIL, process.env.TEAM_EMAIL_2, 'jared@studentluxe.co.uk'].filter(Boolean),
    replyTo: p.email,
    subject: isTypeA
      ? `[Stay Luxe] New Enquiry — ${p.apartment_ref || 'Specific Apartment'}${nightCount ? ', ' + nightCount + ' Nights' : ''}`
      : `[Stay Luxe] New Enquiry — ${formatCity(p.city) || 'Unknown City'}${nightCount ? ', ' + nightCount + ' Nights' : ''}`,
    html
  });
}

// ── Currency detection by city ────────────────────────────────
function currencyForCity(city, otherCity) {
  const GBP = ['london','edinburgh','glasgow','manchester','cambridge','durham','bristol','birmingham','brighton','liverpool','nottingham'];
  const EUR = ['dublin','paris','milan','amsterdam','rome','florence','helsinki','barcelona','madrid','lisbon','porto','valencia'];
  const USD = ['new-york','boston','chicago','washington','philadelphia'];
  const c = (city || '').toLowerCase().trim();
  if (GBP.includes(c)) return '£';
  if (EUR.includes(c)) return '€';
  if (USD.includes(c)) return '$';

  // Free-text other city — detect by keyword
  if (c === 'other' && otherCity) {
    const o = otherCity.toLowerCase();
    const currencyKeywords = {
      '£':   ['uk','united kingdom','england','scotland','wales','london','manchester','birmingham','edinburgh','glasgow','bristol','brighton','liverpool','leeds','sheffield','newcastle','nottingham','cardiff','belfast'],
      '€':   ['france','paris','germany','berlin','munich','hamburg','frankfurt','spain','madrid','barcelona','seville','italy','rome','milan','naples','turin','netherlands','amsterdam','rotterdam','portugal','lisbon','porto','belgium','brussels','antwerp','austria','vienna','graz','greece','athens','thessaloniki','ireland','dublin','cork','finland','helsinki','denmark','copenhagen','sweden','stockholm','gothenburg','norway','oslo','bergen','poland','warsaw','krakow','czech','prague','hungary','budapest','romania','bucharest','croatia','zagreb','luxembourg','malta','slovakia','bratislava','slovenia','estonia','tallinn','latvia','riga','lithuania','vilnius'],
      '$':   ['usa','united states','america','new york','los angeles','chicago','houston','miami','san francisco','seattle','boston','washington','philadelphia','phoenix','dallas','denver','atlanta','las vegas','san diego','austin'],
      'CAD': ['canada','toronto','vancouver','montreal','calgary','ottawa'],
      'AUD': ['australia','sydney','melbourne','brisbane','perth','adelaide'],
      'NZD': ['new zealand','auckland','wellington','christchurch'],
      'CHF': ['switzerland','zurich','geneva','bern','basel','lausanne'],
      '¥':   ['japan','tokyo','osaka','kyoto','nagoya','sapporo','fukuoka','yokohama'],
      'CNY': ['china','beijing','shanghai','guangzhou','shenzhen','chengdu','wuhan','chongqing','tianjin','nanjing'],
      'HKD': ['hong kong'],
      'S$':  ['singapore'],
      'AED': ['dubai','abu dhabi','uae','united arab emirates','sharjah'],
      '฿':   ['thailand','bangkok','phuket','chiang mai','pattaya'],
      'INR': ['india','mumbai','delhi','bangalore','hyderabad','chennai','kolkata','pune','ahmedabad'],
      'KRW': ['korea','south korea','seoul','busan','incheon'],
      'BRL': ['brazil','são paulo','sao paulo','rio de janeiro','rio','brasilia','salvador','fortaleza'],
      'MXN': ['mexico','mexico city','guadalajara','monterrey','cancun'],
      'ZAR': ['south africa','cape town','johannesburg','durban','pretoria'],
      'MYR': ['malaysia','kuala lumpur','penang','johor'],
      'IDR': ['indonesia','jakarta','bali','surabaya','bandung'],
      'PHP': ['philippines','manila','cebu','davao'],
      'TWD': ['taiwan','taipei','kaohsiung','taichung'],
      'TRY': ['turkey','istanbul','ankara','izmir','antalya'],
      'SAR': ['saudi arabia','riyadh','jeddah','mecca','medina'],
      'QAR': ['qatar','doha'],
      'KWD': ['kuwait','kuwait city'],
      'BHD': ['bahrain','manama'],
      'EGP': ['egypt','cairo','alexandria','giza'],
      'NGN': ['nigeria','lagos','abuja','kano'],
      'KES': ['kenya','nairobi','mombasa'],
      'GHS': ['ghana','accra','kumasi'],
      'ARS': ['argentina','buenos aires','cordoba','rosario'],
      'CLP': ['chile','santiago','valparaiso'],
      'COP': ['colombia','bogota','medellin','cali'],
      'PEN': ['peru','lima','cusco'],
      'PKR': ['pakistan','karachi','lahore','islamabad'],
      'BDT': ['bangladesh','dhaka','chittagong'],
      'VND': ['vietnam','ho chi minh','hanoi','da nang'],
      'UAH': ['ukraine','kyiv','kiev','kharkiv','odessa'],
      'RUB': ['russia','moscow','saint petersburg','novosibirsk'],
      'ILS': ['israel','tel aviv','jerusalem','haifa'],
      'SEK': ['sweden','stockholm','gothenburg','malmo'],
      'NOK': ['norway','oslo','bergen','trondheim'],
      'DKK': ['denmark','copenhagen','aarhus'],
      'PLN': ['poland','warsaw','krakow','wroclaw'],
      'CZK': ['czech','prague','brno'],
      'HUF': ['hungary','budapest'],
      'RON': ['romania','bucharest','cluj'],
      'ISK': ['iceland','reykjavik'],
    };
    for (const [symbol, keywords] of Object.entries(currencyKeywords)) {
      if (keywords.some(k => o.includes(k))) return symbol;
    }
  }
  return '';
}

// ──────────────────────────────────────────────────────────────
//  MONDAY.COM — Push lead to board 2171015719
// ──────────────────────────────────────────────────────────────
// ── Google Ads campaign ID → name map ────────────────────────
const CAMPAIGN_MAP = {
  '23593406109': 'jf17_search_generic_os_tablet_phrase_in_row_destination_london',
  '23676288424': 'jf14_search_generic_os_tablet_broad_in_us_destination_london - £150 tCPA Test',
  '23671659281': 'jf3_search_generic_os_desktop_broad_in_us_destination_london - £150 tCPA Test',
  '23598174873': 'jf19_search_brand_global_exact',
  '21918787893': 'rentals-short-stay-os',
  '23512016561': 'cambridge-os',
  '20356089756': 'london-student-os',
  '23603515408': 'jf10_search_generic_os_mobile_exact_in_us_destination_london',
  '23593407051': 'jf9_search_generic_os_mobile_exact_in_row_destination_london',
  '22561087901': 'core-luxe-perf-max',
  '23392672745': 'new-york-os',
  '21429830124': 'lse-summer-uni-campus',
  '23676301570': 'jf9_search_generic_os_mobile_exact_in_row_destination_london - £150 tCPA Test',
  '21973944922': 'core-luxe-os',
  '23671673024': 'jf4_search_generic_os_desktop_exact_in_row_destination_london - £150 tCPA Test',
  '23593406838': 'jf12_search_generic_os_mobile_phrase_in_us_destination_london',
  '23666278518': 'jf13_search_generic_os_tablet_broad_in_row_destination_london - £150 tCPA Test',
  '21902352633': 'lse-summer-all-us',
  '21499603565': 'paris-os',
  '23676319627': 'jf15_search_generic_os_tablet_exact_in_row_destination_london - £150 tCPA Test',
  '23593627429': 'jf16_search_generic_os_tablet_exact_in_us_destination_london',
  '23452513132': 'lse-summer-perf-max',
  '23642461894': 'PARIS - from OS _Experiment',
  '23666244384': 'jf8_search_generic_os_mobile_broad_in_us_destination_london - £150 tCPA Test',
  '23666254497': 'jf5_search_generic_os_desktop_exact_in_us_destination_london - £150 tCPA Test',
  '22082273952': 'rentals-os',
  '22120262100': 'hnwi-pb-zip-os',
  '23588980553': 'jf3_search_generic_os_desktop_broad_in_us_destination_london',
  '23671661003': 'jf6_search_generic_os_desktop_phrase_in_us_destination_london - £150 tCPA Test',
  '23593627561': 'jf18_search_generic_os_tablet_phrase_in_us_destination_london',
  '23676326599': 'jf17_search_generic_os_tablet_phrase_in_row_destination_london - £150 tCPA Test',
  '23588981654': 'jf14_search_generic_os_tablet_broad_in_us_destination_london',
  '23671688303': 'jf18_search_generic_os_tablet_phrase_in_us_destination_london - £150 tCPA Test',
  '23666271564': 'jf10_search_generic_os_mobile_exact_in_us_destination_london - £150 tCPA Test',
  '23593406301': 'jf7_search_generic_os_mobile_broad_in_row_destination_london',
  '23598893477': 'jf2_search_generic_os_desktop_broad_in_row_destination_london',
  '23676311422': 'jf2_search_generic_os_desktop_broad_in_row_destination_london - £150 tCPA Test',
  '23666273505': 'jf12_search_generic_os_mobile_phrase_in_us_destination_london - £150 tCPA Test',
  '23666255946': 'jf11_search_generic_os_mobile_phrase_in_row_destination_london - £150 tCPA Test',
  '23603514478': 'jf13_search_generic_os_tablet_broad_in_row_destination_london',
  '23598893927': 'jf11_search_generic_os_mobile_phrase_in_row_destination_london',
  '23598893684': 'jf1_search_generic_os_desktop_phrase_in_row_destination_london',
  '23642456119': 'LSE SUMMER - All US _Experiment',
  '23593406142': 'jf15_search_generic_os_tablet_exact_in_row_destination_london',
  '23671689740': 'jf16_search_generic_os_tablet_exact_in_us_destination_london - £150 tCPA Test',
  '23593406559': 'jf8_search_generic_os_mobile_broad_in_us_destination_london',
};

function resolveCampaign(val) {
  if (!val) return '';
  const trimmed = val.trim();
  // If it looks like a numeric ID, resolve it — otherwise return as-is
  return /^\d+$/.test(trimmed) ? (CAMPAIGN_MAP[trimmed] || trimmed) : trimmed;
}

async function pushToMonday(p) {
  const nameParts  = (p.full_name || '').trim().split(' ');
  const firstname  = nameParts[0] || '';
  const lastname   = nameParts.slice(1).join(' ') || '';
  const itemName   = p.full_name || 'New Enquiry';

  // Format areas — Monday dropdown expects array of label strings
  const areaLabels = p.areas
    ? p.areas.split(',').map(a => a.trim()).filter(Boolean)
    : [];

  // Apartment type label for dropdown
  const aptTypeLabels = p.apartment_type
    ? [formatAptType(p.apartment_type)]
    : [];

  // Stay type label for status column
  const stayTypeMap = {
    'student':          'Student',
    'young-professional':'Young Professional',
    'corporate':        'Corporate',
    'parent':           'Parent / Guardian',
    'other-stay':       'Other'
  };

  // ── Lead source detection ────────────────────────────────────
  const hasGclid    = !!p.gclid;
  const hasFbclid   = !!p.fbclid;
  const hasPPC      = hasGclid || hasFbclid;
  const hasVisited  = !!(p.visited_paths || p.landing_page);

  // Extract clean domain from referrer e.g. "https://search.yahoo.com/search" → "Yahoo"
  function extractChannel(referrer) {
    if(!referrer) return '';
    try {
      const host = new URL(referrer).hostname.replace('www.', '').replace('search.', '');
      const domainMap = {
        'google.com': 'Google Advert', 'google.co.uk': 'Google Advert',
        'bing.com': 'Bing', 'yahoo.com': 'Yahoo', 'duckduckgo.com': 'DuckDuckGo',
        'instagram.com': 'Instagram', 'facebook.com': 'Meta Advert', 'meta.com': 'Meta Advert',
        'linkedin.com': 'From a Friend', 'twitter.com': 'Unknown', 'x.com': 'Unknown',
        'tiktok.com': 'TikTok', 'youtube.com': 'Unknown',
        'studentluxe.co.uk': 'Unknown'
      };
      return domainMap[host] || 'Unknown';
    } catch(e) { return 'Unknown'; }
  }

  let leadSource = '';
  let leadChannel = '';

  if(hasGclid){
    leadSource  = 'PPC';
    leadChannel = 'Google Advert';
  } else if(hasFbclid){
    leadSource  = 'Socials';
    leadChannel = extractChannel(p.referrer) || 'Instagram';
  } else if(hasVisited){
    leadSource  = 'SEO';
    leadChannel = extractChannel(p.referrer);
  }

  const columnValues = {
    // ── Personal ──────────────────────────────────────────────
    text37:              firstname,
    text60:              lastname,
    email:               p.email ? { email: p.email, text: p.email } : {},
    phone_1: p.phone ? (function(){
      const raw = p.phone.replace(/[\s\-().]/g, '');
      // Detect country from dial code prefix
      const dialMap = {
        '+44':'GB', '+1':'US', '+33':'FR', '+49':'DE', '+39':'IT',
        '+34':'ES', '+351':'PT', '+31':'NL', '+32':'BE', '+41':'CH',
        '+43':'AT', '+46':'SE', '+47':'NO', '+45':'DK', '+358':'FI',
        '+48':'PL', '+420':'CZ', '+36':'HU', '+40':'RO', '+380':'UA',
        '+7':'RU',  '+86':'CN', '+81':'JP', '+82':'KR', '+91':'IN',
        '+61':'AU', '+64':'NZ', '+27':'ZA', '+55':'BR', '+52':'MX',
        '+971':'AE','+966':'SA','+974':'QA','+965':'KW','+962':'JO',
        '+852':'HK','+65':'SG', '+60':'MY', '+66':'TH', '+62':'ID'
      };
      let countryShortName = 'GB';
      for (const [prefix, code] of Object.entries(dialMap)) {
        if (raw.startsWith(prefix)) { countryShortName = code; break; }
      }
      return { phone: raw, countryShortName };
    })() : {},

    // ── Stay details ───────────────────────────────────────────
    date47:              p.check_in  ? { date: p.check_in  } : {},
    date_1:              p.check_out ? { date: p.check_out } : {},
    budget_per_week:     p.budget ? formatBudget(p.budget) : '',
    text8:               p.city === 'other' ? (p.other_city || '') : (formatCity(p.city) || ''),
    dropdown6:           p.apartment_ref        || '',
    apt_type_mkmn4bgg:   formatAptType(p.apartment_type) || '',
    dropdown19:          p.areas || '',

    // ── Contact preference ─────────────────────────────────────
    dropdown40: p.response_methods ? {
      labels: p.response_methods.split(',').map(s => {
        const v = s.trim().toLowerCase();
        if(v === 'phone')     return 'Phone Call (preferred option)';
        if(v === 'whatsapp')  return 'WhatsApp (preferred option)';
        if(v === 'email')     return 'Email';
        return s.trim();
      })
    } : {},

    // ── Guest details ──────────────────────────────────────────
    color_mktcnwyb: p.stay_type ? { label: {
      'student':             'Student',
      'parent':              'Parent or guardian (on behalf of student)',
      'working-professional':'Working professional',
      'corporate':           'Corporate',
      'medical':             'Medical',
      'tourism':             'Tourism',
      'agent':               'Agent (on behalf of client)'
    }[p.stay_type] || p.stay_type } : {},
    text_mknfnmsb:       p.university  || '',
    text9__1:            p.nationality || '',

    // ── Message ────────────────────────────────────────────────
    long_text7:          p.message || '',

    // ── Tracking ───────────────────────────────────────────────
    text_mm1c3b5w:       resolveCampaign(p.utm_campaign),
    text43__1:           p.utm_adgroup   || '',
    text3__1:            p.utm_term      || '',
    text_mm1d87rp:       p.utm_matchtype || '',
    text4__1:            p.gclid || p.fbclid || '',
    text_mm1jhhe7:       p.landing_page  || '',
    long_text__1:        p.visited_paths || '',

    // ── Lead source ────────────────────────────────────────────
    ...(leadSource  && { color_mkxk8y67:    { label: leadSource } }),
    ...(leadChannel && leadChannel !== 'Unknown' && { dropdown_mkxkfbff: { labels: [leadChannel] } }),
    dropdown_mm1v31yb: { labels: ['/Stay Luxe Form'] },
    status1__1:          { label: 'Stay Luxe' },
    ...(p.city && currencyForCity(p.city, p.other_city) && { status0__1: { label: currencyForCity(p.city, p.other_city) } }),
  };

  const mutation = `
    mutation {
      create_item(
        board_id: ${MONDAY_BOARD},
        item_name: ${JSON.stringify(itemName)},
        column_values: ${JSON.stringify(JSON.stringify(columnValues))}
      ) {
        id
      }
    }
  `;

  const response = await fetch(MONDAY_API, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': process.env.MONDAY_API_KEY
    },
    body: JSON.stringify({ query: mutation })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('Monday HTTP error:', response.status, JSON.stringify(data));
    throw new Error('Monday HTTP ' + response.status);
  }
  if (data.errors) {
    console.error('Monday API errors:', JSON.stringify(data.errors, null, 2));
    console.error('Column values sent:', JSON.stringify(columnValues, null, 2));
    throw new Error('Monday API error: ' + JSON.stringify(data.errors));
  }
  return data?.data?.create_item?.id;
}

// ──────────────────────────────────────────────────────────────
//  RESEND API CALL
// ──────────────────────────────────────────────────────────────
async function resendSend(payload) {
  const res = await fetch(RESEND_API, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
  return res.json();
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return d; }
}

function nights(p) {
  if (!p.check_in || !p.check_out) return null;
  const n = Math.round((new Date(p.check_out) - new Date(p.check_in)) / 86400000);
  return n > 0 ? n : null;
}

function formatCity(city) {
  if (!city) return '';
  const map = {
    'london':'London','new-york':'New York','paris':'Paris','edinburgh':'Edinburgh',
    'glasgow':'Glasgow','manchester':'Manchester','cambridge':'Cambridge','durham':'Durham',
    'bristol':'Bristol','barcelona':'Barcelona','madrid':'Madrid','lisbon':'Lisbon',
    'boston':'Boston','chicago':'Chicago','washington':'Washington DC'
  };
  return map[city] || city;
}

function formatAptType(t) {
  if (!t) return '';
  const map = {
    'studio':'Studio','1bed':'1 bedroom','2bed':'2 bedroom',
    '3bed':'3 bedroom','penthouse':'Penthouse','flexible':'Flexible'
  };
  return map[t] || t;
}

function formatBudget(b) {
  if (!b) return '';
  const map = {
    'under-650':'Under £650','650-1000':'£650 – £1,000',
    '1000-2000':'£1,000 – £2,000','2000-4000':'£2,000 – £4,000','5000+':'£5,000+',
    'under-550':'Under £550','550-900':'£550 – £900',
    '900-1350':'£900 – £1,350','1350-2000':'£1,350 – £2,000','2000+':'£2,000+',
    '850-1200':'£850 – £1,200','1200-2000':'£1,200 – £2,000',
    '2000-3500':'£2,000 – £3,500','3500-5000':'£3,500 – £5,000',
    'under-1250':'Under £1,250','1250-1800':'£1,250 – £1,800',
    '1800-2500':'£1,800 – £2,500','2500-4000':'£2,500 – £4,000'
  };
  return map[b] || b;
}

function formatStayType(type, university) {
  if (!type) return '';
  const map = {
    'student':              'Student',
    'parent':               'Parent or guardian (on behalf of student)',
    'working-professional': 'Working professional',
    'corporate':            'Corporate',
    'medical':              'Medical',
    'tourism':              'Tourism',
    'agent':                'Agent (on behalf of client)'
  };
  const label = map[type] || type;
  return university ? `${label} · ${university}` : label;
}
