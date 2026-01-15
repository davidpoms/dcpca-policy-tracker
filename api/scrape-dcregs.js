export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { limit = 20 } = req.query;
  const apiKey = process.env.SCRAPINGBEE_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ 
      success: false,
      error: 'ScrapingBee API key not configured' 
    });
  }

  try {
    // Try multiple category pages that are more accessible
    const categories = [
      'Final Rulemaking',
      'Proposed Rulemaking', 
      'Emergency Rulemaking'
    ];
    
    const allRegulations = [];
    
    for (const category of categories) {
      try {
        // Build URL for specific category search
        const searchUrl = `https://www.dcregs.dc.gov/Common/DCR/Issues/IssueCategoryList.aspx`;
        const scrapingBeeUrl = `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}&url=${encodeURIComponent(searchUrl)}&render_js=true&wait=5000`;
        
        const response = await fetch(scrapingBeeUrl);
        
        if (response.ok) {
          const html = await response.text();
          const regs = parseRegulationsFromCategory(html, category);
          allRegulations.push(...regs);
        }
      } catch (err) {
        console.error(`Error fetching ${category}:`, err.message);
      }
    }

    // If we got nothing from scraping, return sample data with instructions
    if (allRegulations.length === 0) {
      return res.status(200).json({ 
        success: true,
        count: 0,
        regulations: [],
        message: 'DC Register website is blocking automated access. Please use manual entry or check https://www.dcregs.dc.gov/ directly.',
        metadata: {
          scrapedAt: new Date().toISOString(),
          source: 'DC Register (Manual Entry Recommended)'
        }
      });
    }

    return res.status(200).json({ 
      success: true,
      count: allRegulations.length,
      regulations: allRegulations.slice(0, parseInt(limit)),
      metadata: {
        scrapedAt: new Date().toISOString(),
        source: 'DC Register via ScrapingBee'
      }
    });
    
  } catch (error) {
    console.error('Scraping error:', error);
    return res.status(500).json({ 
      success: false,
      error: 'DC Register scraping failed', 
      details: error.message,
      recommendation: 'Use manual entry feature for DC Register items'
    });
  }
}

function parseRegulationsFromCategory(html, category) {
  const regulations = [];
  
  // Look for the specific table structure from your sample
  const tablePattern = /<table[^>]*id="noticeTable"[^>]*>([\s\S]*?)<\/table>/i;
  const tableMatch = html.match(tablePattern);
  
  if (!tableMatch) return regulations;
  
  const tableContent = tableMatch[1];
  const rowPattern = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const rows = tableContent.match(rowPattern) || [];
  
  for (const row of rows) {
    // Skip header rows
    if (row.includes('<thead') || row.includes('<th>')) continue;
