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
const { uploadDiagnostics } = require('./_gads-diagnostics.js');
const { checkLandingWindow, missingLeads, retractionByChannel,
        retractionLedger, classifyRetraction, RETRACTION_OUTCOMES } = require('./_landing-check.js');
const { shell, table, th, td, emptyRow, esc, sendDigest, BRAND } = require('./_digest.js');

// The log keys events by source and action, which reads like plumbing.
// The digest is for Alex, so each pair maps to the name the business uses.
// Replays fold into the same row as the original: a replayed booking is
// still a booking, and the failure detail below already shows what broke.
const ACTION_LABELS = {
  'Step 1 NEW (server-side enquiry)': 'Step 1 Enquiries',
  'Step 1 retraction':                'Step 1 Retractions',
  'Confirmed Booking':                'Confirmed Bookings',
  'High Potential':                   'High Potentials',
  'Moderate Potential':               'Moderate Potentials',
  'Customer Match':                   'Customer Match Syncs'
};

function actionLabel (e) {
  return ACTION_LABELS[e.action] || `${e.source} / ${e.action}`;
}

// ── Google Ads uploads ────────────────────────────────────────
// A retraction that could not go through for a reason already understood (a
// lead unqualified past Google's 55 day window, a conversion Google holds no
// record of) is not an upload failure. Counting it as one turned a clean day
// into "2 failed, 72 ok" and put the whole digest in the red over nothing to
// do. Those are set aside here and tallied in the retraction section instead,
// so the Fail column means only what nobody has an answer for yet.
function isExplainedRetraction (e) {
  if (e.ok || !/Step 1 retraction/.test(e.action || '')) return false;
  return RETRACTION_OUTCOMES[classifyRetraction(e)]?.expected === true;
}

async function buildGadsSection (sinceMs, untilMs, brandFilter) {
  let events = await readGadsEvents(sinceMs, untilMs);
  if (brandFilter) events = events.filter(brandFilter);

  const byAction = {};
  const explainedBy = {};
  let totalOk = 0, totalFail = 0, totalValue = 0, totalExplained = 0;
  for (const e of events) {
    const key = actionLabel(e);
    byAction[key] = byAction[key] || { ok: 0, fail: 0, explained: 0, value: 0, withClickId: 0 };
    if (e.ok) {
      byAction[key].ok++; totalOk++;
    } else if (isExplainedRetraction(e)) {
      const code = classifyRetraction(e);
      byAction[key].explained++; totalExplained++;
      explainedBy[code] = (explainedBy[code] || 0) + 1;
    } else {
      byAction[key].fail++; totalFail++;
    }
    if (e.value) { byAction[key].value += Number(e.value); totalValue += Number(e.value); }
    if (e.hasGclid || e.hasGbraid || e.hasWbraid) byAction[key].withClickId++;
  }

  const rows = Object.keys(byAction).sort().map(k => {
    const r = byAction[k];
    const total = r.ok + r.fail + r.explained;
    const coverage = total > 0 ? Math.round((r.withClickId / total) * 100) : 0;
    return `<tr style="background:${r.fail > 0 ? '#fdf3f2' : ''};">
      ${td(esc(k))}
      ${td(String(r.ok), 'right', `color:${BRAND.green};font-weight:600;`)}
      ${td(String(r.fail), 'right', `color:${r.fail > 0 ? BRAND.red : BRAND.muted};font-weight:${r.fail > 0 ? '600' : '400'};`)}
      ${td(r.value > 0 ? '£' + r.value.toLocaleString('en-GB') : '&mdash;', 'right')}
      ${td(coverage + '%', 'right')}
    </tr>`;
  }).join('');

  // Nothing disappears quietly: what was set aside is named, with its reason,
  // and pointed at the section that carries the running total.
  const setAside = totalExplained ? `
    <div style="margin-top:10px;font-size:11.5px;color:${BRAND.muted};line-height:1.55;">
      ${totalExplained} retraction attempt${totalExplained === 1 ? '' : 's'} left out of the fail count
      (${esc(Object.entries(explainedBy)
              .map(([code, n]) => `${n} ${(RETRACTION_OUTCOMES[code]?.label || code).toLowerCase()}`)
              .join(', '))}).
      Running totals are under Junk lead retraction below.
    </div>` : '';

  // Failure detail earns its space only when something actually failed.
  const failures = events.filter(e => !e.ok && !isExplainedRetraction(e)).slice(-5);
  const failHtml = failures.length ? `
    <div style="margin-top:14px;border-top:0.5px solid ${BRAND.line};padding-top:14px;">
      <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.red};">Latest failures</p>
      ${failures.map(f => `
        <div style="background:#fdf3f2;border-left:3px solid ${BRAND.red};border-radius:4px;padding:9px 11px;margin:0 0 7px;">
          <div style="font-size:12px;font-weight:500;color:${BRAND.ink};">${esc(actionLabel(f))}${f.name ? ' &middot; ' + esc(f.name) : ''}</div>
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
                rows || emptyRow(5, 'No conversion uploads in this window.')) + setAside + failHtml
  };
}



