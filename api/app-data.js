import { getSessionCookieValue, validateSignedSession } from '../lib/session.js';

const ALLOWED_ACTIONS = new Set([
  'app.bootstrap.read',
  'activityLog.list',
  'teamMembers.list',
  'keyword.add',
  'keyword.remove',
  'committee.add',
  'committee.remove',
  'sponsor.add',
  'sponsor.remove',
  'agency.add',
  'agency.remove',
  'note.save',
  'note.delete',
  'teamMember.create',
  'teamMember.update',
  'teamMember.delete',
  'trackedItem.assignment.update',
  'trackedItem.priority.update',
  'trackedItem.summary.save',
  'trackedItem.summary.delete',
  'trackedItem.activity.markSeen',
  'trackedItem.track',
  'trackedItem.untrack',
  'trackedItem.manual.create',
  'trackedItem.manual.update',
  'trackedItem.manual.delete',
  'trackedItem.actionStatus.update',
  'trackedItem.activity.detected',
  'trackedItem.hearing.persist',
  'trackedItem.hearings.audit'
]);

const BOOTSTRAP_SELECTS = Object.freeze({
  trackedItems: 'id,title,bill_number,category,status,last_status,committees,date,description,link,source,agency,introduced_by,co_introducers,assigned_to,priority,action_status,is_new,is_manual_entry,has_new_activity,activity_summary,last_checked_at,hearing_checked_at,tracked_at,notice_id,register_issue,register_notes,next_hearing_date,hearing_type,hearing_location,additional_information,manual_summary,committee_re_referral,latest_activity_date,latest_activity_label,activity_count,deadline,activity_timeline',
  itemNotes: 'item_id,note_text',
  trackedKeywords: 'keyword',
  trackedCommittees: 'committee_name',
  trackedSponsors: 'sponsor_name',
  trackedAgencies: 'agency_name',
  teamMembers: 'id,name,email',
  billStatusHistory: 'item_id,old_status,new_status,change_label,changed_at'
});

function isExactBody(body, allowedKeys) {
  const actualKeys = Object.keys(body || {}).sort();
  const expectedKeys = [...allowedKeys].sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys);
}

function ensureSession(req) {
  const rawCookie = getSessionCookieValue(req);
  try {
    const result = validateSignedSession(rawCookie);
    if (!result.valid) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 500, error: 'Service unavailable' };
  }
}

function normalizeKeywordList(values) {
  const seen = new Set();
  return values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && !seen.has(value) && seen.add(value));
}

function normalizeRequiredText(value) {
  if (typeof value !== 'string') {
    return null;
  }
  return value.trim() === '' ? null : value;
}

function normalizeAgencyName(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeKeywordValue(value) {
  if (typeof value !== 'string') {
    return null;
  }
  return value.trim().toLowerCase();
}

async function supabaseTableRequest(url, serviceKey, table, method, body, query = '', extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...extraHeaders
  };

  const targetUrl = `${url}/rest/v1/${table}${query}`;
  const response = await fetch(targetUrl, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    throw new Error(`Supabase ${method} ${table} failed (${response.status})`);
  }

  return response;
}

async function logActivityEvent(url, serviceKey, action, itemId = null, itemTitle = null, details = {}) {
  try {
    await supabaseTableRequest(url, serviceKey, 'activity_log', 'POST', {
      action,
      item_id: itemId,
      item_title: itemTitle,
      details
    });
  } catch {
    // Preserve the previous browser-side logActivity behavior: do not block the main mutation if the audit insert fails.
  }
}

function isValidTeamMemberEmail(value) {
  return typeof value === 'string' || value === null;
}

async function getTeamMember(url, serviceKey, teamMemberId) {
  const encodedId = encodeURIComponent(teamMemberId);
  const response = await supabaseTableRequest(
    url,
    serviceKey,
    'team_members',
    'GET',
    null,
    `?id=eq.${encodedId}&select=id,name,email,active`
  );
  const members = await response.json();
  return Array.isArray(members) ? members[0] : null;
}

