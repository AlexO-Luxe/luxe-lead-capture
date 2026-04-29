// ============================================================
//  Student Luxe — WhatsApp Click Tracking
//  Deploy to: /api/submit-whatsapp.js
//
//  Called when a visitor clicks any wa.me link on the site.
//  Sends an email notification with UTM and tracking data.
//
//  Environment variables required:
//    RESEND_API_KEY
//    TEAM_EMAIL_2 (alex@studentluxe.co.uk)
// ============================================================

const RESEND_API = 'https://api.resend.com/emails';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const p = req.body;
    console.log('WhatsApp click received:', JSON.stringify(p));

    const ts      = p.timestamp ? new Date(p.timestamp) : new Date();
    const timeStr = ts.toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/London', hour12: true
    });

    const leadSource = p.gclid ? 'PPC' : (p.utm_source || 'Unknown');
    const isPPC      = !!p.gclid;

    const row = (label, value) => value ? `
      <tr>
        <td style="padding:8px 0;font-size:12px;color:#9b9b9b;width:140px;border-bottom:0.5px solid #ede9e3;">${label}</td>
        <td style="padding:8px 0;font-size:12px;color:#1a1a1a;font-weight:500;border-bottom:0.5px solid #ede9e3;">${value}</td>
      </tr>` : '';

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;border-radius:12px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.3);">
  <tr><td style="background:#25D366;padding:20px 28px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <p style="margin:0 0 2px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,255,255,0.7);">WhatsApp Click</p>
        <p style="margin:0;font-size:20px;font-weight:500;color:#fff;">${p.page_path || p.last_page || 'Unknown page'}</p>
      </td>
      <td style="text-align:right;vertical-align:middle;">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884"/></svg>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#fff;padding:24px 28px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:8px 0;font-size:12px;color:#9b9b9b;width:140px;border-bottom:0.5px solid #ede9e3;">Time</td>
        <td style="padding:8px 0;font-size:12px;color:#1a1a1a;font-weight:500;border-bottom:0.5px solid #ede9e3;">${timeStr}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;font-size:12px;color:#9b9b9b;width:140px;border-bottom:0.5px solid #ede9e3;">Source</td>
        <td style="padding:8px 0;font-size:12px;border-bottom:0.5px solid #ede9e3;">
          <span style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:10px;font-weight:600;letter-spacing:0.06em;background:${isPPC ? 'rgba(66,133,244,0.1)' : 'rgba(184,150,110,0.1)'};color:${isPPC ? '#1a56d6' : '#8a6540'};">${leadSource}</span>
        </td>
      </tr>
      ${row('Page', p.page_path || p.last_page)}
      ${row('Landing page', p.landing_page)}
      ${row('Campaign', p.utm_campaign)}
      ${row('Ad group', p.utm_adgroup)}
      ${row('Search term', p.utm_term)}
      ${row('Match type', p.utm_matchtype)}
      ${row('GCLID', p.gclid)}
    </table>
  </td></tr>
  <tr><td style="background:#f7f2eb;padding:14px 28px;text-align:center;border-top:0.5px solid rgba(184,150,110,0.2);">
    <p style="margin:0;font-size:11px;color:#9b9b9b;">Student Luxe · WhatsApp Click Tracking</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

    await fetch(RESEND_API, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        from:    'Student Luxe <reservations@studentluxe.co.uk>',
        to:      [process.env.TEAM_EMAIL || 'alex@studentluxe.co.uk'],
        subject: `Potential WA Lead — ${timeStr}`,
        html
      })
    });

    console.log('WhatsApp notification email sent');
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('submit-whatsapp error:', err.message);
    return res.status(200).json({ error: err.message });
  }
};
