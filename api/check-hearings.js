/**
 * /api/check-hearings.js
 *
 * Runs Mon–Fri at 8:00am ET (13:00 UTC).
 * 1. Checks each tracked bill against LIMS for status changes + hearing updates
 * 2. Writes status changes to bill_status_history
 * 3. Sends immediate alert email when action_needed/monitor_and_assess bills change
 * 4. Runs tracked keyword searches and alerts on newly introduced bills
 *
 * Env vars required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, CRON_SECRET
 *   GMAIL_USER, GMAIL_APP_PASSWORD
 *   DAILY_REPORT_TO  — alert recipient (same as daily report)
 *   LIMS_API_BASE    — e.g. https://lims.dccouncil.gov/api/v2 (or whatever proxy base)
 */

import nodemailer from 'nodemailer';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET   = process.env.CRON_SECRET;
const GMAIL_USER    = process.env.GMAIL_USER;
const GMAIL_PASS    = process.env.GMAIL_APP_PASSWORD;
const ALERT_TO      = process.env.DAILY_REPORT_TO;
const LIMS_BASE     = 'https://lims.dccouncil.gov/api/v2';
const COUNCIL_PERIOD = 26;

// ─── Supabase helpers ─────────────────────────────────────────────────────────

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

async function sbPatch(table, id, body) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: sbHeaders, body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Supabase PATCH ${table}: ${r.status}`);
}

async function sbInsert(table, body) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST', headers: sbHeaders, body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Supabase INSERT ${table}: ${r.status}`);
}

// ─── LIMS helpers ─────────────────────────────────────────────────────────────

async function limsGet(endpoint) {
    const r = await fetch(`${LIMS_BASE}${endpoint}`, {
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
    });
    if (!r.ok) throw new Error(`LIMS ${endpoint}: ${r.status}`);
    return r.json();
}

