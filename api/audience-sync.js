// ============================================================
//  Customer Match reconciliation sweep.
//  GET /api/audience-sync?secret=<CRON_SECRET>[&dryRun=1][&since=2025-01-01]
//
//  Sweeps every Bookings-board row closing since 2025 and ingests each
//  booker's hashed email + phone into the Google Ads customer list
//  (_audience.js). The submit-booking webhook adds bookers in real time;
//  this nightly sweep is the guarantee: first run backfills all history,
//  every later run heals any webhook miss. Re-ingesting is harmless,
//  Google dedupes members on the hashed identifiers.
// ============================================================

const MONDAY_API     = 'https://api.monday.com/v2';
const BOOKINGS_BOARD = 2171015589;

const { ingestBookers } = require('./_audience.js');
const { logGadsEvent }  = require('./_log.js');
const { logError }      = require('./_errlog.js');

module.exports = async function handler (req, res) {
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (req.query?.secret !== process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const dryRun = req.query?.dryRun === '1';
  const since  = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.since || '') ? req.query.since : '2025-01-01';

  const FRAG = `id name
    column_values(ids: ["date9"]) { id text ... on MirrorValue { display_value } }
    relation: column_values(ids: ["link_to_leads26"]) { ... on BoardRelationValue { linked_items { id
      column_values(ids: ["email","phone_1"]) { id text } } } }`;

  try {
    let cursor = null, page = 0;
    const items = [];
    do {
      const q = cursor
        ? `query { next_items_page(limit: 500, cursor: "${cursor}") { cursor items { ${FRAG} } } }`
        : `query { boards(ids: ${BOOKINGS_BOARD}) { items_page(limit: 500, query_params: {
             rules: [{ column_id: "date9", compare_value: ["${since}"], operator: greater_than_or_equals }] }) {
             cursor items { ${FRAG} } } } }`;
      const r = await fetch(MONDAY_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
        body: JSON.stringify({ query: q })
      });
      const d = await r.json();
      if (d.errors) throw new Error('Monday: ' + JSON.stringify(d.errors).slice(0, 200));
      const pd = cursor ? d.data.next_items_page : d.data.boards[0].items_page;
      items.push(...(pd.items || []));
      cursor = pd.cursor;
      page++;
    } while (cursor && page < 40);

    // Dedupe by email before ingesting so the batches stay small.
    const seen = new Set();
    const members = [];
    for (const it of items) {
      const lead = it.relation?.[0]?.linked_items?.[0];
      const lc = {};
      (lead?.column_values || []).forEach(c => { lc[c.id] = (c.text || '').trim(); });
      const key = (lc.email || '').toLowerCase() || lc.phone_1 || '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      members.push({ email: lc.email, phone: lc.phone_1 });
    }

    if (dryRun) {
      return res.status(200).json({ dryRun, since, bookings: items.length, uniqueMembers: members.length });
    }

    const result = await ingestBookers(members);

    // One summary event so the daily digest shows the list breathing.
    await logGadsEvent({
      source: 'audience-sync', action: 'Customer Match', ok: true,
      reason: 'nightly sweep', value: result.ingested
    });

    return res.status(200).json({ since, bookings: items.length, uniqueMembers: members.length, ...result });
  } catch (err) {
    console.error('audience-sync error:', err.message);
    await logError('audience-sync', err);
    return res.status(500).json({ error: err.message });
  }
};
