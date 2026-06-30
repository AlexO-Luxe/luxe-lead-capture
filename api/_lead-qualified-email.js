// _lead-qualified-email.js
//
// VENDORED COPY of render-lead-qualified.js from the canonical repo
// AlexO-Luxe/luxe-emails. Keep the two in sync: edit there, copy here.
//
// Builds the "Lead Qualified" internal notification email from a normalised
// lead object. Pure function, no I/O. Pass it data, get back { subject, html }.
// Used by api/test-lead-qualified.js and (later) the Monday status webhook.
//
// No em dashes in output copy. Table-based, inline-styled, email-client safe.

const BRAND = {
  navy:   '#0d1a2e',
  navy2:  '#13233d',
  gold:   '#B8966E',
  cream:  '#f4f1ec',
  panel:  '#f7f2eb',
  green:  '#417505',
  greenL: '#9ed36a',
  amber:  '#e0a64b',
  ink:    '#1a1a1a',
  muted:  '#9b9b9b',
  logoWhite: 'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/4d6b8086-53ed-4d17-b8f7-20f67be76f41/luxe-white.png?content-type=image%2Fpng'
};

function escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// "2d 5h" style duration between two Date/ISO values
function formatDuration(fromVal, toVal) {
  const from = new Date(fromVal), to = new Date(toVal);
  let mins = Math.max(0, Math.round((to - from) / 60000));
  const d = Math.floor(mins / 1440); mins -= d * 1440;
  const h = Math.floor(mins / 60);   mins -= h * 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mins}m`;
  return `${mins} min`;
}

function fmtDate(val) {
  return new Date(val).toLocaleString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
  });
}
function fmtDateTime(val) {
  return new Date(val).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}
function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2)
    .map(w => w[0]).join('').toUpperCase() || '?';
}
function gbp(n) {
  return '£' + Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

/**
 * @param {object} lead
 *   guestName, contactPhone, contactEmail
 *   createdAt, qualifiedAt            (ISO strings / Date)
 *   qualifiedBy, assignedTo, assignedToRole
 *   source, campaign                  (e.g. "Google Ads / PPC", "London / Marylebone / Sept")
 *   nights, weeklyRate, budgetNote, guests
 *   checkIn, checkOut, location
 *   teamAvgCooking ("3d 14h")
 *   visitedPaths: string[]            (the Leads board "visited paths" column, in order)
 *   notes: [{ author, at, text, kind }]   kind: 'open' | 'mid' | 'qualified'
 *   nextAction, nextActionDue
 *   mondayUrl, whatsappUrl
 */
function renderLeadQualified(lead) {
  const cookingTime = formatDuration(lead.createdAt, lead.qualifiedAt);

  const dotFor = kind =>
    kind === 'qualified' ? BRAND.green : kind === 'open' ? BRAND.gold : '#cdb893';

  const notesHtml = (lead.notes || []).map((n, i, arr) => {
    const last = i === arr.length - 1;
    const connector = last ? '' :
      `<div style="width:1px;height:100%;background:#ede9e3;margin:2px 0 0 4px;min-height:24px;"></div>`;
    return `
    <table width="100%" cellpadding="0" cellspacing="0"${last ? '' : ' style="margin-bottom:2px;"'}><tr>
      <td width="22" style="vertical-align:top;padding-top:3px;">
        <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${dotFor(n.kind)};"></span>
        ${connector}
      </td>
      <td style="vertical-align:top;padding:0 0 ${last ? '4' : '16'}px 8px;">
        ${(n.author || n.at) ? `<p style="margin:0 0 3px;font-size:11px;color:${BRAND.muted};">${n.author ? `<span style="color:${BRAND.ink};font-weight:600;">${escHtml(n.author)}</span>` : ''}${(n.author && n.at) ? ' &middot; ' : ''}${n.at ? escHtml(n.at) : ''}</p>` : ''}
        <p style="margin:0;font-size:13px;color:#3a3a3a;line-height:1.55;word-break:break-word;overflow-wrap:anywhere;">${escHtml(n.text)}</p>
      </td>
    </tr></table>`;
  }).join('');

  // Visited paths block, sourced from the Leads board "visited paths" column.
  const paths = Array.isArray(lead.visitedPaths) ? lead.visitedPaths.filter(Boolean) : [];
  const pathsHtml = paths.length ? `
  <tr><td style="background:#ffffff;padding:18px 32px 0;" class="le-pad">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.panel};border-radius:10px;border-left:3px solid ${BRAND.gold};"><tr><td style="padding:13px 18px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:7px;"><tr>
        <td><p style="margin:0;font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.muted};">Visited Paths</p></td>
        <td style="text-align:right;"><p style="margin:0;font-size:10px;color:${BRAND.muted};">${paths.length} ${paths.length === 1 ? 'page' : 'pages'} before enquiry</p></td>
      </tr></table>
      <p style="margin:0;font-size:12px;color:#3a3a3a;line-height:1.7;word-break:break-word;overflow-wrap:anywhere;">${paths.map((p, i) =>
        `<span style="color:${i === paths.length - 1 ? BRAND.ink : BRAND.gold};font-weight:${i === paths.length - 1 ? '600' : '400'};">${escHtml(p)}</span>`
      ).join(' &rarr; ')}</p>
    </td></tr></table>
  </td></tr>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lead Qualified: ${escHtml(lead.guestName)} | Student Luxe</title>
