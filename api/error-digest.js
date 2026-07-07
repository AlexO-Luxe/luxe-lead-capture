// ============================================================
//  Daily application-error digest.
//  GET /api/error-digest?secret=<CRON_SECRET>&hours=24[&dryRun=1]
//
//  Reads the last N hours from the app:errors Redis set, groups by
//  endpoint + message, and emails alex@ a summary. Sends nothing when
//  there were no errors (no news is good news). Cron: daily.
//
//  Scope: application errors logged via api/_errlog.js across the
//  handlers and crons. Google Ads upload failures are NOT included here,
//  they have their own self-heal-aware alert path (replay cron).
// ============================================================

const { readErrors } = require('./_errlog.js');

const RESEND_API = 'https://api.resend.com/emails';
const TO         = 'alex@studentluxe.co.uk';
const FROM       = 'Student Luxe Alerts <alerts@studentluxe.co.uk>';

module.exports = async function handler (req, res) {
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (req.query?.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const hours   = Math.max(1, Math.min(336, parseInt(req.query?.hours || '24', 10)));
  const dryRun  = req.query?.dryRun === '1';
  const untilMs = Date.now();
  const sinceMs = untilMs - hours * 60 * 60 * 1000;

  try {
    const errors = await readErrors(sinceMs, untilMs);

    // Group by endpoint + normalised message.
    const groups = new Map();
    for (const e of errors) {
      const key = e.endpoint + ' | ' + e.message;
      const g = groups.get(key) || { endpoint: e.endpoint, message: e.message, count: 0, lastTs: 0, sample: e };
      g.count++;
      if ((e.ts || 0) > g.lastTs) { g.lastTs = e.ts; g.sample = e; }
      groups.set(key, g);
    }
    const list = [...groups.values()].sort((a, b) => b.count - a.count);

    const out = { window: `last ${hours}h`, total: errors.length, distinct: list.length, dryRun };

    if (errors.length === 0) {
      out.sent = false;
      out.note = 'no errors, no email';
      return res.status(200).json(out);
    }

    if (!dryRun) await sendDigest(list, errors.length, hours);
    out.sent = !dryRun;
    out.groups = list.map(g => ({ endpoint: g.endpoint, message: g.message.slice(0, 120), count: g.count }));
    return res.status(200).json(out);
  } catch (err) {
    console.error('error-digest error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function sendDigest (list, total, hours) {
  if (!process.env.RESEND_API_KEY) return;
  const safe = (v) => (v == null ? '' : String(v).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])));
  const when = (ts) => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London', hour12: true });

  const rows = list.map(g => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:600;color:#0d1a2e;">${safe(g.endpoint)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;color:#c0392b;font-weight:700;">${g.count}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#9b9b9b;font-size:11px;">${safe(when(g.lastTs))}</td>
    </tr>
    <tr><td colspan="3" style="padding:0 10px 10px;border-bottom:1px solid #eee;"><div style="font-family:Menlo,monospace;font-size:11px;color:#8b2a1d;background:#fdf3f2;padding:8px 10px;border-radius:4px;white-space:pre-wrap;word-break:break-word;">${safe(g.message)}</div></td></tr>`).join('');

  const html = `
<div style="font-family:-apple-system,'DM Sans',Arial,sans-serif;background:#FBF8F2;padding:24px;max-width:640px;margin:0 auto;color:#1a1a1a;">
  <div style="background:#fff;border-radius:10px;border:0.5px solid rgba(184,150,110,0.3);overflow:hidden;">
    <div style="background:#c0392b;color:#fff;padding:16px 22px;font-size:14px;font-weight:600;letter-spacing:0.03em;">
      luxe-lead-capture errors &middot; last ${hours}h
    </div>
    <div style="padding:14px 22px 22px;">
      <p style="font-size:13px;color:#555;line-height:1.55;">
        ${total} error${total === 1 ? '' : 's'} logged across ${list.length} distinct issue${list.length === 1 ? '' : 's'} in the last ${hours} hours. Google Ads upload failures are tracked separately and are not shown here.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr>
          <th style="text-align:left;padding:8px 10px;color:#9b9b9b;">Endpoint</th>
          <th style="text-align:center;padding:8px 10px;color:#9b9b9b;">Count</th>
          <th style="text-align:left;padding:8px 10px;color:#9b9b9b;">Last seen</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:20px;font-size:11px;color:#9b9b9b;line-height:1.6;">
        Sent by /api/error-digest. No email is sent on days with zero errors.
      </p>
    </div>
  </div>
</div>`;

  await fetch(RESEND_API, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [TO], subject: `luxe-lead-capture: ${total} error${total === 1 ? '' : 's'} in last ${hours}h`, html })
  });
}
