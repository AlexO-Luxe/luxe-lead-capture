// ============================================================
//  Student Luxe — Monday Formula Column Debug
//  Deploy to: /api/test-monday-formula.js
//  DELETE THIS FILE after debugging is complete
//  
//  Visit: /api/test-monday-formula?itemId=11788560381
// ============================================================

const MONDAY_API = 'https://api.monday.com/v2';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const itemId = req.query.itemId || '11788560381';
  const results = {};

  // ── TEST 1: Standard column_values query ──────────────────
  try {
    const r = await fetch(MONDAY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': process.env.MONDAY_API_KEY,
        'API-Version': '2024-01'
      },
      body: JSON.stringify({
        query: `
          query {
            items(ids: [${itemId}]) {
              id
              name
              column_values(ids: ["formula2"]) {
                id
                text
                value
                ... on FormulaValue {
                  display_value
                }
              }
            }
          }
        `
      })
    });
    const data = await r.json();
    results.test1_standard = data?.data?.items?.[0]?.column_values?.[0] || data?.errors;
  } catch(e) {
    results.test1_standard = { error: e.message };
  }

  // ── TEST 2: items_page approach ───────────────────────────
  try {
    const r = await fetch(MONDAY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': process.env.MONDAY_API_KEY,
        'API-Version': '2024-01'
      },
      body: JSON.stringify({
        query: `
          query {
            items_page(limit: 1, query_params: {ids: [${itemId}]}) {
              items {
                id
                name
                column_values(ids: ["formula2"]) {
                  id
                  text
                  value
                  ... on FormulaValue {
                    display_value
                  }
                }
              }
            }
          }
        `
      })
    });
    const data = await r.json();
    results.test2_items_page = data?.data?.items_page?.items?.[0]?.column_values?.[0] || data?.errors;
  } catch(e) {
    results.test2_items_page = { error: e.message };
  }

  // ── TEST 3: All column values (no filter) ─────────────────
  try {
    const r = await fetch(MONDAY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': process.env.MONDAY_API_KEY,
        'API-Version': '2024-01'
      },
      body: JSON.stringify({
        query: `
          query {
            items(ids: [${itemId}]) {
              id
              name
              column_values {
                id
                text
                value
                type
              }
            }
          }
        `
      })
    });
    const data = await r.json();
    // Only show formula type columns
    const allCols = data?.data?.items?.[0]?.column_values || [];
    results.test3_all_formula_cols = allCols.filter(c => c.type === 'formula' || c.id === 'formula2');
    results.test3_formula2_raw = allCols.find(c => c.id === 'formula2');
  } catch(e) {
    results.test3_all_formula_cols = { error: e.message };
  }

  // ── TEST 4: Using 2023-10 API version ────────────────────
  try {
    const r = await fetch(MONDAY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': process.env.MONDAY_API_KEY,
        'API-Version': '2023-10'
      },
      body: JSON.stringify({
        query: `
          query {
            items(ids: [${itemId}]) {
              id
              column_values(ids: ["formula2"]) {
                id
                text
                value
              }
            }
          }
        `
      })
    });
    const data = await r.json();
    results.test4_old_api_version = data?.data?.items?.[0]?.column_values?.[0] || data?.errors;
  } catch(e) {
    results.test4_old_api_version = { error: e.message };
  }

  console.log('Monday formula test results:', JSON.stringify(results, null, 2));
  return res.status(200).json(results);
};
