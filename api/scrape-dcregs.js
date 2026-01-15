export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { category = 'all', limit = 20 } = req.query;

  try {
    // DC Register categories
    const categories = [
      'Final Rulemaking',
      'Proposed Rulemaking',
      'Emergency and Proposed Rulemaking',
      'Emergency Rulemaking',
      'Notice of Public Meeting'
    ];

    const categoriesToFetch = category === 'all' ? categories : [category];
    const allRegulations = [];

    for (const cat of categoriesToFetch) {
      try {
        const url = `https://www.dcregs.dc.gov/Common/DCR/Issues/IssueCategoryList.aspx`;
        
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        
        if (!response.ok) continue;
        
        const html = await response.text();
        const regulations = parseRegulations(html, cat);
        allRegulations.push(...regulations);
      } catch (err) {
        console.error(`Error fetching ${cat}:`, err.message);
      }
    }

    // Sort by date (newest first) and limit
    const sorted = allRegulations
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, parseInt(limit));

    return res.status(200).json({ 
      success: true,
      count: sorted.length,
      regulations: sorted
    });
    
  } catch (error) {
    console.error('Scraping error:', error);
    return res.status(500).json({ 
      success: false,
      error: 'Failed to scrape DC Register', 
      details: error.message 
    });
  }
}

function parseRegulations(html, category) {
  const regulations = [];
  
  // Extract issue date
  const issueDateMatch = html.match(/<span id="MainContent_lblIssueDate"[^>]*>([^<]+)<\/span>/);
  const issueDate = issueDateMatch ? issueDateMatch[1].trim() : null;
  
  // Extract register category
  const regCatMatch = html.match(/<span id="MainContent_lblRegCat"[^>]*>([^<]+)<\/span>/);
  const registerCategory = regCatMatch ? regCatMatch[1].trim() : category;
  
  // Find all table rows
  const rowPattern = /<tr>[\s\S]*?<\/tr>/gi;
  const rows = html.match(rowPattern);
  
  if (!rows) return regulations;
  
  for (const row of rows) {
    // Skip header rows
    if (row.includes('<thead') || row.includes('<th')) continue;
    
    // Extract Notice ID
    const noticeIdMatch = row.match(/>(N\d+)<\/a>/);
    const noticeId = noticeIdMatch ? noticeIdMatch[1] : null;
    
    if (!noticeId) continue; // Skip rows without notice ID
    
    // Extract Section Number
    const sectionMatch = row.match(/SectionNumber=([^"&]+)/);
    const sectionNumber = sectionMatch ? sectionMatch[1] : null;
    
    // Extract Subject (title)
    const subjectMatch = row.match(/<span id="MainContent_rpt_RuleMakingList_lblSubject_\d+"[^>]*>([^<]+)<\/span>/);
    const subject = subjectMatch ? subjectMatch[1].trim() : 'Unknown Subject';
    
    // Extract agency from subject
    const agencyMatch = subject.match(/^([^-]+)/);
    const agency = agencyMatch ? agencyMatch[1].trim() : 'Unknown Agency';
    
    // Extract Register Issue (Volume/Issue)
    const registerIssueMatch = row.match(/>Vol\s+(\d+\/\d+)<\/a>/);
    const registerIssue = registerIssueMatch ? registerIssueMatch[1] : null;
    
    // Extract Publish Date
    const publishDateMatch = row.match(/<span id="MainContent_rpt_RuleMakingList_lblActiondate_\d+"[^>]*>([^<]+)<\/span>/);
    const publishDate = publishDateMatch ? publishDateMatch[1].trim() : issueDate;
    
    // Extract document link
    const linkMatch = row.match(/href="([^"]*DownloadFile[^"]*)"/);
    const documentLink = linkMatch ? `https://dcregs.dc.gov${linkMatch[1]}` : null;
    
    // Extract notice detail link
    const noticeDetailMatch = row.match(/NoticeDetail\.aspx\?NoticeId=([^"&]+)/);
    const noticeLink = noticeDetailMatch 
      ? `https://dcregs.dc.gov/Common/NoticeDetail.aspx?NoticeId=${noticeDetailMatch[1]}`
      : null;
    
    regulations.push({
      id: noticeId,
      title: subject,
      agency: agency,
      category: registerCategory,
      status: registerCategory,
      sectionNumber: sectionNumber,
      registerIssue: registerIssue,
      date: publishDate,
      documentLink: documentLink,
      detailLink: noticeLink,
      source: 'Municipal Register',
      isNew: isWithinDays(publishDate, 7)
    });
  }
  
  return regulations;
}

function isWithinDays(dateString, days) {
  if (!dateString) return false;
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffDays = (now - date) / (1000 * 60 * 60 * 24);
    return diffDays <= days;
  } catch (e) {
    return false;
  }
}
