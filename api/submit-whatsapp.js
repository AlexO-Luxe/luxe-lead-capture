// ============================================================
//  Student Luxe — WhatsApp Click Tracking
//  Deploy to: /api/submit-whatsapp.js
//
//  Called when a visitor clicks any wa.me link on the site.
//  Mints the enquiry ref and stores the click bundle for Oskar and the
//  thank-you hand-off panel. The per-click email alert was removed on
//  2026-09-10, it fired for every click and was pure noise.
//
//  Environment variables required:
//    TEAM_EMAIL_2 (alex@studentluxe.co.uk)
// ============================================================

const { logError } = require('./_errlog.js');

// Upstash Redis, lazy singleton (same pattern as _attribution.js)
const { mintRef } = require('./_waref.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const p = req.body;
    console.log('WhatsApp click received:', JSON.stringify(p));

    // Mint the enquiry ref and persist the whole click bundle for Oskar
    const ref = await mintRef({
      ...p,
      created_at: new Date().toISOString(),
    });

    // Email alert removed 2026-09-10 at Alex's request: one per wa.me click
    // was pure noise once the thank-you hand-off launched. The ref bundle
    // above is the part that matters, Oskar and the thank-you panel read it.
    console.log('WhatsApp click stored, ref:', ref);
    return res.status(200).json({ success: true, ref });

  } catch (err) {
    console.error('submit-whatsapp error:', err.message);
    await logError('submit-whatsapp', err);
    return res.status(200).json({ error: err.message });
  }
};
