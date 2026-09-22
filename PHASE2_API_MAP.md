# Phase 2A API Map

## Scope and constraints

This document describes the consolidated authenticated application API route:

  /api/app-data.js

The first migration slice is implemented for the eight low-risk tracked config-table actions. The route continues to preserve the current application behavior while moving those writes behind the server-side session check. The four config tables have a versioned RLS migration that preserves anonymous reads and removes anonymous writes. It has been validated in Preview and must be applied separately to Production after Production policy inventory and rollout checks.

The route must:
- validate the server-side HTTP-only session cookie via the existing helper in lib/session.js
- use SUPABASE_SERVICE_KEY only server-side
- reject unauthenticated requests with 401
- never accept a table name from the browser
- never accept arbitrary Supabase filters from the browser
- never expose SUPABASE_SERVICE_KEY to the browser or the response body
- use a strict action allow-list
- preserve current application behavior until each action is migrated

### team_members schema reconciliation

Preview was created from the canonical schema without `team_members.email`, while Production already has the nullable `email` column. The additive migration `migrations/2026-09-21-add-team-members-email.sql` reconciles Preview without changing Production behavior. It intentionally does not add `added_at`, change RLS, or alter any primary-key type.

Production uses integer member IDs while Preview uses UUID values. The later team-member API slice must treat IDs as opaque values: the frontend should send `teamMemberId: String(memberId)`, and the API may validate only that `teamMemberId` is a non-empty string. No ID-type unification is required for this schema reconciliation.

### team_members mutation slice

Status: IMPLEMENTED in `/api/app-data.js`; the RLS migration is prepared but must not be applied until the rollout checks below pass.

The browser keeps its direct active-member SELECT:

```js
supabase.from('team_members').select('*').eq('active', true).order('name', { ascending: true })
```

The browser sends all three mutations through the existing authenticated route. Team-member IDs are opaque: the frontend serializes them with `String(memberId)`, and the API accepts only non-empty strings without UUID or numeric parsing.

#### teamMember.create

- Request: `{ action: 'teamMember.create', name, email }`
- Exact keys: `action`, `name`, `email`
- Validation: `name` is a string with non-empty `trim()`; `email` is a string or `null`
- Write: `POST team_members` with `{ name, email, active: true }`
- Audit: best-effort `team_member_added` with null `item_id`/`item_title` and `{ name }`
- Response: `{ ok: true }`

#### teamMember.update

- Request: `{ action: 'teamMember.update', teamMemberId, name, email }`
- Exact keys: `action`, `teamMemberId`, `name`, `email`
- Validation: `teamMemberId` is a non-empty string; `name` is a string with non-empty `trim()`; `email` is a string or `null`
- Server first fetches the existing member by ID to obtain the authoritative old name.
- Write: `PATCH team_members` with only `{ name, email }`
- Rename side effect: when the name changes, `PATCH tracked_items` where `assigned_to` exactly equals the old name, setting it to the new name.
- Assignment propagation failure is logged server-side and remains nonfatal after the team-member update succeeds.
- No tracked-item update occurs when the name is unchanged.
- Audit: best-effort `team_member_updated` with null `item_id`/`item_title` and `{ from, to }`
- Response: `{ ok: true }`

#### teamMember.delete

- Request: `{ action: 'teamMember.delete', teamMemberId }`
- Exact keys: `action`, `teamMemberId`
- Validation: `teamMemberId` is a non-empty string; UUID syntax is not required
- Write: `PATCH team_members` with `{ active: false }`
- This is a soft-delete. No physical DELETE is issued and existing `tracked_items.assigned_to` values are preserved.
- Audit: best-effort `team_member_deleted` with null `item_id`/`item_title` and `{ name }`
- Response: `{ ok: true }`

#### RLS inventories and rollout

Known Preview policies before tightening:

- `anon can read team_members`
- `anon can update team_members`

Known Production policies before tightening:

- `Allow public delete`
- `Allow public insert`
- `Allow public read access`
- `Allow public update`
- `anon can read team_members`
- `anon can update team_members`

The prepared migration `migrations/2026-09-21-tighten-team-members-rls.sql` enables RLS, drops both anon write policies and all four observed legacy public policies, then recreates only `anon can read team_members` for anon SELECT. It does not create anon INSERT, UPDATE, or DELETE policies.

Rollout order:

1. Deploy the runtime/API code while the current RLS policies remain in place.
2. Test add, edit, rename, and soft-delete in Preview.
3. Apply the team-members RLS migration in Preview.
4. Verify direct anon INSERT, UPDATE, and DELETE attempts are blocked.
5. Re-test the authenticated API mutations.
6. Repeat in Production only after Preview passes.

