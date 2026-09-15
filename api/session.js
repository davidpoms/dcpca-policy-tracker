import { getSessionCookieValue, validateSignedSession } from '../lib/session.js';

export default function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!process.env.SESSION_SECRET) {
        return res.status(500).json({ error: 'Session configuration unavailable' });
    }

    try {
        const rawValue = getSessionCookieValue(req);
        const result = validateSignedSession(rawValue);

        if (!result.valid) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        return res.status(200).json({
            valid: true,
            expires: result.expires
        });
    } catch (error) {
        return res.status(500).json({ error: 'Authentication service unavailable' });
    }
}
