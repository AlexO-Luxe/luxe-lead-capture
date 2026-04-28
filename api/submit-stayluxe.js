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
//  EMAIL 1 — Guest confirmation
// ──────────────────────────────────────────────────────────────
async function sendGuestConfirmation(p) {
  const firstName = (p.full_name || '').split(' ')[0] || 'there';
  const siteUrl   = process.env.SITE_URL || 'https://www.studentluxe.co.uk';
  const isTypeA   = p.enquiry_type === 'A';

  // Build stay summary rows
  const rows = [
    p.city           && ['City',           formatCity(p.city)],
    p.apartment_ref  && ['Apartment',      p.apartment_ref],
    p.apartment_type && ['Apartment type', formatAptType(p.apartment_type)],
    p.check_in       && ['Check-in',       formatDate(p.check_in)],
    p.check_out      && ['Check-out',      formatDate(p.check_out)],
    nights(p)        && ['Stay length',    nights(p) + ' nights'],
    p.budget         && p.enquiry_type !== 'A' && ['Budget / week', formatBudget(p.budget)],
    p.response_methods && ['We will respond via', p.response_methods],
  ].filter(Boolean);

  const summaryRows = rows.map(([label, value]) => `
    <tr>
      <td style="padding:7px 0;font-size:13px;color:#6b6b6b;border-bottom:0.5px solid #ede9e3;width:45%;">${label}</td>
      <td style="padding:7px 0;font-size:13px;color:#1a1a1a;font-weight:500;border-bottom:0.5px solid #ede9e3;text-align:right;">${value}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Enquiry received — Student Luxe</title></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">

  <!-- HEADER -->
  <tr><td style="background:#0d1a2e;padding:36px 40px 32px;">
    <h1 style="margin:0 0 8px;font-family:Georgia,serif;font-size:28px;font-weight:400;color:#f0ece2;line-height:1.15;letter-spacing:-0.03em;">We've received your enquiry</h1>
    <p style="margin:0;font-size:13px;color:rgba(240,236,226,0.5);font-weight:300;">Our Reservations team will reach out shortly.</p>
  </td></tr>

  <!-- BODY -->
  <tr><td style="background:#ffffff;padding:32px 40px;">
    <p style="margin:0 0 16px;font-size:14px;color:#1a1a1a;line-height:1.7;">Dear ${escHtml(firstName)},</p>
    ${isTypeA ? `
    <p style="margin:0 0 16px;font-size:14px;color:#1a1a1a;line-height:1.7;">Thank you for your enquiry about <strong>${escHtml(p.apartment_ref || 'your chosen apartment')}</strong> — we're currently checking the latest availability and pricing at this building for your chosen dates.</p>
    <p style="margin:0 0 16px;font-size:14px;color:#1a1a1a;line-height:1.7;">A member of our Reservations team will be in touch within 24 hours to confirm these details, and discuss any other options that might suit your needs.</p>
    <p style="margin:0 0 24px;font-size:14px;color:#1a1a1a;line-height:1.7;">We look forward to helping you find your perfect apartment!</p>
    ` : `
    <p style="margin:0 0 16px;font-size:14px;color:#1a1a1a;line-height:1.7;">Thank you for your ${escHtml(formatCity(p.city))} apartment enquiry. A member of our Reservations team will be in touch within 24 hours to discuss this further. We'll send over a selection of apartments based on your initial details, and then take time to understand your needs in more depth.</p>
    <p style="margin:0 0 24px;font-size:14px;color:#1a1a1a;line-height:1.7;">We look forward to helping you find your perfect apartment!</p>
    `}

    <!-- Summary table -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f2eb;border-radius:10px;padding:4px 20px;margin:0 0 24px;">
      <tbody>${summaryRows}</tbody>
    </table>

    ${p.message ? `
    <!-- Guest message -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td style="background:#f7f2eb;border-left:3px solid #B8966E;border-radius:0 8px 8px 0;padding:14px 18px;">
        <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#B8966E;">Your message</p>
        <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.7;font-style:italic;">${escHtml(p.message)}</p>
      </td></tr>
    </table>` : ''}

    <p style="margin:0 0 24px;font-size:14px;color:#1a1a1a;line-height:1.7;">In the meantime, you're welcome to browse our full portfolio of apartments.</p>

    <!-- CTA button -->
    <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr><td style="background:#B8966E;border-radius:8px;">
        <a href="${siteUrl}" style="display:inline-block;padding:13px 32px;font-size:12px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:#ffffff;text-decoration:none;">Browse apartments</a>
      </td></tr>
    </table>

    <!-- About blurb -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td style="border-top:0.5px solid #ede9e3;padding-top:20px;">
        <p style="margin:0 0 6px;font-family:Georgia,serif;font-size:14px;font-weight:400;letter-spacing:-0.01em;color:#1a1a1a;">About Stay Luxe</p>
        <p style="margin:0 0 12px;font-size:12px;color:#6b6b6b;line-height:1.75;">We combine premium apartments with exceptional service to make student and professional living effortless. Our expert team will help you find &amp; book the perfect space — offering local insights, personalised recommendations, and support wherever it's needed.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-top:0.5px solid #ede9e3;padding-top:10px;margin-top:4px;">
          <tr>
            <td width="50%" style="padding:4px 0;font-size:11px;color:#6b6b6b;vertical-align:middle;">
              <span style="display:inline-block;width:13px;height:13px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:13px;font-size:8px;color:#B8966E;margin-right:6px;vertical-align:middle;">✓</span>Fully-furnished
            </td>
            <td width="50%" style="padding:4px 0;font-size:11px;color:#6b6b6b;vertical-align:middle;">
              <span style="display:inline-block;width:13px;height:13px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:13px;font-size:8px;color:#B8966E;margin-right:6px;vertical-align:middle;">✓</span>All bills included
            </td>
          </tr>
          <tr>
            <td width="50%" style="padding:4px 0;font-size:11px;color:#6b6b6b;vertical-align:middle;">
              <span style="display:inline-block;width:13px;height:13px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:13px;font-size:8px;color:#B8966E;margin-right:6px;vertical-align:middle;">✓</span>Hotel-style amenities
            </td>
            <td width="50%" style="padding:4px 0;font-size:11px;color:#6b6b6b;vertical-align:middle;">
              <span style="display:inline-block;width:13px;height:13px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:13px;font-size:8px;color:#B8966E;margin-right:6px;vertical-align:middle;">✓</span>Weekly housekeeping
            </td>
          </tr>
          <tr>
            <td width="50%" style="padding:4px 0;font-size:11px;color:#6b6b6b;vertical-align:middle;">
              <span style="display:inline-block;width:13px;height:13px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:13px;font-size:8px;color:#B8966E;margin-right:6px;vertical-align:middle;">✓</span>Dedicated support
            </td>
            <td width="50%" style="padding:4px 0;font-size:11px;color:#6b6b6b;vertical-align:middle;">
              <span style="display:inline-block;width:13px;height:13px;border-radius:50%;border:0.75px solid #B8966E;text-align:center;line-height:13px;font-size:8px;color:#B8966E;margin-right:6px;vertical-align:middle;">✓</span>Flexible booking policy
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#f7f2eb;padding:18px 0;border-top:0.5px solid rgba(184,150,110,0.2);text-align:center;">
    <p style="margin:0 0 10px;font-size:11px;color:#9b9b9b;line-height:1.9;">
      Stay Luxe Apartments<br>
      Dog &amp; Duck Yard, Princeton St, London, WC1R 4BH<br>
      +44 (0)203 007 0017 &nbsp;·&nbsp; Mon–Fri, 10am–6pm GMT<br>
      © 2026 Stay Luxe Apartments. All rights reserved.
    </p>
    <p style="margin:0;font-size:10px;color:#b9b9b9;line-height:1.6;padding:0 20px;">If you didn't submit this enquiry, please disregard this email. Your details are safe and will never be shared with third parties.</p>
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
//  EMAIL 2 — Team notification
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
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>New enquiry — ${escHtml(guestName)}</title></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">

  <!-- HEADER -->
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

  <!-- MONDAY ERROR BANNER -->
  ${mondayErrorBanner}

  <!-- SUMMARY LINE + PILL -->
  <tr><td style="background:#ffffff;padding:20px 32px 0;">
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

  <!-- CTA BUTTONS -->
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
    to:      [process.env.TEAM_EMAIL, process.env.TEAM_EMAIL_2, 'jared@studentluxe.co.uk'].filter(Boolean),
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
