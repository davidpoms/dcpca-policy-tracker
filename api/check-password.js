/**
 * /api/check-password.js
 *
 * Validates the app password submitted from the frontend login screen.
 * Issues a signed HttpOnly cookie-backed session for the browser.
 *
 * Env vars required:
 *   APP_PASSWORD   — the password staff use to access the tracker
 *   SESSION_SECRET  — server-side secret used to sign the cookie contents
 */

import { createSignedSession, buildSessionCookie, SESSION_MAX_MS } from './_session.js';

const APP_PASSWORD = process.env.APP_PASSWORD;

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!APP_PASSWORD) return res.status(500).json({ error: 'APP_PASSWORD not configured' });

    const { password } = req.body || {};
    if (!password || password !== APP_PASSWORD) {
        // Small delay to slow brute force attempts
        await new Promise(r => setTimeout(r, 600));
        return res.status(401).json({ error: 'Incorrect password' });
    }

    if (!process.env.SESSION_SECRET) {
        return res.status(500).json({ error: 'Session configuration unavailable' });
    }

    try {
        const expires = Date.now() + SESSION_MAX_MS;
        const signedSession = createSignedSession(expires);
        const cookie = buildSessionCookie(signedSession, Math.floor(SESSION_MAX_MS / 1000));

        res.setHeader('Set-Cookie', cookie);
        return res.status(200).json({ expires });
    } catch (error) {
        return res.status(500).json({ error: 'Authentication service unavailable' });
    }
}
