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

    const items = await supabaseGet('/tracked_items?select=*&order=tracked_at.desc');
    const notes = await supabaseGet('/item_notes?select=*');

    const notesMap = {};
    notes.forEach(n => { notesMap[n.item_id] = n.note_text; });

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // midnight local time

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
                    <td style="padding: 2px 8px 2px 16px; color: #6b7280;">Assigned</td>
                    <td style="padding: 2px 0; color: #374151;">${item.assigned_to || 'Unassigned'}</td>
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
                    <td style="padding: 8px;">
                        <div style="font-size: 28px; font-weight: 700; color: #16a34a;">${completed.length}</div>
                        <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Completed</div>
                    </td>
                </tr>
            </table>
        </div>

        ${withHearings.length > 0 ? `
        <div style="${sectionStyle} background: #fffbeb; border: 1px solid #fcd34d;">
            <h2 style="margin: 0 0 12px; font-size: 15px; color: #92400e;">📅 Upcoming Hearings</h2>
            ${withHearings.map(item => renderItem(item, false)).join('')}
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

        ${completed.length > 0 ? `
        <div style="${sectionStyle} background: #f0fdf4; border: 1px solid #86efac;">
            <h2 style="margin: 0 0 12px; font-size: 15px; color: #166534;">✅ Action Completed (${completed.length})</h2>
            ${completed.map(item => renderItem(item)).join('')}
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
        subject: `DC Policy Tracker · ${actionNeeded.length} action needed · ${withHearings.length} upcoming hearings · ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
        html
    });

    console.log(`[daily-report] Sent to ${DAILY_REPORT_TO}`);
    return res.status(200).json({ sent: true, to: DAILY_REPORT_TO });
}
