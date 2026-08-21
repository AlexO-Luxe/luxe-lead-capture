// ============================================================
//  Sync booking value: formula2 -> numeric_mm1ge9h4 (Rev to Google).
//  GET /api/sync-booking-values?secret=<CRON_SECRET>[&dryRun=1&tolerance=1&month=YYYY-MM]
//
//  Why this exists:
//  formula2 ("Total Luxe Commission excl VAT") is the true booking value,
//  but it is a Monday FORMULA column that references cross-board MIRRORS,
//  so Monday never evaluates it server-side and the API returns null for it.
//  It can only be read by a human in the UI. That is why the value has to be
//  hand-copied into numeric_mm1ge9h4 (the plain number column every system,
//  and the Google Ads upload, actually reads).
//
//  This endpoint recomputes formula2 in code from its 10 base columns and
//  writes the result into numeric_mm1ge9h4 when it differs, so new bookings
//  fill themselves in and amended bookings (guest changes nights etc) re-sync.
//
//  Scope: PPC bookings only (lookup_mkxtxk48 contains "PPC"), confirmed
//  (date9 set) and either closed this month or with a future check-in.
//  Non-GBP and split/zero-nightly bookings can't be computed from these
//  columns and are skipped (listed in the digest for manual entry).
//
//  Accuracy: matches the hand-entered value within £1 on ~90% of PPC
//  bookings. The ~10% that differ are mostly extensions / rebookings (whose
//  value comes from instalment columns not modelled here) or genuinely
//  amended bookings. EVERY write is listed in the daily email digest so a
//  wrong auto-write is visible and reversible.
//
//  Writing numeric_mm1ge9h4 re-fires the submit-booking webhook, which
//  re-uploads the conversion to Google with a stable transaction id. That is
//  intended: it keeps Google in sync with amendments.
// ============================================================

const MONDAY_API     = 'https://api.monday.com/v2';
const BOOKINGS_BOARD = 2171015589;
const RESEND_API     = 'https://api.resend.com/emails';
const DIGEST_TO      = 'alex@studentluxe.co.uk';
const FROM           = 'Student Luxe Alerts <alerts@studentluxe.co.uk>';

// The formula2 base columns live in _booking-value.js (shared with the Lead
// Qualified email so the commission math exists in exactly one place).
const { FORMULA2_COLS, computeFormula2, txt, disp, numOf, round2 } = require('./_booking-value.js');

const COLS = [
  ...FORMULA2_COLS,
  'numeric_mm1ge9h4', // Rev to Google (target)
  'lookup_mkxtxk48',  // Lead source lookup: PPC filter
  'date9',            // Close Date (Booking Confirmed): confirmed gate + month scope
  'status'
];

const { logError } = require('./_errlog.js');