// ── Google's own upload diagnostics ───────────────────────────
// The API face of the "Offline conversion data issues" banner. Nothing
// polled it before, which is why the July 2026 transaction-id breakage was
// only spotted when Alex saw the banner himself.
//
// Tone rule, learned from live data on day one: the GOOGLE_ADS_API client
// covers our retraction calls, and a CONVERSION_NOT_FOUND blip there is an
// unretractable junk lead the retraction ledger already explains. Red is
// reserved for the ingest pipeline (Data Manager) being unhealthy or for
// any alert that is not that known pattern.
const CLIENT_LABELS = {
  'UNKNOWN':        'Conversion ingest (Data Manager)',
  'GOOGLE_ADS_API': 'Adjustments (retractions)'
};

async function buildDiagnosticsSection (accountId, accountLabel) {
  if (!(accountId || '').trim()) {
    return { title: 'Google diagnostics', stat: 'not configured', tone: 'plain',
             subtitle: accountLabel,
             html: `<p style="margin:0;font-size:12px;color:${BRAND.muted};">The ${accountLabel} Ads account id is not set in this environment, so Google's upload diagnostics cannot be read.</p>` };
  }
  const d = await uploadDiagnostics(accountId);
  if (!d || !d.clients.length) {
    return { title: 'Google diagnostics', stat: 'no upload activity', tone: 'plain', empty: true };
  }

  let worstReal = 'ok';
  const rows = d.clients.map(c => {
    const isAdjust = c.client === 'GOOGLE_ADS_API';
    const onlyKnownBlip = isAdjust && c.alerts.every(a => a.error === 'CONVERSION_NOT_FOUND');
    const unhealthy = c.status === 'NEEDS_ATTENTION' || c.status === 'NEEDS_REVIEW';
    if (unhealthy && !onlyKnownBlip) worstReal = 'bad';
    else if (unhealthy && worstReal !== 'bad') worstReal = 'warn';

    const alertTxt = c.alerts.length
      ? c.alerts.map(a => `${esc(a.error)}${a.pct != null ? ' (' + a.pct + '%)' : ''}`).join(', ')
      : '';
    return `<tr>
      ${td(esc(CLIENT_LABELS[c.client] || c.client))}
      ${td(String(c.total), 'right')}
      ${td(c.successRate != null ? c.successRate + '%' : '&mdash;', 'right')}
      ${td(unhealthy
          ? `<span style="color:${onlyKnownBlip ? BRAND.amber : BRAND.red};font-weight:600;">${esc(c.status.replace(/_/g, ' ').toLowerCase())}</span>${alertTxt ? `<div style="font-size:11px;color:${BRAND.muted};">${alertTxt}${onlyKnownBlip ? ', covered by the retraction ledger' : ''}</div>` : ''}`
          : `<span style="color:${BRAND.green};font-weight:600;">${esc(c.status.toLowerCase())}</span>`, 'right')}
    </tr>`;
  }).join('');

  return {
    title: 'Google diagnostics',
    stat: worstReal === 'bad' ? 'Google flags upload issues'
        : worstReal === 'warn' ? 'known blips only' : 'healthy',
    tone: worstReal === 'ok' ? 'good' : worstReal,
    subtitle: `${accountLabel}, Google's own verdict on our conversion uploads`,
    html: table(th('Upload client') + th('Events', 'right') + th('Success', 'right') + th('Status', 'right'), rows)
  };
}