Rollback SQL for the common anon UPDATE policy:

```sql
CREATE POLICY "anon can update team_members"
  ON team_members
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);
```

Production legacy-policy rollback SQL, matching the observed policy names and public-role behavior:

```sql
CREATE POLICY "Allow public read access"
  ON team_members FOR SELECT TO public USING (true);
CREATE POLICY "Allow public insert"
  ON team_members FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Allow public update"
  ON team_members FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "Allow public delete"
  ON team_members FOR DELETE TO public USING (true);
```

These rollback policies intentionally reopen anonymous/public writes and are emergency-only. No primary-key type changes or `added_at` changes are part of this slice.

### tracked_items metadata mutation slice

Status: IMPLEMENTED in `/api/app-data.js`. This slice moves only five simple metadata mutations behind the existing authenticated route:

- `trackedItem.assignment.update`
  - Request: `{ action, itemId, newAssignee, oldAssignee, itemTitle }`
  - Exact validation: non-empty string `itemId`; string `newAssignee`, `oldAssignee`, and `itemTitle`
  - Server write: `PATCH tracked_items` with only `{ assigned_to: newAssignee }`, filtered by the exact `itemId`
  - Server-side best-effort audit: `assigned`, with `{ from: oldAssignee, to: newAssignee }`
- `trackedItem.priority.update`
  - Request: `{ action, itemId, newPriority, oldPriority, itemTitle }`
  - Exact validation: non-empty string `itemId`; string priority values and `itemTitle`; no new priority enum
  - Server write: `PATCH tracked_items` with only `{ priority: newPriority }`, filtered by the exact `itemId`
  - Server-side best-effort audit: `priority_changed`, with `{ from: oldPriority, to: newPriority }`
- `trackedItem.summary.save`
  - Request: `{ action, itemId, summary }`
  - Exact validation: non-empty string `itemId`; `summary` must be a string or `null`
  - Server write: `PATCH tracked_items` with only `{ manual_summary: summary }`
  - No activity or status-history event
- `trackedItem.summary.delete`
  - Request: `{ action, itemId }`
  - Server write: `PATCH tracked_items` with only `{ manual_summary: null }`
  - No activity or status-history event
- `trackedItem.activity.markSeen`
  - Request: `{ action, itemId }`
  - Server write: `PATCH tracked_items` with exactly `{ has_new_activity: false, activity_summary: null }`
  - No activity or status-history event

The browser still performs direct SELECTs. It now sends these five mutations through `/api/app-data` and updates local React state only after a successful API response. `summaryText || null` remains in the browser, so empty strings become `null` while whitespace-only strings remain strings.

The canonical `tracked_items` and `activity_log` RLS policies have intentionally not changed. Hearing/activity enrichment remains a browser writer. RLS cannot be tightened until those direct writers are migrated.

Remaining browser mutation paths: hearing persistence in `checkHearingsForTrackedItems()` and `checkHearingForItem()`, plus their `hearings_checked` activity logging.

### Detected-item activity slice

Status: IMPLEMENTED in `/api/app-data.js` as `trackedItem.activity.detected`.

- Exact request: `{ action, itemId, newStatus, activitySummary, lastCheckedAt }`. The browser retains its existing ISO timestamp generation. The server requires a non-empty string item ID and string values for the other fields.
- The server PATCHes only `last_status`, `has_new_activity: true`, `activity_summary`, and `last_checked_at` by exact item ID, then best-effort logs `activity_detected` with the item ID, null item title, and `{ summary: activitySummary }`.
- A tracked-item failure returns a generic client error and skips the audit. An audit failure does not fail the action. The browser still logs an update error to the console and does not update local state in this function; the calling refresh flow retains its current local-state timing.
- `checkHearingsForTrackedItems()` and `checkHearingForItem()` still directly PATCH `tracked_items`, and `hearings_checked` still uses the browser activity logger. `tracked_items` UPDATE and `activity_log` INSERT RLS cannot yet be tightened.

### Manual-entry lifecycle slice

Status: IMPLEMENTED in `/api/app-data.js`. All requests require the signed session and use the server service role. Each request has exactly the listed keys; unknown and missing keys are rejected. Primary database failures return only `Service unavailable`; audit failures do not block the mutation. No action writes `bill_status_history`.