module.exports = async function handler (req, res) {
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (req.query?.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const dryRun    = req.query?.dryRun === '1';
  const tolerance = Math.max(0, parseFloat(req.query?.tolerance || '1'));
  const monthStr  = req.query?.month || monthKey(londonNow()); // YYYY-MM

  try {
    const items    = await fetchScopedBookings(monthStr + '-01', isoToday());
    const out      = { month: monthStr, tolerance, dryRun, scanned: items.length, filled: [], amended: [], skipped: [], unchanged: 0, manualKept: 0 };

    for (const it of items) {
      const cv = {};
      it.column_values.forEach(c => { cv[c.id] = c; });

      // PPC only (lookup can't be filtered server-side, so check here).
      if (!/ppc/i.test(disp(cv.lookup_mkxtxk48))) continue;

      // Confirmed only (date9 set), and in scope: closed this month OR future check-in.
      const closeDate = txt(cv.date9);
      const checkIn   = txt(cv.date69);
      if (!closeDate) continue;                       // not confirmed yet
      const inMonth   = closeDate.slice(0, 7) === monthStr;
      const future    = checkIn && checkIn >= isoToday();
      if (!inMonth && !future) continue;

      const calc = computeFormula2(cv);
      const name = it.name;
      const stored = numOf(txt(cv.numeric_mm1ge9h4));
      const hasStored = txt(cv.numeric_mm1ge9h4) !== '';

      if (calc == null) {
        // Non-computable row (non-GBP currency or a split booking with no
        // nightly rate). If the team already entered a Rev to Google value by
        // hand, trust it and stop flagging; each Monday item counts as its own
        // booking, so split bookings keep one manual value per row. Only rows
        // still missing a value are listed for manual entry.
        if (hasStored && stored > 0) { out.manualKept++; }
        else out.skipped.push({ id: it.id, name, reason: 'non-GBP or zero nightly (split booking)' });
        continue;
      }

      if (!hasStored) {
        if (!dryRun) await writeValue(it.id, calc);
        out.filled.push({ id: it.id, name, value: calc });
      } else if (Math.abs(calc - stored) > tolerance) {
        if (!dryRun) await writeValue(it.id, calc);
        out.amended.push({ id: it.id, name, from: stored, to: calc, diff: round2(calc - stored) });
      } else {
        out.unchanged++;
      }
    }

    // The daily digest reports this run, so the summary is parked in KV for
    // it to pick up rather than sent as its own email. ?email=1 still sends
    // the standalone version for a manual run.
    if (!dryRun) {
      await stashRun(out).catch(e => console.warn('digest stash failed:', e.message));
      if (req.query?.email === '1' && (out.filled.length || out.amended.length || out.skipped.length)) {
        await sendDigest(out).catch(e => console.warn('digest send failed:', e.message));
      }
    }

    out.summary = { filled: out.filled.length, amended: out.amended.length, skipped: out.skipped.length, unchanged: out.unchanged, manualKept: out.manualKept };
    return res.status(200).json(out);
  } catch (err) {
    console.error('sync-booking-values error:', err.message);
    await logError('sync-booking-values', err);
    return res.status(500).json({ error: err.message });
  }
};


// ── Digest handover ────────────────────────────────────────────
// The 06:30 worker run and the 08:30 digest are separate invocations, so
// the result travels through KV. Two-day TTL, long enough that a missed
// digest still finds the last run.
let _kvClient = null;
async function digestKv () {
  if (_kvClient) return _kvClient;
  const { Redis } = await import('@upstash/redis');
  _kvClient = Redis.fromEnv();
  return _kvClient;
}
const RUN_KEY = 'digest:booking-sync';

async function stashRun (out) {
  const k = await digestKv();
  await k.set(RUN_KEY, {
    at: Date.now(),
    filled:  out.filled.map(r => ({ name: r.name, value: r.value })),
    amended: out.amended.map(r => ({ name: r.name, from: r.from, to: r.to, diff: r.diff })),
    skipped: out.skipped.map(r => ({ name: r.name, reason: r.reason })),
    unchanged: out.unchanged
  }, { ex: 2 * 24 * 3600 });
}

// Section for the daily digest. Returns null when the last run is missing
// or older than the window, so a stale run is never reported as today's.
async function buildBookingSyncSection (maxAgeHours = 26) {
  const { esc, table, th, td, emptyRow, BRAND } = require('./_digest.js');
  let run = null;
  try { run = await (await digestKv()).get(RUN_KEY); } catch (e) { return null; }
  if (!run || !run.at || Date.now() - run.at > maxAgeHours * 3600000) return null;

  const rows = [];
  run.filled.forEach(r => rows.push(
    `<tr>${td(esc(r.name))}${td('Filled', 'left', 'color:' + BRAND.green + ';')}${td('£' + Number(r.value).toLocaleString('en-GB', { minimumFractionDigits: 2 }), 'right')}</tr>`));
  run.amended.forEach(r => rows.push(
    `<tr>${td(esc(r.name))}${td('Amended', 'left', 'color:' + BRAND.amber + ';')}${td('£' + Number(r.from).toLocaleString('en-GB') + ' → £' + Number(r.to).toLocaleString('en-GB'), 'right')}</tr>`));
  run.skipped.forEach(r => rows.push(
    `<tr>${td(esc(r.name))}${td('Enter manually', 'left', 'color:' + BRAND.red + ';')}${td(esc(r.reason), 'right', 'font-size:11px;color:' + BRAND.muted + ';')}</tr>`));

  const changes = run.filled.length + run.amended.length;
  if (!rows.length) {
    return { title: 'Booking values', stat: 'all in sync', tone: 'good', empty: true };
  }
  return {
    title: 'Booking values',
    stat: `${changes} updated${run.skipped.length ? ', ' + run.skipped.length + ' need you' : ''}`,
    tone: run.skipped.length ? 'warn' : 'good',
    subtitle: `${run.unchanged} already correct`,
    html: table(th('Booking') + th('Action') + th('Value', 'right'), rows.join(''))
  };
}

// ── Monday ─────────────────────────────────────────────────────
// Pulling every confirmed booking (~2.6k, each with heavy mirror
// display_value fragments) is far too slow. Instead fetch two small
// date-filtered slices and union them: bookings closed this month
// (date9 >= 1st, for fill/amend) and bookings with a future check-in
// (date69 >= today, to catch amendments to advance bookings). Lookup
// columns can't be filtered server-side, so PPC is checked client-side.
const FRAG = `id name column_values(ids: ${JSON.stringify(COLS)}) { id text ... on MirrorValue { display_value } ... on StatusValue { label } }`;

async function fetchScopedBookings (monthStart, today) {
  const a = await fetchByDateRule('date9', monthStart);
  const b = await fetchByDateRule('date69', today);
  const byId = new Map();
  for (const it of [...a, ...b]) byId.set(it.id, it);
  return [...byId.values()];
}

async function fetchByDateRule (columnId, sinceIso) {
  const items = [];
  let cursor = null;
  do {
    const query = cursor
      ? `query { next_items_page(limit: 250, cursor: ${JSON.stringify(cursor)}) { cursor items { ${FRAG} } } }`
      : `query { boards(ids: ${BOOKINGS_BOARD}) { items_page(limit: 250, query_params: {
           rules: [{ column_id: ${JSON.stringify(columnId)}, compare_value: [${JSON.stringify(sinceIso)}], operator: greater_than_or_equals }]
         }) { cursor items { ${FRAG} } } } }`;
    const d = await mondayQuery(query);
    const page = cursor ? d?.data?.next_items_page : d?.data?.boards?.[0]?.items_page;
    if (!page) break;
    items.push(...(page.items || []));
    cursor = page.cursor;
  } while (cursor);
  return items;
}

async function writeValue (itemId, value) {
  const mutation = `mutation {
    change_simple_column_value(board_id: ${BOOKINGS_BOARD}, item_id: ${itemId},
      column_id: "numeric_mm1ge9h4", value: ${JSON.stringify(String(value))}) { id }
  }`;
  const d = await mondayQuery(mutation);
  return d?.data?.change_simple_column_value?.id;
}

async function mondayQuery (query) {
  const r = await fetch(MONDAY_API, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
    body:    JSON.stringify({ query })
  });
  const d = await r.json();
  if (d.errors) throw new Error(JSON.stringify(d.errors).slice(0, 240));
  return d;
}

