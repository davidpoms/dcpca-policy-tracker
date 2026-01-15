export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let endpoint, method, bodyData;
  
  if (req.method === 'POST') {
    endpoint = req.body?.endpoint;
    method = req.body?.method || 'POST';
    bodyData = req.body?.body;
  } else {
    endpoint = req.query.endpoint;
    method = req.query.method || 'GET';
    try {
      bodyData = req.query.body ? JSON.parse(req.query.body) : null;
    } catch (e) {
      bodyData = null;
    }
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
        'Accept': 'application/json'
      }
    };

    if (bodyData && method === 'POST') {
      fetchOptions.body = typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData);
    }

    const response = await fetch(url, fetchOptions);
    
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ 
        error: 'LIMS API error', 
        status: response.status,
        details: errorText 
      });
    }
    
    const data = await response.json();
    return res.status(200).json(data);
    
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ 
      error: 'Proxy failed', 
      details: error.message 
    });
  }
}
