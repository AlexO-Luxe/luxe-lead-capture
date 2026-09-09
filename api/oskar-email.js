// ============================================================
//  Student Luxe — Oskar email alerts (Resend)
//  POST /api/oskar-email
//    { kind: 'reply' | 'digest', to, toName, ...data }
//  Called by the Oskar worker. Same frame as oskar-assignment-email.
//  Auth: CRON_SECRET as Bearer (repo convention).
// ============================================================

const RESEND_API = 'https://api.resend.com/emails';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pill(text, bg, fg) {
  return `<span style="display:inline-block;background:${bg};color:${fg};font-size:10px;font-weight:700;letter-spacing:0.06em;padding:2px 8px;border-radius:20px;white-space:nowrap;">${esc(text)}</span>`;
}
function windowPill(mins) {
  if (mins == null) return '';
  if (mins <= 0) return pill('Closed, template needed', '#FDECEA', '#b42318');
  const h = Math.floor(mins / 60), m = mins % 60;
  const label = (h > 0 ? `${h}h ${m}m` : `${m}m`) + ' left';
  return mins < 120 ? pill(label, '#FFF4D6', '#8a5a00') : pill(label, '#EAF3DE', '#3B6D11');
}
function row(label, value) {
  return `<tr><td style="padding:6px 0;font-size:12px;color:#9b9b9b;width:96px;border-bottom:1px solid #F3EEE4;">${esc(label)}</td><td style="padding:6px 0;font-size:12px;color:#1a1a1a;font-weight:500;border-bottom:1px solid #F3EEE4;">${value}</td></tr>`;
}
function frame(eyebrow, title, body, footer) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:28px 14px;"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;border-radius:12px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.35);background:#ffffff;">
  <tr><td style="background:#0d1a2e;padding:16px 20px;">
    <p style="margin:0 0 3px;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:rgba(212,184,150,0.85);">${esc(eyebrow)}</p>
    <p style="margin:0;font-size:20px;color:#ffffff;font-family:Georgia,'Times New Roman',serif;">${esc(title)}</p>
  </td></tr>
  <tr><td style="padding:18px 20px;">${body}</td></tr>
  <tr><td style="background:#f7f2eb;padding:10px 20px;text-align:center;border-top:0.5px solid rgba(184,150,110,0.2);">
    <p style="margin:0;font-size:10px;color:#9b9b9b;">${esc(footer)}</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}
function button(href, label) {
  return `<a href="${esc(href)}" style="display:block;text-align:center;background:#B8966E;color:#ffffff;text-decoration:none;border-radius:8px;padding:12px;font-size:13px;font-weight:700;margin-top:14px;">${esc(label)}</a>`;
}
function avatar(initial, bg) {
  return `<div style="width:34px;height:34px;border-radius:50%;background:${bg};color:#fff;font-size:12px;font-weight:700;text-align:center;line-height:34px;">${esc(initial)}</div>`;
}

function renderReply(p) {
  const guest = p.guestName || 'A guest';
  const first = String(guest).split(' ')[0];
  const lead = [p.statusLabel ? pill(p.statusLabel, '#E8F0FA', '#0d1a2e') : '', esc(p.leadSummary || '')].filter(Boolean).join(' ');
  const body = `
    <table cellpadding="0" cellspacing="0" style="margin-bottom:14px;"><tr>
      <td style="padding-right:10px;">${avatar(first.charAt(0).toUpperCase(), '#0d1a2e')}</td>
      <td style="font-size:13px;color:#1a1a1a;"><strong>${esc(guest)}</strong> sent a new message to a chat assigned to you</td>
    </tr></table>
    ${p.message ? `<div style="background:#F7F5F0;border-left:2px solid #B8966E;padding:10px 12px;font-size:12.5px;color:#4a4a4a;font-style:italic;margin:0 0 14px;">&ldquo;${esc(p.message)}&rdquo;</div>` : ''}
    <table width="100%" cellpadding="0" cellspacing="0">
      ${lead ? row('Lead', lead) : ''}
      ${row('Reply window', windowPill(p.windowMins))}
      ${row('Sent', esc(p.sentLabel || ''))}
    </table>
    ${p.chatUrl ? button(p.chatUrl, 'Reply in Oskar') : ''}
    <p style="font-size:11px;color:#9b9b9b;margin:12px 0 0;line-height:1.5;">If ${esc(first)} sends more before you reply, you will not get another email. The next one comes after your reply.</p>`;
  return {
    subject: `${first} replied on WhatsApp`,
    html: frame('Oskar · WhatsApp', `${first} is waiting on you`, body, 'You are receiving this because this chat is assigned to you in Oskar. Turn it off in Oskar settings.'),
  };
}