// ── Follow up: did the uploads actually land? ─────────────────
// "Uploaded" only means Google accepted the request. This follows every
// Step 1 upload through to a recorded conversion and keeps a running total.
//
// Days too recent to judge are shown as settling, never as missing. Uploads
// carrying no click id sit outside the count: they hold a hashed email only,
// so Google records one just when it independently matches the person to a
// click, and counting them as losses made a healthy week look broken.
//
// Strictly about uploads going in. Retraction, which is about taking junk
// conversions back out, used to share this card and the two read as one
// contradictory picture: a headline saying nothing was unaccounted for, then a
// red list of eight names directly beneath it. Retraction now has its own
// section below.
async function buildLandingSection () {
  const r = await checkLandingWindow({ days: 7 });
  if (!r.rows.length) return { title: 'Conversion follow up', empty: true };
  const t = r.totals;

  const pctOk   = t.withClickId ? (t.verified / t.withClickId) * 100 : 0;
  const pctWait = t.withClickId ? (t.waiting  / t.withClickId) * 100 : 0;
  const pctMiss = Math.max(0, 100 - pctOk - pctWait);

  const headline = `
    <div style="background:${BRAND.navy};color:#fff;border-radius:10px;padding:16px 18px;">
      <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.gold};">Verified landed this week</div>
      <div style="font-family:'Baskerville Display PT',Baskerville,Georgia,serif;font-size:26px;margin-top:5px;">
        ${t.verified} <span style="font-size:14px;color:rgba(255,255,255,.5);">of ${t.withClickId}</span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;border-radius:3px;overflow:hidden;"><tr>
        <td style="height:6px;background:${BRAND.green};width:${pctOk.toFixed(1)}%;font-size:0;line-height:0;">&nbsp;</td>
        <td style="height:6px;background:#d9c48a;width:${pctWait.toFixed(1)}%;font-size:0;line-height:0;">&nbsp;</td>
        <td style="height:6px;background:${BRAND.red};width:${pctMiss.toFixed(1)}%;font-size:0;line-height:0;">&nbsp;</td>
      </tr></table>
      <div style="margin-top:8px;font-size:11.5px;color:rgba(255,255,255,.6);">
        ${t.waiting} still settling &middot; ${t.missing} not accounted for &middot; ${t.noClickId} more sent on a hashed email only
      </div>
    </div>`;

  const tone = t.settledRate == null ? 'plain'
    : t.settledRate >= 95 ? 'good'
    : t.settledRate >= 85 ? 'warn' : 'bad';

  return {
    title: 'Conversion follow up',
    stat: t.settledRate == null ? `${t.verified}/${t.withClickId} landed` : `${t.settledRate}% landed`,
    tone,
    html: headline
  };
}


