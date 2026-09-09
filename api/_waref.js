// ============================================================
//  Student Luxe — WhatsApp enquiry ref
//  Mints the SL-XXXX ref that ties a WhatsApp chat back to the
//  click bundle (and, from the enquiry form, to the Monday item).
//  Stored in KV as waref:<ref> for 90 days. Oskar reads it back
//  through /api/whatsapp-ref when the ref appears in a message.
//  Used by submit-whatsapp.js and submit-enquiry.js.
// ============================================================

let _kv = null;
async function kv() {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}

const REF_TTL = 60 * 60 * 24 * 90; // 90 days, matches click attribution window
// No 0/O/1/I/L so the ref survives being read aloud or retyped
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function randomRef() {
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  }
  return 'SL-' + s;
}

// Mint a collision-free ref and store the bundle under it.
// Returns null on any failure so callers can proceed without a ref.
async function mintRef(bundle) {
  try {
    const k = await kv();
    for (let attempt = 0; attempt < 5; attempt++) {
      const ref = randomRef();
      const claimed = await k.set('waref:' + ref, bundle, { nx: true, ex: REF_TTL });
      if (claimed === 'OK' || claimed === true) return ref;
    }
    return null;
  } catch (err) {
    console.error('waref: ref mint failed (non-fatal):', err.message);
    return null;
  }
}

module.exports = { mintRef, randomRef, REF_TTL };