async function limsPost(endpoint, body) {
    const r = await fetch(`${LIMS_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`LIMS POST ${endpoint}: ${r.status}`);
    return r.json();
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Date helpers ─────────────────────────────────────────────────────────────

function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Activity date extraction (mirrors client-side logic) ─────────────────────

function extractLatestActivityDate(details) {
    const candidates = [];
    const add = (val, label) => {
        if (!val) return;
        const d = new Date(val);
        if (!isNaN(d) && d.getFullYear() > 2000) candidates.push({ date: d, label });
    };
    if (details.congressionalReview) {
        add(details.congressionalReview.effectiveDate, 'Effective Date (Law)');
        add(details.congressionalReview.lawPublicationDate, 'Law Published');
        add(details.congressionalReview.transmittedDate, 'Transmitted to Congress');
    }
    if (details.mayoralReview) {
        add(details.mayoralReview.enactedDate, 'Enacted');
        add(details.mayoralReview.signedDate, 'Signed by Mayor');
        add(details.mayoralReview.returnedDate, 'Returned by Mayor');
        add(details.mayoralReview.actPublicationDate, 'Act Published');
        add(details.mayoralReview.transmittedDate, 'Transmitted to Mayor');
    }
    (details.actions || []).forEach(a => add(a.actionDate, a.action?.trim() || 'Council Action'));
    (details.committeeMarkup || []).forEach(m => {
        add(m.reportFiledDate, 'Committee Report Filed');
        add(m.committeeActionDate, 'Committee Markup');
    });
    (details.committeeHearing || []).forEach(h => {
        if (new Date(h.hearingDate) <= new Date()) add(h.hearingDate, h.hearingType || 'Committee Hearing');
    });
    (details.committeeReReferral || []).forEach(r => {
        add(r.reReferralDate, 'Committee Re-Referral');
        add(r.reReferralPublishedDate, 'Re-Referral Published');
    });
    add(details.introductionPublicationDate, 'Introduction Published');
    add(details.introductionDate, 'Introduced');
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.date - a.date);
    return { dateIso: candidates[0].date.toISOString(), label: candidates[0].label };
}

function extractNextHearing(details) {
    const now = new Date();
    const candidates = [];
    const addH = (val, type, location) => {
        if (!val) return;
        const d = new Date(val);
        if (!isNaN(d)) candidates.push({ date: d, type, location: location || '' });
    };
    (details.committeeHearing || []).forEach(h => addH(h.hearingDate, h.hearingType || 'Committee Hearing', h.location));
    (details.committeeMarkup || []).forEach(m => addH(m.committeeActionDate, 'Committee Markup', m.location));
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.date - b.date);
    const future = candidates.filter(c => c.date > now);
    if (!future.length) return null;
    return future[0];
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendEmail(subject, html) {
    if (!GMAIL_USER || !GMAIL_PASS || !ALERT_TO) {
        console.warn('[check-hearings] Missing email config — skipping alert');
        return;
    }
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 465, secure: true,
        auth: { user: GMAIL_USER, pass: GMAIL_PASS }
    });
    await transporter.sendMail({
        from: `DC Policy Tracker <${GMAIL_USER}>`,
        to: ALERT_TO,
        subject,
        html
    });
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const isManual = CRON_SECRET && req.headers['authorization'] === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });

    const now = new Date();
    const results = { checked: 0, statusChanges: [], newKeywordMatches: [], errors: [] };

    // ── 1. Load all tracked items ────────────────────────────────────────────

    const trackedItems = await sbGet('/tracked_items?select=*&order=tracked_at.desc');
    const trackedBills = trackedItems.filter(i => !i.is_manual_entry && i.bill_number);
    const trackedKeywords = await sbGet('/tracked_keywords?select=keyword');
    const keywords = trackedKeywords.map(k => k.keyword);

    // ── 2. Check each tracked bill against LIMS ──────────────────────────────

    const statusChangeAlerts = []; // items whose status changed and need email

    for (const item of trackedBills) {
        try {
            const details = await limsGet(`/LegislationDetails/${item.bill_number}`);
            const newStatus = details.status || null;
            const oldStatus = item.status || null;
            const statusChanged = newStatus && oldStatus && newStatus !== oldStatus;

            const activity = extractLatestActivityDate(details);
            const hearing = extractNextHearing(details);
            const reReferrals = details.committeeReReferral || [];

            // Write status history if changed
            if (statusChanged) {
                await sbInsert('bill_status_history', {
                    item_id: item.id,
                    old_status: oldStatus,
                    new_status: newStatus,
                    change_label: activity?.label || null,
                    changed_at: now.toISOString()
                });

                // Queue alert if item is action_needed or monitor_and_assess
                if (item.action_status === 'action_needed' || item.action_status === 'monitor_and_assess') {
                    statusChangeAlerts.push({ item, oldStatus, newStatus, activity, hearing });
                }

                results.statusChanges.push({ id: item.id, title: item.title, oldStatus, newStatus });
            }

            // Update tracked_items
            await sbPatch('tracked_items', item.id, {
                status: newStatus || item.status,
                next_hearing_date: hearing ? hearing.date.toISOString() : null,
                hearing_type: hearing?.type || null,
                hearing_location: hearing?.location || null,
                additional_information: details.additionalInformation || item.additional_information,
                committee_re_referral: reReferrals.length > 0 ? reReferrals : item.committee_re_referral,
                latest_activity_date: activity?.dateIso || item.latest_activity_date || null,
                latest_activity_label: activity?.label || item.latest_activity_label || null,
                hearing_checked_at: now.toISOString()
            });

            results.checked++;
        } catch (err) {
            console.error(`[check-hearings] Error on ${item.bill_number}:`, err.message);
            results.errors.push({ id: item.id, error: err.message });
        }

        await delay(1500);
    }

    // ── 3. Send status change alert email ────────────────────────────────────

    if (statusChangeAlerts.length > 0) {
        const itemStyle = 'margin: 12px 0; padding: 12px; border-radius: 6px; background: white; border: 1px solid #fca5a5;';
        const alertHtml = `
        <!DOCTYPE html><html><head><meta charset="utf-8"></head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; background: #f9fafb;">
            <div style="background: #dc2626; color: white; padding: 16px 24px; border-radius: 10px 10px 0 0;">
                <h1 style="margin: 0; font-size: 18px;">🔔 DC Policy Tracker — Status Change Alert</h1>
                <p style="margin: 4px 0 0; font-size: 12px; opacity: 0.85;">${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
            </div>
            <div style="background: #fef2f2; padding: 16px 24px; border: 1px solid #fca5a5; border-top: none; border-radius: 0 0 10px 10px; margin-bottom: 16px;">
                <p style="margin: 0; font-size: 13px; color: #7f1d1d;">${statusChangeAlerts.length} tracked bill${statusChangeAlerts.length > 1 ? 's have' : ' has'} a new LIMS status update.</p>
            </div>
            ${statusChangeAlerts.map(({ item, oldStatus, newStatus, activity, hearing }) => `
            <div style="${itemStyle}">
                <div style="font-size: 14px; font-weight: 600; color: #111827; margin-bottom: 8px;">
                    ${item.link ? `<a href="${item.link}" style="color: #4f46e5; text-decoration: none;">${item.title}</a>` : item.title}
                </div>
                <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 2px 8px 2px 0; color: #6b7280; white-space: nowrap;">Bill</td>
                        <td style="padding: 2px 0; color: #374151;">${item.bill_number || item.id}</td>
                        <td style="padding: 2px 8px 2px 16px; color: #6b7280;">Priority</td>
                        <td style="padding: 2px 0; color: #374151;">${item.priority || '—'}</td>
                    </tr>
                    <tr>
                        <td style="padding: 4px 8px 4px 0; color: #6b7280; white-space: nowrap; vertical-align: top;">Old Status</td>
                        <td style="padding: 4px 0; color: #6b7280; text-decoration: line-through;">${oldStatus}</td>
                        <td style="padding: 4px 8px 4px 16px; color: #6b7280; vertical-align: top;">Assigned</td>
                        <td style="padding: 4px 0; color: #374151;">${item.assigned_to || 'Unassigned'}</td>
                    </tr>
                    <tr>
                        <td style="padding: 2px 8px 2px 0; color: #dc2626; font-weight: 600; white-space: nowrap;">New Status</td>
                        <td style="padding: 2px 0; color: #dc2626; font-weight: 600;">${newStatus}</td>
                        <td></td><td></td>
                    </tr>
                    ${activity ? `<tr><td style="padding: 4px 8px 2px 0; color: #6b7280; white-space: nowrap;">Last Activity</td><td colspan="3" style="padding: 4px 0; color: #374151;">${activity.label} — ${formatDate(activity.dateIso)}</td></tr>` : ''}
                    ${hearing ? `<tr><td style="padding: 4px 8px 2px 0; color: #d97706; font-weight: 600;">📅 Hearing</td><td colspan="3" style="padding: 4px 0; color: #d97706; font-weight: 600;">${formatDate(hearing.date.toISOString())}</td></tr>` : ''}
                </table>
            </div>`).join('')}
            <div style="margin-top: 24px; text-align: center; font-size: 11px; color: #9ca3af;">
                DC Policy Tracker · <a href="https://dcpca-policy-tracker.vercel.app" style="color: #9ca3af;">Open Tracker</a>
            </div>
        </body></html>`;

        await sendEmail(
            `🔔 DC Policy Tracker — ${statusChangeAlerts.length} Status Change${statusChangeAlerts.length > 1 ? 's' : ''} Detected`,
            alertHtml
        );
    }

    // ── 4. Keyword search for new bills ──────────────────────────────────────

    if (keywords.length > 0) {
        const existingIds = new Set(trackedItems.map(i => i.id));
        // Load already-alerted bill+keyword combos to avoid duplicate alerts
        const alertLog = await sbGet('/keyword_alert_log?select=bill_number,keyword');
        const alreadyAlerted = new Set(alertLog.map(r => `${r.bill_number}::${r.keyword}`));

        const newMatches = []; // { keyword, bill }

        for (const keyword of keywords) {
            try {
                const searchResults = await limsPost('/SearchLegislation', {
                    Keyword: keyword, CategoryId: 0,
                    CouncilPeriodId: COUNCIL_PERIOD, RowLimit: 20, OffSet: 0
                });

                if (Array.isArray(searchResults)) {
                    for (const bill of searchResults) {
                        const billNum = bill.legislationNumber;
                        if (!billNum) continue;
                        const key = `${billNum}::${keyword}`;
                        if (!existingIds.has(billNum) && !alreadyAlerted.has(key)) {
                            newMatches.push({ keyword, bill });
                            // Log so we don't alert again
                            await sbInsert('keyword_alert_log', {
                                bill_number: billNum,
                                keyword: keyword,
                                alerted_at: now.toISOString()
                            });
                        }
                    }
                }
            } catch (err) {
                console.error(`[check-hearings] Keyword search "${keyword}":`, err.message);
            }
            await delay(1000);
        }

        if (newMatches.length > 0) {
            results.newKeywordMatches = newMatches.map(m => ({ keyword: m.keyword, bill: m.bill.legislationNumber, title: m.bill.title }));

            // Group by keyword for readability
            const byKeyword = {};
            newMatches.forEach(({ keyword, bill }) => {
                if (!byKeyword[keyword]) byKeyword[keyword] = [];
                byKeyword[keyword].push(bill);
            });

            const kwItemStyle = 'margin: 8px 0; padding: 10px 12px; border-radius: 6px; background: white; border: 1px solid #c7d2fe;';
            const kwHtml = `
            <!DOCTYPE html><html><head><meta charset="utf-8"></head>
            <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; background: #f9fafb;">
                <div style="background: #4f46e5; color: white; padding: 16px 24px; border-radius: 10px 10px 0 0;">
                    <h1 style="margin: 0; font-size: 18px;">🔍 DC Policy Tracker — New Keyword Matches</h1>
                    <p style="margin: 4px 0 0; font-size: 12px; opacity: 0.85;">${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
                </div>
                <div style="background: #eef2ff; padding: 16px 24px; border: 1px solid #c7d2fe; border-top: none; border-radius: 0 0 10px 10px; margin-bottom: 16px;">
                    <p style="margin: 0; font-size: 13px; color: #3730a3;">${newMatches.length} new bill${newMatches.length > 1 ? 's match' : ' matches'} your tracked keywords. These are not yet in your tracker.</p>
                </div>
                ${Object.entries(byKeyword).map(([kw, bills]) => `
                <div style="margin-bottom: 20px;">
                    <h3 style="margin: 0 0 8px; font-size: 13px; color: #4f46e5; text-transform: uppercase; letter-spacing: 0.05em;">Keyword: "${kw}"</h3>
                    ${bills.map(bill => `
                    <div style="${kwItemStyle}">
                        <div style="font-size: 13px; font-weight: 600; color: #111827; margin-bottom: 4px;">
                            <a href="https://lims.dccouncil.gov/Legislation/${bill.legislationNumber}" style="color: #4f46e5; text-decoration: none;">${bill.title || bill.legislationNumber}</a>
                        </div>
                        <div style="font-size: 11px; color: #6b7280;">
                            ${bill.legislationNumber}
                            ${bill.status ? ` · ${bill.status}` : ''}
                            ${bill.introductionDate ? ` · Introduced ${new Date(bill.introductionDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
                            ${bill.referredToCommittees && bill.referredToCommittees !== 'null' ? ` · ${bill.referredToCommittees}` : ''}
                        </div>
                    </div>`).join('')}
                </div>`).join('')}
                <div style="margin-top: 24px; text-align: center; font-size: 11px; color: #9ca3af;">
                    <a href="https://dcpca-policy-tracker.vercel.app" style="color: #4f46e5; font-weight: 600;">Open Tracker to add these bills →</a>
                </div>
            </body></html>`;

            await sendEmail(
                `🔍 DC Policy Tracker — ${newMatches.length} New Keyword Match${newMatches.length > 1 ? 'es' : ''}`,
                kwHtml
            );
        }
    }

    console.log(`[check-hearings] Done: ${results.checked} checked, ${results.statusChanges.length} status changes, ${results.newKeywordMatches.length} new keyword matches`);
    return res.status(200).json(results);
}
