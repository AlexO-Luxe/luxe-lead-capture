export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      firstname, lastname,
      movein, checkout,
      budget, contact_phone, contact_email,
      utm_source, utm_campaign, utm_content, utm_term, utm_medium, gclid,
      user_journey, city, notes
    } = req.body;

    const itemName = `${firstname} ${lastname}`.trim();

    // Build column values
    const columnValues = {
      text37:           firstname     || '',
      text60:           lastname      || '',
      date47:           movein        ? { date: movein } : {},
      date_1:           checkout      ? { date: checkout } : {},
      budget_per_week:  budget        || '',
      phone_1:          contact_phone ? { phone: contact_phone, countryShortName: 'GB' } : {},
      email:            contact_email ? { email: contact_email, text: contact_email } : {},
      text8:            city          || '',
      text_mm1c3b5w:    utm_campaign  || '',
      text43__1:        utm_content   || '',
      text3__1:         utm_term      || '',
      text_mm1jnrbw:    utm_medium    || '',
      text4__1:         gclid         || '',
      long_text7:       notes         || '',
      long_text__1:     user_journey  || ''
    };

    const mutation = `
      mutation {
        create_item(
          board_id: 2171015719,
          item_name: ${JSON.stringify(itemName)},
          column_values: ${JSON.stringify(JSON.stringify(columnValues))}
        ) {
          id
        }
      }
    `;

    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': process.env.MONDAY_API_KEY
      },
      body: JSON.stringify({ query: mutation })
    });

    const data = await response.json();

    if (data.errors) {
      console.error('Monday API errors:', data.errors);
      return res.status(500).json({ error: 'Monday API error', detail: data.errors });
    }

    return res.status(200).json({ success: true, id: data?.data?.create_item?.id });

  } catch (err) {
    console.error('Submit lead error:', err);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
}
