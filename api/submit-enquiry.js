// ============================================================
//  Student Luxe — Enquiry Submit + Email Handler
//  Deploy to: /api/submit-enquiry.js in your Vercel project
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
  try {
    mondayId = await pushToMonday(p);
    console.log('Monday OK — pulse ID:', mondayId);
  } catch(err) {
    console.error('Monday failed:', err.message || err);
  }

  // Fire both emails in parallel, passing the pulse ID to the team email
  const results = await Promise.allSettled([
    sendGuestConfirmation(p),
    sendTeamNotification(p, mondayId)
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
        <p style="margin:0 0 6px;font-family:Georgia,serif;font-size:14px;font-weight:400;letter-spacing:-0.01em;color:#1a1a1a;">About Student Luxe</p>
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
  <tr><td style="background:#f7f2eb;padding:18px 40px;border-top:0.5px solid rgba(184,150,110,0.2);">
    <p style="margin:0 0 10px;font-size:11px;color:#9b9b9b;line-height:1.9;">
      Student Luxe Apartments<br>
      Dog &amp; Duck Yard, Princeton St, London, WC1R 4BH<br>
      +44 (0)203 007 0017 &nbsp;·&nbsp; Mon–Fri, 10am–6pm GMT<br>
      © 2026 Student Luxe Apartments. All rights reserved.
    </p>
    <p style="margin:0;font-size:10px;color:#b9b9b9;line-height:1.6;">If you didn't submit this enquiry, please disregard this email. Your details are safe and will never be shared with third parties.</p>
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
      ? `Your enquiry about ${p.apartment_ref || 'your apartment'}`
      : `Your ${formatCity(p.city) || ''} apartment enquiry`.trim(),
    html
  });
}

