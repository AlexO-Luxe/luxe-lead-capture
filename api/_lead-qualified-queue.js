// _lead-qualified-queue.js
//
// Delay queue for the "Lead Qualified" staff email.
//
// Why: the salesperson keeps typing after they flip the status. Apartment
// chosen, nightly rate agreed, notes, all land in the 5 to 15 minutes AFTER
// qualification. Sending instantly means the email is always the thinnest
// possible version of the lead. So the webhook now parks the item here and a
// cron (/api/lead-qualified-flush) sends it once the delay has elapsed,
// re-reading Monday at send time so the email carries whatever was added.
//
// Storage (Upstash Redis, same instance as the gads log):
//   leadq:pending        sorted set, member = pulseId, score = due timestamp ms
//   leadq:meta:<id>      JSON blob of the trigger context (who qualified it, when)
//   leadq:sent:<id>      dedupe guard, set for LEAD_QUALIFIED_DEDUPE_HOURS
//
// Every read/write is wrapped so a Redis outage can never swallow an email:
// enqueue reports failure to the caller, which then sends immediately.

const PENDING_KEY  = 'leadq:pending';
const META_PREFIX  = 'leadq:meta:';
const SENT_PREFIX  = 'leadq:sent:';
const META_TTL_SEC = 60 * 60 * 24 * 7;   // meta outlives any sane delay

let _kv = null;
async function kv () {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}

// Minutes to hold a qualified lead before emailing. 0 disables the delay and
// restores the old instant-send behaviour.
const DEFAULT_DELAY_MIN = 15;
function delayMinutes () {
  const raw = process.env.LEAD_QUALIFIED_DELAY_MINUTES;
  const n   = raw === undefined || raw === '' ? DEFAULT_DELAY_MIN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DELAY_MIN;
}

// How long a sent lead stays de-duplicated. Guards against a status toggled
// off and back on again within the same working day.
function dedupeHours () {
  const n = Number(process.env.LEAD_QUALIFIED_DEDUPE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

// Park a lead for later sending. NX on the sorted set: if the lead is already
// queued (status flipped twice), the first due time wins, we do not keep
// pushing the send further out.
// Returns { queued, dueAt } or { queued: false, reason } so the caller can
// fall back to sending now.
async function enqueueLead ({ pulseId, by, qualifiedAt, delayMin }) {
  const mins  = delayMin === undefined ? delayMinutes() : delayMin;
  const dueAt = Date.now() + mins * 60000;
  try {
    const k = await kv();
    await k.set(META_PREFIX + pulseId, JSON.stringify({
      pulseId:     String(pulseId),
      by:          by || '',
      qualifiedAt: qualifiedAt || new Date().toISOString(),
      enqueuedAt:  new Date().toISOString()
    }), { ex: META_TTL_SEC });
    const added = await k.zadd(PENDING_KEY, { nx: true }, { score: dueAt, member: String(pulseId) });
    return { queued: true, dueAt, alreadyQueued: !added };
  } catch (err) {
    console.warn('enqueueLead failed:', err.message);
    return { queued: false, reason: err.message };
  }
}

// Items whose delay has elapsed, oldest first.
async function dueLeads (limit = 25, nowMs = Date.now()) {
  const k    = await kv();
  const ids  = await k.zrange(PENDING_KEY, 0, nowMs, { byScore: true, offset: 0, count: limit });
  const out  = [];
  for (const id of ids || []) {
    let meta = null;
    try {
      const raw = await k.get(META_PREFIX + id);
      meta = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch { /* meta is a nice-to-have, the pulseId is what matters */ }
    out.push({ pulseId: String(id), meta: meta || {} });
  }
  return out;
}

async function removeLead (pulseId) {
  try {
    const k = await kv();
    await k.zrem(PENDING_KEY, String(pulseId));
    await k.del(META_PREFIX + pulseId);
  } catch (err) {
    console.warn('removeLead failed:', err.message);
  }
}

// Atomic claim so two overlapping cron runs cannot both send the same lead.
// Errs toward sending if Redis is unreachable: a rare duplicate beats silence.
async function claimSend (pulseId) {
  try {
    const k   = await kv();
    const res = await k.set(SENT_PREFIX + pulseId, Date.now(), { nx: true, ex: dedupeHours() * 3600 });
    return res === 'OK' || res === true;
  } catch (err) {
    console.warn('claimSend failed (sending anyway):', err.message);
    return true;
  }
}

async function releaseSend (pulseId) {
  try { const k = await kv(); await k.del(SENT_PREFIX + pulseId); }
  catch (err) { console.warn('releaseSend failed:', err.message); }
}

// Everything still waiting, for the flush endpoint's status view.
async function listPending () {
  try {
    const k    = await kv();
    const rows = await k.zrange(PENDING_KEY, 0, -1, { withScores: true });
    const out  = [];
    for (let i = 0; i < (rows || []).length; i += 2) {
      out.push({ pulseId: String(rows[i]), dueAt: new Date(Number(rows[i + 1])).toISOString() });
    }
    return out;
  } catch (err) {
    console.warn('listPending failed:', err.message);
    return [];
  }
}

module.exports = {
  PENDING_KEY,
  delayMinutes,
  dedupeHours,
  enqueueLead,
  dueLeads,
  removeLead,
  claimSend,
  releaseSend,
  listPending
};
