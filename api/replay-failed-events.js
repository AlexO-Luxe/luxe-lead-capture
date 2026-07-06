// ============================================================
//  Replay failed Google Ads conversion uploads.
//  GET /api/replay-failed-events?secret=<CRON_SECRET>&hours=168[&dryRun=1]
//
//  Scans the KV gads:events log for ok:false entries in the window,
//  re-fetches each lead / booking from Monday, rebuilds the event and
//  re-uploads via the Data Manager helper (which now retries the
//  transient 400s that caused most of the original failures).
//
//  Idempotent-ish: uses a stable transactionId per Monday item so a
//  replay that overlaps a later organic success won't double-count.
//  Matches via hashed email + phone (Enhanced Conversions for Leads),
//  so no expired click id is required.
// ============================================================

const MONDAY_API     = 'https://api.monday.com/v2';
const LEADS_BOARD    = 2171015719;
const BOOKINGS_BOARD = 2171015589;

const { readGadsEvents }  = require('./_log.js');
const { logGadsEvent }    = require('./_log.js');
const {
  conversionDestination,
  buildUserIdentifiers,
  ingestEvents,
  CONSENT_GRANTED
} = require('./_dataManager.js');

module.exports = async function handler (req, res) {
  if (req.query?.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const hours   = Math.max(1, Math.min(840, parseInt(req.query?.hours || '168', 10)));
  const dryRun  = req.query?.dryRun === '1';
  const untilMs = Date.now();
  const sinceMs = untilMs - hours * 60 * 60 * 1000;

  try {
    const events = await readGadsEvents(sinceMs, untilMs);
    const fails  = events.filter(e => !e.ok && e.mondayId);

    // Dedupe by mondayId + action (a lead can fail on retry loops repeatedly).
    const seen = new Set();
    const jobs = [];
    for (const f of fails) {
      const key = f.mondayId + '|' + (f.action || '');
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(f);
    }

    const out = { window: `last ${hours}h`, distinctFails: jobs.length, dryRun, results: [] };

    for (const job of jobs) {
      const plan = classify(job);
      if (!plan) {
        out.results.push({ mondayId: job.mondayId, action: job.action, outcome: 'skipped', reason: 'unrecognised source' });
        continue;
      }

      // Fetch the identifiers fresh from Monday.
      let ids;
      try {
        ids = plan.board === BOOKINGS_BOARD
          ? await fetchBookingIdentifiers(job.mondayId)
          : await fetchLeadIdentifiers(job.mondayId);
      } catch (err) {
        out.results.push({ mondayId: job.mondayId, action: job.action, outcome: 'error', reason: 'monday fetch: ' + err.message });
        continue;
      }
      if (!ids) {
        out.results.push({ mondayId: job.mondayId, action: job.action, outcome: 'skipped', reason: 'item not found' });
        continue;
      }

      const userIdentifiers = buildUserIdentifiers({
        email:      ids.email,
        phone:      ids.phone,
        firstName:  ids.firstName,
        lastName:   ids.lastName,
        regionCode: 'GB'
      });
      if (!userIdentifiers.length) {
        out.results.push({ mondayId: job.mondayId, action: job.action, outcome: 'skipped', reason: 'no email/phone to match' });
        continue;
      }

      const value = plan.value != null ? plan.value : (job.value || 0);

      if (dryRun) {
        out.results.push({ mondayId: job.mondayId, action: plan.label, outcome: 'would-upload', identifierCount: userIdentifiers.length, value });
        continue;
      }

      const event = {
        destinationReferences: ['sl-replay'],
        transactionId:         'replay:' + job.mondayId + ':' + plan.actionId,
        eventTimestamp:        new Date().toISOString(),
        eventSource:           'WEB',
        userData:              { userIdentifiers },
        currency:              'GBP',
        conversionValue:       value
      };
      const body = {
        destinations: [ conversionDestination({ conversionActionId: plan.actionId, reference: 'sl-replay' }) ],
        events:  [event],
        consent: CONSENT_GRANTED
      };

      try {
        const result = await ingestEvents(body);
        logGadsEvent({ source: job.source + ' (replay)', action: plan.label, ok: true, reason: 'replayed', email: ids.email, value, mondayId: job.mondayId });
        out.results.push({ mondayId: job.mondayId, action: plan.label, outcome: 'uploaded', requestId: result?.requestId || null, value });
      } catch (err) {
        logGadsEvent({ source: job.source + ' (replay)', action: plan.label, ok: false, reason: 'replay_failed', error: err.message, email: ids.email, mondayId: job.mondayId });
        out.results.push({ mondayId: job.mondayId, action: plan.label, outcome: 'failed', reason: err.message.slice(0, 300) });
      }
    }

    const tally = out.results.reduce((a, r) => { a[r.outcome] = (a[r.outcome] || 0) + 1; return a; }, {});
    out.summary = tally;
    return res.status(200).json(out);
  } catch (err) {
    console.error('replay-failed-events error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// Map a KV fail record to { board, actionId, value, label }.
function classify (job) {
  const src = (job.source || '').toLowerCase();
  const act = (job.action || '').toLowerCase();
  if (src.includes('enquiry')) {
    return { board: LEADS_BOARD, actionId: process.env.GOOGLE_ADS_CONVERSION_ACTION_ID, value: 1.0, label: 'Step 1 NEW (server-side enquiry)' };
  }
  if (src.includes('lead-potential')) {
    if (act.includes('high'))     return { board: LEADS_BOARD, actionId: process.env.GOOGLE_ADS_HIGH_POTENTIAL_ACTION_ID,     value: 300.0, label: 'High Potential' };
    if (act.includes('moderate')) return { board: LEADS_BOARD, actionId: process.env.GOOGLE_ADS_MODERATE_POTENTIAL_ACTION_ID, value: 150.0, label: 'Moderate Potential' };
    return null;
  }
  if (src.includes('booking')) {
    // value comes from the KV record (job.value); actionId is the booking action.
    return { board: BOOKINGS_BOARD, actionId: process.env.GOOGLE_ADS_BOOKING_ACTION_ID, value: null, label: 'Confirmed Booking' };
  }
  return null;
}

async function mondayQuery (query) {
  const r = await fetch(MONDAY_API, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': process.env.MONDAY_API_KEY },
    body:    JSON.stringify({ query })
  });
  const d = await r.json();
  if (d.errors) throw new Error(JSON.stringify(d.errors).slice(0, 200));
  return d;
}

async function fetchLeadIdentifiers (itemId) {
  const q = `query { items(ids: [${itemId}]) {
    id
    column_values(ids: ["email", "phone_1", "text37", "text60"]) { id text }
  } }`;
  const d = await mondayQuery(q);
  const it = d?.data?.items?.[0];
  if (!it) return null;
  const c = {};
  it.column_values.forEach(x => { c[x.id] = x.text || ''; });
  return { email: c.email, phone: c.phone_1, firstName: c.text37, lastName: c.text60 };
}

async function fetchBookingIdentifiers (itemId) {
  const q = `query { items(ids: [${itemId}]) {
    id
    relation: column_values(ids: ["link_to_leads26"]) {
      id
      ... on BoardRelationValue {
        linked_items { id column_values(ids: ["email", "phone_1", "text37", "text60"]) { id text } }
      }
    }
  } }`;
  const d = await mondayQuery(q);
  const it = d?.data?.items?.[0];
  const lead = it?.relation?.[0]?.linked_items?.[0];
  if (!lead) return null;
  const c = {};
  lead.column_values.forEach(x => { c[x.id] = x.text || ''; });
  return { email: c.email, phone: c.phone_1, firstName: c.text37, lastName: c.text60 };
}