async function readTableRows(url, serviceKey, table, query) {
  const response = await supabaseTableRequest(url, serviceKey, table, 'GET', null, query);
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.SESSION_SECRET) {
    return res.status(500).json({ error: 'Service unavailable' });
  }

  const sessionState = ensureSession(req);
  if (!sessionState.ok) {
    return res.status(sessionState.status).json({ error: sessionState.error });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Service unavailable' });
  }

  let body;
  try {
    if (typeof req.body === 'string') {
      body = JSON.parse(req.body);
    } else {
      body = req.body ?? {};
    }
  } catch {
    return res.status(400).json({ error: 'Invalid request' });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const action = body.action;
  if (typeof action !== 'string' || !ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  try {
    switch (action) {
      case 'app.bootstrap.read': {
        if (!isExactBody(body, ['action'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const partial = {};
        const fatalRead = async (dataset, table, query) => {
          try {
            partial[dataset] = await readTableRows(supabaseUrl, serviceKey, table, query);
            return false;
          } catch {
            console.error('[app-data] bootstrap read failed', { dataset });
            return true;
          }
        };

        const fatalResponse = (failedDataset) => res.status(500).json({
          error: 'Service unavailable',
          failedDataset,
          partial
        });

        let failure = await fatalRead('trackedItems', 'tracked_items', `?select=${BOOTSTRAP_SELECTS.trackedItems}&order=tracked_at.desc`);
        if (failure) return fatalResponse('trackedItems');
        failure = await fatalRead('itemNotes', 'item_notes', `?select=${BOOTSTRAP_SELECTS.itemNotes}`);
        if (failure) return fatalResponse('itemNotes');
        failure = await fatalRead('trackedKeywords', 'tracked_keywords', `?select=${BOOTSTRAP_SELECTS.trackedKeywords}&order=added_at.asc`);
        if (failure) return fatalResponse('trackedKeywords');
        failure = await fatalRead('trackedCommittees', 'tracked_committees', `?select=${BOOTSTRAP_SELECTS.trackedCommittees}&order=added_at.asc`);
        if (failure) return fatalResponse('trackedCommittees');
        failure = await fatalRead('trackedSponsors', 'tracked_sponsors', `?select=${BOOTSTRAP_SELECTS.trackedSponsors}&order=added_at.asc`);
        if (failure) return fatalResponse('trackedSponsors');

        try {
          partial.trackedAgencies = await readTableRows(
            supabaseUrl, serviceKey, 'tracked_agencies',
            `?select=${BOOTSTRAP_SELECTS.trackedAgencies}&order=agency_name.asc`
          );
        } catch {
          console.error('[app-data] tolerated bootstrap read failed', { dataset: 'trackedAgencies' });
          partial.trackedAgencies = null;
        }

        failure = await fatalRead(
          'teamMembers', 'team_members',
          `?select=${BOOTSTRAP_SELECTS.teamMembers}&active=eq.true&order=name.asc`
        );
        if (failure) return fatalResponse('teamMembers');

        try {
          partial.billStatusHistory = await readTableRows(
            supabaseUrl, serviceKey, 'bill_status_history',
            `?select=${BOOTSTRAP_SELECTS.billStatusHistory}&order=changed_at.desc`
          );
        } catch {
          console.error('[app-data] tolerated bootstrap read failed', { dataset: 'billStatusHistory' });
          partial.billStatusHistory = null;
        }

        return res.status(200).json({ ok: true, ...partial });
      }

      case 'activityLog.list': {
        if (!isExactBody(body, ['action'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        try {
          const activityLog = await readTableRows(
            supabaseUrl, serviceKey, 'activity_log',
            '?select=id,action,item_title,details,created_at&order=created_at.desc&limit=100'
          );
          return res.status(200).json({ ok: true, activityLog });
        } catch {
          console.error('[app-data] list read failed', { dataset: 'activityLog' });
          return res.status(500).json({ error: 'Service unavailable' });
        }
      }

      case 'teamMembers.list': {
        if (!isExactBody(body, ['action'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        try {
          const teamMembers = await readTableRows(
            supabaseUrl, serviceKey, 'team_members',
            '?select=id,name,email&active=eq.true&order=name.asc'
          );
          return res.status(200).json({ ok: true, teamMembers });
        } catch {
          console.error('[app-data] list read failed', { dataset: 'teamMembers' });
          return res.status(500).json({ error: 'Service unavailable' });
        }
      }

      case 'keyword.add': {
        if (!isExactBody(body, ['action', 'keywords'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (!Array.isArray(body.keywords) || body.keywords.length === 0) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (body.keywords.some((value) => typeof value !== 'string')) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const keywords = normalizeKeywordList(body.keywords);
        if (!keywords.length) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_keywords',
          'POST',
          keywords.map((keyword) => ({ keyword }))
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'keyword_added', null, null, {
          keywords: keywords.join(', ')
        });

        return res.status(200).json({ ok: true, added: keywords });
      }

      case 'keyword.remove': {
        if (!isExactBody(body, ['action', 'keyword'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.keyword !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const keyword = normalizeKeywordValue(body.keyword);
        if (!keyword) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const encoded = encodeURIComponent(keyword);
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_keywords',
          'DELETE',
          null,
          `?keyword=eq.${encoded}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'keyword_removed', null, null, {
          keyword
        });

        return res.status(200).json({ ok: true, keyword });
      }

      case 'committee.add': {
        if (!isExactBody(body, ['action', 'committeeName'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const committeeName = normalizeRequiredText(body.committeeName);
        if (!committeeName) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_committees',
          'POST',
          { committee_name: committeeName }
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'committee_added', null, null, {
          committee: committeeName
        });

        return res.status(200).json({ ok: true, committeeName });
      }

      case 'committee.remove': {
        if (!isExactBody(body, ['action', 'committeeName'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const committeeName = normalizeRequiredText(body.committeeName);
        if (!committeeName) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        const encoded = encodeURIComponent(committeeName);
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_committees',
          'DELETE',
          null,
          `?committee_name=eq.${encoded}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'committee_removed', null, null, {
          committee: committeeName
        });

        return res.status(200).json({ ok: true, committeeName });
      }

      case 'sponsor.add': {
        if (!isExactBody(body, ['action', 'sponsorName'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const sponsorName = normalizeRequiredText(body.sponsorName);
        if (!sponsorName) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_sponsors',
          'POST',
          { sponsor_name: sponsorName }
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'sponsor_added', null, null, {
          sponsor: sponsorName
        });

        return res.status(200).json({ ok: true, sponsorName });
      }

      case 'sponsor.remove': {
        if (!isExactBody(body, ['action', 'sponsorName'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const sponsorName = normalizeRequiredText(body.sponsorName);
        if (!sponsorName) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        const encoded = encodeURIComponent(sponsorName);
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_sponsors',
          'DELETE',
          null,
          `?sponsor_name=eq.${encoded}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'sponsor_removed', null, null, {
          sponsor: sponsorName
        });

        return res.status(200).json({ ok: true, sponsorName });
      }

      case 'agency.add': {
        if (!isExactBody(body, ['action', 'agencyName'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const agencyName = normalizeAgencyName(body.agencyName);
        if (!agencyName) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_agencies',
          'POST',
          { agency_name: agencyName }
        );

        return res.status(200).json({ ok: true, agencyName });
      }

      case 'agency.remove': {
        if (!isExactBody(body, ['action', 'agencyName'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const agencyName = normalizeAgencyName(body.agencyName);
        if (!agencyName) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        const encoded = encodeURIComponent(agencyName);
        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_agencies',
          'DELETE',
          null,
          `?agency_name=eq.${encoded}`
        );

        return res.status(200).json({ ok: true, agencyName });
      }

      case 'note.save': {
        if (!isExactBody(body, ['action', 'itemId', 'noteText', 'activityAction', 'itemTitle'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        if (typeof body.itemId !== 'string' || body.itemId.trim() === '') {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.noteText !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (body.activityAction !== 'note_added' && body.activityAction !== 'note_updated') {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemTitle !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const itemId = body.itemId;
        const noteText = body.noteText;
        const activityAction = body.activityAction;
        const itemTitle = body.itemTitle;

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'item_notes',
          'POST',
          { item_id: itemId, note_text: noteText },
          '?on_conflict=item_id',
          { Prefer: 'resolution=merge-duplicates' }
        );
        await logActivityEvent(supabaseUrl, serviceKey, activityAction, itemId, itemTitle, {});

        return res.status(200).json({ ok: true, itemId, noteText });
      }

      case 'note.delete': {
        if (!isExactBody(body, ['action', 'itemId', 'itemTitle'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        if (typeof body.itemId !== 'string' || body.itemId.trim() === '') {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemTitle !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const itemId = body.itemId;
        const itemTitle = body.itemTitle;
        const encodedId = encodeURIComponent(itemId);

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'item_notes',
          'DELETE',
          null,
          `?item_id=eq.${encodedId}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'note_deleted', itemId, itemTitle, {});

        return res.status(200).json({ ok: true, itemId });
      }

      case 'trackedItem.assignment.update': {
        if (!isExactBody(body, ['action', 'itemId', 'newAssignee', 'oldAssignee', 'itemTitle'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemId !== 'string' || body.itemId.trim() === '' ||
            typeof body.newAssignee !== 'string' || typeof body.oldAssignee !== 'string' ||
            typeof body.itemTitle !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_items',
          'PATCH',
          { assigned_to: body.newAssignee },
          `?id=eq.${encodeURIComponent(body.itemId)}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'assigned', body.itemId, body.itemTitle, {
          from: body.oldAssignee,
          to: body.newAssignee
        });

        return res.status(200).json({ ok: true });
      }

      case 'trackedItem.priority.update': {
        if (!isExactBody(body, ['action', 'itemId', 'newPriority', 'oldPriority', 'itemTitle'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemId !== 'string' || body.itemId.trim() === '' ||
            typeof body.newPriority !== 'string' || typeof body.oldPriority !== 'string' ||
            typeof body.itemTitle !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_items',
          'PATCH',
          { priority: body.newPriority },
          `?id=eq.${encodeURIComponent(body.itemId)}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'priority_changed', body.itemId, body.itemTitle, {
          from: body.oldPriority,
          to: body.newPriority
        });

        return res.status(200).json({ ok: true });
      }

      case 'trackedItem.actionStatus.update': {
        if (!isExactBody(body, ['action', 'itemId', 'itemTitle', 'oldStatus', 'newStatus']) ||
            typeof body.itemId !== 'string' || body.itemId.trim() === '' ||
            typeof body.itemTitle !== 'string' || typeof body.oldStatus !== 'string' ||
            typeof body.newStatus !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(supabaseUrl, serviceKey, 'tracked_items', 'PATCH',
          { action_status: body.newStatus }, `?id=eq.${encodeURIComponent(body.itemId)}`);

        const labelMap = {
          action_needed: 'Action Needed',
          monitor_and_assess: 'Monitor & Assess',
          action_completed: 'Action Completed'
        };
        const oldLabel = labelMap[body.oldStatus] || body.oldStatus;
        const newLabel = labelMap[body.newStatus] || body.newStatus;
        try {
          await supabaseTableRequest(supabaseUrl, serviceKey, 'bill_status_history', 'POST', {
            item_id: body.itemId,
            old_status: oldLabel,
            new_status: newLabel,
            change_label: `Tracker status changed: ${oldLabel} → ${newLabel}`,
            changed_at: new Date().toISOString()
          });
        } catch (error) {
          console.error('[app-data] action-status history insert failed', { action, error: error.message });
          return res.status(500).json({ error: 'Service unavailable', trackedItemUpdated: true });
        }

        await logActivityEvent(supabaseUrl, serviceKey, 'action_status_changed',
          body.itemId, body.itemTitle, { from: body.oldStatus, to: body.newStatus });
        return res.status(200).json({ ok: true });
      }

      case 'trackedItem.activity.detected': {
        if (!isExactBody(body, ['action', 'itemId', 'newStatus', 'activitySummary', 'lastCheckedAt']) ||
            typeof body.itemId !== 'string' || body.itemId.trim() === '' ||
            typeof body.newStatus !== 'string' || typeof body.activitySummary !== 'string' ||
            typeof body.lastCheckedAt !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(supabaseUrl, serviceKey, 'tracked_items', 'PATCH', {
          last_status: body.newStatus,
          has_new_activity: true,
          activity_summary: body.activitySummary,
          last_checked_at: body.lastCheckedAt
        }, `?id=eq.${encodeURIComponent(body.itemId)}`);
        await logActivityEvent(supabaseUrl, serviceKey, 'activity_detected',
          body.itemId, null, { summary: body.activitySummary });
        return res.status(200).json({ ok: true });
      }

      case 'trackedItem.hearing.persist': {
        const keys = [
          'action', 'itemId', 'hearingCheckedAt', 'nextHearingDate', 'hearingType',
          'hearingLocation', 'additionalInformation', 'committeeReReferral',
          'latestActivityDate', 'latestActivityLabel', 'activityCount',
          'activityTimeline', 'coIntroducers'
        ];
        const optionalKeys = ['introducedBy', 'status'].filter(key => Object.hasOwn(body, key));
        const nullableText = value => typeof value === 'string' || value === null;
        if (!isExactBody(body, [...keys, ...optionalKeys]) ||
            typeof body.itemId !== 'string' || body.itemId.trim() === '' ||
            typeof body.hearingCheckedAt !== 'string' ||
            !nullableText(body.nextHearingDate) || !nullableText(body.hearingType) ||
            !nullableText(body.hearingLocation) || !nullableText(body.additionalInformation) ||
            !(Array.isArray(body.committeeReReferral) || body.committeeReReferral === null) ||
            !nullableText(body.latestActivityDate) || !nullableText(body.latestActivityLabel) ||
            typeof body.activityCount !== 'number' || !Number.isFinite(body.activityCount) ||
            !(Array.isArray(body.activityTimeline) || body.activityTimeline === null) ||
            !nullableText(body.coIntroducers) ||
            (Object.hasOwn(body, 'introducedBy') && typeof body.introducedBy !== 'string') ||
            (Object.hasOwn(body, 'status') && typeof body.status !== 'string')) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const patch = {
          hearing_checked_at: body.hearingCheckedAt,
          next_hearing_date: body.nextHearingDate,
          hearing_type: body.hearingType,
          hearing_location: body.hearingLocation,
          additional_information: body.additionalInformation,
          committee_re_referral: body.committeeReReferral,
          latest_activity_date: body.latestActivityDate,
          latest_activity_label: body.latestActivityLabel,
          activity_count: body.activityCount,
          activity_timeline: body.activityTimeline,
          co_introducers: body.coIntroducers
        };
        if (Object.hasOwn(body, 'introducedBy')) patch.introduced_by = body.introducedBy;
        if (Object.hasOwn(body, 'status')) patch.status = body.status;
        await supabaseTableRequest(supabaseUrl, serviceKey, 'tracked_items', 'PATCH',
          patch, `?id=eq.${encodeURIComponent(body.itemId)}`);
        return res.status(200).json({ ok: true });
      }

      case 'trackedItem.hearings.audit': {
        if (!isExactBody(body, ['action', 'checked', 'withUpcoming']) ||
            !Number.isInteger(body.checked) || body.checked < 0 ||
            !Number.isInteger(body.withUpcoming) || body.withUpcoming < 0) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        await logActivityEvent(supabaseUrl, serviceKey, 'hearings_checked', null, null,
          { checked: body.checked, withUpcoming: body.withUpcoming });
        return res.status(200).json({ ok: true });
      }

      case 'trackedItem.summary.save': {
        if (!isExactBody(body, ['action', 'itemId', 'summary'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemId !== 'string' || body.itemId.trim() === '' ||
            (typeof body.summary !== 'string' && body.summary !== null)) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_items',
          'PATCH',
          { manual_summary: body.summary },
          `?id=eq.${encodeURIComponent(body.itemId)}`
        );

        return res.status(200).json({ ok: true });
      }

      case 'trackedItem.summary.delete': {
        if (!isExactBody(body, ['action', 'itemId'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemId !== 'string' || body.itemId.trim() === '') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_items',
          'PATCH',
          { manual_summary: null },
          `?id=eq.${encodeURIComponent(body.itemId)}`
        );

        return res.status(200).json({ ok: true });
      }

      case 'trackedItem.activity.markSeen': {
        if (!isExactBody(body, ['action', 'itemId'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemId !== 'string' || body.itemId.trim() === '') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_items',
          'PATCH',
          { has_new_activity: false, activity_summary: null },
          `?id=eq.${encodeURIComponent(body.itemId)}`
        );

        return res.status(200).json({ ok: true });
      }

      case 'trackedItem.track': {
        const trackKeys = [
          'action', 'itemId', 'title', 'billNumber', 'category', 'status', 'committees',
          'date', 'description', 'link', 'source', 'agency', 'isManualEntry', 'isNew',
          'introducedBy'
        ];
        if (!isExactBody(body, trackKeys)) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemId !== 'string' || body.itemId.trim() === '' ||
            typeof body.title !== 'string' || typeof body.source !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_items',
          'POST',
          {
            id: body.itemId,
            title: body.title,
            bill_number: body.billNumber,
            category: body.category,
            status: body.status,
            committees: body.committees,
            date: body.date,
            description: body.description,
            link: body.link,
            source: body.source,
            agency: body.agency,
            is_manual_entry: body.isManualEntry,
            is_new: body.isNew,
            assigned_to: 'Unassigned',
            priority: 'medium',
            action_status: 'action_needed',
            introduced_by: body.introducedBy,
            last_status: body.status,
            last_checked_at: new Date().toISOString(),
            has_new_activity: false
          }
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'item_tracked', body.itemId, body.title, {
          source: body.source,
          category: body.category
        });

        return res.status(200).json({ ok: true });
      }

      case 'trackedItem.untrack': {
        if (!isExactBody(body, ['action', 'itemId', 'itemTitle'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemId !== 'string' || body.itemId.trim() === '' ||
            typeof body.itemTitle !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_items',
          'DELETE',
          null,
          `?id=eq.${encodeURIComponent(body.itemId)}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'item_untracked', body.itemId, body.itemTitle, {});

        return res.status(200).json({ ok: true });
      }

      case 'trackedItem.manual.create': {
        const manualCreateKeys = [
          'action', 'itemId', 'title', 'agency', 'status', 'date', 'link', 'assignedTo',
          'priority', 'actionStatus', 'noticeId', 'registerIssue', 'registerNotes',
          'deadline', 'isNew', 'latestActivityDate'
        ];
        if (!isExactBody(body, manualCreateKeys)) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemId !== 'string' || body.itemId.trim() === '' ||
            typeof body.title !== 'string' || typeof body.agency !== 'string' ||
            typeof body.status !== 'string' || typeof body.date !== 'string' ||
            typeof body.link !== 'string' || typeof body.assignedTo !== 'string' ||
            typeof body.priority !== 'string' || typeof body.actionStatus !== 'string' ||
            typeof body.noticeId !== 'string' || typeof body.registerIssue !== 'string' ||
            typeof body.registerNotes !== 'string' ||
            (typeof body.deadline !== 'string' && body.deadline !== null) ||
            typeof body.isNew !== 'boolean' ||
            (typeof body.latestActivityDate !== 'string' && body.latestActivityDate !== null)) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_items',
          'POST',
          {
            id: body.itemId,
            title: body.title,
            bill_number: null,
            category: 'Municipal Regulation',
            status: body.status,
            committees: [],
            date: body.date,
            description: body.title,
            link: body.link,
            source: 'Municipal Register',
            agency: body.agency,
            is_manual_entry: true,
            is_new: body.isNew,
            assigned_to: body.assignedTo,
            priority: body.priority,
            action_status: body.actionStatus,
            introduced_by: null,
            notice_id: body.noticeId,
            register_issue: body.registerIssue,
            register_notes: body.registerNotes,
            deadline: body.deadline,
            latest_activity_date: body.latestActivityDate
          }
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'manual_entry_added', body.itemId, body.title, {
          source: 'Municipal Register'
        });

        return res.status(200).json({ ok: true });
      }

      case 'trackedItem.manual.update': {
        const manualUpdateKeys = [
          'action', 'itemId', 'title', 'agency', 'status', 'date', 'link', 'assignedTo',
          'priority', 'actionStatus', 'noticeId', 'registerIssue', 'registerNotes', 'deadline'
        ];
        if (!isExactBody(body, manualUpdateKeys)) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemId !== 'string' || body.itemId.trim() === '' ||
            typeof body.title !== 'string' || typeof body.agency !== 'string' ||
            typeof body.status !== 'string' || typeof body.date !== 'string' ||
            typeof body.link !== 'string' || typeof body.assignedTo !== 'string' ||
            typeof body.priority !== 'string' || typeof body.actionStatus !== 'string' ||
            typeof body.noticeId !== 'string' || typeof body.registerIssue !== 'string' ||
            typeof body.registerNotes !== 'string' ||
            (typeof body.deadline !== 'string' && body.deadline !== null)) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_items',
          'PATCH',
          {
            title: body.title,
            agency: body.agency,
            status: body.status,
            date: body.date,
            link: body.link,
            assigned_to: body.assignedTo,
            priority: body.priority,
            action_status: body.actionStatus,
            notice_id: body.noticeId,
            register_issue: body.registerIssue,
            register_notes: body.registerNotes,
            description: body.title,
            deadline: body.deadline,
            latest_activity_date: body.deadline || body.date || null
          },
          `?id=eq.${encodeURIComponent(body.itemId)}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'manual_entry_updated', body.itemId, body.title, {});

        return res.status(200).json({ ok: true });
      }

      case 'trackedItem.manual.delete': {
        if (!isExactBody(body, ['action', 'itemId'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.itemId !== 'string' || body.itemId.trim() === '') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'tracked_items',
          'DELETE',
          null,
          `?id=eq.${encodeURIComponent(body.itemId)}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'manual_entry_deleted', body.itemId, null, {});

        return res.status(200).json({ ok: true });
      }

      case 'teamMember.create': {
        if (!isExactBody(body, ['action', 'name', 'email'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.name !== 'string' || body.name.trim() === '' || !isValidTeamMemberEmail(body.email)) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'team_members',
          'POST',
          { name: body.name, email: body.email, active: true }
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'team_member_added', null, null, {
          name: body.name
        });

        return res.status(200).json({ ok: true });
      }

      case 'teamMember.update': {
        if (!isExactBody(body, ['action', 'teamMemberId', 'name', 'email'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.teamMemberId !== 'string' || body.teamMemberId.trim() === '') {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.name !== 'string' || body.name.trim() === '' || !isValidTeamMemberEmail(body.email)) {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const existingMember = await getTeamMember(supabaseUrl, serviceKey, body.teamMemberId);
        if (!existingMember || typeof existingMember.name !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'team_members',
          'PATCH',
          { name: body.name, email: body.email },
          `?id=eq.${encodeURIComponent(body.teamMemberId)}`
        );

        if (existingMember.name !== body.name) {
          try {
            await supabaseTableRequest(
              supabaseUrl,
              serviceKey,
              'tracked_items',
              'PATCH',
              { assigned_to: body.name },
              `?assigned_to=eq.${encodeURIComponent(existingMember.name)}`
            );
          } catch (error) {
            console.error('[app-data] team member assignment propagation failed', {
              teamMemberId: body.teamMemberId,
              error: error.message
            });
          }
        }

        await logActivityEvent(supabaseUrl, serviceKey, 'team_member_updated', null, null, {
          from: existingMember.name,
          to: body.name
        });

        return res.status(200).json({ ok: true });
      }

      case 'teamMember.delete': {
        if (!isExactBody(body, ['action', 'teamMemberId'])) {
          return res.status(400).json({ error: 'Invalid request' });
        }
        if (typeof body.teamMemberId !== 'string' || body.teamMemberId.trim() === '') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        const existingMember = await getTeamMember(supabaseUrl, serviceKey, body.teamMemberId);
        if (!existingMember || typeof existingMember.name !== 'string') {
          return res.status(400).json({ error: 'Invalid request' });
        }

        await supabaseTableRequest(
          supabaseUrl,
          serviceKey,
          'team_members',
          'PATCH',
          { active: false },
          `?id=eq.${encodeURIComponent(body.teamMemberId)}`
        );
        await logActivityEvent(supabaseUrl, serviceKey, 'team_member_deleted', null, null, {
          name: existingMember.name
        });

        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('[app-data] request failed', { action, error: error.message });
    return res.status(500).json({ error: 'Service unavailable' });
  }
}
