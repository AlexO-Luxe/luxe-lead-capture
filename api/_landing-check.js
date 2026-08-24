// ============================================================
//  Did the conversions we uploaded actually land?
//
//  Every upload path logs "uploaded" the moment Google's API accepts the
//  request. Acceptance is not the same as a recorded conversion: Google
//  validates asynchronously and can drop an event without telling us. Three
//  junk leads could not be retracted in August 2026 because Google held no
//  Step 1 conversion for them at all, and nothing in the system noticed.
//
//  This compares, for a day old enough to have settled, the Step 1 uploads
//  we logged against the conversions Google reports BY CONVERSION DATE
//  (all_conversions_by_conversion_date, not the default click-date metric,
//  which would compare two different things).
//
//  Uploads with no click id are counted separately and excluded from the
//  landing rate: they carry only a hashed email, so Google can only record
//  one when it independently matches the person to a click. Those legitimately
//  do not land most of the time, and mixing them in made the gap look like
//  30% when the real shortfall is closer to 7%.
// ============================================================

const { readGadsEvents } = require('./_log.js');

// Google needs time to process an offline conversion, so a day is only
// judged once it has had this long to settle.
const SETTLE_DAYS = 3;

async function getAccessToken () {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('token failed');
  return d.access_token;
}

async function recordedByDay (since, until) {
  const tok   = await getAccessToken();
  const cid   = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  const login = ((process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '6046238343').replace(/-/g, '')) || '6046238343';
  const r = await fetch(`https://googleads.googleapis.com/v24/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + tok,
      'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      'login-customer-id': login,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: `SELECT segments.date, segments.conversion_action_name,
                     metrics.all_conversions_by_conversion_date
              FROM customer WHERE segments.date BETWEEN "${since}" AND "${until}"`
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error).slice(0, 200));

  const out = {};
  for (const row of (d.results || [])) {
    const name = row.segments?.conversionActionName || '';
    if (!/Step 1/.test(name)) continue;
    const day = row.segments.date;
    out[day] = (out[day] || 0) + Number(row.metrics?.allConversionsByConversionDate || 0);
  }
  return out;
}

// Per-day follow-up over a rolling window, so the digest can show a running
// total rather than a single day's snapshot.
//
// A day is only judged once it has had SETTLE_DAYS to process. Anything
// newer is still in flight and counted as waiting, never as missing: calling
// a same-day upload "lost" would cry wolf every morning.
//
//   verified = settled and matched by a recorded conversion
//   waiting  = uploaded too recently to judge yet
//   missing  = settled, and Google has no conversion for it
async function checkLandingWindow ({ days = 7, settleDays = SETTLE_DAYS } = {}) {
  const dayMs = 86400000;
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - (days - 1) * dayMs).toISOString().slice(0, 10);

  const events = await readGadsEvents(new Date(start + 'T00:00:00Z').getTime(), Date.now());
  const step1  = events.filter(e => e.ok && /Step 1 NEW/.test(e.action || ''));

  const uploads = {};
  for (const e of step1) {
    const day = new Date(e.ts).toISOString().slice(0, 10);
    uploads[day] = uploads[day] || { withClickId: 0, noClickId: 0 };
    if (e.hasGclid || e.hasGbraid || e.hasWbraid) uploads[day].withClickId++;
    else uploads[day].noClickId++;
  }

  const recorded = await recordedByDay(start, today);

  const rows = [];
  const totals = { withClickId: 0, noClickId: 0, recorded: 0, verified: 0, waiting: 0, missing: 0 };
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * dayMs).toISOString().slice(0, 10);
    const u = uploads[day] || { withClickId: 0, noClickId: 0 };
    if (!u.withClickId && !u.noClickId) continue;

    const rec = Math.round(recorded[day] || 0);
    // Compared as dates, not elapsed milliseconds: an hours-based check flips
    // a day between settled and waiting depending on when the digest runs.
    const settled = day <= new Date(Date.now() - settleDays * dayMs).toISOString().slice(0, 10);

    const verified = settled ? Math.min(rec, u.withClickId) : Math.min(rec, u.withClickId);
    const waiting  = settled ? 0 : Math.max(0, u.withClickId - verified);
    const missing  = settled ? Math.max(0, u.withClickId - rec) : 0;

    totals.withClickId += u.withClickId;
    totals.noClickId   += u.noClickId;
    totals.recorded    += rec;
    totals.verified    += verified;
    totals.waiting     += waiting;
    totals.missing     += missing;

    rows.push({ day, ...u, recorded: rec, settled, verified, waiting, missing });
  }

  totals.rate = totals.withClickId ? Math.round((totals.verified / totals.withClickId) * 100) : null;
  // Judged only on days old enough to have settled, so a run of fresh
  // uploads cannot drag the health reading down.
  const settledRows = rows.filter(r => r.settled);
  const settledUp   = settledRows.reduce((a, r) => a + r.withClickId, 0);
  const settledVer  = settledRows.reduce((a, r) => a + r.verified, 0);
  totals.settledRate = settledUp ? Math.round((settledVer / settledUp) * 100) : null;

  return { days, settleDays, rows, totals };
}


// Leads whose conversion Google could not find when asked for it by name
// through the adjustment API.
//
// This is NOT proof the conversion was never recorded. Checked on
// 2026-08-24: all three leads listed had a real click in Google on the
// enquiry day, and two of them had Step 1 conversions recorded on that very
// campaign and day. Every failure so far is Performance Max, while six of
// seven successful retractions were Search, so the likeliest reading is that
// the adjustment lookup cannot address PMax conversions. Word anything built
// on this list as "could not be matched", never as "missing".
async function missingLeads ({ days = 30, limit = 10 } = {}) {
  try {
    const { Redis } = await import('@upstash/redis');
    const k = Redis.fromEnv();
    const rows = await k.zrange('gads:missing', Date.now() - days * 86400000, Date.now(), { byScore: true });
    return rows
      .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; } })
      .filter(Boolean)
      .reverse()
      .slice(0, limit);
  } catch (err) {
    console.warn('missingLeads lookup failed:', err.message);
    return [];
  }
}


// Does the adjustment lookup work on Performance Max conversions?
//
// Opened 2026-08-24: every retraction that failed was Performance Max, six
// of the seven that worked were Search, and the failing leads all had real
// clicks with conversions recorded on their own campaign and day. That points
// at PMax conversions being unaddressable rather than missing, but seven
// attempts is not a finding.
//
// Rather than remember to look again, the answer accumulates here. Retraction
// outcomes carry their channel, so this tallies them and reports a verdict
// once each channel has enough attempts to mean something. Returns null while
// the evidence is still too thin to say anything honest.
async function retractionByChannel ({ days = 60, minPerChannel = 5 } = {}) {
  const events = await readGadsEvents(Date.now() - days * 86400000, Date.now());
  const attempts = events.filter(e => /Step 1 retraction/.test(e.action || '') && e.channel);
  if (!attempts.length) return null;

  const tally = {};
  for (const e of attempts) {
    const ch = e.channel === 'PERFORMANCE_MAX' ? 'Performance Max'
             : e.channel === 'SEARCH' ? 'Search'
             : 'Other';
    tally[ch] = tally[ch] || { ok: 0, failed: 0 };
    e.ok ? tally[ch].ok++ : tally[ch].failed++;
  }

  const rows = Object.entries(tally)
    .map(([channel, v]) => ({ channel, ...v, total: v.ok + v.failed,
                              rate: Math.round((v.ok / (v.ok + v.failed)) * 100) }))
    .sort((a, b) => b.total - a.total);

  const pmax   = rows.find(r => r.channel === 'Performance Max');
  const search = rows.find(r => r.channel === 'Search');
  const ready  = pmax && search && pmax.total >= minPerChannel && search.total >= minPerChannel;

  let verdict = null;
  if (ready) {
    if (pmax.rate === 0 && search.rate >= 60) {
      verdict = `Confirmed: no Performance Max retraction has ever worked (0 of ${pmax.total}), while Search succeeds ${search.rate}% of the time (${search.ok} of ${search.total}). Junk-lead retraction only works on Search traffic.`;
    } else if (pmax.rate + 25 < search.rate) {
      verdict = `Performance Max retractions succeed ${pmax.rate}% of the time against ${search.rate}% on Search, so the lookup is much weaker on PMax but not impossible.`;
    } else {
      verdict = `Not a Performance Max problem: PMax succeeds ${pmax.rate}% against ${search.rate}% on Search. The failures have another cause.`;
    }
  }

  return { rows, ready, verdict, minPerChannel,
           needed: ready ? 0 : Math.max(minPerChannel - (pmax?.total || 0), minPerChannel - (search?.total || 0)) };
}

module.exports = { checkLandingWindow, missingLeads, retractionByChannel, SETTLE_DAYS };