<style>
  @media only screen and (max-width:600px){
    .le-wrap{padding:0 !important;}
    .le-card{border-radius:0 !important;border-left:none !important;border-right:none !important;}
    .le-pad{padding-left:22px !important;padding-right:22px !important;}
    .le-stack{display:block !important;width:100% !important;}
    .le-hcol{display:block !important;width:100% !important;}
    .le-hlogo{display:block !important;width:100% !important;text-align:left !important;padding-top:16px !important;}
    .le-hlogo img{margin-left:0 !important;}
    .le-cta{display:block !important;width:100% !important;margin:0 0 8px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.cream};font-family:'DM Sans',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escHtml(lead.guestName)} qualified by ${escHtml(lead.qualifiedBy)} &middot; cooked in ${cookingTime} &middot; assigned to ${escHtml(lead.assignedTo)} &middot; ${escHtml(lead.location)}, ${escHtml(lead.nights)} nights</div>

<table width="100%" cellpadding="0" cellspacing="0" class="le-wrap" style="background:${BRAND.cream};padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" class="le-card" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">

  <!-- HEADER -->
  <tr><td style="background:${BRAND.navy};padding:26px 32px 24px;" class="le-pad">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td class="le-hcol" style="vertical-align:top;">
        <span style="display:inline-block;background:rgba(65,117,5,0.18);border:0.5px solid rgba(126,196,55,0.45);border-radius:100px;padding:4px 11px;font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.greenL};font-weight:600;">&#9679;&nbsp; Lead Qualified</span>
        <h1 style="margin:14px 0 2px;font-family:Georgia,serif;font-size:26px;font-weight:400;color:#f0ece2;letter-spacing:-0.02em;line-height:1.15;">${escHtml(lead.guestName)}</h1>
        <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.5);line-height:1.5;">Qualified by <span style="color:${BRAND.gold};font-weight:600;">${escHtml(lead.qualifiedBy)}</span> &middot; ${fmtDateTime(lead.qualifiedAt)}</p>
      </td>
      <td class="le-hlogo" style="text-align:right;vertical-align:top;width:120px;">
        <img src="${BRAND.logoWhite}" alt="Student Luxe" style="height:30px;width:auto;display:block;margin-left:auto;">
      </td>
    </tr></table>
  </td></tr>

  <!-- LEAD COOKING TIME -->
  <tr><td style="background:#ffffff;padding:24px 32px 0;" class="le-pad">
    <p style="margin:0 0 11px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${BRAND.gold};">Lead Cooking Time</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.panel};border-radius:10px;"><tr><td style="padding:16px 18px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td class="le-stack" width="40%" style="vertical-align:middle;">
          <p style="margin:0;font-family:Georgia,serif;font-size:28px;font-weight:400;color:${BRAND.ink};letter-spacing:-0.02em;line-height:1;">${escHtml(cookingTime)}</p>
          ${lead.teamAvgCooking ? `<p style="margin:6px 0 0;font-size:11px;color:${BRAND.green};">vs team avg ${escHtml(lead.teamAvgCooking)}</p>` : ''}
        </td>
        <td class="le-stack" width="60%" style="vertical-align:middle;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${BRAND.muted};"></span></td>
            <td style="padding-left:9px;"><p style="margin:0;font-size:12px;color:#3a3a3a;"><span style="color:${BRAND.muted};">Created</span>&nbsp;&nbsp;${fmtDateTime(lead.createdAt)}</p></td>
          </tr></table>
          <div style="width:1px;height:9px;background:${BRAND.gold};opacity:0.5;margin:2px 0 2px 3px;"></div>
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${BRAND.green};"></span></td>
            <td style="padding-left:9px;"><p style="margin:0;font-size:12px;color:#3a3a3a;"><span style="color:${BRAND.muted};">Qualified</span>&nbsp;&nbsp;${fmtDateTime(lead.qualifiedAt)}</p></td>
          </tr></table>
        </td>
      </tr></table>
    </td></tr></table>
  </td></tr>

  <!-- ASSIGNMENT / SOURCE -->
  <tr><td style="background:#ffffff;padding:24px 32px 0;" class="le-pad">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td class="le-stack" width="50%" style="vertical-align:top;padding-right:8px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.panel};border-radius:10px;"><tr><td style="padding:14px 16px;">
          <p style="margin:0 0 8px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.gold};">Assigned To</p>
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;"><span style="display:inline-block;width:34px;height:34px;border-radius:50%;background:${BRAND.gold};color:#fff;font-size:13px;font-weight:600;text-align:center;line-height:34px;">${escHtml(initials(lead.assignedTo))}</span></td>
            <td style="vertical-align:middle;padding-left:11px;">
              <p style="margin:0;font-size:14px;color:${BRAND.ink};font-weight:600;">${escHtml(lead.assignedTo)}</p>
              <p style="margin:1px 0 0;font-size:11px;color:${BRAND.muted};">${escHtml(lead.assignedToRole || 'Reservations')} &middot; owner</p>
            </td>
          </tr></table>
        </td></tr></table>
      </td>
      <td class="le-stack" width="50%" style="vertical-align:top;padding-left:8px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.panel};border-radius:10px;"><tr><td style="padding:14px 16px;">
          <p style="margin:0 0 8px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.gold};">Lead Source</p>
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;"><span style="display:inline-block;width:34px;height:34px;border-radius:8px;background:${BRAND.navy};color:#fff;font-size:14px;text-align:center;line-height:34px;">&#9733;</span></td>
            <td style="vertical-align:middle;padding-left:11px;">
              <p style="margin:0;font-size:14px;color:${BRAND.ink};font-weight:600;">${escHtml(lead.source)}${lead.sourceFirstTouch ? ` <span style="color:${BRAND.muted};font-weight:400;">(${escHtml(lead.sourceFirstTouch)})</span>` : ''}</p>
              <p style="margin:1px 0 0;font-size:11px;color:${BRAND.muted};">${escHtml(lead.campaign || '')}</p>
            </td>
          </tr></table>
        </td></tr></table>
      </td>
    </tr></table>
  </td></tr>

  <!-- STAY DETAILS -->
  <tr><td style="background:#ffffff;padding:22px 32px 0;" class="le-pad">
    <p style="margin:0 0 11px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${BRAND.gold};">Stay &amp; Guest Details</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:0.5px solid #ede9e3;border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;">
      <tr>
        <td width="50%" style="padding:11px 16px;border-bottom:0.5px solid #f0ece3;border-right:0.5px solid #f0ece3;"><p style="margin:0 0 2px;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.muted};">Check-in</p><p style="margin:0;font-size:13px;color:${BRAND.ink};font-weight:500;">${fmtDate(lead.checkIn)}</p></td>
        <td width="50%" style="padding:11px 16px;border-bottom:0.5px solid #f0ece3;"><p style="margin:0 0 2px;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.muted};">Check-out</p><p style="margin:0;font-size:13px;color:${BRAND.ink};font-weight:500;">${fmtDate(lead.checkOut)}</p></td>
      </tr>
      <tr>
        <td style="padding:11px 16px;border-bottom:0.5px solid #f0ece3;border-right:0.5px solid #f0ece3;"><p style="margin:0 0 2px;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.muted};">Length of stay</p><p style="margin:0;font-size:13px;color:${BRAND.ink};font-weight:500;">${escHtml(lead.nights)} nights &middot; ${escHtml(lead.guests || 1)} guests</p></td>
        <td style="padding:11px 16px;border-bottom:0.5px solid #f0ece3;"><p style="margin:0 0 2px;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.muted};">Location wanted</p><p style="margin:0;font-size:13px;color:${BRAND.ink};font-weight:500;">${escHtml(lead.location)}</p></td>
      </tr>
      <tr>
        <td style="padding:11px 16px;border-right:0.5px solid #f0ece3;"><p style="margin:0 0 2px;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.muted};">Budget</p><p style="margin:0;font-size:13px;color:${BRAND.ink};font-weight:500;">${gbp(lead.weeklyRate)}/week ${lead.budgetNote ? `<span style="color:${BRAND.muted};font-weight:400;">(${escHtml(lead.budgetNote)})</span>` : ''}</p></td>
        <td style="padding:11px 16px;"><p style="margin:0 0 2px;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.muted};">Contact</p><p style="margin:0;font-size:13px;color:${BRAND.ink};font-weight:500;">${escHtml(lead.contactPhone)}</p></td>
      </tr>
    </table>
  </td></tr>

  <!-- VISITED PATHS (leads board column) -->
  ${pathsHtml}

  <!-- SALES PROGRESS NOTES -->
  <tr><td style="background:#ffffff;padding:24px 32px 0;" class="le-pad">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;"><tr>
      <td><p style="margin:0;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${BRAND.gold};">Sales Progress Notes</p></td>
      <td style="text-align:right;"><p style="margin:0;font-size:10px;color:${BRAND.muted};">${(lead.notes || []).length} updates</p></td>
    </tr></table>
    ${notesHtml}
  </td></tr>

  <!-- NEXT ACTION + CTAs -->
  <tr><td style="background:#ffffff;padding:22px 32px 4px;" class="le-pad">
    ${lead.nextAction ? `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fbf4e8;border:0.5px solid #ecd9b6;border-radius:10px;margin-bottom:18px;"><tr><td style="padding:12px 16px;">
      <p style="margin:0;font-size:12px;color:#8a6d2f;line-height:1.5;"><span style="font-weight:700;">Next action${lead.nextActionDue ? ` &middot; due ${escHtml(lead.nextActionDue)}` : ''}:</span> ${escHtml(lead.nextAction)}</p>
    </td></tr></table>` : ''}
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td align="center"><a href="${escHtml(lead.mondayUrl || '#')}" style="display:block;background:${BRAND.navy};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:13px 8px;border-radius:8px;text-align:center;">Open in Monday</a></td>
    </tr></table>
    <div style="height:24px;"></div>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:${BRAND.navy};padding:18px 32px;text-align:center;" class="le-pad">
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.45);line-height:1.8;">Student Luxe Apartments &middot; Internal lead notification<br>Triggered by Monday automation when status changes to <span style="color:${BRAND.gold};">Qualified</span></p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  const subject = `✓ Lead qualified: ${lead.guestName} - by ${lead.qualifiedBy}`;

  return { subject, html };
}

module.exports = { renderLeadQualified, formatDuration, escHtml };
