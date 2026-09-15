import { clearSessionCookie } from './_session.js';

export default function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    res.setHeader('Set-Cookie', clearSessionCookie());
    return res.status(200).json({ ok: true });
}