- `trackedItem.manual.create`: `{ action, itemId, title, agency, status, date, link, assignedTo, priority, actionStatus, noticeId, registerIssue, registerNotes, deadline, isNew, latestActivityDate }`. The browser retains `MANUAL-${Date.now()}`, its existing title check, agency fallback, `isNewItem` calculation, and deadline/date fallback. The server inserts the existing manual row fields into `tracked_items`: ID, title, null bill number, Municipal Regulation category, status, empty committees, date, description equal to title, link, Municipal Register source, agency, manual flag, `isNew`, assignment, priority, action status, null introducer, notice/register fields, deadline, and latest activity date. Audit: best-effort `manual_entry_added` with `{ source: 'Municipal Register' }`.
- `trackedItem.manual.update`: `{ action, itemId, title, agency, status, date, link, assignedTo, priority, actionStatus, noticeId, registerIssue, registerNotes, deadline }`. The server PATCHes only the existing manual-entry field allowlist by exact item ID: title, agency, status, date, link, assignment, priority, action status, notice/register fields, description equal to title, deadline, and `latest_activity_date` equal to `deadline || date || null`. Audit: best-effort `manual_entry_updated` with empty details.
- `trackedItem.manual.delete`: `{ action, itemId }`. The browser keeps the existing confirmation. The server physically DELETEs the `tracked_items` row by exact item ID. Audit: best-effort `manual_entry_deleted` with null title and empty details.

Each action returns `{ ok: true }`. The browser changes local items, selection, and edit state only after API success. `tracked_items` and `activity_log` RLS are unchanged. Hearing enrichment still writes from the browser, so `tracked_items` RLS cannot yet be tightened.

### Action-status slice

Status: IMPLEMENTED in `/api/app-data.js` as `trackedItem.actionStatus.update`.

- Exact request: `{ action, itemId, itemTitle, oldStatus, newStatus }`; `itemId` is a non-empty string and the other values are strings. The existing label map converts `action_needed` to `Action Needed`, `monitor_and_assess` to `Monitor & Assess`, and `action_completed` to `Action Completed`; other strings retain their original value.
- The server first PATCHes `tracked_items` with only `{ action_status: newStatus }`, filtered by exact item ID. It then POSTs `bill_status_history` with the item ID, old/new display labels, `Tracker status changed: OLD → NEW`, and request-time ISO `changed_at`. Only after history succeeds does it best-effort POST `action_status_changed` to `activity_log` with `{ from: oldStatus, to: newStatus }`.
- A tracked-item PATCH failure stops before history and activity. A history failure stops before activity and returns `{ error: 'Service unavailable', trackedItemUpdated: true }` with HTTP 500. This marker lets the browser reflect the successful PATCH locally while retaining its error UI. Activity failure does not fail the request. The writes are not transactional.
- The browser no longer writes either table or logs this action directly. Signed-session and service-role authorization follow the existing route. Hearing-related browser writes remain, so `tracked_items` RLS is unchanged. The `bill_status_history` read-only browser policy is prepared below.

#### bill_status_history RLS tightening

Known live policy inventory in both Preview and Production:

- `anon can read bill_status_history`: `FOR SELECT TO anon USING (true)`
- `anon can insert bill_status_history`: `FOR INSERT TO anon WITH CHECK (true)`

The browser no longer inserts history. `trackedItem.actionStatus.update` writes through `/api/app-data` with the service role; `check-hearings.js` also runs server-side with the service role. The canonical `rls-migration.sql` and `migrations/2026-09-21-tighten-bill-status-history-rls.sql` retain only the anon SELECT policy. This migration has not been applied.

Rollout: deploy the action-status runtime first, apply the versioned migration in Preview, verify anon SELECT succeeds and anon INSERT is denied while authenticated action-status history writes still succeed, then repeat in Production after Preview passes. `tracked_items` and `activity_log` RLS remain unchanged.

Rollback, only if the previous anonymous INSERT access must be restored:

```sql
CREATE POLICY "anon can insert bill_status_history"
  ON bill_status_history FOR INSERT TO anon WITH CHECK (true);
```

The direct `activity_log` browser helper remains for unmigrated flows. Assignment and priority audit writes for this slice now occur server-side; summary and mark-seen actions produce no activity event.

### tracked-item track/untrack lifecycle slice

Status: IMPLEMENTED in `/api/app-data.js`.

#### trackedItem.track

- Exact request keys: `action`, `itemId`, `title`, `billNumber`, `category`, `status`, `committees`, `date`, `description`, `link`, `source`, `agency`, `isManualEntry`, `isNew`, `introducedBy`
- Validation: `itemId` must be a non-empty string; `title` and `source` must be strings. Other fields preserve the existing legislation and Municipal Register source shapes, including nullable values and committee arrays.
- Server write: `POST tracked_items` with the explicit source fields mapped to database columns.
- Server-supplied defaults: `assigned_to = 'Unassigned'`, `priority = 'medium'`, `action_status = 'action_needed'`, `has_new_activity = false`, and a request-time ISO `last_checked_at`.
- No upsert and no arbitrary field map.
- Server-side best-effort audit: `item_tracked`, with `item_id`, `item_title`, and `{ source, category }`.
- No `bill_status_history` write.
- Response: `{ ok: true }`.