// ──────────────────────────────────────────────────────────────
//  EMAIL 2 — Team notification
// ──────────────────────────────────────────────────────────────
async function sendTeamNotification(p, mondayId) {
  const isTypeA   = p.enquiry_type === 'A';
  const badgeColor = isTypeA ? '#0F6E56' : '#B8966E';
  const badgeBg   = isTypeA ? 'rgba(29,158,117,0.15)' : 'rgba(184,150,110,0.15)';
  const badgeLabel = isTypeA ? 'Check availability' : 'Send guest options';
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
  <tr><td style="background:#1a2640;padding:20px 28px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle;">
        <p style="margin:0;font-size:14px;font-weight:500;color:#f0ece2;">${escHtml(guestName)}</p>
        <p style="margin:3px 0 0;font-size:11px;color:rgba(240,236,226,0.5);">${submittedFormatted}</p>
      </td>
      <td style="text-align:right;vertical-align:middle;">
        <span style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:10px;font-weight:500;letter-spacing:0.06em;background:${badgeBg};color:${badgeColor};border:0.5px solid ${badgeColor};">${badgeLabel}</span>
      </td>
    </tr></table>
  </td></tr>

  <!-- CONTACT -->
  <tr><td style="background:#ffffff;padding:22px 28px;border-bottom:0.5px solid #ede9e3;">
    <p style="margin:0 0 14px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Contact</p>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      ${field('Name', p.full_name)}
      ${field('Email', p.email)}
    </tr><tr>
      ${field('Phone', p.phone)}
      ${field('Respond via', p.response_methods)}
    </tr></table>
  </td></tr>

  <!-- STAY DETAILS -->
  <tr><td style="background:#ffffff;padding:22px 28px;border-bottom:0.5px solid #ede9e3;">
    <p style="margin:0 0 14px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Stay details</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${isTypeA ? `<tr>${field('Apartment', p.apartment_ref)}${field('Apartment type', formatAptType(p.apartment_type))}</tr>` : ''}
      <tr>
        ${field('City', formatCity(p.city))}
        ${field('Apartment type', formatAptType(p.apartment_type))}
      </tr><tr>
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
  ${p.message ? `<tr><td style="background:#ffffff;padding:22px 28px;border-bottom:0.5px solid #ede9e3;">
    <p style="margin:0 0 10px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Message</p>
    <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.7;font-style:italic;">"${escHtml(p.message)}"</p>
  </td></tr>` : ''}

  <!-- TRACKING -->
  <tr><td style="background:#ffffff;padding:22px 28px;border-bottom:0.5px solid #ede9e3;">
    <p style="margin:0 0 10px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Tracking</p>
    <table cellpadding="0" cellspacing="0" style="background:#f7f2eb;border-radius:8px;padding:12px 16px;width:100%;">
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;width:110px;">Source</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(p.utm_source||'—')}</td></tr>
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;">Campaign</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(p.utm_campaign||'—')}</td></tr>
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;">Search term</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;">${escHtml(p.utm_term||'—')}</td></tr>
      <tr><td colspan="2" style="padding:8px 0 0;border-top:0.5px solid rgba(184,150,110,0.2);"></td></tr>
      <tr><td style="padding:3px 0;font-size:11px;color:#9b9b9b;vertical-align:top;">Journey</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;font-weight:500;line-height:1.7;">${escHtml(p.visited_paths||'—')}</td></tr>
    </table>
  </td></tr>

  <!-- CTA BUTTONS -->
  <tr><td style="background:#f7f2eb;padding:16px 28px;">
    <table cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:8px;"><a href="mailto:${p.email}" style="display:inline-block;padding:10px 20px;background:#B8966E;border-radius:8px;font-size:12px;font-weight:500;color:#ffffff;text-decoration:none;">Reply by email</a></td>
      <td><a href="${crmUrl}" style="display:inline-block;padding:10px 20px;background:#ffffff;border:0.5px solid rgba(184,150,110,0.4);border-radius:8px;font-size:12px;font-weight:500;color:#1a1a1a;text-decoration:none;">View on Leads Board</a></td>
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
//  MONDAY.COM — Push lead to board 2171015719
// ──────────────────────────────────────────────────────────────
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
        'google.com': 'Google', 'google.co.uk': 'Google',
        'bing.com': 'Bing', 'yahoo.com': 'Yahoo', 'duckduckgo.com': 'DuckDuckGo',
        'instagram.com': 'Instagram', 'facebook.com': 'Facebook', 'meta.com': 'Facebook',
        'linkedin.com': 'LinkedIn', 'twitter.com': 'X (Twitter)', 'x.com': 'X (Twitter)',
        'tiktok.com': 'TikTok', 'youtube.com': 'YouTube'
      };
      return domainMap[host] || host;
    } catch(e) { return referrer; }
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
      // Form sends "+XX XXXXXXXXX" — strip dial code, keep number only
      const raw = p.phone.replace(/[\s\-().]/g, '');
      // If starts with +, pass as-is — Monday handles international format
      return { phone: raw, countryShortName: 'GB' };
    })() : {},

    // ── Stay details ───────────────────────────────────────────
    date47:              p.check_in  ? { date: p.check_in  } : {},
    date_1:              p.check_out ? { date: p.check_out } : {},
    budget_per_week:     formatBudget(p.budget) !== p.budget ? formatBudget(p.budget) : (p.budget || ''),
    text8:               formatCity(p.city)     || '',
    dropdown6:           p.apartment_ref        || '',
    apt_type_mkmn4bgg:   formatAptType(p.apartment_type) || '',
    dropdown19:          p.areas || '',
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
    text_mm1c3b5w:       p.utm_campaign  || '',
    text43__1:           p.utm_adgroup   || '',
    text3__1:            p.utm_term      || '',
    text_mm1d87rp:       p.utm_matchtype || '',
    text4__1:            p.gclid || p.fbclid || '',
    text_mm1jhhe7:       p.landing_page  || '',
    long_text__1:        p.visited_paths || '',

    // ── Lead source ────────────────────────────────────────────
    ...(leadSource  && { color_mkxk8y67:    { label: leadSource } }),
    ...(leadChannel && { dropdown_mkxkfbff: { labels: [leadChannel] } }),
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
