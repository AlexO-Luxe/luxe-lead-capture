// ============================================================
//  Standing to-dos for the weekly PPC review.
//
//  Manual jobs that live outside this repo (pasting a script into
//  Squarespace, checking something in the Ads UI) get forgotten unless
//  they are in front of Alex every Monday. Each item is seeded here in
//  code; its done-state lives in KV so clearing one needs no deploy:
//
//    /api/pmax-review?secret=<CRON_SECRET>&todoDone=<id>
//
//  Items stay on the list until marked done. Add new ones here with a
//  fresh id; an id that has already been marked done stays hidden.
// ============================================================

const DONE_KEY = 'todo:manual:done';

const STANDING_TODOS = [
  {
    id:   'footer-snippet-2026-09',
    area: 'Site',
    text: 'Paste the updated site-wide tracking snippet (public/squarespace-tracking-snippet.html) into the Squarespace footer code injection. It clears stale keyword cookies when a new Google click lands, so Perf Max leads stop showing an old Search keyword.'
  },
  {
    id:   'form-script-2026-09',
    area: 'Site',
    text: 'Paste the updated 02-tracking.js (luxe-enquiry-form repo, branch claude/birmingham-enquiry-form-break-27lz05) into the reservations page code block. Same cookie fix, defence in depth on the form page itself.'
  },
  {
    id:   'jotform-birmingham-2026-09',
    area: 'Site',
    text: 'Find and retire the old Jotform still reachable for Birmingham: check the Birmingham page source for a jotform embed, check Jotform submissions, then disable the form and its Monday integration so nothing bypasses duplicate detection.'
  }
];

let _kv = null;
async function kv () {
  if (_kv) return _kv;
  const { Redis } = await import('@upstash/redis');
  _kv = Redis.fromEnv();
  return _kv;
}

// Open items, oldest first. KV trouble returns the full seeded list rather
// than nothing, so a Redis blip never hides a reminder.
async function openManualTodos () {
  let done = [];
  try { done = (await (await kv()).smembers(DONE_KEY)) || []; } catch {}
  const doneSet = new Set(done);
  return STANDING_TODOS.filter(t => !doneSet.has(t.id));
}

async function markManualTodoDone (id) {
  if (!STANDING_TODOS.some(t => t.id === id)) return { ok: false, reason: 'unknown id' };
  await (await kv()).sadd(DONE_KEY, id);
  return { ok: true, id };
}

module.exports = { STANDING_TODOS, openManualTodos, markManualTodoDone };
