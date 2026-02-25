/**
 * /api/build-bill-cache.js
 *
 * Builds and maintains a full cache of all LIMS legislation details
 * in the lims_bill_cache Supabase table.
 *
 * Strategy:
 *   - Runs nightly at midnight ET (05:00 UTC)
 *   - Paginates through ALL bills for the current council period via SearchLegislation
 *   - For each bill, fetches full LegislationDetails and upserts into cache
 *   - Skips bills already cached in the last 7 days unless their status changed
 *   - Can be triggered manually via CRON_SECRET for initial population
 *
 * Env vars required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, CRON_SECRET
 */

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET   = process.env.CRON_SECRET;
const LIMS_BASE     = 'https://lims.dccouncil.gov/api/v2';
const COUNCIL_PERIOD = 26;
const DETAIL_DELAY_MS = 1200;  // between detail fetches
const PAGE_DELAY_MS   = 800;   // between pagination requests

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
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify(body)
    });
    if (!r.ok) {
        const text = await r.text();
        throw new Error(`Supabase UPSERT ${table}: ${r.status} ${text}`);
    }
}

// ─── LIMS helpers ─────────────────────────────────────────────────────────────

async function limsPost(endpoint, body) {
    const r = await fetch(`${LIMS_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`LIMS POST ${endpoint}: ${r.status}`);
    return r.json();
}

async function limsGet(endpoint) {
    const r = await fetch(`${LIMS_BASE}${endpoint}`, {
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
    });
    if (!r.ok) throw new Error(`LIMS GET ${endpoint}: ${r.status}`);
    return r.json();
}

const delay = ms => new Promise(r => setTimeout(r, ms));

const parseMembers = (val) =>
    Array.isArray(val) ? val.map(m => m.memberName || String(m)).join('; ') : (val || null);

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const isManual = CRON_SECRET && req.headers['authorization'] === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });

    const now = new Date();
    const stats = { fetched: 0, upserted: 0, skipped: 0, errors: 0 };

    // Load existing cache to know what's fresh (cached within last 7 days)
    const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(now.getDate() - 7);
    const existingCache = await sbGet(
        `/lims_bill_cache?select=bill_number,status,cached_at&council_period_id=eq.${COUNCIL_PERIOD}`
    );
    const cacheMap = {}; // bill_number -> { status, cached_at }
    existingCache.forEach(r => { cacheMap[r.bill_number] = r; });
    console.log(`[build-bill-cache] ${existingCache.length} bills already in cache`);

    // ── 1. Paginate through all legislation ───────────────────────────────────
    const allBills = [];
    let offset = 0;
    while (true) {
        try {
            const page = await limsPost('/SearchLegislation', {
                Keyword: '', CategoryId: 0,
                CouncilPeriodId: COUNCIL_PERIOD, RowLimit: 100, OffSet: offset
            });
            if (!Array.isArray(page) || page.length === 0) break;
            allBills.push(...page);
            console.log(`[build-bill-cache] Fetched page at offset ${offset}: ${page.length} bills (total: ${allBills.length})`);
            if (page.length < 100) break;
            offset += 100;
            await delay(PAGE_DELAY_MS);
        } catch (err) {
            console.error(`[build-bill-cache] Pagination error at offset ${offset}:`, err.message);
            break;
        }
    }

    stats.fetched = allBills.length;
    console.log(`[build-bill-cache] Total bills found: ${allBills.length}`);

    // ── 2. Fetch details for each bill and upsert ─────────────────────────────
    for (const bill of allBills) {
        const billNum = bill.legislationNumber;
        if (!billNum) continue;

        const cached = cacheMap[billNum];
        const cachedAt = cached ? new Date(cached.cached_at) : null;
        const isFresh = cachedAt && cachedAt >= sevenDaysAgo;
        const statusUnchanged = cached && cached.status === bill.status;

        // Skip if fresh and status hasn't changed
        if (isFresh && statusUnchanged) {
            stats.skipped++;
            continue;
        }

        try {
            const details = await limsGet(`/LegislationDetails/${billNum}`);

            const introducedBy = parseMembers(details.introducers);
            const coIntroducers = parseMembers(details.coIntroducers);
            const committees = Array.isArray(details.committeesReferredTo)
                ? details.committeesReferredTo.join('; ')
                : (details.referredToCommittees || null);

            await sbUpsert('lims_bill_cache', {
                bill_number: billNum,
                council_period_id: COUNCIL_PERIOD,
                title: details.title || bill.title,
                category: details.category || bill.category,
                status: details.status || bill.status,
                introduced_by: introducedBy,
                co_introducers: coIntroducers,
                committees: committees,
                introduction_date: details.introductionDate || null,
                additional_information: details.additionalInformation || null,
                link: `https://lims.dccouncil.gov/Legislation/${billNum}`,
                raw_details: details,
                cached_at: now.toISOString()
            });

            stats.upserted++;
        } catch (err) {
            console.error(`[build-bill-cache] Error on ${billNum}:`, err.message);
            stats.errors++;
        }

        await delay(DETAIL_DELAY_MS);
    }

    console.log(`[build-bill-cache] Done:`, stats);
    return res.status(200).json({ ...stats, total: allBills.length });
}
