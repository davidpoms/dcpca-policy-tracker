/**
 * /api/send-eod-report.js
 *
 * Sends an end-of-day summary — only if there were updates today.
 * Runs Mon-Fri at 5pm ET (22:00 UTC).
 */

import nodemailer from 'nodemailer';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GMAIL_USER           = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD   = process.env.GMAIL_APP_PASSWORD;
const DAILY_REPORT_TO      = process.env.DAILY_REPORT_TO;
const CRON_SECRET          = process.env.CRON_SECRET;

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

export default async function handler(req, res) {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const isManual = CRON_SECRET && req.headers['authorization'] === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !DAILY_REPORT_TO) {
        return res.status(500).json({ error: 'Missing email config', vars: { GMAIL_USER: !!GMAIL_USER, GMAIL_APP_PASSWORD: !!GMAIL_APP_PASSWORD, DAILY_REPORT_TO: !!DAILY_REPORT_TO } });
    }

    try {

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    const todaysHistory = await supabaseGet(
        `/bill_status_history?changed_at=gte.${encodeURIComponent(todayStart)}&order=changed_at.desc`
    );

    const newlyTracked = await supabaseGet(
        `/tracked_items?tracked_at=gte.${encodeURIComponent(todayStart)}&order=tracked_at.desc`
    );

    if (todaysHistory.length === 0 && newlyTracked.length === 0) {
        console.log('[send-eod-report] No updates today — skipping email');
        return res.status(200).json({ sent: false, reason: 'no_updates' });
    }

    const changedItemIds = [...new Set(todaysHistory.map(h => h.item_id))];
    const allItems = await supabaseGet('/tracked_items?select=*');
    const notes = await supabaseGet('/item_notes?select=*');
    const notesMap = {};
    notes.forEach(n => { notesMap[n.item_id] = n.note_text; });

    const todayStartDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const historyByItem = {};
    todaysHistory.forEach(h => {
        if (!historyByItem[h.item_id]) historyByItem[h.item_id] = [];
        historyByItem[h.item_id].push(h);
    });

    const changedItems = changedItemIds
        .map(id => allItems.find(i => i.id === id))
        .filter(Boolean);

    const itemStyle = 'margin: 12px 0; padding: 12px; border-radius: 6px; background: white; border: 1px solid #e5e7eb;';

    const renderChangedItem = (item) => {
        const entries = historyByItem[item.id] || [];
        const hasHearing = item.next_hearing_date && new Date(item.next_hearing_date) >= todayStartDate;
        const note = notesMap[item.id];
        return `
        <div style="${itemStyle}">
            <div style="font-size: 14px; font-weight: 600; color: #111827; margin-bottom: 8px;">
                ${item.link ? `<a href="${item.link}" style="color: #4f46e5; text-decoration: none;">${item.title}</a>` : item.title}
            </div>
            <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
                <tr>
                    <td style="padding: 2px 8px 2px 0; color: #6b7280; white-space: nowrap;">Bill</td>
                    <td style="padding: 2px 0; color: #374151;">${item.bill_number || item.id}</td>
                    <td style="padding: 2px 8px 2px 16px; color: #6b7280;">Status</td>
                    <td style="padding: 2px 0; color: #374151;">${item.status || '—'}</td>
                </tr>
                <tr>
                    <td style="padding: 2px 8px 2px 0; color: #6b7280;">${item.is_manual_entry ? 'Agency' : 'Committee'}</td>
                    <td colspan="3" style="padding: 2px 0; color: #374151;">${item.is_manual_entry ? (item.agency || '—') : (item.committees && item.committees.length > 0 ? (Array.isArray(item.committees) ? item.committees.join(', ') : item.committees) : '—')}</td>
                </tr>
                ${entries.map(h => {
                    const isHearing = h.change_label && h.change_label.startsWith('Hearing Scheduled');
                    return `<tr>
                        <td style="padding: 4px 8px 2px 0; color: ${isHearing ? '#d97706' : '#dc2626'}; font-weight: 600; white-space: nowrap; vertical-align: top;">
                            ${isHearing ? '📅 New Hearing' : '🔔 Status Change'}
                        </td>
                        <td colspan="3" style="padding: 4px 0; color: ${isHearing ? '#d97706' : '#374151'}; ${isHearing ? 'font-weight: 600;' : ''}">
                            ${isHearing ? h.change_label.replace('Hearing Scheduled: ', '') : `${h.old_status} &rarr; <strong>${h.new_status}</strong>`}
                        </td>
                    </tr>`;
                }).join('')}
                ${hasHearing ? `<tr><td style="padding: 4px 8px 2px 0; color: #d97706;">📅 Upcoming</td><td colspan="3" style="padding: 4px 0; color: #d97706;">${formatDate(item.next_hearing_date)}${item.hearing_location ? ' — ' + item.hearing_location : ''}</td></tr>` : ''}
                ${note ? `<tr><td style="padding: 4px 8px 2px 0; color: #6b7280; vertical-align: top;">Note</td><td colspan="3" style="padding: 4px 0; color: #374151; font-style: italic;">${note}</td></tr>` : ''}
            </table>
        </div>`;
    };

    const statusChanges = changedItems.filter(item =>
        (historyByItem[item.id] || []).some(h => !h.change_label || !h.change_label.startsWith('Hearing Scheduled'))
    );
    const hearingChanges = changedItems.filter(item =>
        (historyByItem[item.id] || []).some(h => h.change_label && h.change_label.startsWith('Hearing Scheduled'))
    );

    const allItems = await supabaseGet('/tracked_items?select=action_status,next_hearing_date,latest_activity_date,tracked_at,is_manual_entry');
    const actionNeeded = allItems.filter(i => i.action_status === 'action_needed');
    const monitorAndAssess = allItems.filter(i => i.action_status === 'monitor_and_assess');
    const withHearings = allItems.filter(i => i.next_hearing_date && new Date(i.next_hearing_date) >= todayStartDate);
    const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentlyUpdated = allItems.filter(i => {
        const actDate = i.latest_activity_date ? new Date(i.latest_activity_date) : null;
        const addedDate = i.is_manual_entry && i.tracked_at ? new Date(i.tracked_at) : null;
        return (actDate && actDate >= sevenDaysAgo) || (addedDate && addedDate >= sevenDaysAgo);
    });
    const updatesToday = changedItems.length + newlyTracked.length;

    const itemStyleNew = 'margin: 12px 0; padding: 12px; border-radius: 6px; background: white; border: 1px solid #a5b4fc;';
    const renderNewItem = (item) => {
        const note = notesMap[item.id];
        const hasHearing = item.next_hearing_date && new Date(item.next_hearing_date) >= todayStartDate;
        return `
        <div style="${itemStyleNew}">
            <div style="font-size: 14px; font-weight: 600; color: #111827; margin-bottom: 8px;">
                ${item.link ? `<a href="${item.link}" style="color: #4f46e5; text-decoration: none;">${item.title}</a>` : item.title}
            </div>
            <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
                <tr>
                    <td style="padding: 2px 8px 2px 0; color: #6b7280; white-space: nowrap;">Bill</td>
                    <td style="padding: 2px 0; color: #374151;">${item.bill_number || item.id}</td>
                    <td style="padding: 2px 8px 2px 16px; color: #6b7280;">Status</td>
                    <td style="padding: 2px 0; color: #374151;">${item.status || '—'}</td>
                </tr>
                <tr>
                    <td style="padding: 2px 8px 2px 0; color: #6b7280;">Category</td>
                    <td style="padding: 2px 0; color: #374151;">${item.category || '—'}</td>
                    <td style="padding: 2px 8px 2px 16px; color: #6b7280;">Priority</td>
                    <td style="padding: 2px 0; color: #374151;">${item.priority || '—'}</td>
                </tr>
                <tr>
                    <td style="padding: 2px 8px 2px 0; color: #6b7280;">${item.is_manual_entry ? 'Agency' : 'Committee'}</td>
                    <td colspan="3" style="padding: 2px 0; color: #374151;">${item.is_manual_entry ? (item.agency || '—') : (item.committees && item.committees.length > 0 ? (Array.isArray(item.committees) ? item.committees.join(', ') : item.committees) : '—')}</td>
                </tr>
                ${item.introduced_by ? `<tr><td style="padding: 2px 8px 2px 0; color: #6b7280;">Sponsor</td><td colspan="3" style="padding: 2px 0; color: #374151;">${item.introduced_by}</td></tr>` : ''}
                ${hasHearing ? `<tr><td style="padding: 4px 8px 2px 0; color: #d97706; font-weight: 600;">📅 Hearing</td><td colspan="3" style="padding: 4px 0; color: #d97706; font-weight: 600;">${formatDate(item.next_hearing_date)}</td></tr>` : ''}
                ${note ? `<tr><td style="padding: 4px 8px 2px 0; color: #6b7280; vertical-align: top;">Note</td><td colspan="3" style="padding: 4px 0; color: #374151; font-style: italic;">${note}</td></tr>` : ''}
            </table>
        </div>`;
    };

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 700px; margin: 0 auto; padding: 24px; background: #f9fafb; color: #111827;">
    <div style="background: #1e3a5f; color: white; padding: 20px 24px; border-radius: 10px 10px 0 0;">
        <h1 style="margin: 0; font-size: 20px; font-weight: 700;">DC Policy Tracker</h1>
        <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.85;">End-of-Day Update &middot; ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
    </div>
    <div style="background: white; padding: 16px 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px; margin-bottom: 24px;">
        <table style="width: 100%; text-align: center; border-collapse: collapse;">
            <tr>
                <td style="padding: 8px; border-right: 1px solid #e5e7eb;">
                    <div style="font-size: 28px; font-weight: 700; color: #854d0e;">${updatesToday}</div>
                    <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Updates Since Yesterday</div>
                </td>
                <td style="padding: 8px; border-right: 1px solid #e5e7eb;">
                    <div style="font-size: 28px; font-weight: 700; color: #d97706;">${withHearings.length}</div>
                    <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Upcoming Hearings</div>
                </td>
                <td style="padding: 8px; border-right: 1px solid #e5e7eb;">
                    <div style="font-size: 28px; font-weight: 700; color: #16a34a;">${recentlyUpdated.length}</div>
                    <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Updates Last 7 Days</div>
                </td>
                <td style="padding: 8px; border-right: 1px solid #e5e7eb;">
                    <div style="font-size: 28px; font-weight: 700; color: #dc2626;">${actionNeeded.length}</div>
                    <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Action Needed</div>
                </td>
                <td style="padding: 8px;">
                    <div style="font-size: 28px; font-weight: 700; color: #2563eb;">${monitorAndAssess.length}</div>
                    <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Monitor & Assess</div>
                </td>
            </tr>
        </table>
    </div>

    ${statusChanges.length > 0 ? `
    <div style="margin-bottom: 24px; padding: 16px; background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px;">
        <h2 style="margin: 0 0 12px; font-size: 15px; color: #991b1b;">🔔 Status Changes (${statusChanges.length})</h2>
        ${statusChanges.map(item => renderChangedItem(item)).join('')}
    </div>` : ''}

    ${hearingChanges.length > 0 ? `
    <div style="margin-bottom: 24px; padding: 16px; background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px;">
        <h2 style="margin: 0 0 12px; font-size: 15px; color: #92400e;">📅 New Hearings Scheduled (${hearingChanges.length})</h2>
        ${hearingChanges.map(item => renderChangedItem(item)).join('')}
    </div>` : ''}

    ${newlyTracked.length > 0 ? `
    <div style="margin-bottom: 24px; padding: 16px; background: #eef2ff; border: 1px solid #a5b4fc; border-radius: 8px;">
        <h2 style="margin: 0 0 12px; font-size: 15px; color: #3730a3;">➕ Newly Tracked Today (${newlyTracked.length})</h2>
        ${newlyTracked.map(item => renderNewItem(item)).join('')}
    </div>` : ''}

    <div style="margin-top: 24px; padding: 12px; text-align: center; font-size: 11px; color: #9ca3af;">
        DC Policy Tracker &middot; <a href="https://dcpca-policy-tracker.vercel.app" style="color: #9ca3af;">Open Tracker</a>
    </div>
</body>
</html>`;

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
    });

    const toAddresses = DAILY_REPORT_TO.split(',').map(e => e.trim()).filter(Boolean);
    await transporter.sendMail({
        from: `"DC Policy Tracker" <${GMAIL_USER}>`,
        to: toAddresses.join(', '),
        subject: `📋 DC Policy EOD — ${statusChanges.length} status change${statusChanges.length !== 1 ? 's' : ''}, ${hearingChanges.length} new hearing${hearingChanges.length !== 1 ? 's' : ''}, ${newlyTracked.length} newly tracked · ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
        html
    });

    console.log(`[send-eod-report] Sent — ${statusChanges.length} status changes, ${hearingChanges.length} new hearings`);
    return res.status(200).json({ sent: true, statusChanges: statusChanges.length, hearingChanges: hearingChanges.length });

    } catch (err) {
        console.error('[send-eod-report] Fatal error:', err);
        return res.status(500).json({ error: err.message, stack: err.stack });
    }
}
