window.DCPCAFrontend = window.DCPCAFrontend || {};

function extractNextHearing(details) {
    const now = new Date();
    const candidates = [];

    // committeeHearing — the primary field the DC Council API uses
    const committeeHearings = details.committeeHearing || [];
    if (Array.isArray(committeeHearings)) {
        committeeHearings.forEach(h => {
            if (!h.hearingDate) return;
            const d = new Date(h.hearingDate);
            if (!isNaN(d)) candidates.push({
                date: d,
                type: h.hearingType || 'Committee Hearing',
                location: h.location || h.room || ''
            });
        });
    }

    // committeeMarkup
    const markups = details.committeeMarkup || [];
    if (Array.isArray(markups)) {
        markups.forEach(h => {
            if (!h.hearingDate) return;
            const d = new Date(h.hearingDate);
            if (!isNaN(d)) candidates.push({ date: d, type: h.hearingType || 'Committee Markup', location: h.location || '' });
        });
    }

    // Flat fields as fallback
    for (const f of ['nextHearingDate', 'hearingDate', 'committeeHearingDate', 'scheduledHearingDate']) {
        if (details[f]) {
            const d = new Date(details[f]);
            if (!isNaN(d)) candidates.push({ date: d, type: 'Hearing', location: details.hearingLocation || '' });
        }
    }

    // legislativeHistory / actions as fallback
    const hearingKeywords = ['hearing', 'markup', 'public hearing', 'oversight hearing'];
    const history = details.legislativeHistory || details.history || details.actions || details.events || [];
    if (Array.isArray(history)) {
        history.forEach(event => {
            const action = (event.action || event.actionType || event.eventType || event.description || event.name || '').toLowerCase();
            if (!hearingKeywords.some(k => action.includes(k))) return;
            const rawDate = event.date || event.actionDate || event.eventDate || event.scheduledDate || event.hearingDate;
            if (!rawDate) return;
            const d = new Date(rawDate);
            if (!isNaN(d)) candidates.push({
                date: d,
                type: event.action || event.actionType || event.eventType || 'Hearing',
                location: event.location || event.room || event.hearingLocation || ''
            });
        });
    }

    if (!candidates.length) return { date: null, dateStr: null, timeStr: null, type: null, location: null, isPast: null, allFuture: [] };

    candidates.sort((a, b) => a.date - b.date);
    const future = candidates.filter(c => c.date > now);
    const best = future.length > 0 ? future[0] : candidates[candidates.length - 1];

    return {
        date: best.date,
        dateStr: best.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
        timeStr: best.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        type: best.type,
        location: best.location,
        isPast: best.date <= now,
        allFuture: future.map(c => ({
            dateStr: c.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
            timeStr: c.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
            type: c.type,
            location: c.location
        }))
    };
}

window.DCPCAFrontend.extractNextHearing = extractNextHearing;
