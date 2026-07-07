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
      error:     event.error     ? String(event.error).slice(0, 300) : ''
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

module.exports = { logGadsEvent, readGadsEvents, claimAlert };