#### trackedItem.untrack

- Exact request keys: `action`, `itemId`, `itemTitle`
- Validation: non-empty string `itemId` and string `itemTitle`.
- Server write: `DELETE tracked_items` filtered by exact `id`.
- Server-side best-effort audit: `item_untracked`, with empty details.
- No `bill_status_history` write.
- Response: `{ ok: true }`.

The browser updates selection and tracked-item defaults only after the API succeeds. Direct browser writes for hearing/activity enrichment remain, so `tracked_items` write RLS and `activity_log` write RLS must remain unchanged for now.

### item_notes RLS inventory and rollout

Preview inventory:
- `item_notes` currently has anonymous INSERT/UPDATE/DELETE policies in Preview, plus anonymous SELECT access.
- The legacy `PUBLIC` role is not the primary issue in Preview; the direct browser path is still allowed through the anon policies.

Production inventory:
- `item_notes` has the same anon policies plus legacy `PUBLIC` SELECT/INSERT/UPDATE/DELETE policies when the database drift is present.
- The direct browser client is therefore able to write notes from both the anon and public role paths unless the policy set is tightened.

Rollout:
1. deploy code while the existing RLS is still permissive
2. test note save/edit/delete through the authenticated API in Preview
3. apply the item_notes RLS migration to Preview
4. verify direct anon INSERT/UPDATE/DELETE are rejected after the Preview migration is applied
5. apply to Production only after Preview passes

Rollback:
- Common emergency rollback: restore the original anonymous INSERT/UPDATE/DELETE policies for `item_notes` if a production issue requires immediate fallback.
- Production-only legacy `PUBLIC` emergency rollback: restore `PUBLIC` INSERT/UPDATE/DELETE policies if required to recover access, but this intentionally reopens the security issue and must be treated as a temporary emergency-only step.
- `public UPDATE` rollback must use:
  ```sql
  CREATE POLICY "Allow public update" ON item_notes FOR UPDATE TO public USING (true)
  ```
  with no explicit `WITH CHECK` clause; restoring `PUBLIC` writes without matching the original pattern leaves the table exposed again.
- Warning: restoring `PUBLIC` policies reopens the same write path that this migration is designed to close.

## Session/auth model

The future route follows the existing app contract:
- Browser sends the HttpOnly cookie named `dc_tracker_session`
- Server reads the cookie through `getSessionCookieValue(req)`
- Server validates the signed session via `validateSignedSession(rawValue)`
- If invalid or missing, return `401` with a generic error
- For all app-data actions, use the service-role key to perform writes, not the anon key

Pseudo-flow:

```js
import { getSessionCookieValue, validateSignedSession } from '../lib/session.js';

const sessionCookie = getSessionCookieValue(req);
const sessionResult = validateSignedSession(sessionCookie);
if (!sessionResult.valid) {
  return res.status(401).json({ error: 'Unauthorized' });
}
```

## Future action allow-list

Each action is explicit and validated. The route should reject unknown actions with `400`.

### trackedItem.create
- Request body contract
  - `{ action: 'trackedItem.create', item: { ... } }`
- Allowed fields
  - `id`
  - `title`
  - `bill_number`
  - `category`
  - `status`
  - `committees`
  - `date`
  - `description`
  - `link`
  - `source`
  - `agency`
  - `is_manual_entry`
  - `is_new`
  - `assigned_to`
  - `priority`
  - `action_status`
  - `introduced_by`
  - `last_status`
  - `last_checked_at`
  - `has_new_activity`
  - `notice_id`
  - `register_issue`
  - `register_notes`
  - `deadline`
- Required identifiers
  - `id` required
  - `title` required
- Server-side validation
  - ensure action name is exact
  - reject unknown fields
  - ensure `id` is present and not empty
  - ensure `title` is a string
  - optionally enforce `source` in current set (`DC Council`, `Municipal Register`)
- Supabase operation(s)
  - `insert` into `tracked_items`
- Expected response contract
  - `{ ok: true, itemId: '...' }`
- Related audit/history side effects
  - append `activity_log` entry for `item_tracked`
  - no bill history row unless the UI explicitly triggers a status-change event
- Existing frontend functions that would switch to this action
  - `toggleSelection()` when selecting an item to track
  - `addManualEntry()` when creating a manual entry

### trackedItem.update
- Request body contract
  - `{ action: 'trackedItem.update', itemId: '...', changes: { ... } }`
