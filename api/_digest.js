// ============================================================
//  Shared shell for the combined report emails.
//
//  Nine separate scheduled emails used to land each week, four of them
//  inside two hours on a Monday morning. They are now composed into one
//  daily ops digest and one weekly report, so every recurring report
//  shares this shell and every section looks like part of one document.
//
//  A section is { title, subtitle, html, stat, tone, empty }. Sections
//  flagged empty are dropped, so a quiet day produces a short email
//  rather than a page of "nothing to report" panels.
// ============================================================

const BRAND = {
  navy:  '#0d1a2e',
  gold:  '#B8966E',
  cream: '#FBF8F2',
  ink:   '#1a1a1a',
  muted: '#9b9b9b',
  line:  '#ede9e3',
  green: '#1d9e75',
  red:   '#c0392b',
  amber: '#B8710F'
};

function esc (v) {
  return (v == null ? '' : String(v)).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

const TONE_COLOUR = { good: BRAND.green, bad: BRAND.red, warn: BRAND.amber, plain: BRAND.gold };

// One report section, rendered as a titled card.
function card (section) {
  const accent = TONE_COLOUR[section.tone || 'plain'] || BRAND.gold;
  return `
  <div style="background:#fff;border-radius:10px;border:0.5px solid rgba(184,150,110,0.25);overflow:hidden;margin:0 0 14px;">
    <div style="padding:14px 20px 10px;border-bottom:0.5px solid ${BRAND.line};">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${accent};font-weight:600;">${esc(section.title)}</td>
        ${section.stat ? `<td align="right" style="font-size:12px;color:${BRAND.ink};font-weight:600;">${esc(section.stat)}</td>` : ''}
      </tr></table>
      ${section.subtitle ? `<div style="font-size:11px;color:${BRAND.muted};margin-top:4px;">${esc(section.subtitle)}</div>` : ''}
    </div>
    <div style="padding:14px 20px 18px;">${section.html}</div>
  </div>`;
}

// Full email: navy masthead, then every non-empty section as a card.
function shell ({ eyebrow, title, subtitle, sections, footer }) {
  const live = (sections || []).filter(s => s && !s.empty && s.html);
  const body = live.map(card).join('');
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'DM Sans',Helvetica,Arial,sans-serif;background:${BRAND.cream};padding:22px;max-width:700px;margin:0 auto;color:${BRAND.ink};">
  <div style="background:${BRAND.navy};color:#fff;border-radius:10px;padding:18px 22px;margin:0 0 14px;">
    <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.gold};margin-bottom:5px;">${esc(eyebrow)}</div>
    <div style="font-family:'Baskerville Display PT',Baskerville,Georgia,serif;font-size:23px;font-weight:400;letter-spacing:-0.02em;">${esc(title)}</div>
    ${subtitle ? `<div style="font-size:11px;color:rgba(255,255,255,0.55);margin-top:6px;">${esc(subtitle)}</div>` : ''}
  </div>
  ${body || `<div style="background:#fff;border-radius:10px;border:0.5px solid rgba(184,150,110,0.25);padding:26px;text-align:center;font-size:12.5px;color:${BRAND.muted};font-style:italic;">Nothing to report.</div>`}
  <p style="margin:16px 4px 0;font-size:10.5px;color:${BRAND.muted};line-height:1.6;">${footer || ''}</p>
</div>`;
}

// Shared table furniture, so every section's tables match.
function th (label, align = 'left') {
  return `<th style="padding:8px 12px;border-bottom:0.5px solid ${BRAND.line};text-align:${align};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.muted};font-weight:500;">${esc(label)}</th>`;
}
function td (value, align = 'left', style = '') {
  return `<td style="padding:9px 12px;border-bottom:0.5px solid ${BRAND.line};font-size:12.5px;color:${BRAND.ink};text-align:${align};${style}">${value}</td>`;
}
function table (head, rows) {
  return `<table style="width:100%;border-collapse:collapse;">
    <thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}
function emptyRow (span, text) {
  return `<tr><td colspan="${span}" style="padding:16px 12px;text-align:center;color:${BRAND.muted};font-style:italic;font-size:12.5px;">${esc(text)}</td></tr>`;
}

async function sendDigest ({ subject, html, to }) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Student Luxe Alerts <alerts@studentluxe.co.uk>',
      to: [to || 'alex@studentluxe.co.uk'],
      subject,
      html
    })
  });
  if (!r.ok) throw new Error('resend ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return true;
}

module.exports = { BRAND, esc, card, shell, th, td, table, emptyRow, sendDigest };
