// ============================================================
//  Daily summary of Google Ads conversion uploads.
//  GET /api/gads-daily-summary?secret=<CRON_SECRET>&hours=24
//
//  Reads the last N hours (default 24) from the KV gads:events
//  sorted set and emails alex@ a summary table: per action,
//  count OK, count failed, total value, click-ID coverage.
//
//  Wired up as a Claude routine (scheduled cloud agent) firing
//  at 08:00 London daily.
// ============================================================

const { readGadsEvents } = require('./_log.js');

const RESEND_API = 'https://api.resend.com/emails';
const TO         = 'alex@studentluxe.co.uk';
const FROM       = 'Student Luxe Alerts <alerts@studentluxe.co.uk>';

module.exports = async function handler (req, res) {
  if (req.query?.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const hours    = Math.max(1, Math.min(168, parseInt(req.query?.hours || '24', 10)));
  const untilMs  = Date.now();
  const sinceMs  = untilMs - hours * 60 * 60 * 1000;

  const events = await readGadsEvents(sinceMs, untilMs);

  // Group by source + action
  const byAction = {};
  let totalOk = 0, totalFail = 0, totalValue = 0;
  events.forEach(e => {
    const key = `${e.source} / ${e.action}`;
    if (!byAction[key]) byAction[key] = { ok: 0, fail: 0, value: 0, withGclid: 0, withGbraid: 0, withWbraid: 0, withClickId: 0 };
    if (e.ok) { byAction[key].ok++; totalOk++; }
    else      { byAction[key].fail++; totalFail++; }
    if (e.value) { byAction[key].value += Number(e.value); totalValue += Number(e.value); }
    if (e.hasGclid)  byAction[key].withGclid++;
    if (e.hasGbraid) byAction[key].withGbraid++;
    if (e.hasWbraid) byAction[key].withWbraid++;
    if (e.hasGclid || e.hasGbraid || e.hasWbraid) byAction[key].withClickId++;
  });

  const rangeLabel = hours === 24 ? 'last 24h' : `last ${hours}h`;
  const dateLabel  = new Date(sinceMs).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/London', hour12: true
  }) + ' → ' + new Date(untilMs).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/London', hour12: true
  });

  const subject = totalFail === 0 && totalOk > 0
    ? `Google Ads daily summary: ${totalOk} uploaded, all green`
    : totalFail > 0
      ? `Google Ads daily summary: ${totalFail} failed, ${totalOk} ok`
      : `Google Ads daily summary: no activity in ${rangeLabel}`;

  const safe = (v) => (v == null ? '' : String(v).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])));

  let rows = '';
  Object.keys(byAction).sort().forEach(k => {
    const r = byAction[k];
    const coverage = (r.ok + r.fail) > 0 ? Math.round((r.withClickId / (r.ok + r.fail)) * 100) : 0;
    const failBg = r.fail > 0 ? '#fdf3f2' : '';
    rows += `
      <tr style="background:${failBg};">
        <td style="padding:10px 14px;border-bottom:0.5px solid #ede9e3;font-size:12.5px;color:#1a1a1a;">${safe(k)}</td>
        <td style="padding:10px 14px;border-bottom:0.5px solid #ede9e3;font-size:13px;color:#1d9e75;text-align:right;font-weight:600;">${r.ok}</td>
        <td style="padding:10px 14px;border-bottom:0.5px solid #ede9e3;font-size:13px;color:${r.fail > 0 ? '#c0392b' : '#9b9b9b'};text-align:right;font-weight:${r.fail > 0 ? '600' : '400'};">${r.fail}</td>
        <td style="padding:10px 14px;border-bottom:0.5px solid #ede9e3;font-size:12.5px;color:#6b6b6b;text-align:right;">${r.value > 0 ? '£' + r.value.toLocaleString('en-GB') : '—'}</td>
        <td style="padding:10px 14px;border-bottom:0.5px solid #ede9e3;font-size:12.5px;color:#6b6b6b;text-align:right;">${coverage}%</td>
      </tr>`;
  });
  if (!rows) {
    rows = `<tr><td colspan="5" style="padding:18px 14px;text-align:center;color:#9b9b9b;font-style:italic;font-size:12.5px;">No conversion uploads in this window.</td></tr>`;
  }

  // Failure detail rows (only when present)
  let failDetail = '';
  const failures = events.filter(e => !e.ok).slice(-5);
  if (failures.length) {
    failDetail = `
      <div style="margin-top:18px;border-top:0.5px solid #ede9e3;padding-top:18px;">
        <p style="margin:0 0 10px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#c0392b;">Latest failures (max 5)</p>
        ${failures.map(f => `
          <div style="background:#fdf3f2;border-left:3px solid #c0392b;border-radius:4px;padding:10px 12px;margin:0 0 8px;font-size:12px;color:#8b2a1d;">
            <div style="font-weight:500;color:#1a1a1a;margin-bottom:3px;">${safe(f.source)} / ${safe(f.action)}</div>
            <div style="font-size:11px;color:#6b6b6b;margin-bottom:4px;">${new Date(f.ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London', hour12: true })} · ${safe(f.email)}</div>
            <div style="font-family:Menlo,Monaco,monospace;font-size:10.5px;color:#8b2a1d;line-height:1.5;">${safe(f.error).slice(0, 350)}</div>
          </div>
        `).join('')}
      </div>`;
  }

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'DM Sans',Helvetica,Arial,sans-serif;background:#fafafa;padding:24px;max-width:680px;margin:0 auto;color:#1a1a1a;">
  <div style="background:#fff;border-radius:10px;overflow:hidden;border:0.5px solid rgba(184,150,110,0.25);">
    <div style="background:#0d1a2e;color:#fff;padding:16px 22px;">
      <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#B8966E;margin-bottom:4px;">Google Ads daily summary</div>
      <div style="font-family:'Baskerville Display PT',Baskerville,Georgia,serif;font-size:22px;font-weight:400;letter-spacing:-0.02em;">${totalFail > 0 ? totalFail + ' failed, ' : ''}${totalOk} uploaded</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.55);margin-top:6px;">${dateLabel}</div>
    </div>
    <div style="padding:0 22px 22px;">
      <table style="width:100%;border-collapse:collapse;margin-top:14px;">
        <thead>
          <tr>
            <th style="padding:10px 14px;border-bottom:0.5px solid #ede9e3;text-align:left;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b9b9b;font-weight:500;">Action</th>
            <th style="padding:10px 14px;border-bottom:0.5px solid #ede9e3;text-align:right;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b9b9b;font-weight:500;">OK</th>
            <th style="padding:10px 14px;border-bottom:0.5px solid #ede9e3;text-align:right;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b9b9b;font-weight:500;">Fail</th>
            <th style="padding:10px 14px;border-bottom:0.5px solid #ede9e3;text-align:right;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b9b9b;font-weight:500;">Value</th>
            <th style="padding:10px 14px;border-bottom:0.5px solid #ede9e3;text-align:right;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9b9b9b;font-weight:500;">Click ID%</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:16px;display:flex;gap:10px;font-size:11px;color:#9b9b9b;">
        <div>Total value: <strong style="color:#0d1a2e;">${totalValue > 0 ? '£' + totalValue.toLocaleString('en-GB') : '—'}</strong></div>
        <div>·</div>
        <div>Events: <strong style="color:#0d1a2e;">${events.length}</strong></div>
      </div>
      ${failDetail}
      <p style="margin:22px 0 0;font-size:11px;color:#9b9b9b;line-height:1.6;">
        Sent by /api/gads-daily-summary. Triggered by a Claude routine at 08:00 London.
        Live dashboard: https://luxe-lead-capture.vercel.app/dashboard-attribution.html
      </p>
    </div>
  </div>
</div>`;

  try {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing');
    const r = await fetch(RESEND_API, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ from: FROM, to: [TO], subject, html })
    });
    const ok = r.ok;
    if (!ok) {
      const text = await r.text();
      return res.status(500).json({ error: 'resend ' + r.status + ': ' + text.slice(0, 300) });
    }
    return res.status(200).json({
      ok,
      window:  rangeLabel,
      counts:  { ok: totalOk, fail: totalFail, total: events.length, value: totalValue }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
