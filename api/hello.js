export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Get parameters from query string or body
  let endpoint, method, body;
  
  if (req.method === 'GET') {
    endpoint = req.query.endpoint;
    method = req.query.method || 'GET';
    body = req.query.body ? JSON.parse(req.query.body) : null;
  } else {
    endpoint = req.body.endpoint;
    method = req.body.method || 'POST';
    body = req.body.body;
  }

  if (!endpoint) {
    return res.status(400).json({ error: 'endpoint parameter required' });
  }

  const url = `https://lims.dccouncil.gov/api/v2/PublicData${endpoint}`;

  try {
    const fetchOptions = {
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };

    if (body && method === 'POST') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    const data = await response.json();
    
    return res.status(200).json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch from LIMS API', 
      details: error.message 
    });
  }
}