function renderDigest(p) {
  const waiting = Array.isArray(p.waiting) ? p.waiting : [];
  const fresh = Array.isArray(p.fresh) ? p.fresh : [];
  const closing = waiting.filter((w) => w.windowMins != null && w.windowMins > 0 && w.windowMins < 240).length;
  const stat = (n, l) => `<td style="padding:0 4px;"><div style="background:#F7F5F0;border-radius:8px;padding:10px;text-align:center;"><div style="font-size:22px;font-weight:700;color:#0d1a2e;font-family:Georgia,serif;">${n}</div><div style="font-size:10px;color:#9b9b9b;text-transform:uppercase;letter-spacing:0.08em;margin-top:2px;">${esc(l)}</div></div></td>`;
  const sec = (t) => `<p style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#B8966E;font-weight:700;margin:14px 0 6px;">${esc(t)}</p>`;
  const item = (w, right) => `<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #F3EEE4;"><tr>
      <td style="padding:8px 10px 8px 0;width:28px;vertical-align:top;"><div style="width:28px;height:28px;border-radius:50%;background:#0d1a2e;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:28px;">${esc(String(w.name || '?').charAt(0).toUpperCase())}</div></td>
      <td style="padding:8px 0;vertical-align:top;"><div style="font-weight:600;font-size:13px;color:#1a1a1a;"><a href="${esc(w.chatUrl || p.oskarUrl || '#')}" style="color:#1a1a1a;text-decoration:none;">${esc(w.name || 'Guest')}</a> ${w.statusLabel ? pill(w.statusLabel, '#E8F0FA', '#0d1a2e') : ''}</div><div style="font-size:12px;color:#6b6b6b;margin-top:2px;">${esc(w.preview || '')}</div></td>
      <td style="padding:8px 0;text-align:right;white-space:nowrap;font-size:11px;color:#9b9b9b;vertical-align:top;">${right}</td></tr></table>`;
  let body = `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:6px;"><tr>${stat(waiting.length, 'Waiting on you')}${stat(closing, 'Windows closing')}${stat(p.sentYesterday || 0, 'Sent yesterday')}</tr></table>`;
  if (waiting.length) {
    body += sec('Waiting on you');
    waiting.forEach((w) => { body += item(w, `${esc(w.waitingLabel || '')}<br>${windowPill(w.windowMins)}`); });
  }
  if (fresh.length) {
    body += sec('New to you since yesterday');
    fresh.forEach((w) => { body += item(w, esc(w.howLabel || 'Assigned')); });
  }
  body += button(p.oskarUrl || '#', 'Open Oskar');
  const first = String(p.toName || '').split(' ')[0] || 'there';
  return {
    subject: `Your Oskar chats, ${p.dateLabel || 'today'}: ${waiting.length} waiting on you`,
    html: frame('Oskar · Daily digest', `Good morning, ${first}`, body, 'Sent every morning at 9am UK time to everyone with chats assigned in Oskar. Nothing to report, no email.'),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const p = req.body || {};
    if (!p.to) return res.status(400).json({ error: 'to required' });
    const rendered = p.kind === 'digest' ? renderDigest(p) : p.kind === 'reply' ? renderReply(p) : null;
    if (!rendered) return res.status(400).json({ error: 'Unknown kind' });
    const resp = await fetch(RESEND_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Student Luxe <reservations@studentluxe.co.uk>',
        to: [p.to],
        subject: rendered.subject,
        html: rendered.html,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('oskar-email: Resend error', data);
      return res.status(502).json({ error: 'Email send failed', details: data });
    }
    return res.status(200).json({ success: true, id: data.id || null });
  } catch (err) {
    console.error('oskar-email:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};
