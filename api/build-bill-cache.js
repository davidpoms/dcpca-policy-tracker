/**
 * /api/build-bill-cache.js
 *
 * Incrementally builds the lims_bill_cache table — processes 20 bills per
 * invocation to stay within Vercel's function timeout.
 *
 * First call: paginates SearchLegislation to collect all bill numbers,
 *             saves them + cursor position to lims_cache_cursor, then
 *             processes the first batch.
 * Subsequent calls: picks up where it left off.
 * When complete: returns { status: "complete" }
 *
 * PowerShell loop to run until done:
 *   $headers = @{ "Authorization" = "Bearer YOUR_SECRET" }
 *   do {
 *     $r = Invoke-WebRequest -Uri "https://dcpca-policy-tracker.vercel.app/api/build-bill-cache" -Method POST -Headers $headers
 *     $body = $r.Content | ConvertFrom-Json
 *     Write-Host "$($body.position)/$($body.total) — $($body.status)"
 *     Start-Sleep 5
 *   } while ($body.status -eq "in_progress")
 *
 * Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, CRON_SECRET
 */

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET    = process.env.CRON_SECRET;
const PROXY_URL      = 'https://dcpca-policy-tracker.vercel.app/api/hello';
const COUNCIL_PERIOD = 26;
const PAGE_SIZE      = 100;  // bills per SearchLegislation page
const BATCH_SIZE     = 20;   // detail fetches per invocation
const DETAIL_DELAY   = 1200; // ms between detail fetches

// ─── Supabase helpers ─────────────────────────────────────────────────────────

const sbHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates,return=minimal'
};

async function sbGet(path) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
        headers: { ...sbHeaders, 'Prefer': 'return=representation' }
    });
    if (!r.ok) throw new Error(`Supabase GET ${path}: ${r.status}`);
    return r.json();
}

async function sbUpsert(table, body) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST', headers: sbHeaders, body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Supabase UPSERT ${table}: ${r.status} ${await r.text()}`);
}

async function sbPatch(table, filter, body) {
    const qs = Object.entries(filter).map(([k,v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
        method: 'PATCH', headers: sbHeaders, body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Supabase PATCH ${table}: ${r.status}`);
}

// ─── LIMS via proxy ───────────────────────────────────────────────────────────

async function limsPost(endpoint, body) {
    const r = await fetch(PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, method: 'POST', body })
    });
    if (!r.ok) throw new Error(`Proxy POST ${endpoint}: ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    return data;
}

async function limsGet(endpoint) {
    const r = await fetch(PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, method: 'GET', body: null })
    });
    if (!r.ok) throw new Error(`Proxy GET ${endpoint}: ${r.status}`);
    const data = await r.json();
    if (data.error) return null; // bill doesn't exist, skip silently
    return data;
}

const delay = ms => new Promise(r => setTimeout(r, ms));
const parseMembers = (val) =>
    Array.isArray(val) ? val.map(m => m.memberName || String(m)).join('; ') : (val || null);

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const isManual = CRON_SECRET && req.headers['authorization'] === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });

    const reset = req.query?.reset === 'true' || req.body?.reset === true;
    if (reset) {
        await fetch(`${SUPABASE_URL}/rest/v1/lims_cache_cursor?council_period_id=eq.${COUNCIL_PERIOD}`, {
            method: 'DELETE', headers: sbHeaders
        });
        console.log('[build-bill-cache] Cursor reset');
    }

    // ── Load or initialize cursor ─────────────────────────────────────────────
    let cursorRows = await sbGet(`/lims_cache_cursor?council_period_id=eq.${COUNCIL_PERIOD}`);
    let cursor = cursorRows[0];

    if (!cursor) {
        console.log('[build-bill-cache] No cursor found — generating bill numbers by iteration...');

        // Since SearchLegislation caps results, generate bill numbers directly
        // Fetch a wide range and let LegislationDetails calls skip 404s
        const allBillNumbers = [];
        const MAX_BILL = 1500;  // B26 bills
        const MAX_RES  = 1000;  // PR26 resolutions

        for (let i = 1; i <= MAX_BILL; i++) {
            allBillNumbers.push(`B26-${String(i).padStart(4, '0')}`);
        }
        for (let i = 1; i <= MAX_RES; i++) {
            allBillNumbers.push(`PR26-${String(i).padStart(4, '0')}`);
        }

        cursor = {
            council_period_id: COUNCIL_PERIOD,
            bill_numbers: allBillNumbers,
            position: 0,
            total: allBillNumbers.length,
            completed: false,
            started_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        await sbUpsert('lims_cache_cursor', cursor);
        console.log(`[build-bill-cache] Cursor initialized with ${allBillNumbers.length} candidates`);

        // Return immediately — next call will start processing details
        return res.status(200).json({
            status: 'initialized',
            total: allBillNumbers.length,
            message: 'Bill number list generated. Call again to start processing details.'
        });
    }

    if (cursor.completed) {
        return res.status(200).json({
            status: 'complete',
            total: cursor.total,
            message: 'Cache is fully built. Delete the lims_cache_cursor row to rebuild from scratch.'
        });
    }

    // ── Process next batch ────────────────────────────────────────────────────
    const billNumbers = cursor.bill_numbers;
    const start = cursor.position;
    const end = Math.min(start + BATCH_SIZE, billNumbers.length);
    const batch = billNumbers.slice(start, end);

    const stats = { upserted: 0, errors: 0 };

    for (const billNum of batch) {
        try {
            const details = await limsGet(`/LegislationDetails/${billNum}`);

            // Skip if not found or empty response
            if (!details || !details.title) {
                stats.skipped = (stats.skipped || 0) + 1;
                await delay(300); // shorter delay for misses
                continue;
            }

            await sbUpsert('lims_bill_cache', {
                bill_number: billNum,
                council_period_id: COUNCIL_PERIOD,
                title: details.title,
                category: details.category,
                status: details.status,
                introduced_by: parseMembers(details.introducers),
                co_introducers: parseMembers(details.coIntroducers),
                committees: Array.isArray(details.committeesReferredTo)
                    ? details.committeesReferredTo.join('; ')
                    : (details.referredToCommittees || null),
                introduction_date: details.introductionDate || null,
                additional_information: details.additionalInformation || null,
                link: `https://lims.dccouncil.gov/Legislation/${billNum}`,
                raw_details: details,
                cached_at: new Date().toISOString()
            });
            stats.upserted++;
        } catch (err) {
            console.error(`[build-bill-cache] Error on ${billNum}:`, err.message);
            stats.errors++;
        }
        await delay(DETAIL_DELAY);
    }

    // ── Save cursor progress ──────────────────────────────────────────────────
    const newPosition = end;
    const completed = newPosition >= billNumbers.length;
    await sbPatch('lims_cache_cursor', { council_period_id: COUNCIL_PERIOD }, {
        position: newPosition,
        completed,
        updated_at: new Date().toISOString()
    });

    const remaining = billNumbers.length - newPosition;
    console.log(`[build-bill-cache] ${newPosition}/${billNumbers.length} — ${remaining} remaining`);

    return res.status(200).json({
        ...stats,
        position: newPosition,
        total: billNumbers.length,
        remaining,
        status: completed ? 'complete' : 'in_progress'
    });
}
