// ============================================================
//  Student Luxe — Dashboard Comments API
//  GET  /api/dashboard-comments?period=2026-04
//  POST /api/dashboard-comments  { period, author, text }
//  DELETE /api/dashboard-comments { period, id }
//
//  Storage: Vercel KV (or filesystem fallback via /tmp)
//  Since Vercel KV may not be configured, we use a simple
//  JSON file in /tmp as fallback (resets on cold start).
//  For persistence, set KV_REST_API_URL + KV_REST_API_TOKEN
//  env vars and this will use Vercel KV automatically.
// ============================================================

const MONDAY_API = 'https://api.monday.com/v2';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const useKV = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

  try {
    if (req.method === 'GET') {
      const { period } = req.query;
      if (!period) return res.status(400).json({ error: 'period required' });
      const comments = await getComments(period, useKV);
      return res.status(200).json({ period, comments });
    }

    if (req.method === 'POST') {
      const { period, author, text } = req.body;
      if (!period || !author || !text) return res.status(400).json({ error: 'period, author, text required' });
      const VALID_AUTHORS = ['AO','JD','AW','AK','AB'];
      if (!VALID_AUTHORS.includes(author)) return res.status(400).json({ error: 'Invalid author' });

      const comments = await getComments(period, useKV);
      const comment = {
        id:        Date.now().toString(),
        author,
        text:      text.slice(0, 1000), // cap length
        timestamp: new Date().toISOString()
      };
      comments.push(comment);
      await setComments(period, comments, useKV);
      return res.status(200).json({ success: true, comment });
    }

    if (req.method === 'DELETE') {
      const { period, id } = req.body;
      if (!period || !id) return res.status(400).json({ error: 'period, id required' });
      const comments = await getComments(period, useKV);
      const filtered = comments.filter(c => c.id !== id);
      await setComments(period, filtered, useKV);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('Comments error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Storage helpers ───────────────────────────────────────────

async function getComments(period, useKV) {
  const key = `sl_comments_${period}`;
  if (useKV) {
    const url = `${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });
    const data = await r.json();
    return data.result ? JSON.parse(data.result) : [];
  } else {
    // Filesystem fallback (/tmp persists within same Lambda instance)
    const fs   = require('fs');
    const path = require('path');
    const file = path.join('/tmp', `${key}.json`);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  }
}

async function setComments(period, comments, useKV) {
  const key  = `sl_comments_${period}`;
  const data = JSON.stringify(comments);
  if (useKV) {
    const url = `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}`;
    await fetch(url, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ value: data })
    });
  } else {
    const fs   = require('fs');
    const path = require('path');
    const file = path.join('/tmp', `${key}.json`);
    fs.writeFileSync(file, data, 'utf8');
  }
}
