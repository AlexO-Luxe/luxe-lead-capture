// _lead-qualified-email.js
//
// THE canonical Lead Qualified email template. This file started as a copy of
// render-lead-qualified.js in AlexO-Luxe/luxe-emails, but has since gained the
// Booking Agreed block and section renames, and (per Alex, 2026-07-29) THIS is
// now the only version. Do not sync from luxe-emails: its copy is outdated.
// Edit here, nowhere else.
//
// Builds the "Lead Qualified" internal notification email from a normalised
// lead object. Pure function, no I/O. Pass it data, get back { subject, html }.
// Used by api/test-lead-qualified.js and the live delay-queue flush
// (api/lead-qualified-flush.js via _lead-qualified-data.js).
//
// No em dashes in output copy. Table-based, inline-styled, email-client safe.

const BRAND = {
  navy:   '#0d1a2e',
  navy2:  '#13233d',
  gold:   '#B8966E',
  goldLabel: '#8B6E4E',
  goldSoft:  'rgba(184,150,110,0.35)',
  cream:  '#EDE9E1',
  panel:  '#FBF8F2',
  green:  '#417505',
  greenL: '#9ed36a',
  amber:  '#e0a64b',
  ink:    '#1a1a1a',
  muted:  '#9b9b9b',
  logoWhite: 'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/4d6b8086-53ed-4d17-b8f7-20f67be76f41/luxe-white.png?content-type=image%2Fpng',
  // Same wordmark and photo wash as the enquiry emails, so every internal
  // notification reads as one family.
  wordmark:  'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/3b2d0218-5cf8-4041-8460-2ec2228c864b/Logo+White+website.png?content-type=image%2Fpng',
  bandPhoto: 'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/1709156541414-LL1XG1IVRXX4IXKZWPHR/12.+3++Bed+Westminster+Amphora+Apartments+Bed.jpg?content-type=image%2Fjpeg',
  headerPhoto: 'https://images.squarespace-cdn.com/content/v1/5de66dfc5511bf790e4476bd/886169ef-649a-4d18-bb36-aadf18dd4d40/new-office-002-2.jpg?format=1000w'
};

// Headshots from studentluxe.co.uk/meet-the-team, keyed by full name as it
// appears on the Monday assignee. Anyone missing falls back to a gold initials
// disc, so a new starter never breaks the layout. Keep in step with the page.
const TEAM_PHOTOS = {
  'Sam Smithies':         'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/1576ec6c-4743-4e3f-998f-11ed3e818e74/team%3ASam.jpg',
  'Edoardo Martelli':     'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/2ed7e4c3-9b2b-496c-aaef-14d174695a9e/edo-team.jpg',
  'Lina Staugaityte':     'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/149f2c5c-4d51-47e6-beea-be191c82e207/Lina-student-luxe-team.jpg',
  'Rongrong Luo':         'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/9be6b8d9-399a-41ea-9820-7292033a2680/rongrong-student-luxe.jpg',
  'Stefan Hrebenciuc':    'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/80aa6dbf-ddda-472f-855e-2d5329001a3a/stefan-student-luxe.jpg',
  'Jessica Charriz':      'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/826c78af-c970-496d-b534-0b7d02218e19/Jessica-team.jpg',
  'Joe Li':               'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/73adf913-5d3e-480d-b381-6c725ff98d80/joe-team.jpg',
  'Michele Gargiulo':     'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/8b5b6bdb-8804-43fb-a877-157601e05709/michele-team.jpg',
  'Sarika Clemmow':       'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/d1ae4835-54bb-4c05-b133-e599aa2a19d8/sarika-team.jpg',
  'Josh Danan':           'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/cdda286e-7fa7-4469-8c7b-ed4395073168/Joshua-Danan-Student-Luxe.jpg',
  'Paige Grinter':        'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/54094f14-2f02-479b-b1ba-5e01bbab2afd/Paige-student-luxe-1.jpg',
  'Dana Danan':           'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/82439802-83de-480a-926a-db9c44a6afe0/dana-team.jpg',
  'George Toskov':        'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/d29d869f-eca2-4386-aba3-3eafa0d86ad4/George-student-luxe.jpg',
  'Lillian Cheng':        'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/82c434f9-e292-4bd7-85ca-d83c493ff2dd/Lillian-team.jpeg',
  'Aleksandra Bitjukova': 'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/ed65180e-4245-45cf-ac1c-151aa93e84a4/Aleks-student-luxe.jpeg',
  'Alessandra Weigel':    'https://images.squarespace-cdn.com/content/5de66dfc5511bf790e4476bd/bd615afa-3a33-4ea3-b1ac-73993ebe4794/alessandra-team.jpg',
};

