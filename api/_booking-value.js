// _booking-value.js
//
// Shared recompute of the Monday formula column formula2 ("Total Luxe
// Commission excl VAT") on the Bookings / Booking Flow board (2171015589).
//
// CORRECTION (5 Aug 2026): formula2 IS readable from the API. It only ever
// returned null because our queries lacked an inline `... on FormulaValue`
// fragment, not because Monday refuses to evaluate mirror-referencing
// formulas. Verified live on API versions 2024-10 through 2026-01.
//
// So prefer `bookingValue()` below, which reads formula2 directly. It beats
// this recompute on every axis: it is always live (the recompute only reaches
// rows inside the daily sync's date window, older rows freeze and drift), and
// Monday evaluates rows this JS cannot, notably non-GBP and split bookings.
// The recompute stays as the fallback and as the sync's writer.
//
// Extracted from api/sync-booking-values.js (which writes the result into
// numeric_mm1ge9h4) so the Lead Qualified email can show the same figure
// without a second, drifting copy of the formula. Pure functions, no I/O.

// Base columns formula2 reduces to (see settings_str reverse-engineering).
const FORMULA2_COLS = [
  'color_mm00yfav',   // Currencies (status): "£" gates the whole calc
  'date69',           // Check In
  'date_1',           // Check Out
  'mirror68',         // Commission Calc (BB): "Gross" | "Net"
  'mirror74',         // VAT / No VAT (BB)
  'mirror_144',       // Net / Gross (BB)
  'numbers54',        // Previous Nights in Altogether (Ext)
  'numbers80',        // Agreed Nightly Rate
  'numbers92',        // Luxe % Commission (percent-unit: used as /100)
  'numeric_mm1a1e33'  // Discount Amount Gross (whole booking)
];

// formula2 = ROUND(IF(mirror68="Gross",
//              MINUS(MULTIPLY(TotalGross, comm), DiscountNet),
//              MINUS(MULTIPLY(TotalNet,   comm), DiscountNet)), 2)
//   TotalGross = GrossRate * nights ;  TotalNet = NetRate * nights
//   DiscountNet = discountGross / 1.2 ;  comm = numbers92 / 100
// Returns null when it can't be computed (non-GBP, zero nightly, bad dates).
// cv: { <columnId>: { text, display_value } }
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

  const rate = eq(m68, 'Gross')
    ? grossRate(cur, m144, m74, n80, n54, nights)
    : netRate(cur, m144, m74, n80, n54, nights);

  return round2(rate * nights * comm - disc);
}

function grossRate (cur, m144, m74, n80, n54, nights) {
  if (cur !== '£') return n80;
  let r;
  if (eq(m144, 'Gross') || (eq(m144, 'Net') && eq(m74, 'No VAT')) || (nights >= 90 && eq(m74, 'VAT on < 90 nights'))) {
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
  if (eq(m74, 'No Vat') || eq(m144, 'Net') || (eq(m74, 'Vat on < 90 Nights') && nights >= 90)) return n80;
  const tot = nights + n54;
  if (tot >= 28) return (28 * n80 / 1.2 + (tot - 28) * n80 / 1.04) / tot;
  if (tot < 28)  return (tot * n80 / 1.2) / tot;
  return 0;
}

// ── helpers ────────────────────────────────────────────────────
function txt (c)  { return (c?.text || '').trim(); }
function disp (c) { return (c?.display_value || '').trim(); }
function numOf (v) { const n = parseFloat(String(v).replace(/[£$€,\s]/g, '')); return Number.isFinite(n) ? n : 0; }
// Monday formula string comparison is CASE-SENSITIVE. The sub-formulas use
// inconsistent literal casing on purpose-or-by-accident (net-rate checks
// "No Vat" while the mirror value is "No VAT", so that branch never matches
// and VAT is stripped). Replicate exactly: compare case-sensitively against
// the literal each sub-formula actually uses.
function eq (a, b) { return (a || '').trim() === (b || '').trim(); }
function round2 (n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function daysBetween (ci, co) {
  if (!ci || !co) return null;
  const a = Date.parse(ci + 'T00:00:00Z'), b = Date.parse(co + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// ── Reading the booking value straight off Monday ──────────────
// Request these ids, and splice VALUE_FRAGMENT into the column_values
// selection. Without the FormulaValue fragment formula2 silently reads as
// null, which is the bug that caused the whole recompute to exist.
const VALUE_COLS     = ['formula2', 'numeric_mm1ge9h4'];
const VALUE_FRAGMENT = '... on FormulaValue { display_value } ... on MirrorValue { display_value }';

// Authoritative booking value for one row, given a flat { columnId: string }
// map. formula2 wins because it is Monday's own live figure; Rev to Google is
// the fallback for a row where the formula is blank. Returns { value, source }
// so callers can log which one they used.
function bookingValue (flat) {
  const f = numOf(flat?.formula2);
  if (f !== null && f > 0) return { value: round2(f), source: 'formula2' };
  const n = numOf(flat?.numeric_mm1ge9h4);
  if (n !== null && n > 0) return { value: round2(n), source: 'numeric_mm1ge9h4' };
  return { value: null, source: 'none' };
}

module.exports = {
  FORMULA2_COLS,
  VALUE_COLS,
  VALUE_FRAGMENT,
  bookingValue,
  computeFormula2,
  grossRate,
  netRate,
  txt,
  disp,
  numOf,
  eq,
  round2,
  daysBetween
};
