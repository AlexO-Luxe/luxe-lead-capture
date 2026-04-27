// ============================================================
//  Student Luxe — Dashboard Comments API
//  GET    /api/dashboard-comments?period=2026-04
//  POST   /api/dashboard-comments  { period, author, text }
//  DELETE /api/dashboard-comments  { period, id }
//
//  Storage: Vercel Blob (luxe-listings-blob)
//  Requires: BLOB_READ_WRITE_TOKEN env var (auto-set by Vercel)
// ============================================================

const VALID_AUTHORS = ['AO', 'JD', 'AW', 'AK', 'AB'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { period } = req.query;
      if (!period) return res.status(400).json({ error: 'period required' });
      const comments = await getComments(period);
      return res.status(200).json({ period, comments });
    }

    if (req.method === 'POST') {
      const { period, author, text } = req.body;
      if (!period || !author || !text) return res.status(400).json({ error: 'period, author, text required' });
      if (!VALID_AUTHORS.includes(author)) return res.status(400).json({ error: 'Invalid author' });

      const comments = await getComments(period);
      const comment  = {
        id:        `${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
        author,
        text:      text.slice(0, 1000),
        timestamp: new Date().toISOString()
      };
      comments.push(comment);
      await saveComments(period, comments);
      return res.status(200).json({ success: true, comment });
    }

    if (req.method === 'DELETE') {
      const { period, id } = req.body;
      if (!period || !id) return res.status(400).json({ error: 'period, id required' });
      const comments = await getComments(period);
      await saveComments(period, comments.filter(c => c.id !== id));
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('Comments error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

function blobKey(period) {
  return 'dashboard-comments/' + period.replace(/[^a-z0-9-]/gi, '_') + '.json';
}

async function getComments(period) {
  try {
    const { list } = require('@vercel/blob');
    const key = blobKey(period);
    const result = await list({ prefix: key, token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!result.blobs || !result.blobs.length) return [];
    const r = await fetch(result.blobs[0].url + '?t=' + Date.now()); // bust CDN cache
    if (!r.ok) return [];
    return await r.json();
  } catch (e) {
    console.log('getComments error:', e.message);
    return [];
  }
}

async function saveComments(period, comments) {
  try {
    const { put } = require('@vercel/blob');
    const key = blobKey(period);
    await put(key, JSON.stringify(comments), {
      access:          'public',
      addRandomSuffix: false,
      token:           process.env.BLOB_READ_WRITE_TOKEN,
      contentType:     'application/json'
    });
  } catch (e) {
    console.error('saveComments error:', e.message);
    throw e;
  }
}