// ── digest email ───────────────────────────────────────────────
async function sendDigest (out) {
  if (!process.env.RESEND_API_KEY) return;
  const safe = (v) => (v == null ? '' : String(v).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])));
  const money = (v) => '£' + Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const rows = (list, cells) => list.map(cells).join('');
  const filledRows = rows(out.filled, r =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${safe(r.name)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${money(r.value)}</td></tr>`);
  const amendedRows = rows(out.amended, r =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${safe(r.name)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#9b9b9b;">${money(r.from)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${money(r.to)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:${r.diff >= 0 ? '#417505' : '#c0392b'};">${r.diff >= 0 ? '+' : ''}${money(r.diff)}</td></tr>`);
  const skipRows = rows(out.skipped, r =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${safe(r.name)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#9b9b9b;">${safe(r.reason)}</td></tr>`);

  const section = (title, head, body) => body
    ? `<h3 style="font-family:Georgia,serif;color:#0d1a2e;font-size:15px;margin:22px 0 8px;">${title}</h3>
       <table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    : '';

  const html = `
<div style="font-family:-apple-system,'DM Sans',Arial,sans-serif;background:#FBF8F2;padding:24px;max-width:640px;margin:0 auto;color:#1a1a1a;">
  <div style="background:#fff;border-radius:10px;border:0.5px solid rgba(184,150,110,0.3);overflow:hidden;">
    <div style="background:#0d1a2e;color:#fff;padding:16px 22px;font-size:14px;font-weight:600;letter-spacing:0.03em;">
      Booking value sync — ${safe(out.month)}
    </div>
    <div style="padding:8px 22px 22px;">
      <p style="font-size:13px;color:#555;line-height:1.55;">
        ${out.filled.length} filled, ${out.amended.length} amended, ${out.skipped.length} need manual entry, ${out.unchanged} already correct, ${out.manualKept || 0} manual values kept (non-GBP/split, entered by hand).
        Values recomputed from the Monday formula and written to <em>Rev to Google</em>. Please glance at any amended row against the formula column.
      </p>
      ${section('Filled (were blank)', `<th style="text-align:left;padding:6px 10px;color:#9b9b9b;">Booking</th><th style="text-align:right;padding:6px 10px;color:#9b9b9b;">Value</th>`, filledRows)}
      ${section('Amended (value changed)', `<th style="text-align:left;padding:6px 10px;color:#9b9b9b;">Booking</th><th style="text-align:right;padding:6px 10px;color:#9b9b9b;">Was</th><th style="text-align:right;padding:6px 10px;color:#9b9b9b;">Now</th><th style="text-align:right;padding:6px 10px;color:#9b9b9b;">Diff</th>`, amendedRows)}
      ${section('Skipped — enter manually', `<th style="text-align:left;padding:6px 10px;color:#9b9b9b;">Booking</th><th style="text-align:left;padding:6px 10px;color:#9b9b9b;">Reason</th>`, skipRows)}
      <p style="margin-top:22px;font-size:11px;color:#9b9b9b;line-height:1.6;">
        Sent by /api/sync-booking-values. Skipped rows are non-GBP or split bookings that can't be computed from the rate columns.
      </p>
    </div>
  </div>
</div>`;

  await fetch(RESEND_API, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [DIGEST_TO], subject: `Booking value sync — ${out.summary?.filled || out.filled.length} filled, ${out.summary?.amended || out.amended.length} amended`, html })
  });
}

// ── helpers ────────────────────────────────────────────────────
function londonNow () {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
}
function monthKey (d) { return d.toISOString().slice(0, 7); }
function isoToday () { return londonNow().toISOString().slice(0, 10); }

module.exports.buildBookingSyncSection = buildBookingSyncSection;
