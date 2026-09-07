// ============================================================
//  Student Luxe — Oskar assignment alert
//  Deploy to: /api/oskar-assignment-email.js
//
//  POST /api/oskar-assignment-email
//  Called by Oskar when an agent assigns a WhatsApp chat to a
//  COLLEAGUE. Oskar has no mail of its own, so sending lives here
//  alongside the verified Resend domain.
//
//  Body: { to, toName, fromName, guestName, phone, statusLabel,
//          windowLabel, lastMessage, chatUrl }
//
//  Auth: CRON_SECRET as ?secret= or Bearer (repo convention).
// ============================================================

const RESEND_API = 'https://api.resend.com/emails';
const { logError } = require('./_errlog.js');

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const q = req.query || {};
    const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (process.env.CRON_SECRET && q.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const p = req.body || {};
    if (!p.to) return res.status(400).json({ error: 'to is required' });

    const guest = esc(p.guestName || 'A guest');
    const from = esc(p.fromName || 'A colleague');
    const initials = (p.fromName || 'SL')
      .split(/\s+/)
      .map((w) => w.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase();

    const row = (label, value) =>
      value
        ? `<tr>
             <td style="padding:6px 0;font-size:12px;color:#9b9b9b;width:96px;border-bottom:1px solid #F3EEE4;">${esc(label)}</td>
             <td style="padding:6px 0;font-size:12px;color:#1a1a1a;font-weight:500;border-bottom:1px solid #F3EEE4;">${value}</td>
           </tr>`
        : '';

    const statusPill = p.statusLabel
      ? `<span style="display:inline-block;background:#e8f4fd;color:#0d1a2e;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;padding:2px 8px;border-radius:20px;">${esc(p.statusLabel)}</span>`
      : '';
    const windowPill = p.windowLabel
      ? `<span style="display:inline-block;background:#EAF3DE;color:#3B6D11;font-size:10px;font-weight:700;letter-spacing:0.06em;padding:2px 8px;border-radius:20px;">${esc(p.windowLabel)}</span>`
      : '';

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:28px 14px;">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;border-radius:12px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.35);background:#ffffff;">
  <tr><td style="background:#0d1a2e;padding:16px 20px;">
    <p style="margin:0 0 3px;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:rgba(212,184,150,0.85);">Oskar &middot; WhatsApp</p>
    <p style="margin:0;font-size:20px;color:#ffffff;font-family:Georgia,'Times New Roman',serif;">A chat is now yours</p>
  </td></tr>
  <tr><td style="padding:18px 20px;">
    <table cellpadding="0" cellspacing="0" style="margin-bottom:14px;"><tr>
      <td style="padding-right:10px;">
        <div style="width:34px;height:34px;border-radius:50%;background:#B8966E;color:#fff;font-size:12px;font-weight:700;text-align:center;line-height:34px;">${esc(initials)}</div>
      </td>
      <td style="font-size:13px;color:#1a1a1a;"><strong>${from}</strong> assigned you this conversation</td>
    </tr></table>

    <table width="100%" cellpadding="0" cellspacing="0">
      ${row('Guest', `${guest} ${statusPill}`)}
      ${row('Phone', esc(p.phone))}
      ${row('Reply window', windowPill)}
    </table>

    ${
      p.lastMessage
        ? `<div style="background:#F7F5F0;border-left:2px solid #B8966E;padding:10px 12px;font-size:12.5px;color:#4a4a4a;font-style:italic;margin:14px 0;">&ldquo;${esc(p.lastMessage)}&rdquo;</div>`
        : ''
    }

    ${
      p.chatUrl
        ? `<a href="${esc(p.chatUrl)}" style="display:block;text-align:center;background:#B8966E;color:#ffffff;text-decoration:none;border-radius:8px;padding:12px;font-size:13px;font-weight:700;margin-top:14px;">Open the chat in Oskar</a>`
        : ''
    }
  </td></tr>
  <tr><td style="background:#f7f2eb;padding:10px 20px;text-align:center;border-top:0.5px solid rgba(184,150,110,0.2);">
    <p style="margin:0;font-size:10px;color:#9b9b9b;">You are receiving this because a colleague assigned you a chat in Oskar.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

    const resp = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Student Luxe <reservations@studentluxe.co.uk>',
        to: [p.to],
        subject: `${p.fromName || 'A colleague'} assigned you a WhatsApp chat: ${p.guestName || 'new chat'}`,
        html,
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.error('oskar-assignment-email: Resend rejected the send:', resp.status, detail.slice(0, 300));
      return res.status(502).json({ error: 'Email send failed', status: resp.status });
    }

    console.log('oskar-assignment-email sent to', p.to);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('oskar-assignment-email error:', err.message);
    await logError('oskar-assignment-email', err);
    return res.status(500).json({ error: err.message });
  }
};