- Allowed fields
  - `title`
  - `agency`
  - `status`
  - `date`
  - `description`
  - `link`
  - `assigned_to`
  - `priority`
  - `action_status`
  - `manual_summary`
  - `last_status`
  - `has_new_activity`
  - `activity_summary`
  - `last_checked_at`
  - `hearing_checked_at`
  - `next_hearing_date`
  - `hearing_type`
  - `hearing_location`
  - `additional_information`
  - `committee_re_referral`
  - `latest_activity_date`
  - `latest_activity_label`
  - `activity_count`
  - `activity_timeline`
  - `introduced_by`
  - `co_introducers`
  - `notice_id`
  - `register_issue`
  - `register_notes`
  - `deadline`
- Required identifiers
  - `itemId` required
  - `changes` object required
- Server-side validation
  - validate `itemId`
  - allow only explicit fields
  - reject unknown or nested object fields
  - if `action_status` changes, record the status-change audit side effect via `bill_status_history`
- Supabase operation(s)
  - `update` on `tracked_items` with `.eq('id', itemId)`
  - optional `insert` into `bill_status_history` when `action_status` changes
- Expected response contract
  - `{ ok: true, itemId: '...' }`
- Related audit/history side effects
  - `bill_status_history` insert when action status changes
  - `activity_log` insert for `assigned`, `priority_changed`, `action_status_changed`, or `activity_detected`
- Existing frontend functions that would switch to this action
  - `updateAssignment()`
  - `updatePriority()`
  - `updateActionStatus()`
  - `saveSummary()`
  - `deleteManualSummary()`
  - `updateManualEntry()`
  - `updateItemActivity()`
  - `markActivityAsSeen()`
  - `checkHearingForItem()`
  - `checkHearingsForTrackedItems()`

### trackedItem.delete
- Request body contract
  - `{ action: 'trackedItem.delete', itemId: '...' }`
- Allowed fields
  - none beyond `itemId`
- Required identifiers
  - `itemId` required
- Server-side validation
  - validate `itemId`
- Supabase operation(s)
  - `delete` from `tracked_items` with `.eq('id', itemId)`
- Expected response contract
  - `{ ok: true, itemId: '...' }`
- Related audit/history side effects
  - `activity_log` insert for `item_untracked`
- Existing frontend functions that would switch to this action
  - `toggleSelection()` when untracking an item
  - `deleteManualEntry()`

### note.save
- Status: IMPLEMENTED
- Request body contract
  - `{ action: 'note.save', itemId: '...', noteText: '...', activityAction: 'note_added' | 'note_updated', itemTitle: '...' }`
- Allowed fields
  - `itemId`
  - `noteText`
  - `activityAction`
  - `itemTitle`
- Required identifiers
  - `itemId` required
  - `noteText` must be a string (empty strings remain accepted to preserve current browser behavior)
  - `activityAction` must be `note_added` or `note_updated`
- Server-side validation
  - reject invalid or tampered request shape
  - preserve current browser-side save semantics exactly
- Supabase operation(s)
  - `POST` to `item_notes` with `?on_conflict=item_id` and `Prefer: resolution=merge-duplicates`
- Expected response contract
  - `{ ok: true, itemId: '...', noteText: '...' }`
- Related audit/history side effects
  - `activity_log` insert for `note_added` or `note_updated`
- Existing frontend functions that switched to this action
  - `saveNote()` in the add/edit note flow

### note.delete
- Status: IMPLEMENTED
- Request body contract
  - `{ action: 'note.delete', itemId: '...', itemTitle: '...' }`
- Allowed fields
  - `itemId`
  - `itemTitle`
- Required identifiers
  - `itemId` required
- Supabase operation(s)
  - `DELETE` from `item_notes` with `.eq('item_id', itemId)`
- Expected response contract
  - `{ ok: true, itemId: '...' }`
- Related audit/history side effects
  - `activity_log` insert for `note_deleted`
- Existing frontend functions that switched to this action
  - `deleteNote()`

### keyword.add
- Status: IMPLEMENTED
- Request body contract
  - `{ action: 'keyword.add', keywords: ['keyword1', 'keyword2'] }`
- Allowed fields
  - `keywords` array of strings
- Required identifiers
  - array length > 0
- Server-side validation
  - reject empty values
  - lowercase/trim on server if that matches current app behavior
  - reject duplicates by checking existing values or by deduplicating server-side
- Supabase operation(s)
  - `insert` into `tracked_keywords`
- Expected response contract
  - `{ ok: true, added: ['...'] }`
- Related audit/history side effects
  - `activity_log` insert for `keyword_added` with details `{ keywords: 'keyword1, keyword2' }`
