/**
 * /api/send-daily-report.js
 *
 * Sends a detailed daily status email via Gmail SMTP.
 * Runs Mon–Fri at 8:30am ET (13:30 UTC).
 *
 * Env vars required:
 *   GMAIL_USER          — your Gmail address
 *   GMAIL_APP_PASSWORD  — 16-char app password from myaccount.google.com/apppasswords
 *   DAILY_REPORT_TO     — recipient email (can be same as GMAIL_USER)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   CRON_SECRET
 */

import nodemailer from 'nodemailer';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const DAILY_REPORT_TO = process.env.DAILY_REPORT_TO;
const CRON_SECRET = process.env.CRON_SECRET;

async function supabaseGet(path) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
        headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json'
        }
    });
    if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
    return res.json();
}

function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatChangeLabel(h) {
    if (h.change_label && h.change_label !== 'Backfill — status at time of migration') return h.change_label;
    if (h.old_status && h.new_status && h.old_status !== h.new_status) return `${h.old_status} → ${h.new_status}`;
    if (h.new_status) return h.new_status;
    return '(updated)';
}

function priorityEmoji(p) {
    return { high: '🔴', medium: '🟡', low: '🟢' }[p] || '⚪';
}

export default async function handler(req, res) {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const isManual = CRON_SECRET && req.headers['authorization'] === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !DAILY_REPORT_TO) {
        return res.status(500).json({ error: 'Missing GMAIL_USER, GMAIL_APP_PASSWORD, or DAILY_REPORT_TO' });
    }

    try {
    const items = await supabaseGet('/tracked_items?select=*&order=tracked_at.desc');
    const notes = await supabaseGet('/item_notes?select=*');
    let statusHistory = [];
    try {
        statusHistory = await supabaseGet('/bill_status_history?select=*&order=changed_at.desc');
    } catch (err) {
        console.warn('[daily-report] Could not load bill_status_history:', err.message);
    }

    const notesMap = {};
    notes.forEach(n => { notesMap[n.item_id] = n.note_text; });

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(now.getDate() - 7);

    // Recent updates: LIMS activity in last 7 days OR manually added in last 7 days
    const recentlyUpdated = items.filter(i => {
        const actDate = i.latest_activity_date ? new Date(i.latest_activity_date) : null;
        const addedDate = i.tracked_at ? new Date(i.tracked_at) : null;
        return (actDate && actDate >= sevenDaysAgo) || (i.is_manual_entry && addedDate && addedDate >= sevenDaysAgo);
    }).sort((a, b) => {
        const da = new Date(a.latest_activity_date || a.tracked_at || 0);
        const db = new Date(b.latest_activity_date || b.tracked_at || 0);
        return db - da;
    });

    // Build status history map per item
    const historyMap = {};
    statusHistory.forEach(h => {
        if (!historyMap[h.item_id]) historyMap[h.item_id] = [];
        historyMap[h.item_id].push(h);
    });

    // Changes since yesterday's 8:30am run
    const sinceLastRun = new Date(now);
    sinceLastRun.setDate(sinceLastRun.getDate() - 1);
    sinceLastRun.setHours(13, 30, 0, 0); // 8:30am ET = 13:30 UTC
    const recentChanges = statusHistory.filter(h => new Date(h.changed_at) >= sinceLastRun && h.change_label !== 'Backfill — status at time of migration');
    const newlyTracked = items.filter(i => i.tracked_at && new Date(i.tracked_at) >= sinceLastRun);
    const recentChangeItemIds = [...new Set(recentChanges.map(h => h.item_id))];
    // Exclude newly tracked items from change list to avoid double-showing
    const newlyTrackedIds = new Set(newlyTracked.map(i => i.id));
    const changesSinceLastRun = recentChanges.filter(h => !newlyTrackedIds.has(h.item_id)).length + newlyTracked.length;

    const highlightBlock = changesSinceLastRun > 0 ? (() => {
        const changedItems = recentChangeItemIds
            .filter(id => !newlyTrackedIds.has(id))
            .map(id => items.find(i => i.id === id)).filter(Boolean);
        const rows = [
            ...newlyTracked.map(item => {
                const billLink = item.link
                    ? `<a href="${item.link}" style="color:#4f46e5;text-decoration:none;">${item.bill_number || item.id}</a>`
                    : (item.bill_number || item.id);
                return `<tr style="border-bottom:1px solid #fde047;">
                    <td style="padding:6px 8px 6px 0;color:#4f46e5;font-weight:500;white-space:nowrap;">${billLink}</td>
                    <td style="padding:6px 8px;color:#374151;font-size:11px;">${item.title}</td>
                    <td style="padding:6px 0;color:#16a34a;font-size:11px;white-space:nowrap;">➕ Newly tracked</td>
                </tr>`;
            }),
            ...changedItems.map(item => {
                const changes = recentChanges.filter(h => h.item_id === item.id);
                const billLink = item.link
                    ? `<a href="${item.link}" style="color:#4f46e5;text-decoration:none;">${item.bill_number || item.id}</a>`
                    : (item.bill_number || item.id);
                const changeLabels = changes.map(h => formatChangeLabel(h)).join('<br>');
                return `<tr style="border-bottom:1px solid #fde047;">
                    <td style="padding:6px 8px 6px 0;color:#4f46e5;font-weight:500;white-space:nowrap;">${billLink}</td>
                    <td style="padding:6px 8px;color:#374151;font-size:11px;">${item.title}</td>
                    <td style="padding:6px 0;color:#854d0e;font-size:11px;white-space:nowrap;">${changeLabels}</td>
                </tr>`;
            })
        ].join('');
        return `<div style="margin-bottom:24px;padding:16px;background:#fefce8;border:1px solid #fde047;border-radius:8px;">
            <h2 style="margin:0 0 12px;font-size:14px;font-weight:700;color:#854d0e;">⚡ ${changesSinceLastRun} update${changesSinceLastRun !== 1 ? 's' : ''} since yesterday</h2>
            <table style="width:100%;font-size:12px;border-collapse:collapse;">${rows}</table>
        </div>`;
    })() : '';
    const actionNeeded = items.filter(i => i.action_status === 'action_needed');
    const monitorAndAssess = items.filter(i => i.action_status === 'monitor_and_assess');
    const completed = items.filter(i => i.action_status === 'action_completed');
    const withHearings = items
        .filter(i => i.next_hearing_date && new Date(i.next_hearing_date) >= todayStart)
        .sort((a, b) => new Date(a.next_hearing_date) - new Date(b.next_hearing_date));

    const sectionStyle = 'margin: 24px 0; padding: 16px; border-radius: 8px;';
    const itemStyle = 'margin: 12px 0; padding: 12px; border-radius: 6px; background: white; border: 1px solid #e5e7eb;';

    const renderItem = (item, showHearing = true) => {
        const hearing = showHearing && item.next_hearing_date && new Date(item.next_hearing_date) >= todayStart;
        const note = notesMap[item.id];
        return `
        <div style="${itemStyle}">
            <div style="font-size: 14px; font-weight: 600; color: #111827; margin-bottom: 8px;">
                ${priorityEmoji(item.priority)}
                ${item.link ? `<a href="${item.link}" style="color: #4f46e5; text-decoration: none;">${item.title}</a>` : item.title}
            </div>
            <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
                <tr>
                    <td style="padding: 2px 8px 2px 0; color: #6b7280; white-space: nowrap;">Bill</td>
                    <td style="padding: 2px 0; color: #374151;">${item.bill_number || item.id}</td>
                    <td style="padding: 2px 8px 2px 16px; color: #6b7280; white-space: nowrap;">Category</td>
                    <td style="padding: 2px 0; color: #374151;">${item.category || '—'}</td>
                </tr>
                <tr>
                    <td style="padding: 2px 8px 2px 0; color: #6b7280;">Status</td>
                    <td style="padding: 2px 0; color: #374151;">${item.status || '—'}</td>
                    <td style="padding: 2px 8px 2px 16px; color: #6b7280;">Committee</td>
                    <td style="padding: 2px 0; color: #374151;">${item.committees && item.committees.length > 0 ? (Array.isArray(item.committees) ? item.committees.join(', ') : item.committees) : '—'}</td>
                </tr>
                ${item.introduced_by ? `<tr><td style="padding: 2px 8px 2px 0; color: #6b7280;">Sponsor</td><td colspan="3" style="padding: 2px 0; color: #374151;">${item.introduced_by}</td></tr>` : ''}
                ${item.latest_activity_date && item.latest_activity_label ? `<tr><td style="padding: 2px 8px 2px 0; color: #6b7280; white-space: nowrap;">Last Activity</td><td colspan="3" style="padding: 2px 0; color: #374151;">${item.latest_activity_label} &mdash; ${formatDate(item.latest_activity_date)}</td></tr>` : ''}
                ${hearing ? `<tr><td style="padding: 4px 8px 2px 0; color: #d97706; font-weight: 600;">📅 Hearing</td><td colspan="3" style="padding: 4px 0; color: #d97706; font-weight: 600;">${formatDate(item.next_hearing_date)}${item.hearing_location ? ' — ' + item.hearing_location : ''}</td></tr>` : ''}
                ${item.committee_re_referral && item.committee_re_referral.length > 0 ? `<tr><td style="padding: 4px 8px 2px 0; color: #c2410c; font-weight: 600;">🔁 Re-referred</td><td colspan="3" style="padding: 4px 0; color: #c2410c;">${item.committee_re_referral.map(r => `${Array.isArray(r.committeeName) ? r.committeeName.join(', ') : (r.committeeName || '')}${r.reReferralDate ? ' (' + new Date(r.reReferralDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ')' : ''}`).join('; ')}</td></tr>` : ''}
                ${note ? `<tr><td style="padding: 4px 8px 2px 0; color: #6b7280; vertical-align: top;">Note</td><td colspan="3" style="padding: 4px 0; color: #374151; font-style: italic;">${note}</td></tr>` : ''}
                ${item.additional_information || item.manual_summary ? `<tr><td style="padding: 4px 8px 2px 0; color: #6b7280; vertical-align: top;">Summary</td><td colspan="3" style="padding: 4px 0; color: #374151; font-size: 11px;">${(item.manual_summary || item.additional_information).substring(0, 400)}${(item.manual_summary || item.additional_information).length > 400 ? '…' : ''}</td></tr>` : ''}
            </table>
        </div>`;
    };

    const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 700px; margin: 0 auto; padding: 24px; background: #f9fafb; color: #111827;">
        <div style="background: #4f46e5; color: white; padding: 20px 24px; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 20px; font-weight: 700;">DC Policy Tracker</h1>
            <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.85;">Daily Status Report · ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
        </div>
        <div style="background: white; padding: 16px 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px; margin-bottom: 24px;">
            <table style="width: 100%; text-align: center; border-collapse: collapse;">
                <tr>
                    <td style="padding: 8px; border-right: 1px solid #e5e7eb;">
                        <div style="font-size: 28px; font-weight: 700; color: #dc2626;">${actionNeeded.length}</div>
                        <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Action Needed</div>
                    </td>
                    <td style="padding: 8px; border-right: 1px solid #e5e7eb;">
                        <div style="font-size: 28px; font-weight: 700; color: #2563eb;">${monitorAndAssess.length}</div>
                        <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Monitor & Assess</div>
                    </td>
                    <td style="padding: 8px; border-right: 1px solid #e5e7eb;">
                        <div style="font-size: 28px; font-weight: 700; color: #d97706;">${withHearings.length}</div>
                        <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Upcoming Hearings</div>
                    </td>
                    <td style="padding: 8px; border-right: 1px solid #e5e7eb;">
                        <div style="font-size: 28px; font-weight: 700; color: #16a34a;">${recentlyUpdated.length}</div>
                        <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Recent Updates</div>
                    </td>
                    <td style="padding: 8px;">
                        <div style="font-size: 28px; font-weight: 700; color: #374151;">${items.length}</div>
                        <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Total Tracked</div>
                    </td>
                </tr>
            </table>
        </div>

        ${highlightBlock}

        ${recentlyUpdated.length > 0 ? `
        <div style="${sectionStyle} background: #f0fdf4; border: 1px solid #86efac;">
            <h2 style="margin: 0 0 12px; font-size: 15px; color: #166534;">🆕 Recent Updates — Last 7 Days (${recentlyUpdated.length})</h2>
            ${recentlyUpdated.map(item => {
                const recentHistory = (historyMap[item.id] || []).filter(h => new Date(h.changed_at) >= sevenDaysAgo);
                // Find when the current status was first recorded in history
                const allHistory = (historyMap[item.id] || []).slice().sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));
                const statusSinceEntry = allHistory.find(h => h.new_status === item.status);
                const statusSince = statusSinceEntry
                    ? new Date(statusSinceEntry.changed_at)
                    : item.tracked_at
                        ? new Date(item.tracked_at)
                        : null;
                const statusSinceLabel = statusSince
                    ? statusSince.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + (statusSinceEntry ? '' : '*')
                    : '—';
                const note = notesMap[item.id];
                return `
                <div style="${itemStyle}">
                    <div style="font-size: 14px; font-weight: 600; color: #111827; margin-bottom: 8px;">
                        ${item.link ? `<a href="${item.link}" style="color: #4f46e5; text-decoration: none;">${item.title}</a>` : item.title}
                    </div>
                    <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
                        <tr>
                            <td style="padding: 2px 8px 2px 0; color: #6b7280;">Bill</td>
                            <td style="padding: 2px 0; color: #374151;">${item.bill_number || item.id}</td>
                            <td style="padding: 2px 8px 2px 16px; color: #6b7280;">Committee</td>
                            <td style="padding: 2px 0; color: #374151;">${item.committees && item.committees.length > 0 ? (Array.isArray(item.committees) ? item.committees.join(', ') : item.committees) : '—'}</td>
                        </tr>
                        <tr>
                            <td style="padding: 2px 8px 2px 0; color: #6b7280;">Status</td>
                            <td style="padding: 2px 0; color: #374151;">${item.status || '—'}</td>
                            <td style="padding: 2px 8px 2px 16px; color: #6b7280;">Since</td>
                            <td style="padding: 2px 0; color: #374151;">${statusSinceLabel}</td>
                        </tr>
                        ${item.latest_activity_label && item.latest_activity_date ? `<tr><td style="padding: 2px 8px 2px 0; color: #16a34a; font-weight: 600;">Latest</td><td colspan="3" style="padding: 2px 0; color: #16a34a; font-weight: 600;">${item.latest_activity_label} — ${formatDate(item.latest_activity_date)}</td></tr>` : ''}
                        ${recentHistory.length > 0 ? `<tr><td style="padding: 4px 8px 2px 0; color: #6b7280; vertical-align: top;">Changes</td><td colspan="3" style="padding: 4px 0; color: #374151; font-size: 11px;">${recentHistory.map(h => formatChangeLabel(h)).join('<br>')}</td></tr>` : ''}
                        ${note ? `<tr><td style="padding: 4px 8px 2px 0; color: #6b7280; vertical-align: top;">Note</td><td colspan="3" style="padding: 4px 0; color: #374151; font-style: italic;">${note}</td></tr>` : ''}
                        ${item.manual_summary ? `<tr><td style="padding: 4px 8px 2px 0; color: #6b7280; vertical-align: top;">Summary</td><td colspan="3" style="padding: 4px 0; color: #374151; font-size: 11px;">${item.manual_summary.substring(0, 400)}${item.manual_summary.length > 400 ? '…' : ''}</td></tr>` : ''}
                    </table>
                </div>`;
            }).join('')}
        </div>` : ''}

        ${withHearings.length > 0 ? `
        <div style="${sectionStyle} background: #fffbeb; border: 1px solid #fcd34d;">
            <h2 style="margin: 0 0 12px; font-size: 15px; color: #92400e;">📅 Upcoming Hearings</h2>
            ${withHearings.map(item => renderItem(item, true)).join('')}
        </div>` : ''}

        ${actionNeeded.length > 0 ? `
        <div style="${sectionStyle} background: #fef2f2; border: 1px solid #fca5a5;">
            <h2 style="margin: 0 0 12px; font-size: 15px; color: #991b1b;">🔴 Action Needed (${actionNeeded.length})</h2>
            ${actionNeeded.map(item => renderItem(item)).join('')}
        </div>` : ''}

        ${monitorAndAssess.length > 0 ? `
        <div style="${sectionStyle} background: #eff6ff; border: 1px solid #93c5fd;">
            <h2 style="margin: 0 0 12px; font-size: 15px; color: #1e40af;">🔵 Monitor & Assess (${monitorAndAssess.length})</h2>
            ${monitorAndAssess.map(item => renderItem(item)).join('')}
        </div>` : ''}

        <div style="margin-top: 24px; padding: 12px; text-align: center; font-size: 11px; color: #9ca3af;">
            DC Policy Tracker · <a href="https://dcpca-policy-tracker.vercel.app" style="color: #9ca3af;">Open Tracker</a>
        </div>
    </body>
    </html>`;

    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            user: GMAIL_USER,
            pass: GMAIL_APP_PASSWORD
        }
    });

    await transporter.sendMail({
        from: `DC Policy Tracker <${GMAIL_USER}>`,
        to: DAILY_REPORT_TO,
        subject: `DC Policy Tracker ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${changesSinceLastRun} update${changesSinceLastRun !== 1 ? 's' : ''} since yesterday · ${actionNeeded.length} action needed · ${withHearings.length} upcoming hearings`,
        html
    });

    console.log(`[daily-report] Sent to ${DAILY_REPORT_TO}`);
    return res.status(200).json({ sent: true, to: DAILY_REPORT_TO });

    } catch (err) {
        console.error('[daily-report] Fatal error:', err);
        return res.status(500).json({ error: err.message, stack: err.stack });
    }
}
