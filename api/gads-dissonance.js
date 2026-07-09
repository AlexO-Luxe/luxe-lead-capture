// ============================================================
//  Google Ads dissonance report (weekly).
//  GET /api/gads-dissonance?secret=<CRON_SECRET>&days=7[&dryRun=1]
//
//  Monday is the source of truth. For each confirmed PPC booking (Step 4)
//  and each High Potential PPC lead (Step 3) in the window, audit whether it
//  should have produced a Google Ads conversion, and flag the ones that
//  won't / didn't, and why:
//    - no usable gclid (can't match a click)
//    - gclid not a matchable Search click in click_view (Display-only/expired)
//    - Monday campaign/keyword disagrees with what Google actually has (attribution drift)
//    - our upload failed or never fired (KV gads:events log)
//    - value we uploaded differs from Monday's value
//
//  Google's conversion data is anonymous (counts + values by CLICK date, no
//  identity), so it can't be matched per-booking. It's shown as a headline
//  total for sanity only. The per-row truth comes from click_view + our log.
// ============================================================

const MONDAY_API     = 'https://api.monday.com/v2';
const LEADS_BOARD    = 2171015719;
const BOOKINGS_BOARD = 2171015589;
const CUSTOMER_ID    = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
const MCC_ID         = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '6046238343';
const RESEND_API     = 'https://api.resend.com/emails';
const TO             = 'alex@studentluxe.co.uk';
const FROM           = 'Student Luxe Alerts <alerts@studentluxe.co.uk>';

const { readGadsEvents, logGadsEvent } = require('./_log.js');
const { cleanGclid, conversionDestination, buildUserIdentifiers, ingestEvents, CONSENT_GRANTED } = require('./_dataManager.js');

const BOOKING_ACTION = () => process.env.GOOGLE_ADS_BOOKING_ACTION_ID;
const HP_ACTION      = () => process.env.GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID;

