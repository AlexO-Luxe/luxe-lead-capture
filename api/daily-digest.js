// ============================================================
//  Student Luxe, daily ops digest.
//  GET /api/daily-digest?secret=<CRON_SECRET>[&hours=24][&dryRun=1]
//
//  Replaces three separate daily emails (Google Ads summary 08:30,
//  booking value sync 06:30, error digest 07:00) with one message at
//  08:30 London. The worker crons still run on their own schedules and
//  park their results, this only reports them.
//
//  Sections drop out when they have nothing to say, so a clean day is a
//  short email rather than three pages of "nothing to report". Genuine
//  upload failures still alert immediately via _alert.js, they do not
//  wait for the digest.
// ============================================================

const { readGadsEvents } = require('./_log.js');
const { readErrors }     = require('./_errlog.js');
const { logError }       = require('./_errlog.js');
const { buildBookingSyncSection } = require('./sync-booking-values.js');
const { shell, table, th, td, emptyRow, esc, sendDigest, BRAND } = require('./_digest.js');

// ── Google Ads uploads ────────────────────────────────────────
async function buildGadsSection (sinceMs, untilMs) {
  const events = await readGadsEvents(sinceMs, untilMs);

  const byAction = {};
  let totalOk = 0, totalFail = 0, totalValue = 0;
  for (const e of events) {
    const key = `${e.source} / ${e.action}`;
    byAction[key] = byAction[key] || { ok: 0, fail: 0, value: 0, withClickId: 0 };
    if (e.ok) { byAction[key].ok++; totalOk++; } else { byAction[key].fail++; totalFail++; }
    if (e.value) { byAction[key].value += Number(e.value); totalValue += Number(e.value); }
    if (e.hasGclid || e.hasGbraid || e.hasWbraid) byAction[key].withClickId++;
  }

  const rows = Object.keys(byAction).sort().map(k => {
    const r = byAction[k];
    const total = r.ok + r.fail;
    const coverage = total > 0 ? Math.round((r.withClickId / total) * 100) : 0;
    return `<tr style="background:${r.fail > 0 ? '#fdf3f2' : ''};">
      ${td(esc(k))}
      ${td(String(r.ok), 'right', `color:${BRAND.green};font-weight:600;`)}
      ${td(String(r.fail), 'right', `color:${r.fail > 0 ? BRAND.red : BRAND.muted};font-weight:${r.fail > 0 ? '600' : '400'};`)}
      ${td(r.value > 0 ? '£' + r.value.toLocaleString('en-GB') : '&mdash;', 'right')}
      ${td(coverage + '%', 'right')}
    </tr>`;
  }).join('');

  // Failure detail earns its space only when something actually failed.
  const failures = events.filter(e => !e.ok).slice(-5);
  const failHtml = failures.length ? `
    <div style="margin-top:14px;border-top:0.5px solid ${BRAND.line};padding-top:14px;">
      <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.red};">Latest failures</p>
      ${failures.map(f => `
        <div style="background:#fdf3f2;border-left:3px solid ${BRAND.red};border-radius:4px;padding:9px 11px;margin:0 0 7px;">
          <div style="font-size:12px;font-weight:500;color:${BRAND.ink};">${esc(f.source)} / ${esc(f.action)}${f.name ? ' &middot; ' + esc(f.name) : ''}</div>
          <div style="font-family:Menlo,Monaco,monospace;font-size:10.5px;color:#8b2a1d;line-height:1.5;margin-top:3px;">${esc(f.error || f.reason).slice(0, 300)}</div>
        </div>`).join('')}
    </div>` : '';

  if (!events.length) {
    return { title: 'Google Ads uploads', stat: 'no activity', tone: 'plain', empty: true };
  }
  return {
    title: 'Google Ads uploads',
    stat: totalFail > 0 ? `${totalFail} failed, ${totalOk} ok` : `${totalOk} uploaded, all green`,
    tone: totalFail > 0 ? 'bad' : 'good',
    subtitle: totalValue > 0 ? `£${totalValue.toLocaleString('en-GB')} of conversion value` : '',
    html: table(th('Action') + th('OK', 'right') + th('Fail', 'right') + th('Value', 'right') + th('Click ID%', 'right'),
                rows || emptyRow(5, 'No conversion uploads in this window.')) + failHtml
  };
}

