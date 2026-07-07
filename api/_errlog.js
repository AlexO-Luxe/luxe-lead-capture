// ============================================================
//  General application error log.
//  Any handler catch can call logError(endpoint, err, extra) to
//  persist an error to a Redis sorted set. /api/error-digest reads
//  it once a day and emails a summary. Separate from gads:events
//  (which is conversion-upload specific); this is for ANY error:
//  Monday failures, email failures, unexpected throws, etc.
//  Fire-safe: never throws.
// ============================================================

const KEY = 'app:errors';
const TTL = 60 * 60 * 24 * 14;   // 14 days, sliding

let _kv = null;
async function kv () {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}

async function logError (endpoint, err, extra = {}) {
  try {
    const k  = await kv();
    const ts = Date.now();
    const e  = {
      ts,
      endpoint: String(endpoint || 'unknown'),
      message:  String(err?.message || err || '').slice(0, 500),
      stack:    String(err?.stack || '').slice(0, 800),
      ...extra
    };
    await k.zadd(KEY, { score: ts, member: JSON.stringify(e) });
    await k.zremrangebyscore(KEY, 0, ts - TTL * 1000);
  } catch (e) {
    console.warn('logError failed (non-fatal):', e.message);
  }
}

async function readErrors (sinceMs, untilMs) {
  try {
    const k = await kv();
    const rows = await k.zrange(KEY, sinceMs, untilMs || '+inf', { byScore: true });
    return (rows || []).map(r => {
      try { return typeof r === 'string' ? JSON.parse(r) : r; }
      catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    console.warn('readErrors failed:', err.message);
    return [];
  }
}

module.exports = { logError, readErrors };
