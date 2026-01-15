export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { endpoint, method = 'GET', body } = req.method === 'POST' ? req.body : req.query;

  if (!endpoint) {
    return res.status(400).json({ error: 'Endpoint required' });
  }

  const url = `https://lims.dccouncil.gov/api/v2/PublicData${endpoint}`;

  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    if (body && method === 'POST') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
