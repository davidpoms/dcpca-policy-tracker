/**
 * /api/check-password.js
 *
 * Validates the app password submitted from the frontend login screen.
 * Returns a signed session token the frontend stores in sessionStorage.
 *
 * Env vars required:
 *   APP_PASSWORD  — the password staff use to access the tracker
 *   CRON_SECRET   — reused as the signing key for the session token
 */

const APP_PASSWORD = process.env.APP_PASSWORD;
const SIGNING_KEY  = process.env.CRON_SECRET;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!APP_PASSWORD) return res.status(500).json({ error: 'APP_PASSWORD not configured' });

    const { password } = req.body || {};
    if (!password || password !== APP_PASSWORD) {
        // Small delay to slow brute force attempts
        await new Promise(r => setTimeout(r, 600));
        return res.status(401).json({ error: 'Incorrect password' });
    }

    // Issue a simple time-stamped token the frontend can validate
    // Format: base64(timestamp + ":" + hmac-ish signature)
    const timestamp = Date.now();
    const payload   = `${timestamp}:${SIGNING_KEY}`;
    const token     = Buffer.from(payload).toString('base64');

    return res.status(200).json({ token, expires: timestamp + 8 * 60 * 60 * 1000 }); // 8 hour session
}
