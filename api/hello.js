import { getSessionCookieValue, validateSignedSession } from '../lib/session.js';

const LIMS_BASE = 'https://lims.dccouncil.gov/api/v2/PublicData';
const OUTER_KEYS = ['endpoint', 'method', 'body'];
const SEARCH_KEYS = ['Keyword', 'CategoryId', 'CouncilPeriodId', 'RowLimit', 'OffSet'];
const LEGISLATION_NUMBER = /^(?:B|PR|HN)\d{2}-\d{1,4}$/;

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function hasValidSession(req) {
  if (!process.env.SESSION_SECRET) return false;
  try {
    return validateSignedSession(getSessionCookieValue(req)).valid;
  } catch {
    return false;
  }
}

function hasValidCronAuthorization(req) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req?.headers?.authorization === `Bearer ${secret}`;
}

function isAuthorized(req) {
  const headers = req?.headers || {};
  const hasAuthorizationHeader = Object.prototype.hasOwnProperty.call(headers, 'authorization');
  const hasSessionCookie = getSessionCookieValue(req) !== null;

  if (hasAuthorizationHeader) {
    return !hasSessionCookie && hasValidCronAuthorization(req);
  }

  return hasValidSession(req);
}

function parseRequestBody(body) {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function resolveLimsRequest(body) {
  if (!hasExactKeys(body, OUTER_KEYS)) return null;

  if (body.endpoint === '/CouncilPeriods' && body.method === 'GET' && body.body === null) {
    return { endpoint: '/CouncilPeriods', method: 'GET', url: `${LIMS_BASE}/CouncilPeriods` };
  }

  const detailMatch = typeof body.endpoint === 'string'
    ? body.endpoint.match(/^\/LegislationDetails\/([^/?#]+)$/)
    : null;
  if (detailMatch && body.method === 'GET' && body.body === null && LEGISLATION_NUMBER.test(detailMatch[1])) {
    const legislationNumber = detailMatch[1];
    return {
      endpoint: `/LegislationDetails/${legislationNumber}`,
      method: 'GET',
      url: `${LIMS_BASE}/LegislationDetails/${encodeURIComponent(legislationNumber)}`
    };
  }

  if (body.endpoint !== '/SearchLegislation' || body.method !== 'POST' || !hasExactKeys(body.body, SEARCH_KEYS)) {
    return null;
  }

  const search = body.body;
  const standardFields = typeof search.Keyword === 'string' &&
    search.CategoryId === 0 &&
    Number.isSafeInteger(search.CouncilPeriodId) && search.CouncilPeriodId > 0 &&
    Number.isSafeInteger(search.RowLimit) &&
    Number.isSafeInteger(search.OffSet) && search.OffSet >= 0;
  if (!standardFields) return null;

  const keywordSearch = search.RowLimit === 20 && search.OffSet === 0;
  const categoryPage = search.RowLimit === 100 && search.Keyword === '' && search.OffSet % 100 === 0;
  if (!keywordSearch && !categoryPage) return null;

  return {
    endpoint: '/SearchLegislation',
    method: 'POST',
    url: `${LIMS_BASE}/SearchLegislation`,
    body: {
      Keyword: search.Keyword,
      CategoryId: 0,
      CouncilPeriodId: search.CouncilPeriodId,
      RowLimit: search.RowLimit,
      OffSet: search.OffSet
    }
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.query && Object.keys(req.query).length > 0) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.LIMS_API_KEY) {
    return res.status(500).json({ error: 'LIMS configuration unavailable' });
  }

  const request = resolveLimsRequest(parseRequestBody(req.body));
  if (!request) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${process.env.LIMS_API_KEY}`
      },
      ...(request.method === 'POST' ? { body: JSON.stringify(request.body) } : {})
    });

    if (!response.ok) {
      console.error(`LIMS API request failed for ${request.endpoint} with status ${response.status}`);
      return res.status(response.status).json({
        error: 'LIMS API error',
        status: response.status,
        details: 'Upstream request failed',
        endpoint: request.endpoint
      });
    }

    const data = await response.json();
    console.log(`Success: ${request.method} ${request.endpoint} returned ${Array.isArray(data) ? data.length + ' items' : 'data'}`);
    return res.status(200).json(data);
  } catch (error) {
    console.error(`LIMS API request failed for ${request.endpoint}`);
    return res.status(500).json({
      error: 'Proxy failed',
      details: 'Upstream request failed',
      endpoint: request.endpoint
    });
  }
}