- Existing frontend functions that would switch to this action
  - `addKeyword()`

### keyword.remove
- Status: IMPLEMENTED
- Request body contract
  - `{ action: 'keyword.remove', keyword: '...' }`
- Allowed fields
  - `keyword`
- Required identifiers
  - `keyword` required
- Supabase operation(s)
  - `delete` from `tracked_keywords` with `.eq('keyword', keyword)`
- Expected response contract
  - `{ ok: true, keyword: '...' }`
- Related audit/history side effects
  - `activity_log` insert for `keyword_removed` with details `{ keyword: '...' }`
- Existing frontend functions that would switch to this action
  - `removeKeyword()`

### committee.add
- Status: IMPLEMENTED
- Request body contract
  - `{ action: 'committee.add', committeeName: '...' }`
- Allowed fields
  - `committeeName`
- Required identifiers
  - `committeeName` required
- Supabase operation(s)
  - `insert` into `tracked_committees`
- Expected response contract
  - `{ ok: true, committeeName: '...' }`
- Related audit/history side effects
  - `activity_log` insert for `committee_added` with details `{ committee: '...' }`
- Existing frontend functions that would switch to this action
  - `addCommittee()`

### committee.remove
- Status: IMPLEMENTED
- Request body contract
  - `{ action: 'committee.remove', committeeName: '...' }`
- Allowed fields
  - `committeeName`
- Supabase operation(s)
  - `delete` from `tracked_committees` with `.eq('committee_name', committeeName)`
- Expected response contract
  - `{ ok: true, committeeName: '...' }`
- Related audit/history side effects
  - `activity_log` insert for `committee_removed` with details `{ committee: '...' }`
- Existing frontend functions that would switch to this action
  - `removeCommittee()`

### sponsor.add
- Status: IMPLEMENTED
- Request body contract
  - `{ action: 'sponsor.add', sponsorName: '...' }`
- Allowed fields
  - `sponsorName`
- Required identifiers
  - `sponsorName` required
- Supabase operation(s)
  - `insert` into `tracked_sponsors`
- Expected response contract
  - `{ ok: true, sponsorName: '...' }`
- Related audit/history side effects
  - `activity_log` insert for `sponsor_added` with details `{ sponsor: '...' }`
- Existing frontend functions that would switch to this action
  - `addSponsor()`

### sponsor.remove
- Status: IMPLEMENTED
- Request body contract
  - `{ action: 'sponsor.remove', sponsorName: '...' }`
- Allowed fields
  - `sponsorName`
- Supabase operation(s)
  - `delete` from `tracked_sponsors` with `.eq('sponsor_name', sponsorName)`
- Expected response contract
  - `{ ok: true, sponsorName: '...' }`
- Related audit/history side effects
  - `activity_log` insert for `sponsor_removed` with details `{ sponsor: '...' }`
- Existing frontend functions that would switch to this action
  - `removeSponsor()`

### agency.add
- Status: IMPLEMENTED
- Request body contract
  - `{ action: 'agency.add', agencyName: '...' }`
- Allowed fields
  - `agencyName`
- Required identifiers
  - `agencyName` required
- Supabase operation(s)
  - `insert` into `tracked_agencies`
- Expected response contract
  - `{ ok: true, agencyName: '...' }`
- Related audit/history side effects
  - no `activity_log` entry
- Existing frontend functions that would switch to this action
  - `addAgency()`

### agency.remove
- Status: IMPLEMENTED
- Request body contract
  - `{ action: 'agency.remove', agencyName: '...' }`
- Allowed fields
  - `agencyName`
- Supabase operation(s)
  - `delete` from `tracked_agencies` with `.eq('agency_name', agencyName)`
- Expected response contract
  - `{ ok: true, agencyName: '...' }`
- Related audit/history side effects
  - no `activity_log` entry
- Existing frontend functions that would switch to this action
  - `removeAgency()`

### teamMember.create
- Request body contract
  - `{ action: 'teamMember.create', name: '...', email: '...' }`
- Allowed fields
  - `name`
  - `email`
- Required identifiers
  - `name` required
- Server-side validation
  - normalise strings
  - `email` optional but if present must be string
- Supabase operation(s)
  - `insert` into `team_members`
- Expected response contract
  - `{ ok: true, teamMember: { ... } }`
- Related audit/history side effects
  - `activity_log` insert for `team_member_added`
- Existing frontend functions that would switch to this action
  - `addTeamMember()`

### teamMember.update
- Request body contract
  - `{ action: 'teamMember.update', teamMemberId: '...', name: '...', email: '...' }`
- Allowed fields
  - `teamMemberId`
  - `name`
  - `email`
