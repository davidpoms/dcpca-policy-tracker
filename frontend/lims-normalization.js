window.DCPCAFrontend = window.DCPCAFrontend || {};

const normalizeCommittees = (value) => {
    if (Array.isArray(value)) return value;

    if (typeof value !== 'string') return [];

    const text = value.trim();
    if (!text || text === 'null') return [];

    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
            return parsed;
        }
        if (typeof parsed === 'string' && parsed.trim()) {
            return [parsed.trim()];
        }
    } catch {
        // Not JSON; fall through to legacy/plain-text handling.
    }

    return text
        .split(';')
        .map(value => value.trim())
        .filter(Boolean);
};

const parseMembers = (val) => Array.isArray(val) ? val.map(m => m.memberName || m).join(', ') : (val || null);

const transformLimsSearchItem = (leg, isNewItem) => {
    const committees = normalizeCommittees(leg.referredToCommittees);
    const introducedBy = parseMembers(leg.introducers) || leg.introducedBy || leg.primarySponsor || leg.sponsor || null;
    const coIntroducers = parseMembers(leg.coIntroducers) || null;
    return {
        id: leg.legislationNumber, title: leg.title, billNumber: leg.legislationNumber,
        category: leg.category || leg.subCategory || 'Uncategorized',
        status: leg.status || 'Unknown', committees,
        date: leg.introductionDate ? new Date(leg.introductionDate).toISOString().split('T')[0] : '',
        description: leg.shortDescription || leg.title,
        link: `https://lims.dccouncil.gov/Legislation/${leg.legislationNumber}`,
        source: 'DC Council', isNew: isNewItem(leg.introductionDate),
        assignedTo: null, priority: null, actionStatus: 'action_needed', introducedBy, coIntroducers
    };
};

window.DCPCAFrontend.normalizeCommittees = normalizeCommittees;
window.DCPCAFrontend.parseMembers = parseMembers;
window.DCPCAFrontend.transformLimsSearchItem = transformLimsSearchItem;
