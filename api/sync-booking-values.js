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

// Base columns formula2 reduces to (see settings_str reverse-engineering).
const COLS = [
  'color_mm00yfav',   // Currencies (status): "£" gates the whole calc
  'date69',           // Check In
  'date_1',           // Check Out
  'mirror68',         // Commission Calc (BB): "Gross" | "Net"
  'mirror74',         // VAT / No VAT (BB)
  'mirror_144',       // Net / Gross (BB)
  'numbers54',        // Previous Nights in Altogether (Ext)
  'numbers80',        // Agreed Nightly Rate
  'numbers92',        // Luxe % Commission (percent-unit: used as /100)
  'numeric_mm1a1e33', // Discount Amount Gross (whole booking)
  'numeric_mm1ge9h4', // Rev to Google (target)
  'lookup_mkxtxk48',  // Lead source lookup: PPC filter
  'date9',            // Close Date (Booking Confirmed) — confirmed gate + month scope
  'status'
];

module.exports = async function handler (req, res) {
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (req.query?.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const dryRun    = req.query?.dryRun === '1';
  const tolerance = Math.max(0, parseFloat(req.query?.tolerance || '1'));
  const monthStr  = req.query?.month || monthKey(londonNow()); // YYYY-MM

  try {
    const items    = await fetchPpcBookings();
    const out      = { month: monthStr, tolerance, dryRun, scanned: items.length, filled: [], amended: [], skipped: [], unchanged: 0 };

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
        out.skipped.push({ id: it.id, name, reason: calc === null ? 'non-GBP or zero nightly (split booking)' : 'incomplete data' });
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

    if (!dryRun && (out.filled.length || out.amended.length || out.skipped.length)) {
      await sendDigest(out).catch(e => console.warn('digest send failed:', e.message));
    }

    out.summary = { filled: out.filled.length, amended: out.amended.length, skipped: out.skipped.length, unchanged: out.unchanged };
    return res.status(200).json(out);
  } catch (err) {
    console.error('sync-booking-values error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── formula2 recompute ─────────────────────────────────────────
// formula2 = ROUND(IF(mirror68="Gross",
//              MINUS(MULTIPLY(TotalGross, comm), DiscountNet),
//              MINUS(MULTIPLY(TotalNet,   comm), DiscountNet)), 2)
//   TotalGross = GrossRate * nights ;  TotalNet = NetRate * nights
//   DiscountNet = discountGross / 1.2 ;  comm = numbers92 / 100
// Returns null when it can't be computed (non-GBP, zero nightly, bad dates).
function computeFormula2 (cv) {
  const cur = txt(cv.color_mm00yfav);
  const nights = daysBetween(txt(cv.date69), txt(cv.date_1));
  if (nights == null) return null;
  const n80 = numOf(txt(cv.numbers80));
  if (n80 === 0 || cur !== '£') return null; // split booking / foreign currency

  const m68  = disp(cv.mirror68);
  const m144 = disp(cv.mirror_144);
  const m74  = disp(cv.mirror74);
  const n54  = numOf(txt(cv.numbers54));
  const comm = numOf(txt(cv.numbers92)) / 100;
  const disc = numOf(txt(cv.numeric_mm1a1e33)) / 1.2;

  const rate = eqi(m68, 'Gross')
    ? grossRate(cur, m144, m74, n80, n54, nights)
    : netRate(cur, m144, m74, n80, n54, nights);

  return round2(rate * nights * comm - disc);
}

function grossRate (cur, m144, m74, n80, n54, nights) {
  if (cur !== '£') return n80;
  let r;
  if (eqi(m144, 'Gross') || (eqi(m144, 'Net') && eqi(m74, 'No VAT')) || (nights >= 90 && eqi(m74, 'VAT on < 90 nights'))) {
    r = n80;
  } else if (n54 >= 28) {
    r = n80 * 1.04;
  } else if (nights + n54 <= 28) {
    r = n80 * 1.2;
  } else {
    r = ((28 - n54) * n80 * 1.2 + (nights - (28 - n54)) * n80 * 1.04) / nights;
  }
  return round2(r);
}

function netRate (cur, m144, m74, n80, n54, nights) {
  if (cur !== '£') return n80;
  if (eqi(m74, 'No Vat') || eqi(m144, 'Net') || (eqi(m74, 'Vat on < 90 Nights') && nights >= 90)) return n80;
  const tot = nights + n54;
  if (tot >= 28) return (28 * n80 / 1.2 + (tot - 28) * n80 / 1.04) / tot;
  if (tot < 28)  return (tot * n80 / 1.2) / tot;
  return 0;
}

// ── Monday ─────────────────────────────────────────────────────
async function fetchPpcBookings () {
  const frag = `id name column_values(ids: ${JSON.stringify(COLS)}) { id text ... on MirrorValue { display_value } ... on StatusValue { label } }`;
  const items = [];
  let cursor = null;
  do {
    const query = cursor
      ? `query { next_items_page(limit: 250, cursor: ${JSON.stringify(cursor)}) { cursor items { ${frag} } } }`
      // Lookup columns can't be filtered server-side (contains_text is
      // unsupported for that type), so filter on date9 (confirmed bookings)
      // here and check PPC client-side from the lookup's display_value.
      : `query { boards(ids: ${BOOKINGS_BOARD}) { items_page(limit: 250, query_params: {
           rules: [{ column_id: "date9", compare_value: [""], operator: is_not_empty }]
         }) { cursor items { ${frag} } } } }`;
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
        ${out.filled.length} filled, ${out.amended.length} amended, ${out.skipped.length} need manual entry, ${out.unchanged} already correct.
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
function txt (c)  { return (c?.text || '').trim(); }
function disp (c) { return (c?.display_value || '').trim(); }
function numOf (v) { const n = parseFloat(String(v).replace(/[£$€,\s]/g, '')); return Number.isFinite(n) ? n : 0; }
function eqi (a, b) { return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase(); }
function round2 (n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function daysBetween (ci, co) {
  if (!ci || !co) return null;
  const a = Date.parse(ci + 'T00:00:00Z'), b = Date.parse(co + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}
function londonNow () {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
}
function monthKey (d) { return d.toISOString().slice(0, 7); }
function isoToday () { return londonNow().toISOString().slice(0, 10); }
