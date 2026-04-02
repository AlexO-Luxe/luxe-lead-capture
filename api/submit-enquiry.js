// ============================================================
//  Student Luxe — Enquiry Submit + Email Handler
//  Deploy to: /api/submit-enquiry.js in your Vercel project
//
//  Environment variables required (set in Vercel dashboard):
//    RESEND_API_KEY      = re_KKJUoUXw_NDrM1CQmCFyJfCSWjeLdNWqQ
//    TEAM_EMAIL          = alex@studentluxe.co.uk
//    FROM_EMAIL          = reservations@studentluxe.co.uk
//    FROM_NAME           = Student Luxe Apartments
//    SITE_URL            = https://www.studentluxe.co.uk
// ============================================================

const RESEND_API = 'https://api.resend.com/emails';

export default async function handler(req, res) {

  // CORS — allow your Squarespace domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const p = req.body;

  try {
    // ── Send both emails in parallel ────────────────────────
    await Promise.all([
      sendGuestConfirmation(p),
      sendTeamNotification(p)
    ]);

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Email send error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
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
    <h1 style="margin:0 0 8px;font-family:Georgia,serif;font-size:28px;font-weight:400;color:#f0ece2;line-height:1.15;white-space:nowrap;">We've received your enquiry</h1>
    <p style="margin:0;font-size:13px;color:rgba(240,236,226,0.5);font-weight:300;">Our Reservations team will reach out shortly.</p>
  </td></tr>

  <!-- BODY -->
  <tr><td style="background:#ffffff;padding:32px 40px;">
    <p style="margin:0 0 16px;font-size:14px;color:#1a1a1a;line-height:1.7;">Dear ${escHtml(firstName)},</p>
    ${isTypeA ? `
    <p style="margin:0 0 16px;font-size:14px;color:#1a1a1a;line-height:1.7;">Thank you for your enquiry about <strong>${escHtml(p.apartment_ref || 'your chosen apartment')}</strong> — we're currently checking the latest availability and pricing for your dates.</p>
    <p style="margin:0 0 20px;font-size:14px;color:#1a1a1a;line-height:1.7;">A member of our Reservations team will be in touch within 24 hours (10am–6pm GMT, Mon–Fri) to confirm these details, and discuss any other options that might suit your needs.</p>
    <p style="margin:0 0 20px;font-size:14px;color:#1a1a1a;line-height:1.7;">We look forward to helping you find your perfect apartment!</p>
    ` : `
    <p style="margin:0 0 16px;font-size:14px;color:#1a1a1a;line-height:1.7;">Thank you for your ${escHtml(formatCity(p.city))} apartment enquiry. A member of our Reservations team will be in touch within 24 hours (10am–6pm GMT, Mon–Fri) to discuss this further.</p>
    <p style="margin:0 0 20px;font-size:14px;color:#1a1a1a;line-height:1.7;">We look forward to helping you find your perfect apartment!</p>
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

    <p style="margin:0;font-size:12px;color:#9b9b9b;line-height:1.6;">If you didn't submit this enquiry, please disregard this email. Your details are safe and will never be shared with third parties.</p>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#f7f2eb;padding:18px 40px;border-top:0.5px solid rgba(184,150,110,0.2);">
    <p style="margin:0;font-size:11px;color:#9b9b9b;line-height:1.9;">
      Student Luxe Apartments<br>
      Dog &amp; Duck Yard, Princeton St, London, WC1R 4BH<br>
      +44 (0)203 007 0017 &nbsp;·&nbsp; Mon–Fri, 10am–6pm GMT<br>
      © 2026 Student Luxe Apartments. All rights reserved.
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  return resendSend({
    from:    `${process.env.FROM_NAME || 'Student Luxe'} <${process.env.FROM_EMAIL}>`,
    to:      [p.email],
    subject: isTypeA
      ? `Your enquiry about ${p.apartment_ref || 'your apartment'} — Student Luxe Apartments`
      : `Your Student Luxe Apartments enquiry — we're on it`,
    html
  });
}

