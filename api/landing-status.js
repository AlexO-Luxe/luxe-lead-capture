// ============================================================
//  Conversion landing status, for the PPC dashboard.
//  GET /api/landing-status   (Bearer CRON_SECRET or DIGEST_TOKEN)
//
//  The dashboard lives in a different Vercel project, so the numbers it
//  shows on /ppc are read from here rather than recomputed. Same source as
//  the daily digest, so the board and the email can never disagree.
// ============================================================

const { checkLandingWindow, missingLeads, retractionByChannel, retractionLedger,
        stepLanding, SETTLE_DAYS } = require('./_landing-check.js');
const { logError } = require('./_errlog.js');

module.exports = async function handler (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const ok = (process.env.CRON_SECRET  && bearer === process.env.CRON_SECRET)
          || (process.env.DIGEST_TOKEN && bearer === process.env.DIGEST_TOKEN)
          || req.query?.secret === process.env.CRON_SECRET;
  if (!ok) return res.status(401).json({ error: 'unauthorized' });

  try {
    const days = Math.max(1, Math.min(30, parseInt(req.query?.days || '7', 10)));
    const [window, missing, steps, channels, ledger] = await Promise.all([
      checkLandingWindow({ days }),
      missingLeads({ days: 30, limit: 10 }).catch(() => []),
      stepLanding({ days }).catch(() => []),
      retractionByChannel().catch(() => null),
      retractionLedger({ days: 30, limit: 10 }).catch(() => null)
    ]);

    // Retraction tallies come from the ledger the digest uses, so the board and
    // the email cannot disagree. They used to be summed off the channel split,
    // which counted a lead skipped for being months past Google's adjustment
    // window as a retraction failure. Now expired and merged rows sit in their
    // own outcomes and noMatch means only what actually reached Google and
    // did not match.
    const notRecorded = ledger?.rows?.find(r => r.code === 'not_recorded')?.count || 0;
    const retracted   = ledger?.retracted  || 0;
    const unresolved  = ledger?.unresolved || 0;
    const noMatch     = notRecorded + unresolved;

    return res.status(200).json({
      checkedAt:  new Date().toISOString(),
      settleDays: SETTLE_DAYS,
      totals:     window.totals,
      days:       window.rows,
      steps,
      retraction: {
        retracted, noMatch, unresolved,
        queued:    ledger?.queued    || 0,
        explained: ledger?.explained || 0,
        outcomes:  ledger?.rows      || [],
        unexplained: ledger?.unexplained || [],
        ready:   channels?.ready || false,
        verdict: channels?.ready ? channels.verdict : null,
        needed:  channels?.ready ? 0 : (channels?.needed ?? null)
      },
      missing
    });
  } catch (err) {
    console.error('landing-status error:', err.message);
    await logError('landing-status', err);
    return res.status(500).json({ error: err.message });
  }
};
