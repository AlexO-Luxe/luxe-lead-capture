// ============================================================
//  Shared alert helper
//  Sends a Resend email to alex@ when Google Ads conversion
//  uploads fail. Fire-and-forget — never throws.
// ============================================================

const RESEND_API = 'https://api.resend.com/emails';
const ALERT_TO   = 'alex@studentluxe.co.uk';
const FROM       = 'Student Luxe Alerts <alerts@studentluxe.co.uk>';

async function sendGadsAlert ({ source, action, payload, error }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('Alert skipped: RESEND_API_KEY missing');
    return;
  }
  const ts = new Date().toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/London', hour12: true
  });

  const safe = (v) => (v == null ? '' : String(v).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])));

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'DM Sans',Helvetica,Arial,sans-serif;background:#fafafa;padding:24px;max-width:600px;margin:0 auto;color:#1a1a1a;">
  <div style="background:#fff;border-radius:10px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.25);">
    <div style="background:#c0392b;color:#fff;padding:14px 22px;font-size:13px;font-weight:600;letter-spacing:0.04em;">
      Google Ads upload failed
    </div>
    <div style="padding:22px;">
      <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#333;">
        A server-side conversion upload to Google Ads failed. The enquiry / booking
        itself was saved to Monday and the guest received their confirmation, so
        nothing is broken from the visitor's side. But the conversion will not appear
        in Google Ads unless we fix the upload path.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><td style="padding:6px 0;color:#9b9b9b;width:120px;">When</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${safe(ts)}</td></tr>
        <tr><td style="padding:6px 0;color:#9b9b9b;">Source</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${safe(source)}</td></tr>
        <tr><td style="padding:6px 0;color:#9b9b9b;">Action</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${safe(action) || '(default)'}</td></tr>
        ${payload?.email     ? `<tr><td style="padding:6px 0;color:#9b9b9b;">Email</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${safe(payload.email)}</td></tr>` : ''}
        ${payload?.name      ? `<tr><td style="padding:6px 0;color:#9b9b9b;">Name</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${safe(payload.name)}</td></tr>` : ''}
        ${payload?.mondayId  ? `<tr><td style="padding:6px 0;color:#9b9b9b;">Monday ID</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${safe(payload.mondayId)}</td></tr>` : ''}
        ${payload?.value     ? `<tr><td style="padding:6px 0;color:#9b9b9b;">Value</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">£${safe(payload.value)}</td></tr>` : ''}
        ${payload?.hasGclid  != null ? `<tr><td style="padding:6px 0;color:#9b9b9b;">gclid</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${payload.hasGclid  ? 'yes' : 'no'}</td></tr>` : ''}
        ${payload?.hasGbraid != null ? `<tr><td style="padding:6px 0;color:#9b9b9b;">gbraid</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${payload.hasGbraid ? 'yes' : 'no'}</td></tr>` : ''}
      </table>
      <div style="margin-top:20px;padding:14px;background:#fdf3f2;border-left:3px solid #c0392b;border-radius:4px;font-size:11.5px;color:#8b2a1d;font-family:Menlo,Monaco,monospace;line-height:1.55;white-space:pre-wrap;word-break:break-word;">${safe(error).slice(0, 1500)}</div>
      <p style="margin:18px 0 0;font-size:11px;color:#9b9b9b;line-height:1.6;">
        Sent by /api/_alert from luxe-lead-capture. Replies to this address go nowhere.
      </p>
    </div>
  </div>
</div>`;

  try {
    const r = await fetch(RESEND_API, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        from:    FROM,
        to:      [ALERT_TO],
        subject: `Google Ads upload failed — ${source}`,
        html
      })
    });
    if (!r.ok) {
      const t = await r.text();
      console.warn('Alert send returned', r.status, t.slice(0, 200));
    }
  } catch (e) {
    console.warn('Alert send threw:', e.message);
  }
}

// ============================================================
//  Success ping — temporary, for confirming the Data Manager API
//  migration is working. Auto-expires 2026-07-02 23:59 UTC.
//  After cutoff, calls silently no-op.
// ============================================================

const SUCCESS_NOTIFY_UNTIL = new Date('2026-07-08T23:59:00Z').getTime();

async function sendGadsSuccess ({ source, action, payload }) {
  if (Date.now() > SUCCESS_NOTIFY_UNTIL) return;
  if (!process.env.RESEND_API_KEY) return;

  const ts = new Date().toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/London', hour12: true
  });
  const safe = (v) => (v == null ? '' : String(v).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])));

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'DM Sans',Helvetica,Arial,sans-serif;background:#fafafa;padding:24px;max-width:600px;margin:0 auto;color:#1a1a1a;">
  <div style="background:#fff;border-radius:10px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.25);">
    <div style="background:#417505;color:#fff;padding:14px 22px;font-size:13px;font-weight:600;letter-spacing:0.04em;">
      Google Ads upload OK
    </div>
    <div style="padding:22px;">
      <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#333;">
        Server-side conversion uploaded successfully via the Data Manager API.
        Temporary confirmation, runs until 2 Jul 2026 then auto-stops.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><td style="padding:6px 0;color:#9b9b9b;width:120px;">When</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${safe(ts)}</td></tr>
        <tr><td style="padding:6px 0;color:#9b9b9b;">Source</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${safe(source)}</td></tr>
        <tr><td style="padding:6px 0;color:#9b9b9b;">Action</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${safe(action) || '(default)'}</td></tr>
        ${payload?.email     ? `<tr><td style="padding:6px 0;color:#9b9b9b;">Email</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${safe(payload.email)}</td></tr>` : ''}
        ${payload?.name      ? `<tr><td style="padding:6px 0;color:#9b9b9b;">Name</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${safe(payload.name)}</td></tr>` : ''}
        ${payload?.mondayId  ? `<tr><td style="padding:6px 0;color:#9b9b9b;">Monday ID</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${safe(payload.mondayId)}</td></tr>` : ''}
        ${payload?.value     ? `<tr><td style="padding:6px 0;color:#9b9b9b;">Value</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">£${safe(payload.value)}</td></tr>` : ''}
        ${payload?.requestId ? `<tr><td style="padding:6px 0;color:#9b9b9b;">DM requestId</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;font-family:Menlo,monospace;font-size:11px;">${safe(payload.requestId)}</td></tr>` : ''}
        ${payload?.hasGclid  != null ? `<tr><td style="padding:6px 0;color:#9b9b9b;">gclid</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${payload.hasGclid  ? 'yes' : 'no'}</td></tr>` : ''}
        ${payload?.hasGbraid != null ? `<tr><td style="padding:6px 0;color:#9b9b9b;">gbraid</td><td style="padding:6px 0;color:#1a1a1a;font-weight:500;">${payload.hasGbraid ? 'yes' : 'no'}</td></tr>` : ''}
      </table>
      <p style="margin:18px 0 0;font-size:11px;color:#9b9b9b;line-height:1.6;">
        Sent by /api/_alert. Auto-stops 2 Jul 2026 23:59 UTC, no code change needed.
      </p>
    </div>
  </div>
</div>`;

  try {
    await fetch(RESEND_API, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        from:    FROM,
        to:      [ALERT_TO],
        subject: `Google Ads upload OK — ${source}`,
        html
      })
    });
  } catch (e) {
    console.warn('Success ping send threw:', e.message);
  }
}

module.exports = { sendGadsAlert, sendGadsSuccess };