// Exact match first, then first name, so "Sarika" still finds Sarika Clemmow.
function headshotFor (name) {
  const n = String(name || '').trim();
  if (!n) return null;
  if (TEAM_PHOTOS[n]) return TEAM_PHOTOS[n];
  const first = n.split(/\s+/)[0].toLowerCase();
  const hit = Object.keys(TEAM_PHOTOS).find(k => k.split(/\s+/)[0].toLowerCase() === first);
  return hit ? TEAM_PHOTOS[hit] : null;
}

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
 *   booking: {                          Booking Flow board row, null if none yet
 *     apartment, checkIn, checkOut, nights, nightlyRate,
 *     commission, commissionEstimated, status, url
 *   }
 *   nextAction, nextActionDue
 *   mondayUrl, whatsappUrl
 */
function renderLeadQualified(lead) {
  // Under 24 hours reads as "Same day": the exact hour count adds nothing
  // when the win is simply that it closed same-day. Stage timeline rows keep
  // their precise durations, only the headline stat rounds up.
  const cookingMs   = new Date(lead.qualifiedAt) - new Date(lead.createdAt);
  const cookingTime = (cookingMs >= 0 && cookingMs < 86400000)
    ? 'Same day'
    : formatDuration(lead.createdAt, lead.qualifiedAt);
  const ownerPhoto  = headshotFor(lead.assignedTo);

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

  // Stage timeline rows for the Lead Cooking Time section. Falls back to a
  // simple Created -> Qualified pair when no timeline was supplied.
  const toneColor = { muted: BRAND.muted, gold: BRAND.gold, amber: BRAND.amber, green: BRAND.green };
  const tl = (Array.isArray(lead.timeline) && lead.timeline.length)
    ? lead.timeline
    : [{ label: 'Created', at: lead.createdAt, tone: 'muted' },
       { label: 'Qualified', at: lead.qualifiedAt, tone: 'green' }];
  const timelineRowsHtml = tl.map((r, i) => {
    const connector = i === tl.length - 1 ? ''
      : `<div style="width:1px;height:9px;background:${BRAND.gold};opacity:0.5;margin:2px 0 2px 3px;"></div>`;
    return `<table cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${toneColor[r.tone] || BRAND.muted};"></span></td>
            <td style="padding-left:9px;"><p style="margin:0;font-size:12px;color:#3a3a3a;"><span style="color:${BRAND.muted};">${escHtml(r.label)}</span>&nbsp;&nbsp;${fmtDateTime(r.at)}</p></td>
          </tr></table>${connector}`;
  }).join('');

  // Booking Flow board detail, present once the salesperson has started the
  // booking row (usually within minutes of qualifying, which is why this email
  // is held back before sending). Omitted entirely when there is no row yet.
  const bk = lead.booking || null;
  const pend = v => (v === null || v === undefined || v === '')
    ? `<span style="color:${BRAND.muted};font-weight:400;">Not set yet</span>` : null;
  const bkCell = (label, valueHtml, opts = {}) => `
        <td width="${opts.width || '50%'}"${opts.colspan ? ` colspan="${opts.colspan}"` : ''} style="padding:11px 16px;${opts.last ? '' : 'border-bottom:0.5px solid #f0ece3;'}${opts.noRight ? '' : 'border-right:0.5px solid #f0ece3;'}">
          <p style="margin:0 0 2px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.muted};">${label}</p>
          <p style="margin:0;font-size:12.5px;color:${BRAND.ink};font-weight:500;word-break:break-word;">${valueHtml}</p>
        </td>`;
  const bookingHtml = bk ? `
  <tr><td style="background:#ffffff;padding:24px 32px 0;" class="le-pad">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:11px;"><tr>
      <td><p style="margin:0;font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.goldLabel};">Booking Agreed</p></td>
      <td style="text-align:right;"><p style="margin:0;font-size:10px;color:${BRAND.muted};">Booking Flow board${bk.status ? ` &middot; ${escHtml(bk.status)}` : ''}</p></td>
    </tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.goldSoft};border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;">
      <tr>${bkCell('Apartment agreed', pend(bk.apartment) || escHtml(bk.apartment), { width: '100%', colspan: 2, noRight: true })}</tr>
      <tr>
        ${bkCell('Check-in', pend(bk.checkIn) || fmtDate(bk.checkIn))}
        ${bkCell('Number of nights', pend(bk.nights) || `${escHtml(bk.nights)} nights`, { noRight: true })}
      </tr>
      <tr>
        ${bkCell('Agreed nightly rate', pend(bk.nightlyRate) || `${gbp(bk.nightlyRate)}/night`, { last: true })}
        <td style="padding:11px 16px;background:#fbf7f1;">
          <p style="margin:0 0 2px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.muted};">Total Luxe commission</p>
          ${(bk.commission === null || bk.commission === undefined || bk.commission === '')
            ? `<p style="margin:0;font-size:11px;color:${BRAND.muted};font-weight:400;line-height:1.4;">${escHtml(bk.salesperson || 'The salesperson')} has not filled this in on Booking Flow yet</p>`
            : `<p style="margin:0;font-size:15px;color:${BRAND.ink};font-weight:700;">${gbp(bk.commission)}${
                bk.commissionEstimated ? ` <span style="font-size:10px;color:${BRAND.muted};font-weight:400;">est.</span>` : ''}</p>`}
        </td>
      </tr>
    </table>
    ${bk.url ? `<p style="margin:7px 0 0;font-size:11px;color:${BRAND.muted};"><a href="${escHtml(bk.url)}" style="color:${BRAND.gold};text-decoration:none;">Open the booking row &rarr;</a></p>` : ''}
  </td></tr>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Lead Qualified: ${escHtml(lead.guestName)} | Student Luxe</title>
<style>
  :root{color-scheme:light dark;supported-color-schemes:light dark}
  .le-dark{background-color:#000000!important}
  .le-on-dark{color:#ffffff!important}
  @media (prefers-color-scheme:dark){
    .le-dark{background-color:#000000!important}
    .le-on-dark{color:#ffffff!important}
  }
  @media only screen and (max-width:600px){
    .le-wrap{padding:0 !important;}
    .le-card{border-radius:0 !important;border-left:none !important;border-right:none !important;}
    .le-pad{padding-left:14px !important;padding-right:14px !important;}
    .le-hlogo-img{height:19px !important;}
    .le-cook{display:block !important;width:100% !important;text-align:left !important;padding-top:12px !important;}
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

  <!-- HEADER: single centred band, same treatment as the enquiry emails. The
       wordmark is white artwork, so this band stays dark in every scheme and
       Outlook falls back to the bgcolor. -->
  <tr><td class="le-pad le-dark" bgcolor="#000000" background="${BRAND.headerPhoto}" style="background-color:#000000;background-image:linear-gradient(rgba(0,0,0,.55),rgba(0,0,0,.55)),url('${BRAND.headerPhoto}');background-size:cover;background-position:center;background-repeat:no-repeat;padding:20px 32px 20px;text-align:center;">
    <img class="le-hlogo-img" src="${BRAND.wordmark}" alt="Student Luxe" height="22" style="height:22px;width:auto;max-width:100%;display:block;margin:0 auto 20px;">
    <p style="margin:0 0 8px;"><span style="display:inline-block;background:rgba(65,117,5,0.22);border:0.5px solid rgba(126,196,55,0.45);border-radius:100px;padding:4px 12px;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${BRAND.greenL};font-weight:500;">&#9679;&nbsp; Lead Qualified</span></p>
    <p class="le-on-dark" style="margin:0 0 5px;font-family:Georgia,serif;font-size:24px;color:#ffffff;letter-spacing:-0.035em;line-height:1.2;">${escHtml(lead.guestName)}</p>
    <p class="le-on-dark" style="margin:0;font-size:11.5px;color:rgba(255,255,255,0.6);line-height:1.5;">Qualified by <span style="color:#D4B896;">${escHtml(lead.qualifiedBy)}</span> &middot; ${fmtDateTime(lead.qualifiedAt)}</p>
  </td></tr>

  <!-- OWNER STRIP: who has the lead, how long it took, where it came from.
       One panel instead of three, per the approved option 1. -->
  <tr><td class="le-pad" style="background:#ffffff;padding:22px 32px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.panel};border-radius:10px;"><tr><td style="padding:16px 18px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;width:52px;padding-right:14px;">
          ${ownerPhoto
            ? `<img src="${escHtml(ownerPhoto)}" alt="${escHtml(lead.assignedTo)}" width="52" height="52" style="width:52px;height:52px;border-radius:50%;object-fit:cover;display:block;">`
            : `<span style="display:inline-block;width:52px;height:52px;border-radius:50%;background:${BRAND.gold};color:#fff;font-size:16px;font-weight:600;text-align:center;line-height:52px;">${escHtml(initials(lead.assignedTo))}</span>`}
        </td>
        <td style="vertical-align:middle;">
          <p style="margin:0 0 2px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:#9b8f7d;">Assigned to</p>
          <p style="margin:0;font-size:15px;font-weight:500;color:${BRAND.ink};">${escHtml(lead.assignedTo)}</p>
          <p style="margin:1px 0 0;font-size:11.5px;color:${BRAND.muted};">${escHtml(lead.assignedToRole || 'Reservations')}</p>
        </td>
        <td class="le-cook" style="text-align:right;vertical-align:middle;">
          <p style="margin:0 0 2px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:#9b8f7d;">Cooking time</p>
          <p style="margin:0;font-family:Georgia,serif;font-size:22px;color:${BRAND.ink};letter-spacing:-0.02em;line-height:1;">${escHtml(cookingTime)}</p>
          ${lead.teamAvgCooking ? `<p style="margin:4px 0 0;font-size:11px;color:${BRAND.green};">vs avg ${escHtml(lead.teamAvgCooking)}</p>` : ''}
        </td>
      </tr></table>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 0;"><tr><td style="border-top:1px solid rgba(184,150,110,0.25);padding-top:11px;">
        <p style="margin:0;font-size:12px;color:#6b6b6b;line-height:1.6;"><span style="font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:#9b8f7d;">Source</span>&nbsp;&nbsp;<span style="color:${BRAND.ink};font-weight:500;">${escHtml(lead.source)}</span>${lead.sourceFirstTouch ? ` <span style="color:${BRAND.muted};">(${escHtml(lead.sourceFirstTouch)})</span>` : ''}${lead.campaign ? ` &middot; ${escHtml(lead.campaign)}` : ''}</p>
      </td></tr></table>
    </td></tr></table>
  </td></tr>

  <!-- BOOKING AGREED (booking flow board, when a row exists) -->
  ${bookingHtml}

  <!-- STAY DETAILS -->
  <tr><td style="background:#ffffff;padding:22px 32px 0;" class="le-pad">
    <p style="margin:0 0 11px;font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.goldLabel};">Original Form Entry from Guest</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.goldSoft};border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;">
      <tr>
        <td width="50%" style="padding:11px 16px;border-bottom:0.5px solid #f0ece3;border-right:0.5px solid #f0ece3;"><p style="margin:0 0 2px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.muted};">Check-in</p><p style="margin:0;font-size:12.5px;color:${BRAND.ink};font-weight:500;word-break:break-word;">${fmtDate(lead.checkIn)}</p></td>
        <td width="50%" style="padding:11px 16px;border-bottom:0.5px solid #f0ece3;"><p style="margin:0 0 2px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.muted};">Check-out</p><p style="margin:0;font-size:12.5px;color:${BRAND.ink};font-weight:500;word-break:break-word;">${fmtDate(lead.checkOut)}</p></td>
      </tr>
      <tr>
        <td style="padding:11px 16px;border-bottom:0.5px solid #f0ece3;border-right:0.5px solid #f0ece3;"><p style="margin:0 0 2px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.muted};">Length of stay</p><p style="margin:0;font-size:12.5px;color:${BRAND.ink};font-weight:500;word-break:break-word;">${escHtml(lead.nights)} nights &middot; ${escHtml(lead.guests || 1)} guests</p></td>
        <td style="padding:11px 16px;border-bottom:0.5px solid #f0ece3;"><p style="margin:0 0 2px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.muted};">Location wanted</p><p style="margin:0;font-size:12.5px;color:${BRAND.ink};font-weight:500;word-break:break-word;">${escHtml(lead.location)}</p></td>
      </tr>
      <tr>
        <td style="padding:11px 16px;border-right:0.5px solid #f0ece3;"><p style="margin:0 0 2px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.muted};">Budget</p><p style="margin:0;font-size:12.5px;color:${BRAND.ink};font-weight:500;word-break:break-word;">${gbp(lead.weeklyRate)}/week ${lead.budgetNote ? `<span style="color:${BRAND.muted};font-weight:400;">(${escHtml(lead.budgetNote)})</span>` : ''}</p></td>
        <td style="padding:11px 16px;"><p style="margin:0 0 2px;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.muted};">Contact</p><p style="margin:0;font-size:12.5px;color:${BRAND.ink};font-weight:500;word-break:break-word;">${escHtml(lead.contactPhone)}</p></td>
      </tr>
    </table>
  </td></tr>

  <!-- VISITED PATHS (leads board column) -->
  ${pathsHtml}

  <!-- SALES PROGRESS NOTES -->
  <tr><td style="background:#ffffff;padding:24px 32px 0;" class="le-pad">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;"><tr>
      <td><p style="margin:0;font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.goldLabel};">Sales Progress Notes</p></td>
      <td style="text-align:right;"><p style="margin:0;font-size:10px;color:${BRAND.muted};">${(lead.notes || []).length} updates</p></td>
    </tr></table>
    ${notesHtml}
  </td></tr>

  <!-- NEXT ACTION + CTAs -->
  <tr><td style="background:#ffffff;padding:22px 32px 4px;" class="le-pad">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fbf4e8;border:0.5px solid #ecd9b6;border-radius:10px;margin-bottom:18px;"><tr><td style="padding:12px 16px;">
      <p style="margin:0;font-size:12px;color:#8a6d2f;line-height:1.5;"><span style="font-weight:700;">Next action</span> &middot; Awaiting for guest initial payment to confirm booking</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td align="center"><a href="${escHtml(lead.mondayUrl || '#')}" style="display:inline-block;background:${BRAND.gold};color:#ffffff;text-decoration:none;font-size:12.5px;font-weight:500;padding:12px 26px;border-radius:8px;text-align:center;">Open in Monday</a></td>
    </tr></table>
    <div style="height:24px;"></div>
  </td></tr>

  <!-- FOOTER -->
  <tr><td class="le-pad le-dark" bgcolor="#000000" background="${BRAND.bandPhoto}" style="background-color:#000000;background-image:linear-gradient(rgba(0,0,0,.8),rgba(0,0,0,.8)),url('${BRAND.bandPhoto}');background-size:cover;background-position:center;background-repeat:no-repeat;padding:26px 32px;text-align:center;">
    <img src="${BRAND.wordmark}" alt="Student Luxe" height="18" style="height:18px;width:auto;display:block;margin:0 auto 14px;">
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.5);line-height:1.8;">Internal lead notification<br>Sent when the Monday status changes to <span style="color:#D4B896;">Qualified</span></p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  // "⏳ Lead qualified by Sarika: Aaina H. Singh, 92 nights"
  // Qualifier by first name; nights from the agreed booking when there is
  // one, else the form entry; omitted when neither is known.
  const qualifierFirst = String(lead.qualifiedBy || '').trim().split(/\s+/)[0] || 'team';
  const subjectNights  = (lead.booking && lead.booking.nights) || lead.nights || '';
  const subject = `⏳ Lead qualified by ${qualifierFirst}: ${lead.guestName}${subjectNights ? `, ${subjectNights} nights` : ''}`;

  return { subject, html };
}

module.exports = { renderLeadQualified, formatDuration, escHtml };
