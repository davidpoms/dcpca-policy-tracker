import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'dc_tracker_session';
export const SESSION_MAX_MS = 8 * 60 * 60 * 1000;

function base64UrlEncode(value) {
    return Buffer.from(value)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, 'base64');
}

function getSessionSecret() {
    const secret = process.env.SESSION_SECRET;
    if (!secret) throw new Error('SESSION_SECRET not configured');
    return secret;
}

export function buildSessionCookie(sessionValue, maxAgeSeconds = Math.floor(SESSION_MAX_MS / 1000)) {
    const secureFlag = process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionValue)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secureFlag}`;
}

export function clearSessionCookie() {
    const secureFlag = process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureFlag}`;
}

export function createSignedSession(expiresAt = Date.now() + SESSION_MAX_MS) {
    const secret = getSessionSecret();
    const nonce = randomBytes(16).toString('hex');
    const payload = JSON.stringify({ exp: Number(expiresAt), n: nonce });
    const encodedPayload = base64UrlEncode(payload);
    const signature = createHmac('sha256', secret)
        .update(encodedPayload)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');

    return `${encodedPayload}.${signature}`;
}

export function validateSignedSession(rawValue, now = Date.now()) {
    if (typeof rawValue !== 'string' || !rawValue.trim()) {
        return { valid: false, reason: 'missing' };
    }

    const parts = rawValue.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return { valid: false, reason: 'malformed' };
    }

    const [encodedPayload, suppliedSignature] = parts;
    const secret = getSessionSecret();
    const expectedSignature = createHmac('sha256', secret)
        .update(encodedPayload)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');

    const expectedBuffer = Buffer.from(expectedSignature);
    const suppliedBuffer = Buffer.from(suppliedSignature);

    if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) {
        return { valid: false, reason: 'tampered' };
    }

    try {
        const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
        if (!payload || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || typeof payload.n !== 'string' || !payload.n) {
            return { valid: false, reason: 'malformed' };
        }

        if (payload.exp <= now) {
            return { valid: false, reason: 'expired' };
        }

        return { valid: true, expires: payload.exp };
    } catch {
        return { valid: false, reason: 'malformed' };
    }
}

export function getSessionCookieValue(req) {
    const cookieHeader = req?.headers?.cookie || '';
    if (!cookieHeader) return null;

    const cookies = cookieHeader.split(';');
    for (const rawCookie of cookies) {
        const trimmed = rawCookie.trim();
        if (!trimmed) continue;
        const equalsIndex = trimmed.indexOf('=');
        if (equalsIndex === -1) continue;
        const name = trimmed.slice(0, equalsIndex).trim();
        const value = trimmed.slice(equalsIndex + 1).trim();
        if (name === SESSION_COOKIE_NAME) {
            try {
                return decodeURIComponent(value);
            } catch {
                return value;
            }
        }
    }

    return null;
}