// ── Application errors ────────────────────────────────────────
async function buildErrorSection (sinceMs, untilMs) {
  const errors = await readErrors(sinceMs, untilMs);
  if (!errors.length) return { title: 'Errors', stat: 'none', tone: 'good', empty: true };

  const bySource = {};
  errors.forEach(e => {
    bySource[e.source] = bySource[e.source] || { count: 0, last: null };
    bySource[e.source].count++;
    bySource[e.source].last = e;
  });

  const rows = Object.entries(bySource).sort((a, b) => b[1].count - a[1].count).map(([src, info]) => `
    <tr>
      ${td(esc(src))}
      ${td(String(info.count), 'right', `color:${BRAND.red};font-weight:600;`)}
      ${td(`<span style="font-family:Menlo,Monaco,monospace;font-size:10.5px;color:#8b2a1d;">${esc(info.last.message || info.last.error || '').slice(0, 140)}</span>`)}
    </tr>`).join('');

  return {
    title: 'Errors',
    stat: `${errors.length} in 24h`,
    tone: 'bad',
    html: table(th('Source') + th('Count', 'right') + th('Most recent'), rows)
  };
}

module.exports = async function handler (req, res) {
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (req.query?.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const hours   = Math.max(1, Math.min(168, parseInt(req.query?.hours || '24', 10)));
  const untilMs = Date.now();
  const sinceMs = untilMs - hours * 3600000;

  try {
    // One slow section must not cost the whole digest, so each is settled
    // independently and a thrown section is simply left out.
    const settled = await Promise.allSettled([
      buildGadsSection(sinceMs, untilMs),
      buildBookingSyncSection(hours + 2),
      buildErrorSection(sinceMs, untilMs)
    ]);
    settled.forEach((s, i) => {
      if (s.status === 'rejected') console.warn(`daily-digest section ${i} failed:`, s.reason?.message);
    });
    const sections = settled.map(s => s.status === 'fulfilled' ? s.value : null).filter(Boolean);

    const gads   = sections.find(s => s.title === 'Google Ads uploads');
    const errs   = sections.find(s => s.title === 'Errors');
    const live   = sections.filter(s => !s.empty);
    const trouble = (errs && !errs.empty) || (gads && gads.tone === 'bad');

    const dateLabel = new Date(untilMs).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London'
    });

    const subject = trouble
      ? `Daily ops: ${gads && gads.tone === 'bad' ? gads.stat : ''}${trouble && errs && !errs.empty ? (gads && gads.tone === 'bad' ? ', ' : '') + errs.stat + ' errors' : ''}`.replace(/^Daily ops: , /, 'Daily ops: ')
      : `Daily ops: all green${gads && !gads.empty ? ', ' + gads.stat : ''}`;

    const html = shell({
      eyebrow: 'Student Luxe',
      title: trouble ? 'Daily ops, needs a look' : 'Daily ops, all green',
      subtitle: dateLabel + ' · last ' + hours + 'h',
      sections,
      footer: 'Combined daily digest (/api/daily-digest). Replaces the separate Google Ads summary, booking value sync and error digest emails. Upload failures still alert immediately.'
    });

    if (req.query?.dryRun === '1') {
      return res.status(200).json({ dryRun: true, subject, sections: sections.map(s => ({ title: s.title, stat: s.stat, empty: !!s.empty })), html });
    }

    await sendDigest({ subject, html });
    return res.status(200).json({ sent: true, subject, sections: live.map(s => s.title) });

  } catch (err) {
    console.error('daily-digest error:', err.message);
    await logError('daily-digest', err);
    return res.status(500).json({ error: err.message });
  }
};
