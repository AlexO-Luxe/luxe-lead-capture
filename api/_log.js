// ============================================================
//  Shared event logger for Google Ads conversion attempts.
//  Writes each attempt to a Redis sorted set keyed by timestamp,
//  read by /api/gads-daily-summary for the daily digest email.
// ============================================================

const KEY = 'gads:events';
const TTL = 60 * 60 * 24 * 35;   // 35 days, sliding

let _kv = null;
async function kv () {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}

async function logGadsEvent (event) {
  try {
    const k  = await kv();
    const ts = Date.now();
    const e  = {
      ts,
      ok:        !!event.ok,
      source:    event.source    || '',
      action:    event.action    || '',
      reason:    event.reason    || (event.ok ? 'uploaded' : 'failed'),
      email:     event.email     || '',
      value:     event.value     || 0,
      hasGclid:  !!event.hasGclid,
      hasGbraid: !!event.hasGbraid,
      hasWbraid: !!event.hasWbraid,
      mondayId:  event.mondayId  || '',
      // 2000, not 300: Google's Data Manager 400s carry the actual culprit in
      // details[].metadata (e.g. the exact events.events[0].field name) well
      // past 300 chars. Truncating here made INVALID_ARGUMENT undiagnosable.
      error:     event.error     ? String(event.error).slice(0, 2000) : ''
    };
    await k.zadd(KEY, { score: ts, member: JSON.stringify(e) });
    // Trim entries older than 35 days
    await k.zremrangebyscore(KEY, 0, ts - TTL * 1000);
  } catch (err) {
    console.warn('logGadsEvent failed (non-fatal):', err.message);
  }
}

// Atomic once-per-window claim, so a stuck upload alerts once, not every
// replay cycle. Returns true the first time a key is claimed (=> send the
// alert), false if already claimed within the TTL. Errs toward alerting if
// KV is unavailable.
async function claimAlert (mondayId, action, ttlSec = 86400) {
  try {
    const k   = await kv();
    const key = 'gads:alerted:' + mondayId + ':' + (action || '');
    const res = await k.set(key, Date.now(), { nx: true, ex: ttlSec });
    return res === 'OK' || res === true;
  } catch (err) {
    console.warn('claimAlert failed (alerting anyway):', err.message);
    return true;
  }
}

async function readGadsEvents (sinceMs, untilMs) {
  try {
    const k = await kv();
    const rows = await k.zrange(KEY, sinceMs, untilMs || '+inf', { byScore: true });
    return (rows || []).map(r => {
      try { return typeof r === 'string' ? JSON.parse(r) : r; }
      catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    console.warn('readGadsEvents failed:', err.message);
    return [];
  }
}

// Ignore list: mondayId|action pairs the replay must skip entirely (no
// re-upload, no alert). For bookings/leads that can never upload and are not
// worth chasing, e.g. a lead mislabelled PPC with no contact details.
const IGNORE_KEY = 'gads:ignore';

async function isIgnored (mondayId, action) {
  try {
    const k = await kv();
    return !!(await k.sismember(IGNORE_KEY, mondayId + '|' + (action || '')));
  } catch (err) {
    console.warn('isIgnored failed:', err.message);
    return false;
  }
}

async function setIgnore (mondayId, action, on = true) {
  const k = await kv();
  const m = mondayId + '|' + (action || '');
  if (on) await k.sadd(IGNORE_KEY, m);
  else    await k.srem(IGNORE_KEY, m);
  return m;
}

async function listIgnored () {
  try { const k = await kv(); return (await k.smembers(IGNORE_KEY)) || []; }
  catch { return []; }
}

module.exports = { logGadsEvent, readGadsEvents, claimAlert, isIgnored, setIgnore, listIgnored };
