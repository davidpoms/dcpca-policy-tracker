/**
 * /api/check-hearings
 *
 * Vercel Cron Job — runs daily at 8am ET, weekdays only.
 * Reads all tracked legislation from Supabase, fetches
 * /LegislationDetails/{id} via the existing /api/hello proxy,
 * parses hearing dates, and writes results back to Supabase.
 *
 * Also callable manually:
 *   POST https://dcpca-policy-tracker.vercel.app/api/check-hearings
 *   Header: Authorization: Bearer <CRON_SECRET>
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key (not anon)
const CRON_SECRET = process.env.CRON_SECRET;

// Re-use the existing proxy — no need for DC_API_BASE or any extra auth logic.
const PROXY_URL = 'https://dcpca-policy-tracker.vercel.app/api/hello';

// ─── Hearing parser (mirrors extractNextHearing in the frontend) ──────────────

function extractNextHearing(details) {
  const now = new Date();
  const hearingKeywords = ['hearing', 'markup', 'committee hearing', 'public hearing', 'oversight hearing'];
  const candidates = [];

  // Pattern A – flat date fields
  for (const f of ['nextHearingDate', 'hearingDate', 'committeeHearingDate', 'scheduledHearingDate']) {
    if (details[f]) {
      const d = new Date(details[f]);
      if (!isNaN(d)) candidates.push({ date: d, type: 'Hearing', location: details.hearingLocation || '' });
    }
  }

  // Pattern B – legislativeHistory / actions / events array
  const history = details.legislativeHistory || details.history || details.actions || details.events || [];
  if (Array.isArray(history)) {
    for (const event of history) {
      const action = (event.action || event.actionType || event.eventType || event.description || event.name || '').toLowerCase();
      if (!hearingKeywords.some(k => action.includes(k))) continue;
      const rawDate = event.date || event.actionDate || event.eventDate || event.scheduledDate || event.hearingDate;
      if (!rawDate) continue;
      const d = new Date(rawDate);
      if (!isNaN(d)) {
        candidates.push({
          date: d,
          type: event.action || event.actionType || event.eventType || 'Hearing',
          location: event.location || event.room || event.hearingLocation || ''
        });
      }
    }
  }

  // Pattern C – committeeReferrals
  const referrals = details.committeeReferrals || details.referrals || [];
  if (Array.isArray(referrals)) {
    for (const ref of referrals) {
      if (ref.hearingDate) {
        const d = new Date(ref.hearingDate);
        if (!isNaN(d)) candidates.push({ date: d, type: 'Committee Hearing', location: ref.location || ref.room || '' });
      }
    }
  }

  if (!candidates.length) return { date: null, type: null, location: null };

  candidates.sort((a, b) => a.date - b.date);
  const future = candidates.filter(c => c.date > now);
  const best = future.length > 0 ? future[0] : candidates[candidates.length - 1];

  return { date: best.date, type: best.type, location: best.location };
}

// ─── Supabase helper (no SDK needed) ─────────────────────────────────────────

async function supabaseRequest(path, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'GET' ? 'count=exact' : 'return=minimal'
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${text}`);
  }

  if (method === 'PATCH' || method === 'DELETE') return null;
  return res.json();
}

// ─── DC Council API helper — calls the existing /api/hello proxy ──────────────

async function fetchLegislationDetails(legislationNumber) {
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: `/LegislationDetails/${legislationNumber}`,
      method: 'GET',
      body: null
    })
  });

  if (!res.ok) throw new Error(`Proxy returned ${res.status} for ${legislationNumber}`);

  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {

  // Auth: accept Vercel's automatic cron header OR a manual Bearer token
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isManual = CRON_SECRET && req.headers['authorization'] === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Missing env vars: SUPABASE_URL and/or SUPABASE_SERVICE_KEY' });
  }

  const startedAt = new Date().toISOString();
  console.log(`[check-hearings] Starting at ${startedAt}`);

  // Load all tracked non-manual items
  let trackedItems;
  try {
    trackedItems = await supabaseRequest(
      '/tracked_items?is_manual_entry=eq.false&select=id,title',
      'GET'
    );
  } catch (err) {
    console.error('[check-hearings] Failed to load tracked items:', err);
    return res.status(500).json({ error: 'Failed to load tracked items', detail: err.message });
  }

  if (!trackedItems || trackedItems.length === 0) {
    console.log('[check-hearings] No tracked items found.');
    return res.status(200).json({ message: 'No tracked items to check.', checked: 0 });
  }

  console.log(`[check-hearings] Checking ${trackedItems.length} items…`);

  const results = { checked: 0, updated: 0, withUpcoming: 0, errors: [] };
  const BATCH_SIZE = 3;

  for (let i = 0; i < trackedItems.length; i += BATCH_SIZE) {
    const batch = trackedItems.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (item) => {
      try {
        const details = await fetchLegislationDetails(item.id);
        const hearing = extractNextHearing(details);
        const isPast = hearing.date && hearing.date <= new Date();

        await supabaseRequest(
          `/tracked_items?id=eq.${encodeURIComponent(item.id)}`,
          'PATCH',
          {
            hearing_checked_at: new Date().toISOString(),
            next_hearing_date: hearing.date ? hearing.date.toISOString() : null,
            hearing_type: hearing.type || null,
            hearing_location: hearing.location || null
          }
        );

        results.checked++;
        results.updated++;
        if (hearing.date && !isPast) results.withUpcoming++;

        console.log(`[check-hearings] ✓ ${item.id}${hearing.date ? ` — hearing ${hearing.date.toLocaleDateString()}` : ' — no hearing'}`);
      } catch (err) {
        console.error(`[check-hearings] ✗ ${item.id}: ${err.message}`);
        results.errors.push({ id: item.id, error: err.message });
        results.checked++;
      }
    }));

    // Polite pause between batches
    if (i + BATCH_SIZE < trackedItems.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Log summary to activity_log
  try {
    await supabaseRequest('/activity_log', 'POST', [{
      action: 'cron_hearings_checked',
      item_id: null,
      item_title: null,
      details: {
        checked: results.checked,
        withUpcoming: results.withUpcoming,
        errors: results.errors.length,
        ranAt: startedAt
      }
    }]);
  } catch (err) {
    console.warn('[check-hearings] Could not write to activity_log:', err.message);
  }

  console.log(`[check-hearings] Done. ${results.withUpcoming} upcoming hearings. ${results.errors.length} errors.`);
  return res.status(200).json(results);
}