// ──────────────────────────────────────────────────────────────
//  EMAIL 2 — Team notification
// ──────────────────────────────────────────────────────────────
async function sendTeamNotification(p) {
  const isTypeA   = p.enquiry_type === 'A';
  const badgeColor = isTypeA ? '#0F6E56' : '#B8966E';
  const badgeBg   = isTypeA ? 'rgba(29,158,117,0.15)' : 'rgba(184,150,110,0.15)';
  const badgeLabel = isTypeA ? 'Option A — Book specific apartment' : 'Option B — Send options';
  const guestName = p.full_name || 'New enquiry';
  const nightCount = nights(p);

  const field = (label, value) => value ? `
    <td style="padding:0 20px 14px 0;vertical-align:top;width:50%;">
      <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.1em;color:#9b9b9b;text-transform:uppercase;">${label}</p>
      <p style="margin:0;font-size:13px;color:#1a1a1a;font-weight:500;">${escHtml(String(value))}</p>
    </td>` : '';

  const trackingRows = [
    ['utm_source',   p.utm_source],
    ['utm_medium',   p.utm_medium],
    ['utm_campaign', p.utm_campaign],
    ['utm_term',     p.utm_term],
    ['gclid',        p.gclid],
    ['fbclid',       p.fbclid],
    ['landing_page', p.landing_page],
    ['submit_page',  p.submit_page],
    ['submitted_at', p.submitted_at ? new Date(p.submitted_at).toUTCString() : ''],
  ].filter(([,v]) => v).map(([k,v]) =>
    `<tr><td style="padding:3px 12px 3px 0;font-size:11px;color:#9b9b9b;white-space:nowrap;">${k}</td><td style="padding:3px 0;font-size:11px;color:#1a1a1a;">${escHtml(v)}</td></tr>`
  ).join('');

  // WhatsApp link
  const phoneRaw = (p.phone || '').replace(/\D/g, '');
  const waLink = phoneRaw ? `https://wa.me/${phoneRaw}?text=${encodeURIComponent(`Hi ${(p.full_name||'').split(' ')[0]}, thanks for your enquiry with Student Luxe. We'd love to help you find the perfect apartment — do you have a moment to chat?`)}` : null;

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
        <p style="margin:2px 0 0;font-size:11px;color:rgba(240,236,226,0.45);">New enquiry · ${new Date().toLocaleDateString('en-GB', {day:'numeric',month:'long',year:'numeric'})}</p>
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
  ${trackingRows ? `<tr><td style="background:#ffffff;padding:22px 28px;border-bottom:0.5px solid #ede9e3;">
    <p style="margin:0 0 10px;font-size:10px;letter-spacing:0.18em;color:#B8966E;text-transform:uppercase;">Tracking</p>
    <table cellpadding="0" cellspacing="0" style="background:#f7f2eb;border-radius:8px;padding:10px 16px;width:100%;font-family:monospace;">${trackingRows}</table>
  </td></tr>` : ''}

  <!-- CTA BUTTONS -->
  <tr><td style="background:#f7f2eb;padding:16px 28px;">
    <table cellpadding="0" cellspacing="0"><tr style="gap:8px;">
      ${waLink ? `<td style="padding-right:8px;"><a href="${waLink}" style="display:inline-block;padding:10px 20px;background:#25D366;border-radius:8px;font-size:12px;font-weight:500;color:#ffffff;text-decoration:none;">Reply on WhatsApp</a></td>` : ''}
      <td style="padding-right:8px;"><a href="mailto:${p.email}" style="display:inline-block;padding:10px 20px;background:#B8966E;border-radius:8px;font-size:12px;font-weight:500;color:#ffffff;text-decoration:none;">Reply by email</a></td>
      <td><a href="mailto:${p.email}?subject=Re: Your Student Luxe enquiry" style="display:inline-block;padding:10px 20px;background:#ffffff;border:0.5px solid rgba(184,150,110,0.4);border-radius:8px;font-size:12px;font-weight:500;color:#1a1a1a;text-decoration:none;">View in CRM</a></td>
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
    subject: `New enquiry — ${guestName}${p.city ? ' · ' + formatCity(p.city) : ''}`,
    html
  });
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
    'student':'Student','young-professional':'Young professional',
    'corporate':'Corporate','parent':'Parent / guardian','other-stay':'Other'
  };
  const label = map[type] || type;
  return university ? `${label} · ${university}` : label;
}
