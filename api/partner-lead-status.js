// ============================================================
//  POST /api/partner-lead-status   (Authorization: Bearer <token>)
//    { id: "123456", status: "Enquiry" | "Booking" }
//    200 { ok: true, id, status }
//    400 unknown status
//    401 no / expired session
//    403 the lead is not this partner's
//
//  The one thing an operator can write. It sets the Operator Status
//  column on the Leads board, which is theirs alone: no sales column
//  is ever touched from out here.
//
//  A token proves WHICH partner is asking, so the lead is re-read from
//  Monday and re-checked against that partner's own matching rules
//  before the write. Otherwise an operator could post any item id on
//  the board and move a lead that was never theirs.
// ============================================================

const { requirePartner, applyCors, monday, kvDel } = require('./_partner-auth.js');
const { logError } = require('./_errlog.js');

const LEADS_BOARD  = '2171015719';
const STATUS_COL   = 'color_mm6d7xqf';   // Operator Status: Enquiry / Booking
const ALLOWED      = ['Enquiry', 'Booking'];

function val (item, id) {
  const c = (item.column_values || []).find(c => c.id === id);
  if (!c) return '';
  return (c.label || c.text || '').trim();
}

module.exports = async function handler (req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const partner = requirePartner(req, res);
  if (!partner) return;

  try {
    const body   = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id     = String(body.id || '').replace(/[^0-9]/g, '');
    const status = String(body.status || '').trim();

    if (!id) return res.status(400).json({ error: 'Missing lead id.' });
    if (ALLOWED.indexOf(status) === -1) {
      return res.status(400).json({ error: 'Status must be Enquiry or Booking.' });
    }
    // Only operators own this column. A school portal is read-only.
    if (partner.kind !== 'operator') return res.status(403).json({ error: 'Not permitted.' });

    // Re-read the lead and prove it is this partner's before writing.
    const data = await monday(`{ items(ids: [${id}]) {
      id
      board { id }
      column_values(ids: ["dropdown6", "apt_type_mkmn4bgg"]) { id text }
    } }`);
    const item = data?.items?.[0];
    if (!item || String(item.board?.id) !== LEADS_BOARD) {
      return res.status(403).json({ error: 'That lead is not available.' });
    }
    const building = val(item, 'dropdown6');
    const aptType  = val(item, 'apt_type_mkmn4bgg');
    if (!/standard student living/i.test(aptType) || !partner.buildings.test(building)) {
      return res.status(403).json({ error: 'That lead is not available.' });
    }

    const value = JSON.stringify(JSON.stringify({ label: status }));
    await monday(`mutation {
      change_column_value(board_id: ${LEADS_BOARD}, item_id: ${id}, column_id: "${STATUS_COL}", value: ${value}) { id }
    }`);

    // The dashboard reads from a 120s cache, so drop it or the operator
    // watches their own change bounce back.
    await kvDel('partner:leads:' + partner.key);

    return res.status(200).json({ ok: true, id, status });
  } catch (err) {
    await logError('partner-lead-status', err, { partner: partner.key });
    return res.status(500).json({ error: 'Could not save that right now.' });
  }
};
