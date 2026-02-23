/**
 * /api/send-weekly-report.js
 *
 * Sends a clean weekly summary to a broader group.
 * Runs every Monday at 9am ET.
 * Less internal detail than the daily — no notes, no per-item priority.
 *
 * Env vars required:
 *   RESEND_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   WEEKLY_REPORT_TO   — comma-separated list: "alice@org.com,bob@org.com"
 *   CRON_SECRET
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const WEEKLY_REPORT_TO = process.env.WEEKLY_REPORT_TO; // comma-separated
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
    return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default async function handler(req, res) {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const isManual = CRON_SECRET && req.headers['authorization'] === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });
    if (!RESEND_API_KEY || !WEEKLY_REPORT_TO) return res.status(500).json({ error: 'Missing RESEND_API_KEY or WEEKLY_REPORT_TO' });

    const items = await supabaseGet('/tracked_items?select=*&order=tracked_at.desc');
    const now = new Date();

    const actionNeeded = items.filter(i => i.action_status === 'action_needed');
    const monitorAndAssess = items.filter(i => i.action_status === 'monitor_and_assess');
    const withHearings = items
        .filter(i => i.next_hearing_date && new Date(i.next_hearing_date) > now)
        .sort((a, b) => new Date(a.next_hearing_date) - new Date(b.next_hearing_date));

    // Week range label
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1); // Monday
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const weekLabel = `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    const rowStyle = 'padding: 10px 12px; border-bottom: 1px solid #f3f4f6; font-size: 13px;';
    const thStyle = 'padding: 8px 12px; background: #f9fafb; font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; text-align: left;';

    const renderTable = (sectionItems, showHearing = true) => {
        if (sectionItems.length === 0) return '<p style="font-size: 13px; color: #6b7280; padding: 8px 0;">None this week.</p>';
        return `
        <table style="width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
            <thead>
                <tr>
                    <th style="${thStyle}">Bill / Title</th>
                    <th style="${thStyle}">Status</th>
                    <th style="${thStyle}">Assigned To</th>
                    ${showHearing ? `<th style="${thStyle}">Hearing</th>` : ''}
                </tr>
            </thead>
            <tbody>
                ${sectionItems.map((item, idx) => {
                    const hearing = item.next_hearing_date && new Date(item.next_hearing_date) > now;
                    return `
                    <tr style="background: ${idx % 2 === 0 ? 'white' : '#fafafa'}">
                        <td style="${rowStyle}">
                            ${item.link ? `<a href="${item.link}" style="color: #4f46e5; font-weight: 500; text-decoration: none;">${item.bill_number || item.id}</a>` : (item.bill_number || item.id)}
                            <div style="font-size: 12px; color: #374151; margin-top: 2px;">${item.title}</div>
                        </td>
                        <td style="${rowStyle} color: #374151;">${item.status || '—'}</td>
                        <td style="${rowStyle} color: #374151;">${item.assigned_to || 'Unassigned'}</td>
                        ${showHearing ? `<td style="${rowStyle} ${hearing ? 'color: #d97706; font-weight: 600;' : 'color: #9ca3af;'}">${hearing ? `📅 ${formatDate(item.next_hearing_date)}` : '—'}</td>` : ''}
                    </tr>`;
                }).join('')}
            </tbody>
        </table>`;
    };

    const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 750px; margin: 0 auto; padding: 24px; background: #f9fafb; color: #111827;">

        <div style="background: #1e3a5f; color: white; padding: 20px 24px; border-radius: 10px; margin-bottom: 24px;">
            <h1 style="margin: 0; font-size: 20px; font-weight: 700;">DC Policy Weekly Update</h1>
            <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.8;">Week of ${weekLabel}</p>
        </div>

        <div style="display: flex; gap: 12px; margin-bottom: 24px;">
            ${[
                ['Action Needed', actionNeeded.length, '#dc2626', '#fef2f2'],
                ['Monitor & Assess', monitorAndAssess.length, '#2563eb', '#eff6ff'],
                ['Upcoming Hearings', withHearings.length, '#d97706', '#fffbeb'],
                ['Total Tracked', items.length, '#374151', '#f3f4f6']
            ].map(([label, count, color, bg]) => `
            <div style="flex: 1; padding: 16px; background: ${bg}; border-radius: 8px; text-align: center;">
                <div style="font-size: 28px; font-weight: 700; color: ${color};">${count}</div>
                <div style="font-size: 11px; color: #6b7280; margin-top: 2px;">${label}</div>
            </div>`).join('')}
        </div>

        ${withHearings.length > 0 ? `
        <div style="margin-bottom: 24px;">
            <h2 style="font-size: 15px; font-weight: 700; color: #92400e; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 2px solid #fcd34d;">📅 Upcoming Hearings</h2>
            ${renderTable(withHearings, false)}
        </div>` : ''}

        ${actionNeeded.length > 0 ? `
        <div style="margin-bottom: 24px;">
            <h2 style="font-size: 15px; font-weight: 700; color: #991b1b; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 2px solid #fca5a5;">Action Needed</h2>
            ${renderTable(actionNeeded)}
        </div>` : ''}

        ${monitorAndAssess.length > 0 ? `
        <div style="margin-bottom: 24px;">
            <h2 style="font-size: 15px; font-weight: 700; color: #1e40af; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 2px solid #93c5fd;">Monitor & Assess</h2>
            ${renderTable(monitorAndAssess)}
        </div>` : ''}

        <div style="margin-top: 32px; padding: 16px; background: #f3f4f6; border-radius: 8px; font-size: 12px; color: #6b7280; text-align: center;">
            This is an automated weekly summary from DC Policy Tracker.<br>
            For full details including notes and history, <a href="https://dcpca-policy-tracker.vercel.app" style="color: #4f46e5;">open the tracker</a>.
        </div>
    </body>
    </html>`;

    const toAddresses = WEEKLY_REPORT_TO.split(',').map(e => e.trim()).filter(Boolean);

    const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: 'DC Policy Tracker <onboarding@resend.dev>', 
            to: toAddresses,
            subject: `DC Policy Weekly · ${actionNeeded.length} action needed · ${withHearings.length} upcoming hearings · ${weekLabel}`,
            html
        })
    });

    if (!emailRes.ok) {
        const err = await emailRes.text();
        console.error('Resend error:', err);
        return res.status(500).json({ error: 'Email send failed', detail: err });
    }

    const result = await emailRes.json();
    console.log(`[weekly-report] Sent to ${toAddresses.join(', ')}, id: ${result.id}`);
    return res.status(200).json({ sent: true, to: toAddresses, id: result.id });
}