- Required identifiers
  - `teamMemberId` required
  - `name` required
- Server-side validation
  - validate `teamMemberId`
  - if name changes, also update `tracked_items.assigned_to` values for the old name in a controlled batch update
- Supabase operation(s)
  - `update` on `team_members` with `.eq('id', teamMemberId)`
  - optional `update` on `tracked_items` with `.eq('assigned_to', oldName)`
- Expected response contract
  - `{ ok: true, teamMemberId: '...' }`
- Related audit/history side effects
  - `activity_log` insert for `team_member_updated`
- Existing frontend functions that would switch to this action
  - `updateTeamMember()`

### teamMember.delete
- Request body contract
  - `{ action: 'teamMember.delete', teamMemberId: '...' }`
- Allowed fields
  - `teamMemberId`
- Required identifiers
  - `teamMemberId` required
- Supabase operation(s)
  - `update` on `team_members` setting `active = false`
- Expected response contract
  - `{ ok: true, teamMemberId: '...' }`
- Related audit/history side effects
  - `activity_log` insert for `team_member_deleted`
- Existing frontend functions that would switch to this action
  - `deleteTeamMember()`

## Recommended first migration slice

Implemented first migration slice: `keyword.add`, `keyword.remove`, `committee.add`, `committee.remove`, `sponsor.add`, `sponsor.remove`, `agency.add`, `agency.remove`.

The six keyword/committee/sponsor actions log to `activity_log` using the same action names and row structure as the previous browser-side implementation. Agency add/remove intentionally do not log. The versioned migration `migrations/2026-09-15-tighten-config-table-rls.sql` removes anon INSERT, UPDATE, and DELETE policies for these four tables while retaining anon SELECT. It also removes legacy PUBLIC-role policies discovered during the Production inventory.

## RLS rollout and rollback

Apply `migrations/2026-09-15-tighten-config-table-rls.sql` manually in Supabase SQL Editor:

Preview:
- run the migration against the Preview Supabase project
- verify browser SELECTs still load
- verify keyword, committee, sponsor, and agency add/remove flows work through `/api/app-data.js`
- verify direct anon INSERT, UPDATE, and DELETE attempts are rejected

Production:
- only after Preview passes, run the same migration against Production Supabase
- re-test the four UI mutation flows

The Preview inventory originally had only anon SELECT, INSERT, and DELETE policies for these tables. Production additionally had legacy PUBLIC-role SELECT, INSERT, and DELETE policies named `Allow public read access`, `Allow public insert`, and `Allow public delete` on tracked keywords, committees, and sponsors. Because `TO public` applies broadly, removing only anon write policies would leave direct browser writes open.

Common anon rollback, restoring the previous anon INSERT and DELETE policies for all four tables if required:

```sql
DROP POLICY IF EXISTS "anon can insert tracked_keywords" ON tracked_keywords;
CREATE POLICY "anon can insert tracked_keywords" ON tracked_keywords FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS "anon can delete tracked_keywords" ON tracked_keywords;
CREATE POLICY "anon can delete tracked_keywords" ON tracked_keywords FOR DELETE TO anon USING (true);

DROP POLICY IF EXISTS "anon can insert tracked_committees" ON tracked_committees;
CREATE POLICY "anon can insert tracked_committees" ON tracked_committees FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS "anon can delete tracked_committees" ON tracked_committees;
CREATE POLICY "anon can delete tracked_committees" ON tracked_committees FOR DELETE TO anon USING (true);

DROP POLICY IF EXISTS "anon can insert tracked_sponsors" ON tracked_sponsors;
CREATE POLICY "anon can insert tracked_sponsors" ON tracked_sponsors FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS "anon can delete tracked_sponsors" ON tracked_sponsors;
CREATE POLICY "anon can delete tracked_sponsors" ON tracked_sponsors FOR DELETE TO anon USING (true);

DROP POLICY IF EXISTS "anon can insert tracked_agencies" ON tracked_agencies;
CREATE POLICY "anon can insert tracked_agencies" ON tracked_agencies FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS "anon can delete tracked_agencies" ON tracked_agencies;
CREATE POLICY "anon can delete tracked_agencies" ON tracked_agencies FOR DELETE TO anon USING (true);
```

Production legacy rollback, only if specifically required to restore the pre-migration Production inventory:

```sql
DROP POLICY IF EXISTS "Allow public read access" ON tracked_keywords;
CREATE POLICY "Allow public read access" ON tracked_keywords FOR SELECT TO public USING (true);
DROP POLICY IF EXISTS "Allow public insert" ON tracked_keywords;
CREATE POLICY "Allow public insert" ON tracked_keywords FOR INSERT TO public WITH CHECK (true);
DROP POLICY IF EXISTS "Allow public delete" ON tracked_keywords;
CREATE POLICY "Allow public delete" ON tracked_keywords FOR DELETE TO public USING (true);

DROP POLICY IF EXISTS "Allow public read access" ON tracked_committees;
CREATE POLICY "Allow public read access" ON tracked_committees FOR SELECT TO public USING (true);
DROP POLICY IF EXISTS "Allow public insert" ON tracked_committees;
CREATE POLICY "Allow public insert" ON tracked_committees FOR INSERT TO public WITH CHECK (true);
DROP POLICY IF EXISTS "Allow public delete" ON tracked_committees;
CREATE POLICY "Allow public delete" ON tracked_committees FOR DELETE TO public USING (true);

DROP POLICY IF EXISTS "Allow public read access" ON tracked_sponsors;
CREATE POLICY "Allow public read access" ON tracked_sponsors FOR SELECT TO public USING (true);
DROP POLICY IF EXISTS "Allow public insert" ON tracked_sponsors;
CREATE POLICY "Allow public insert" ON tracked_sponsors FOR INSERT TO public WITH CHECK (true);
DROP POLICY IF EXISTS "Allow public delete" ON tracked_sponsors;
CREATE POLICY "Allow public delete" ON tracked_sponsors FOR DELETE TO public USING (true);
```

Do not apply the Production legacy rollback for tracked agencies. Restoring the legacy PUBLIC-role write policies reopens the security issue and should be reserved for an emergency rollback.

Why this group first:
- it is a coherent, small UI surface with low blast radius
- it changes tracking configuration rather than core item state
- it is easy to test with direct table inserts/deletes and explicit audit log writes
- it reduces raw browser write access without immediately coupling multiple item-level history writes
- it avoids the largest coupled sequence in the app: `tracked_items` updates plus `bill_status_history` and `activity_log` inflight writes

This is better than starting with `tracked_items` because many tracked-item actions trigger multiple coupled writes in the same user action and can produce side effects such as `bill_status_history` inserts, `activity_log` inserts, and UI-refresh dependencies that are harder to isolate and verify safely.

## Tests required for the future /api/app-data.js route

Required tests:
1. missing session cookie -> `401`
2. tampered/expired/invalid session -> `401`
3. unknown action -> `400`
4. missing required fields -> `400`
5. disallowed extra fields are rejected or ignored explicitly
6. successful action calls only the intended Supabase operation(s)
7. service-role secret is never returned in the response
8. current direct-browser mutation remains in place until each specific action is migrated
9. the API function count remains `<= 12` after the route is added and other route removals are preserved

Suggested test patterns:
- use a mocked Supabase client or stubbed server-side helper injection
- assert exact `insert`/`update`/`delete` calls for each action
- assert no table name or filter comes from request body
- assert validation errors are generic and consistent
- assert the response for a success does not contain `SUPABASE_SERVICE_KEY`

## Current direct browser mutation inventory

The current browser code in index.html performs direct Supabase writes to the following tables:

- `tracked_items` — INSERT, UPDATE, DELETE
- `item_notes` — UPSERT, DELETE
- `bill_status_history` — INSERT
- `activity_log` — INSERT
- `team_members` — UPDATE, INSERT, DELETE via update(active=false)
- `tracked_keywords` — INSERT, DELETE
- `tracked_committees` — INSERT, DELETE
- `tracked_sponsors` — INSERT, DELETE
- `tracked_agencies` — INSERT, DELETE

This is a total of 16 table-operation combinations in direct browser writes, with more coupled multi-write user actions around tracked item and hearing status updates.

## More coupled / complex sequences than expected

The most coupled and complex sequences are:
- `checkHearingsForTrackedItems()` and `checkHearingForItem()`
  - update `tracked_items`
  - sometimes write `bill_status_history`
  - may update `activity_log`
  - refresh local UI state after the same operation
- `updateActionStatus()`
  - updates `tracked_items`
  - immediately inserts into `bill_status_history`
  - logs the action in `activity_log`
- `toggleSelection()`
  - inserts or deletes `tracked_items`
  - logs to `activity_log`
- `addTeamMember()` and `updateTeamMember()`
  - insert/update team members
  - then may update `tracked_items.assigned_to` values as a secondary write

These are not simple single-table mutations and are the reason the implementation should migrate a small configuration-style slice first rather than the immediate migration of the broadest item-tracking workflow.

## Summary

The future route should be strict, action-based, and tied to existing server-side session validation. The best first slice is the tracking configuration tables (keywords/committees/sponsors/agencies) because they are small, coherent, and less entangled with status-history writing than `tracked_items` operations.
