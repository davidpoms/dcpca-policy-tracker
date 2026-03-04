/**
 * /api/backfill-status-history.js
 *
 * One-time backfill: inserts a bill_status_history entry for every tracked
 * item that doesn't already have one, using today's date as the baseline.
 * This gives the "Since" field in reports a real wall-clock anchor date.
 *
 * Run once via PowerShell:
 *   Invoke-WebRequest -Uri "https://dcpca-policy-tracker.vercel.app/api/backfill-status-history" -Method POST -Headers @{ "Authorization" = "Bearer dcpcapolicyhearingtracker" } -UseBasicParsing
 */

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET   = process.env.CRON_SECRET;

const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
};

async function sbGet(path) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { headers: sbHeaders });
    if (!r.ok) throw new Error(`Supabase GET ${path}: ${r.status}`);
    return r.json();
}

async function sbInsert(table, body) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST', headers: sbHeaders, body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Supabase INSERT ${table}: ${r.status} ${await r.text()}`);
}

export default async function handler(req, res) {
    const isManual = CRON_SECRET && req.headers['authorization'] === `Bearer ${CRON_SECRET}`;
    if (!isManual) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const items = await sbGet('/tracked_items?select=*');
        const existingHistory = await sbGet('/bill_status_history?select=item_id');
        const itemsWithHistory = new Set(existingHistory.map(h => h.item_id));

        const now = new Date().toISOString();
        let inserted = 0;
        let skipped = 0;

        for (const item of items) {
            if (itemsWithHistory.has(item.id)) {
                skipped++;
                continue;
            }
            if (!item.status) {
                skipped++;
                continue;
            }

            await sbInsert('bill_status_history', {
                item_id: item.id,
                old_status: item.status,
                new_status: item.status,
                change_label: 'Backfill — status at time of migration',
                changed_at: now
            });
            inserted++;
        }

        console.log(`[backfill] inserted: ${inserted}, skipped: ${skipped}`);
        return res.status(200).json({ inserted, skipped, total: items.length });

    } catch (err) {
        console.error('[backfill] Error:', err);
        return res.status(500).json({ error: err.message });
    }
}