// ── Junk lead retraction ──────────────────────────────────────
// The other direction of travel: conversions coming back out.
//
// When the team marks a PPC lead Budget too low or Spam enquiry, its Step 1
// conversion is retracted so Smart Bidding stops treating that enquiry as a
// win and chasing more like it. Plenty of those attempts do not go through,
// and almost all of them have an answer already, so what this section owes is
// a running total of the answers plus a loud, short list of the ones without.
async function buildRetractionSection () {
  const [ledger, missing, channels] = await Promise.all([
    retractionLedger({ days: 30, limit: 8 }),
    missingLeads({ days: 30, limit: 8 }).catch(() => []),
    retractionByChannel().catch(() => null)
  ]);
  if (!ledger.total && !ledger.queued) return { title: 'Junk lead retraction', empty: true };

  const intro = `
    <p style="margin:0 0 12px;font-size:12px;color:${BRAND.muted};line-height:1.6;">
      PPC leads marked Budget too low or Spam enquiry have their Step 1 conversion pulled
      back out of Google, so bidding stops chasing more like them. Last ${ledger.days} days:
    </p>`;

  const ledgerRows = ledger.rows.map(r => `
    <tr style="background:${r.expected ? '' : '#fdf3f2'};">
      ${td(esc(r.label))}
      ${td(String(r.count), 'right', `font-weight:600;color:${
        r.code === 'retracted' ? BRAND.green : r.expected ? BRAND.ink : BRAND.red};`)}
      ${td(esc(r.note), 'left', `color:${BRAND.muted};font-size:11.5px;`)}
    </tr>`).join('');

  const queuedLine = ledger.queued ? `
    <div style="margin-top:10px;font-size:11.5px;color:${BRAND.muted};line-height:1.55;">
      ${ledger.queued} queued, waiting for Google to finish processing the original conversion
      before it can be adjusted.
    </div>` : '';

  // The only part of this section anyone needs to act on.
  const chase = ledger.unexplained.length ? `
    <div style="background:#fdf3f2;border-left:3px solid ${BRAND.red};border-radius:6px;padding:11px 13px;margin-top:12px;">
      <div style="font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#a8321f;font-weight:600;margin-bottom:7px;">Needs a look</div>
      ${ledger.unexplained.map(u => {
        const when = u.at ? new Date(u.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
        return `<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #f6e9e7;"><tr>
          <td style="padding:5px 0;font-size:12.5px;color:${BRAND.ink};">
            ${u.itemId
              ? `<a href="https://studentluxe.monday.com/boards/2171015719/pulses/${esc(u.itemId)}" style="color:${BRAND.ink};font-weight:600;text-decoration:none;">${esc(u.name)}</a>`
              : `<span style="font-weight:600;">${esc(u.name)}</span>`}${u.campaign ? ` <span style="color:${BRAND.muted};">&middot; ${esc(u.campaign)}</span>` : ''}
          </td>
          <td align="right" style="padding:5px 0;font-size:12px;color:#a8321f;white-space:nowrap;">${esc(when)}</td>
        </tr></table>`;
      }).join('')}
      <div style="margin-top:8px;font-size:11.5px;color:${BRAND.muted};line-height:1.55;">
        Inside the adjustment window, sent to Google, and still no match. These are the ones
        without an explanation, so they are the only retraction failures worth chasing.
      </div>
    </div>` : '';

  // Named rather than counted, because the question they raise (can Performance
  // Max conversions be adjusted at all?) is answered by looking at them.
  const noRecord = missing.length ? `
    <div style="background:${BRAND.cream};border-radius:6px;padding:11px 13px;margin-top:12px;">
      <div style="font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.gold};font-weight:600;margin-bottom:7px;">No conversion found, by name</div>
      ${missing.map(m => {
        const when = m.createdAt ? new Date(m.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
        const age  = m.createdAt ? Math.max(1, Math.round((Date.now() - new Date(m.createdAt).getTime()) / 86400000)) : null;
        return `<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid rgba(184,150,110,0.18);"><tr>
          <td style="padding:5px 0;font-size:12.5px;color:${BRAND.ink};">
            <a href="https://studentluxe.monday.com/boards/2171015719/pulses/${esc(m.itemId)}" style="color:${BRAND.ink};font-weight:600;text-decoration:none;">${esc(m.name || m.itemId)}</a>${m.campaign ? ` <span style="color:${BRAND.muted};">&middot; ${esc(m.campaign)}</span>` : ''}
          </td>
          <td align="right" style="padding:5px 0;font-size:12px;color:${BRAND.muted};white-space:nowrap;">${esc(when)}${age ? ` &middot; ${age} day${age === 1 ? '' : 's'}` : ''}</td>
        </tr></table>`;
      }).join('')}
      <div style="margin-top:8px;font-size:11.5px;color:${BRAND.muted};line-height:1.55;">
        All junk leads (Budget too low or Spam enquiry) whose Step 1 conversion Google could not
        find when asked to remove it. That is not proof it was never recorded: most are
        Performance Max, where the lookup fails even when the click and the conversion both
        exist. Nothing to fix, they stay counted in Google. Names link to the Monday row.
      </div>
    </div>` : '';

  // The open Performance Max question answers itself here as attempts
  // accumulate, rather than waiting to be asked again.
  const channelBlock = !channels ? '' : `
    <div style="margin-top:12px;padding:11px 13px;background:${BRAND.cream};border-radius:6px;">
      <div style="font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.gold};font-weight:600;margin-bottom:6px;">Retraction by channel</div>
      ${channels.rows.map(row => `<div style="font-size:12.5px;color:${BRAND.ink};padding:2px 0;">
        ${esc(row.channel)}: <b>${row.ok} of ${row.total}</b> succeeded
        <span style="color:${row.rate >= 60 ? BRAND.green : BRAND.red};">${row.rate}%</span>
      </div>`).join('')}
      <div style="font-size:11.5px;color:${channels.ready ? BRAND.ink : BRAND.muted};margin-top:6px;line-height:1.5;">
        ${channels.ready ? esc(channels.verdict)
          : `Not enough attempts yet to judge whether Performance Max conversions can be retracted at all. Needs about ${channels.needed} more.`}
      </div>
    </div>`;

  const stat = ledger.unresolved
    ? `${ledger.retracted} removed, ${ledger.unresolved} to chase`
    : `${ledger.retracted} removed in ${ledger.days} days`;

  return {
    title: 'Junk lead retraction',
    stat,
    tone: ledger.unresolved > 0 ? 'bad' : 'good',
    html: intro
        + table(th('Outcome') + th('Count', 'right') + th(''),
                ledgerRows || emptyRow(3, 'No retraction attempts in this window.'))
        + queuedLine + chase + noRecord + channelBlock
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
    // Two digests, one per brand. Stay Luxe conversions route to their own
    // Ads account, so it gets its own email: its uploads (Stay Luxe source
    // prefix) and Google's diagnostics for that account. Everything else,
    // landing, retraction, booking values, errors, is Student Luxe
    // machinery and stays in the Student Luxe digest.
    const isStayLuxe = req.query?.brand === 'stayluxe';
    const stayFilter    = (e) => /^Stay Luxe/.test(e.source || '');
    const studentFilter = (e) => !/^Stay Luxe/.test(e.source || '');

    const settled = await Promise.allSettled(isStayLuxe
      ? [
          buildGadsSection(sinceMs, untilMs, stayFilter),
          buildDiagnosticsSection(process.env.STAYLUXE_ADS_CUSTOMER_ID, 'Stay Luxe Ads account')
        ]
      : [
          buildGadsSection(sinceMs, untilMs, studentFilter),
          buildDiagnosticsSection(process.env.GOOGLE_ADS_CUSTOMER_ID, 'Student Luxe Ads account'),
          buildLandingSection(),
          buildRetractionSection(),
          buildBookingSyncSection(hours + 2),
          buildErrorSection(sinceMs, untilMs)
        ]);
    settled.forEach((s, i) => {
      if (s.status === 'rejected') console.warn(`daily-digest section ${i} failed:`, s.reason?.message);
    });
    const sections = settled.map(s => s.status === 'fulfilled' ? s.value : null).filter(Boolean);

    const gads    = sections.find(s => s.title === 'Google Ads uploads');
    const diag    = sections.find(s => s.title === 'Google diagnostics');
    const errs    = sections.find(s => s.title === 'Errors');
    const live    = sections.filter(s => !s.empty);
    const landing = sections.find(s => s.title === 'Conversion follow up');
    const retract = sections.find(s => s.title === 'Junk lead retraction');
    const trouble = (errs && !errs.empty) || (gads && gads.tone === 'bad')
                 || (diag && diag.tone === 'bad')
                 || (landing && landing.tone === 'bad') || (retract && retract.tone === 'bad');

    const dateLabel = new Date(untilMs).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London'
    });

    // Built from whichever sections are actually in trouble. The old version
    // read only the uploads and errors sections, so a digest raised purely by
    // retraction or landing arrived with an empty subject line.
    const parts = [];
    if (gads    && gads.tone    === 'bad') parts.push(gads.stat);
    if (diag    && diag.tone    === 'bad') parts.push(diag.stat);
    if (landing && landing.tone === 'bad') parts.push(landing.stat);
    if (retract && retract.tone === 'bad') parts.push(retract.stat);
    if (errs    && !errs.empty)            parts.push(errs.stat + ' errors');

    const opsName = isStayLuxe ? 'Stay Luxe ops' : 'Daily ops';
    const subject = trouble
      ? `${opsName}: ${parts.join(', ') || 'needs a look'}`
      : `${opsName}: all green${gads && !gads.empty ? ', ' + gads.stat : ''}`;

    const html = shell({
      eyebrow: isStayLuxe ? 'Stay Luxe' : 'Student Luxe',
      title: trouble ? `${opsName}, needs a look` : `${opsName}, all green`,
      subtitle: dateLabel + ' · last ' + hours + 'h',
      sections,
      footer: isStayLuxe
        ? 'Stay Luxe daily digest (/api/daily-digest?brand=stayluxe): conversion uploads to the Stay Luxe Ads account and Google&#39;s own diagnostics for it. Upload failures still alert immediately.'
        : 'Combined daily digest (/api/daily-digest). Replaces the separate Google Ads summary, booking value sync and error digest emails. Upload failures still alert immediately.'
    });

    if (req.query?.dryRun === '1') {
      return res.status(200).json({ dryRun: true, subject, sections: sections.map(s => ({ title: s.title, stat: s.stat, tone: s.tone || null, empty: !!s.empty })), html });
    }

    await sendDigest({ subject, html });
    return res.status(200).json({ sent: true, subject, sections: live.map(s => s.title) });

  } catch (err) {
    console.error('daily-digest error:', err.message);
    await logError('daily-digest', err);
    return res.status(500).json({ error: err.message });
  }
};
