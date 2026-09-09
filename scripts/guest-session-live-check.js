// ============================================================
//  Live check for Guest Services sign in, against real Monday data.
//
//    node scripts/guest-session-live-check.js <ref#> <surname>
//
//  Needs MONDAY_API_KEY in the environment (or .env.local in the repo
//  root). Prints status codes only, never the guest's details.
//
//  Why this exists: sign in depends on Monday column ids and column
//  TYPES (mirror vs status vs text). A column rename or a board change
//  breaks it in a way no offline test can catch. Run this after
//  touching guest-session.js, or after board surgery on Leads
//  (2171015719) or Booking Flow (2171015589).
// ============================================================

const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  });
}

const ref     = process.argv[2];
const surname = process.argv[3];

if (!ref || !surname) {
  console.log('usage: node scripts/guest-session-live-check.js <ref#> <surname>');
  process.exit(2);
}
if (!process.env.MONDAY_API_KEY) {
  console.log('MONDAY_API_KEY not set, skipping');
  process.exit(2);
}

process.env.GUEST_PORTAL_SECRET = process.env.GUEST_PORTAL_SECRET || 'live-check-secret';

const handler = require('../api/guest-session.js');

function call (body) {
  return new Promise(resolve => {
    const req = { method: 'POST', headers: { origin: 'https://www.studentluxe.co.uk' }, body };
    const res = {
      _status: 0,
      setHeader () {},
      status (s) { this._status = s; return this; },
      json (j) { resolve({ status: this._status, json: j }); return this; },
      end () { resolve({ status: this._status, json: null }); return this; }
    };
    handler(req, res);
  });
}

let failures = 0;
function check (name, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (!ok && detail ? '  -> ' + detail : ''));
  if (!ok) failures++;
}

(async () => {
  let r = await call({ ref: ref, surname: surname });
  check('valid ref + surname -> 200 with token', r.status === 200 && !!(r.json && r.json.token),
        'status ' + r.status + ' ' + JSON.stringify((r.json && r.json.error) || ''));

  if (r.status === 200) {
    const g = r.json.guest || {};
    // Each field comes from a different Monday column type, so a blank one
    // usually means that column moved, not that the guest is unusual.
    check('  ref echoed (Leads item_id7)', !!g.ref, JSON.stringify(g.ref));
    check('  first name (Leads text37)', !!g.first);
    check('  city (Leads text8)', !!g.city, 'blank city, check text8');
    check('  check in yyyy-mm-dd (Booking date69)', /^\d{4}-\d{2}-\d{2}$/.test(g.checkIn || ''),
          JSON.stringify(g.checkIn));
  }

  r = await call({ ref: ref, surname: 'Definitelynotthesurname' });
  check('wrong surname -> 401', r.status === 401, 'status ' + r.status);

  r = await call({ ref: '999999999999', surname: surname });
  check('unknown reference -> 401', r.status === 401, 'status ' + r.status);

  console.log(failures ? '\n' + failures + ' failed' : '\nall good');
  process.exit(failures ? 1 : 0);
})();
