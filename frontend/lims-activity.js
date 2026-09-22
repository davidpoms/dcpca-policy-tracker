window.DCPCAFrontend = window.DCPCAFrontend || {};

function extractLatestActivityDate(details) {
    const candidates = [];

    const add = (val, label) => {
        if (!val) return;
        const d = new Date(val);
        if (!isNaN(d) && d.getFullYear() > 2000) candidates.push({ date: d, label });
    };

    // Congressional review
    if (details.congressionalReview) {
        add(details.congressionalReview.effectiveDate, 'Effective Date (Law)');
        add(details.congressionalReview.lawPublicationDate, 'Law Published');
        add(details.congressionalReview.transmittedDate, 'Transmitted to Congress');
    }

    // Mayoral review
    if (details.mayoralReview) {
        add(details.mayoralReview.enactedDate, 'Enacted');
        add(details.mayoralReview.signedDate, 'Signed by Mayor');
        add(details.mayoralReview.returnedDate, 'Returned by Mayor');
        add(details.mayoralReview.actPublicationDate, 'Act Published');
        add(details.mayoralReview.transmittedDate, 'Transmitted to Mayor');
    }

    // Council actions (votes)
    (details.actions || []).forEach(a => add(a.actionDate, a.action?.trim() || 'Council Action'));

    // Committee markups
    (details.committeeMarkup || []).forEach(m => {
        add(m.reportFiledDate, 'Committee Report Filed');
        add(m.committeeActionDate, 'Committee Markup');
    });

    // Past hearings
    (details.committeeHearing || []).forEach(h => {
        if (new Date(h.hearingDate) <= new Date()) add(h.hearingDate, h.hearingType || 'Committee Hearing');
    });

    // Re-referrals
    (details.committeeReReferral || []).forEach(r => {
        add(r.reReferralDate, 'Committee Re-Referral');
        add(r.reReferralPublishedDate, 'Re-Referral Published');
    });

    // Introduction dates as floor
    add(details.introductionPublicationDate, 'Introduction Published');
    add(details.introductionDate, 'Introduced');

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.date - a.date);
    const best = candidates[0];
    return { date: best.date, dateIso: best.date.toISOString(), label: best.label };
}

function extractActivityTimeline(details) {
    const events = [];
    const add = (val, label, extra) => {
        if (!val) return;
        const d = new Date(val);
        if (!isNaN(d) && d.getFullYear() > 2000) events.push({ date: d, label, extra: extra || null });
    };

    add(details.introductionDate, 'Introduced');
    add(details.committeeReferralDate, 'Referred to Committee');
    add(details.introductionPublicationDate, 'Introduction Published');

    (details.committeeReReferral || []).forEach(r => {
        const committee = Array.isArray(r.committeeName) ? r.committeeName.join(', ') : (r.committeeName || '');
        add(r.reReferralDate, 'Committee Re-Referral', committee);
        add(r.reReferralPublishedDate, 'Re-Referral Published', committee);
    });

    (details.committeeHearing || []).forEach(h => {
        add(h.noticeFiledDate, `${h.hearingType || 'Hearing'} Notice Filed`);
        add(h.hearingDate, h.hearingType || 'Committee Hearing');
    });

    (details.committeeMarkup || []).forEach(m => {
        add(m.committeeActionDate, 'Committee Markup');
        add(m.reportFiledDate, 'Committee Report Filed');
    });

    (details.actions || []).forEach(a => {
        const voteResult = a.voteDetails?.voteResult;
        add(a.actionDate, a.action?.trim() || 'Council Action', voteResult || null);
    });

    if (details.mayoralReview) {
        add(details.mayoralReview.transmittedDate, 'Transmitted to Mayor');
        add(details.mayoralReview.signedDate, 'Signed by Mayor');
        add(details.mayoralReview.returnedDate, 'Returned by Mayor');
        add(details.mayoralReview.enactedDate, 'Enacted');
        add(details.mayoralReview.actPublicationDate, 'Act Published');
    }

    if (details.congressionalReview) {
        add(details.congressionalReview.transmittedDate, 'Transmitted to Congress');
        add(details.congressionalReview.effectiveDate, 'Effective Date (Law)');
        add(details.congressionalReview.lawPublicationDate, 'Law Published');
    }

    // Deduplicate by date+label, sort chronologically
    const seen = new Set();
    return events
        .filter(e => { const k = `${e.date.getTime()}::${e.label}`; if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => a.date - b.date)
        .map(e => ({
            dateStr: e.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            label: e.label,
            extra: e.extra,
            isFuture: e.date > new Date()
        }));
}

window.DCPCAFrontend.extractLatestActivityDate = extractLatestActivityDate;
window.DCPCAFrontend.extractActivityTimeline = extractActivityTimeline;
