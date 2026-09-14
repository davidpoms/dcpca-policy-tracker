export default function handler(req, res) {
    const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;

    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
        return res.status(500).json({ error: 'Client configuration is not available' });
    }

    return res.status(200).json({ SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY });
}

export default function handler(req, res) {
    const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;

    const missing = [];
    if (!SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!SUPABASE_PUBLISHABLE_KEY) missing.push('SUPABASE_PUBLISHABLE_KEY');

    if (missing.length) {
        return res.status(500).json({
            error: 'Client configuration is not available',
            missing
        });
    }

    return res.status(200).json({
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY
    });
}