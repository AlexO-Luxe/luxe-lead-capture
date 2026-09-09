// ============================================================
//  Self-check for the Guest Services auth path.
//  Run: node scripts/guest-auth-check.js
//  No network, no Monday, no Redis. Exits non-zero on failure.
//
//  Covers the two decisions that gate the portal: is this token
//  really ours, and is this surname really on the booking.
// ============================================================

process.env.GUEST_PORTAL_SECRET = 'self-check-secret';

const assert = require('assert');
const crypto = require('crypto');
const auth = require('../api/_guest-auth.js');

function bearer (token) {
  return { headers: { authorization: 'Bearer ' + token } };
}

function b64url (obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── tokens ────────────────────────────────────────────────────
const { token } = auth.issueToken({ ref: 'SL-48213', id: '9', first: 'Alex', city: 'London' });
const decoded = auth.readToken(bearer(token));

assert.ok(decoded, 'a freshly issued token must verify');
assert.strictEqual(decoded.ref, 'SL-48213');
assert.strictEqual(decoded.first, 'Alex');
assert.ok(decoded.exp > decoded.iat, 'token must expire after it was issued');

assert.strictEqual(auth.readToken(bearer(token.slice(0, -2) + 'aa')), null, 'tampered signature must fail');
assert.strictEqual(auth.readToken(bearer('nonsense')), null, 'garbage must fail');
assert.strictEqual(auth.readToken({ headers: {} }), null, 'missing header must fail');

// Non-base64 characters used to decode to zero bytes, which made
// timingSafeEqual throw and turned a bad token into a 500 rather than a
// 401. Same string length as a real signature, so a length guard alone
// does not catch it.
const goodBody = token.split('.')[0];
const goodMac  = token.split('.')[1];
assert.strictEqual(auth.readToken(bearer(goodBody + '.' + '!'.repeat(goodMac.length))), null,
  'invalid base64 signature must fail, not throw');
assert.strictEqual(auth.readToken(bearer(goodBody + '.' + goodMac.slice(0, -3) + '!!!')), null,
  'partly invalid signature must fail, not throw');
assert.strictEqual(auth.readToken(bearer('!!!.' + goodMac)), null, 'invalid payload must fail, not throw');
assert.strictEqual(auth.readToken(bearer(goodBody + '.')), null, 'empty signature must fail');

// Payload swap: keep our signature, change the body it signed.
const forgedBody = b64url({
  ref: 'SL-00000', id: '1', first: 'Mallory', city: 'London',
  iat: 0, exp: Math.floor(Date.now() / 1000) + 3600
});
assert.strictEqual(
  auth.readToken(bearer(forgedBody + '.' + token.split('.')[1])),
  null,
  'a swapped payload must not verify against the original signature'
);

// Expiry is enforced, not just recorded.
const expiredBody = b64url({
  ref: 'SL-48213', id: '9', first: 'Alex', city: 'London',
  iat: 0, exp: Math.floor(Date.now() / 1000) - 60
});
const expiredMac = crypto.createHmac('sha256', process.env.GUEST_PORTAL_SECRET)
  .update(expiredBody).digest('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
assert.strictEqual(auth.readToken(bearer(expiredBody + '.' + expiredMac)), null, 'expired token must fail');

// ── surname matching ──────────────────────────────────────────
const booking = ['Obertelli', 'Alex', 'Alex Obertelli'];

assert.ok(auth.surnameMatches(booking, 'Obertelli'), 'exact surname');
assert.ok(auth.surnameMatches(booking, '  obertelli '), 'case and whitespace ignored');
assert.ok(auth.surnameMatches([null, null, 'Smith, Jane, Chelsea'], 'Smith'), 'surname inside a comma-titled row');
assert.ok(auth.surnameMatches([null, null, "O'Brien"], 'obrien'), 'punctuation ignored');
assert.ok(auth.surnameMatches(['Smith-Jones'], 'Jones'), 'either half of a double-barrelled name');
assert.ok(auth.surnameMatches(['Müller'], 'Muller'), 'accents ignored');

assert.strictEqual(auth.surnameMatches(booking, 'Smith'), false, 'wrong surname rejected');
assert.strictEqual(auth.surnameMatches(booking, ''), false, 'empty surname rejected');
assert.strictEqual(auth.surnameMatches(booking, 'Ober'), false, 'partial surname rejected');
assert.strictEqual(auth.surnameMatches([], 'Obertelli'), false, 'no booking data rejected');

console.log('guest-auth self-check passed');