module.exports = async function handler (req, res) {
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (req.query?.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const days   = Math.max(1, Math.min(31, parseInt(req.query?.days || '7', 10)));
  const dryRun = req.query?.dryRun === '1';
  const fix    = req.query?.fix === '1';
  const untilMs = Date.now();
  const sinceMs = untilMs - days * 86400000;
  const sinceIso = new Date(sinceMs).toISOString().slice(0, 10);

  try {
    const token   = await getAccessToken();
    const events  = await readGadsEvents(sinceMs - 30 * 86400000, untilMs); // wide, to find upload records

    const bookings = await fetchBookings(sinceIso);
    const hpleads  = await fetchHighPotential(sinceMs);

    // One click_view scan for every gclid in the set (batched by day).
    const allGclids = [...new Set([...bookings, ...hpleads].map(x => x.gclid).filter(Boolean))];
    const clickMap  = await buildClickMap(token, allGclids, bookings.concat(hpleads));

    const bookRows = bookings.map(b => auditRow(b, clickMap, events, 'Confirmed Booking'));
    const hpRows   = hpleads.map(l => auditRow(l, clickMap, events, 'High Potential'));

    const g4 = await convTotals(token, 'Step 4 — Confirmed Booking (real value)', sinceIso);
    const g3 = await convTotals(token, 'Step 3 — High potential leads', sinceIso);

    const out = {
      window: `last ${days}d`, dryRun,
      step4: summarize(bookRows, g4),
      step3: summarize(hpRows, g3),
      bookings: bookRows,
      hpleads:  hpRows
    };

    // Auto-remediation: upload the conversion for any dissonant row that has a
    // matchable Search click but never recorded (never uploaded, or upload
    // failed). Stable replay transaction id so nothing double-counts.
    if (fix && !dryRun) {
      out.fixed = [];
      const jobs = [
        ...bookings.map((b, i) => ({ item: b, row: bookRows[i], actionId: BOOKING_ACTION(), value: b.value })),
        ...hpleads.map((l, i)  => ({ item: l, row: hpRows[i],   actionId: HP_ACTION(),      value: 300 }))
      ];
      for (const j of jobs) {
        const it = j.item, r = j.row;
        if (r.verdict === 'ok' || r.uploaded === 'ok') continue;   // already fine
        if (!it.gclid || !clickMap[it.gclid]) continue;            // no matchable click, EC seed's job
        if (!(Number(j.value) > 0)) continue;                      // nothing to value
        const ids = buildUserIdentifiers({ email: it.email, phone: it.phone, regionCode: 'GB' });
        try {
          const result = await ingestEvents({
            destinations: [ conversionDestination({ conversionActionId: j.actionId, reference: 'sl-fix' }) ],
            events: [{
              destinationReferences: ['sl-fix'],
              transactionId: 'replay:' + it.id + ':' + j.actionId,
              eventTimestamp: new Date().toISOString(),
              eventSource: 'WEB',
              adIdentifiers: { gclid: it.gclid },
              userData: { userIdentifiers: ids },
              currency: 'GBP',
              conversionValue: Number(j.value)
            }],
            consent: CONSENT_GRANTED
          });
          await logGadsEvent({ source: 'gads-dissonance (fix)', action: j.actionId === BOOKING_ACTION() ? 'Confirmed Booking' : 'High Potential', ok: true, reason: 'dissonance_fix', value: j.value, mondayId: it.id });
          r.autoFixed = true;   // so the email shows it as resolved this run, not stale-broken
          out.fixed.push({ id: it.id, name: it.name, value: j.value, requestId: result?.requestId || null });
        } catch (err) {
          out.fixed.push({ id: it.id, name: it.name, value: j.value, error: err.message.slice(0, 160) });
        }
      }
    }

    if (!dryRun) await sendReport(out, days).catch(e => console.warn('report send failed:', e.message));
    return res.status(200).json(out);
  } catch (err) {
    console.error('gads-dissonance error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── audit one row ──────────────────────────────────────────────
function auditRow (item, clickMap, events, action) {
  const flags = [];
  const click = item.gclid ? clickMap[item.gclid] : null;

  if (!item.gclidRaw)                    flags.push('no click id');
  else if (!item.gclid)                  flags.push('click id is a braid/fbclid (not a gclid)');
  else if (!click)                       flags.push('gclid not a matchable Search click (Display-only or expired)');
  else {
    if (item.campaign && !looseMatch(item.campaign, click.campaign)) flags.push(`campaign drift: Monday "${item.campaign}" vs Google "${click.campaign}"`);
    if (item.keyword  && click.keyword && !looseMatch(item.keyword, click.keyword)) flags.push(`keyword drift: Monday "${item.keyword}" vs Google "${click.keyword}"`);
  }

  // upload status from our KV log (latest entry for this mondayId + action)
  const evs = events.filter(e => String(e.mondayId) === String(item.id) && (e.action || '').includes(action.split(' ')[0]));
  const latest = evs.sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
  if (!latest)              flags.push('no upload attempt logged');
  else if (!latest.ok)      flags.push('last upload failed');
  else if (item.value != null && latest.value != null && Math.abs(Number(item.value) - Number(latest.value)) > 1)
                            flags.push(`value drift: Monday £${item.value} vs uploaded £${latest.value}`);

  return {
    id: item.id, name: item.name, value: item.value,
    mondayCampaign: item.campaign, mondayKeyword: item.keyword,
    googleCampaign: click?.campaign || null, googleKeyword: click?.keyword || null, clickDate: click?.date || null,
    uploaded: latest ? (latest.ok ? 'ok' : 'failed') : 'none',
    verdict: flags.length ? 'DISSONANCE' : 'ok',
    flags
  };
}

function summarize (rows, gTotals) {
  const clean = rows.filter(r => r.verdict === 'ok');
  const diss  = rows.filter(r => r.verdict !== 'ok');
  const mondayValue = rows.reduce((a, r) => a + (Number(r.value) || 0), 0);
  return {
    mondayCount: rows.length, mondayValue: round2(mondayValue),
    clean: clean.length, dissonant: diss.length,
    googleRecorded: gTotals   // { conv, value } by click date, sanity only
  };
}

// ── Monday ─────────────────────────────────────────────────────
async function fetchBookings (sinceIso) {
  const frag = `id name column_values(ids: ["numeric_mm1ge9h4","date9","lookup_mkxtxk48","status"]) { id text ... on MirrorValue { display_value } }
    relation: column_values(ids: ["link_to_leads26"]) { ... on BoardRelationValue { linked_items { id created_at column_values(ids: ["text4__1","text_mm1c3b5w","text3__1","text_mm4ncd41","text_mm4n9t2x","email","phone_1"]) { id text } } } }`;
  const q = `query { boards(ids: ${BOOKINGS_BOARD}) { items_page(limit: 200, query_params: {
      rules: [{ column_id: "date9", compare_value: ["${sinceIso}"], operator: greater_than_or_equals }] }) {
      items { ${frag} } } } }`;
  const d = await mondayQuery(q);
  const items = d?.data?.boards?.[0]?.items_page?.items || [];
  return items.map(it => {
    const cv = {}; it.column_values.forEach(c => { cv[c.id] = c.display_value || c.text || ''; });
    if (!/ppc/i.test(cv.lookup_mkxtxk48 || '')) return null;
    const lead = it.relation?.[0]?.linked_items?.[0];
    const lc = {}; (lead?.column_values || []).forEach(c => { lc[c.id] = (c.text || '').trim(); });
    const raw = lc.text4__1 || '';
    const value = parseFloat((cv.numeric_mm1ge9h4 || '').replace(/[£$€,\s]/g, ''));
    return {
      id: it.id, name: it.name, value: Number.isFinite(value) ? value : null,
      gclidRaw: raw, gclid: cleanGclid(raw, lc.text_mm4ncd41, lc.text_mm4n9t2x),
      campaign: lc.text_mm1c3b5w || '', keyword: lc.text3__1 || '',
      email: lc.email || '', phone: lc.phone_1 || '',
      leadCreated: lead?.created_at || null
    };
  }).filter(Boolean);
}

async function fetchHighPotential (sinceMs) {
  const q = `query { boards(ids: ${LEADS_BOARD}) { items_page(limit: 200, query_params: {
      rules: [{ column_id: "color_mkt29g1r", compare_value: ["High Potential"], operator: contains_text }],
      order_by: [{ column_id: "__last_updated__", direction: desc }] }) {
      items { id name created_at updated_at column_values(ids: ["text4__1","text_mm1c3b5w","text3__1","color_mkxk8y67","text_mm4ncd41","text_mm4n9t2x","email","phone_1"]) { id text } } } } }`;
  const d = await mondayQuery(q);
  const items = d?.data?.boards?.[0]?.items_page?.items || [];
  // Audit leads CREATED in the window (this week's new HP leads), not merely
  // re-touched. An old lead an automation nudged this week would otherwise
  // false-flag "no upload logged" because its real Step 3 upload predates the
  // KV log window. Trade-off: a lead created earlier but marked HP this week
  // is missed; rare for a weekly cadence, widen `days` to catch it.
  return items.filter(it => new Date(it.created_at || 0).getTime() >= sinceMs).map(it => {
    const c = {}; it.column_values.forEach(x => { c[x.id] = (x.text || '').trim(); });
    if (!/ppc/i.test(c.color_mkxk8y67 || '')) return null;
    const raw = c.text4__1 || '';
    return {
      id: it.id, name: it.name, value: 300,
      gclidRaw: raw, gclid: cleanGclid(raw, c.text_mm4ncd41, c.text_mm4n9t2x),
      campaign: c.text_mm1c3b5w || '', keyword: c.text3__1 || '',
      email: c.email || '', phone: c.phone_1 || '',
      leadCreated: it.created_at || null
    };
  }).filter(Boolean);
}

async function mondayQuery (query) {
  const r = await fetch(MONDAY_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY }, body: JSON.stringify({ query }) });
  const d = await r.json();
  if (d.errors) throw new Error(JSON.stringify(d.errors).slice(0, 200));
  return d;
}

// ── Google Ads ─────────────────────────────────────────────────
// One click_view query per day (gclid IN [...]), scanning from the earliest
// lead's creation up to today, capped at 100 days. Returns gclid -> click.
async function buildClickMap (token, gclids, items) {
  const map = {};
  if (!gclids.length) return map;
  // Scan the FULL click_view retention window (~90d). A first-touch gclid can
  // be much older than the lead it's stored on (returning enquirer), so we
  // can't anchor the scan to the lead's creation date.
  const start   = new Date(Date.now() - 92 * 86400000);
  const inList = gclids.map(g => `"${g}"`).join(',');

  for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    let rows;
    try {
      rows = await gadsQuery(token, `SELECT click_view.gclid, campaign.name, click_view.keyword_info.text
        FROM click_view WHERE click_view.gclid IN (${inList}) AND segments.date = '${day}'`);
    } catch { rows = []; }
    for (const r of rows) {
      const g = r.clickView?.gclid;
      if (g && !map[g]) map[g] = { date: day, campaign: r.campaign?.name || '', keyword: r.clickView?.keywordInfo?.text || '' };
    }
  }
  return map;
}

async function convTotals (token, actionName, sinceIso) {
  try {
    const rows = await gadsQuery(token, `SELECT metrics.all_conversions, metrics.all_conversions_value
      FROM conversion_action WHERE conversion_action.name = "${actionName}" AND segments.date BETWEEN "${sinceIso}" AND "${new Date().toISOString().slice(0,10)}"`);
    let c = 0, v = 0;
    rows.forEach(r => { c += Number(r.metrics?.allConversions || 0); v += Number(r.metrics?.allConversionsValue || 0); });
    return { conv: round2(c), value: round2(v) };
  } catch { return { conv: null, value: null }; }
}

async function getAccessToken () {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_ADS_CLIENT_ID, client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET, refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  const d = await r.json();
  if (!d.access_token) throw new Error('Token failed: ' + JSON.stringify(d).slice(0, 160));
  return d.access_token;
}

async function gadsQuery (token, gaql) {
  const r = await fetch(`https://googleads.googleapis.com/v21/customers/${CUSTOMER_ID}/googleAds:search`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN, 'login-customer-id': MCC_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gaql }) });
  const text = await r.text();
  if (!text.trim().startsWith('{')) throw new Error('GAds non-JSON: ' + text.slice(0, 120));
  const data = JSON.parse(text);
  if (data.error) throw new Error('GAds: ' + JSON.stringify(data.error).slice(0, 160));
  return data.results || [];
}

