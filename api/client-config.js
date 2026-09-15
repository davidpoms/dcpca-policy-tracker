export default function handler(req, res) {
    const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;

    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
        return res.status(500).json({
            error: 'Client configuration is not available'
        });
    }

    return res.status(200).json({
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY
    });
}