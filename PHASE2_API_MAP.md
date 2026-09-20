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
