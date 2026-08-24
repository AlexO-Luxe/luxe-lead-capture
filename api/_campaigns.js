// ============================================================
//  Live campaign id to name lookup.
//
//  Google's tracking template hands us the numeric campaign id, so a lead
//  is only labelled with a readable campaign name if we can translate it.
//  That translation used to be a hardcoded map in submit-enquiry.js, which
//  silently rots: every campaign launched after the last manual top-up
//  wrote its raw id onto the lead instead (core-luxe-uk-perf-max,
//  perf-max-india and 8 others were missing when this was written).
//
//  Names are pulled from Google once a day and cached in KV, so a campaign
//  created this morning resolves this afternoon with no code change. The
//  hardcoded map stays as the offline fallback.
// ============================================================

const KEY        = 'gads:campaign-names';
const KV_TTL_SEC = 24 * 3600;   // one refresh a day is plenty, campaigns are not renamed hourly
const MEM_TTL_MS = 10 * 60000;  // per warm instance, keeps KV reads off the hot path
const FETCH_TIMEOUT_MS = 3000;  // a slow Google must never hold up an enquiry

let _kv = null;
async function kv () {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}

let cache = { at: 0, map: {} };
// name or id, lowercased, to SEARCH / PERFORMANCE_MAX / etc.
const CHANNELS = {};

async function fetchFromGoogle () {
  const r0 = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  const tok = (await r0.json()).access_token;
  if (!tok) throw new Error('no access token');

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
    // Every campaign, not just enabled ones: a lead can arrive days after
    // its campaign was paused, and the name still has to resolve.
    body: JSON.stringify({ query: 'SELECT campaign.id, campaign.name, campaign.advertising_channel_type FROM campaign' })
  });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error).slice(0, 200));

  const map = {};
  for (const row of (d.results || [])) {
    const c = row.campaign;
    if (!c?.id || !c?.name) continue;
    map[String(c.id)] = c.name;
    // Channel keyed by name as well as id, because everything downstream
    // (Monday columns, the retraction log) carries the name, not the id.
    CHANNELS[c.name.trim().toLowerCase()] = c.advertisingChannelType || '';
    CHANNELS[String(c.id)] = c.advertisingChannelType || '';
  }
  return map;
}

// Populates the in-process cache. Safe to call on every request: warm
// instances return immediately, and any failure leaves the caller on the
// hardcoded fallback rather than throwing into the enquiry path.
async function primeCampaignNames () {
  if (Date.now() - cache.at < MEM_TTL_MS && Object.keys(cache.map).length) return cache.map;

  try {
    const k = await kv();
    const stored = await k.get(KEY);
    if (stored && typeof stored === 'object' && Object.keys(stored).length) {
      cache = { at: Date.now(), map: stored };
      return cache.map;
    }

    // KV entry has expired, so refresh from Google and re-seed it.
    const fresh = await Promise.race([
      fetchFromGoogle(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), FETCH_TIMEOUT_MS))
    ]);
    if (Object.keys(fresh).length) {
      cache = { at: Date.now(), map: fresh };
      await k.set(KEY, fresh, { ex: KV_TTL_SEC });
      return cache.map;
    }
  } catch (err) {
    console.warn('campaign-names lookup failed, using fallback map:', err.message);
  }
  return cache.map;
}

// Synchronous read, so the existing resolveCampaign() stays sync.
function campaignName (id) {
  return cache.map[String(id || '').trim()] || '';
}

// Channel type for a campaign name or id, '' when unknown. Call
// primeCampaignNames() first, the lookup is populated by the same fetch.
function campaignChannel (nameOrId) {
  return CHANNELS[String(nameOrId || '').trim().toLowerCase()] || '';
}

module.exports = { primeCampaignNames, campaignName, campaignChannel };