// ── email ──────────────────────────────────────────────────────
async function sendReport (out, days) {
  if (!process.env.RESEND_API_KEY) return;
  const safe = v => (v == null ? '' : String(v).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])));
  const money = v => '£' + Number(v || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const section = (title, s, rows) => {
    const diss = rows.filter(r => r.verdict !== 'ok');
    const af = rows.filter(r => r.autoFixed).length;
    const head = `<h3 style="font-family:Georgia,serif;color:#0d1a2e;font-size:16px;margin:22px 0 4px;">${title}</h3>
      <p style="font-size:12px;color:#555;margin:0 0 10px;">
        Monday: <b>${s.mondayCount}</b> (${money(s.mondayValue)}) &middot; clean <b style="color:#417505;">${s.clean}</b> &middot;
        dissonant <b style="color:#c0392b;">${s.dissonant}</b>${af ? ` &middot; <b style="color:#417505;">${af} auto-fixed this run</b>` : ''} &middot;
        Google recorded this window (by click date, sanity only): ${s.googleRecorded?.conv ?? '?'} / ${money(s.googleRecorded?.value)}
      </p>`;
    if (!diss.length) return head + `<p style="font-size:13px;color:#417505;">All ${s.mondayCount} matched cleanly. No dissonance.</p>`;
    const body = diss.map(r => {
      const fixed = r.autoFixed;
      const badge = fixed ? '🔧✅' : (r.uploaded === 'ok' ? '✅' : r.uploaded === 'failed' ? '❌' : '—');
      const note = fixed
        ? `<div style="font-size:11.5px;color:#2f6b16;background:#f2f8ee;padding:7px 9px;border-radius:4px;">Auto-fixed this run, conversion uploaded now.<br><span style="color:#9b9b9b;">flagged because: ${r.flags.map(safe).join('; ')}</span></div>`
        : `<div style="font-size:11.5px;color:#8b2a1d;background:#fdf3f2;padding:7px 9px;border-radius:4px;">${r.flags.map(safe).join('<br>')}</div>`;
      return `
      <tr><td style="padding:7px 9px;border-bottom:1px solid #eee;font-weight:600;color:#0d1a2e;">${safe(r.name)}</td>
        <td style="padding:7px 9px;border-bottom:1px solid #eee;text-align:right;">${money(r.value)}</td>
        <td style="padding:7px 9px;border-bottom:1px solid #eee;color:#9b9b9b;">${safe(r.mondayCampaign || '—')}</td>
        <td style="padding:7px 9px;border-bottom:1px solid #eee;">${badge}</td></tr>
      <tr><td colspan="4" style="padding:0 9px 9px;border-bottom:1px solid #eee;">${note}</td></tr>`;
    }).join('');
    return head + `<table style="width:100%;border-collapse:collapse;font-size:12.5px;"><thead><tr>
      <th style="text-align:left;padding:7px 9px;color:#9b9b9b;">Name</th><th style="text-align:right;padding:7px 9px;color:#9b9b9b;">Value</th>
      <th style="text-align:left;padding:7px 9px;color:#9b9b9b;">Campaign (Monday)</th><th style="text-align:left;padding:7px 9px;color:#9b9b9b;">Upload</th>
      </tr></thead><tbody>${body}</tbody></table>`;
  };

  const html = `
<div style="font-family:-apple-system,'DM Sans',Arial,sans-serif;background:#FBF8F2;padding:24px;max-width:680px;margin:0 auto;color:#1a1a1a;">
  <div style="background:#fff;border-radius:10px;border:0.5px solid rgba(184,150,110,0.3);overflow:hidden;">
    <div style="background:#0d1a2e;color:#fff;padding:16px 22px;font-size:14px;font-weight:600;letter-spacing:0.03em;">
      Google Ads dissonance report &middot; last ${days} days
    </div>
    <div style="padding:8px 22px 24px;">
      <p style="font-size:12.5px;color:#555;line-height:1.55;">Monday bookings and High Potential leads audited against Google's click data + our upload log. Only <b>dissonant</b> rows are listed, the ones that won't record, recorded wrong, or drifted from Google's attribution.</p>
      ${section('Step 4 — Confirmed Bookings', out.step4, out.bookings)}
      ${section('Step 3 — High Potential Leads', out.step3, out.hpleads)}
      <p style="margin-top:22px;font-size:11px;color:#9b9b9b;line-height:1.6;">Sent by /api/gads-dissonance. Google totals are by click date and anonymous, headline only. Per-row truth is click_view + our KV log.</p>
    </div>
  </div>
</div>`;

  await fetch(RESEND_API, { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [TO], subject: `Google Ads dissonance — ${out.step4.dissonant + out.step3.dissonant} flagged (last ${days}d)`, html }) });
}

// ── helpers ────────────────────────────────────────────────────
function norm (s) { return (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' '); }
// Loose compare: lowercase, collapse spaces, strip trailing junk (Google
// campaign names carry stray "  -" suffixes). Treat prefix containment as a
// match so a truncated/suffixed variant of the same name doesn't false-flag.
function normLoose (s) { return norm(s).replace(/[^a-z0-9]+$/, '').replace(/^[^a-z0-9]+/, ''); }
function looseMatch (a, b) {
  const x = normLoose(a), y = normLoose(b);
  if (!x || !y) return true;
  return x === y || x.startsWith(y) || y.startsWith(x);
}
function round2 (n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
