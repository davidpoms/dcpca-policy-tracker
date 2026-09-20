import { getSessionCookieValue, validateSignedSession } from '../lib/session.js';

const ALLOWED_ACTIONS = new Set([
  'keyword.add',
  'keyword.remove',
  'committee.add',
  'committee.remove',
  'sponsor.add',
  'sponsor.remove',
  'agency.add',
  'agency.remove',
  'note.save',
  'note.delete'
]);

function isExactBody(body, allowedKeys) {
  const actualKeys = Object.keys(body || {}).sort();
  const expectedKeys = [...allowedKeys].sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys);
}

function ensureSession(req) {
  const rawCookie = getSessionCookieValue(req);
  try {
    const result = validateSignedSession(rawCookie);
    if (!result.valid) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 500, error: 'Service unavailable' };
  }
}

function normalizeKeywordList(values) {
  const seen = new Set();
  return values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && !seen.has(value) && seen.add(value));
}

function normalizeRequiredText(value) {
  if (typeof value !== 'string') {
    return null;
  }
  return value.trim() === '' ? null : value;
}

function normalizeAgencyName(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeKeywordValue(value) {
  if (typeof value !== 'string') {
    return null;
  }
  return value.trim().toLowerCase();
}

async function supabaseTableRequest(url, serviceKey, table, method, body, query = '', extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...extraHeaders
  };

  const targetUrl = `${url}/rest/v1/${table}${query}`;
  const response = await fetch(targetUrl, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    throw new Error(`Supabase ${method} ${table} failed (${response.status})`);
  }

  return response;
}

async function logActivityEvent(url, serviceKey, action, itemId = null, itemTitle = null, details = {}) {
  try {
    await supabaseTableRequest(url, serviceKey, 'activity_log', 'POST', {
      action,
      item_id: itemId,
      item_title: itemTitle,
      details
    });
  } catch {
    // Preserve the previous browser-side logActivity behavior: do not block the main mutation if the audit insert fails.
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.SESSION_SECRET) {
    return res.status(500).json({ error: 'Service unavailable' });
  }

  const sessionState = ensureSession(req);
  if (!sessionState.ok) {
    return res.status(sessionState.status).json({ error: sessionState.error });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Service unavailable' });
  }

  let body;
  try {
    if (typeof req.body === 'string') {
      body = JSON.parse(req.body);
    } else {
      body = req.body ?? {};
    }
  } catch {
    return res.status(400).json({ error: 'Invalid request' });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const action = body.action;
  if (typeof action !== 'string' || !ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  try {
    switch (action) {
      case 'keyword.add': {
        if (!isExactBody(body, ['action', 'keywords'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (!Array.isArray(body.keywords) || body.keywords.length === 0) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (body.keywords.some((value) => typeof value !== 'string')) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const keywords = normalizeKeywordList(body.keywords);
        if (!keywords.length) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_keywords',
          'POST',
          keywords.map((keyword) => ({ keyword }))
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'keyword_added', null, null, {
          keywords: keywords.join(', ')
        });

        return res.status(200).json({ ok: true, added: keywords });
      }

      case 'keyword.remove': {
        if (!isExactBody(body, ['action', 'keyword'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.keyword !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const keyword = normalizeKeywordValue(body.keyword);
        if (!keyword) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const encoded = encodeURIComponent(keyword);
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_keywords',
          'DELETE',
          null,
          `?keyword=eq.${encoded}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'keyword_removed', null, null, {
          keyword
        });

        return res.status(200).json({ ok: true, keyword });
      }

      case 'committee.add': {
        if (!isExactBody(body, ['action', 'committeeName'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const committeeName = normalizeRequiredText(body.committeeName);
        if (!committeeName) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_committees',
          'POST',
          { committee_name: committeeName }
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'committee_added', null, null, {
          committee: committeeName
        });

        return res.status(200).json({ ok: true, committeeName });
      }

      case 'committee.remove': {
        if (!isExactBody(body, ['action', 'committeeName'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const committeeName = normalizeRequiredText(body.committeeName);
        if (!committeeName) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        const encoded = encodeURIComponent(committeeName);
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_committees',
          'DELETE',
          null,
          `?committee_name=eq.${encoded}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'committee_removed', null, null, {
          committee: committeeName
        });

        return res.status(200).json({ ok: true, committeeName });
      }

      case 'sponsor.add': {
        if (!isExactBody(body, ['action', 'sponsorName'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const sponsorName = normalizeRequiredText(body.sponsorName);
        if (!sponsorName) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_sponsors',
          'POST',
          { sponsor_name: sponsorName }
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'sponsor_added', null, null, {
          sponsor: sponsorName
        });

        return res.status(200).json({ ok: true, sponsorName });
      }

      case 'sponsor.remove': {
        if (!isExactBody(body, ['action', 'sponsorName'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const sponsorName = normalizeRequiredText(body.sponsorName);
        if (!sponsorName) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        const encoded = encodeURIComponent(sponsorName);
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_sponsors',
          'DELETE',
          null,
          `?sponsor_name=eq.${encoded}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'sponsor_removed', null, null, {
          sponsor: sponsorName
        });

        return res.status(200).json({ ok: true, sponsorName });
      }

      case 'agency.add': {
        if (!isExactBody(body, ['action', 'agencyName'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const agencyName = normalizeAgencyName(body.agencyName);
        if (!agencyName) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_agencies',
          'POST',
          { agency_name: agencyName }
        );

        return res.status(200).json({ ok: true, agencyName });
      }

      case 'agency.remove': {
        if (!isExactBody(body, ['action', 'agencyName'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const agencyName = normalizeAgencyName(body.agencyName);
        if (!agencyName) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        const encoded = encodeURIComponent(agencyName);
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_agencies',
          'DELETE',
          null,
          `?agency_name=eq.${encoded}`
        );

        return res.status(200).json({ ok: true, agencyName });
      }

      case 'note.save': {
        if (!isExactBody(body, ['action', 'itemId', 'noteText', 'activityAction', 'itemTitle'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        if (typeof body.itemId !== 'string' || body.itemId.trim() === '') {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.noteText !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (body.activityAction !== 'note_added' && body.activityAction !== 'note_updated') {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemTitle !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const itemId = body.itemId;
        const noteText = body.noteText;
        const activityAction = body.activityAction;
        const itemTitle = body.itemTitle;

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'item_notes',
          'POST',
          { item_id: itemId, note_text: noteText },
          '?on_conflict=item_id',
          { Prefer: 'resolution=merge-duplicates' }
        );
        await logActivityEvent(supabaseUrl, serviceKey, activityAction, itemId, itemTitle, {});

        return res.status(200).json({ ok: true, itemId, noteText });
      }

      case 'note.delete': {
        if (!isExactBody(body, ['action', 'itemId', 'itemTitle'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        if (typeof body.itemId !== 'string' || body.itemId.trim() === '') {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemTitle !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const itemId = body.itemId;
        const itemTitle = body.itemTitle;
        const encodedId = encodeURIComponent(itemId);

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'item_notes',
          'DELETE',
          null,
          `?item_id=eq.${encodedId}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'note_deleted', itemId, itemTitle, {});

        return res.status(200).json({ ok: true, itemId });
      }

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('[app-data] request failed', { action, error: error.message });
    return res.status(500).json({ error: 'Service unavailable' });
  }
}
