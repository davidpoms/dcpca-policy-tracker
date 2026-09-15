# AUTH_RLS_PLAN.md

## 1. Exact current trust boundary and data flow

This application is currently split between a browser-only shared-password gate and a browser-connected Supabase client that accesses database tables directly with the Supabase publishable/anon key.

Current flow:

1. The browser loads [index.html](index.html).
2. The page calls `/api/client-config` and receives only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` from [api/client-config.js](api/client-config.js).
3. The browser creates a Supabase client with that publishable key and uses it for direct browser-side reads and writes.
4. Before the app renders the dashboard, the user is prompted for the shared app password.
5. The browser posts to [api/check-password.js](api/check-password.js), which validates against `APP_PASSWORD`.
6. On success, the API returns a random opaque token and an 8-hour expiry timestamp.
7. That token is stored in `sessionStorage` in the browser.
8. There is no server-side validation of that token in the current codebase.
9. The app then continues by using the Supabase browser client directly. The browser is effectively acting as an authenticated user as far as the database is concerned, because the publishable key and RLS policies determine access.

Important boundary: the login check is a UI gate, not the actual database authorization boundary.

The true authorization boundary today is:

- anonymous browser client with the publishable key
- plus RLS rules in [rls-migration.sql](rls-migration.sql)

The server-side secret `CRON_SECRET` protects cron/manual API jobs, but it does not protect browser Supabase reads/writes. `SUPABASE_SERVICE_KEY` is server-side only and is not exposed to the browser.

---

## 2. Inventory of current browser database operations by table and permission

This inventory is based on [index.html](index.html), [rls-migration.sql](rls-migration.sql), and the current database schema in [migration.sql](migration.sql).

### tracked_items

Browser operations performed in [index.html](index.html):
- SELECT: yes
- INSERT: yes
- UPDATE: yes
- DELETE: yes

Examples:
- read initial list: `.from('tracked_items').select('*').order('tracked_at', { ascending: false })`
- update tracked item fields: `.from('tracked_items').update({ ... }).eq('id', itemId)`
- insert new tracked item: `.from('tracked_items').insert({ ... })`
- delete tracked item: `.from('tracked_items').delete().eq('id', itemId)`

Current RLS in [rls-migration.sql](rls-migration.sql):
- SELECT TO anon USING (true)
- INSERT TO anon WITH CHECK (true)
- UPDATE TO anon USING (true) WITH CHECK (true)
- DELETE TO anon USING (true)

### item_notes

Browser operations performed:
- SELECT: yes
- INSERT: yes
- UPDATE: yes
- DELETE: yes

Current RLS:
- SELECT/INSERT/UPDATE/DELETE all allowed to anon

### bill_status_history

Browser operations performed:
- SELECT: yes
- INSERT: yes
- UPDATE: no
- DELETE: no

Current RLS:
- SELECT TO anon USING (true)
- INSERT TO anon WITH CHECK (true)
- no browser update/delete

### team_members

Browser operations performed:
- SELECT: yes
- INSERT: yes
- UPDATE: yes
- DELETE: not explicitly in the browser logic, but the schema allows it via RLS policy if configured elsewhere

Current RLS:
- SELECT TO anon USING (true)
- UPDATE TO anon USING (true) WITH CHECK (true)
- insert/delete are described as managed via dashboard or service role, but the browser code itself includes insert/update flows for team members.

### tracked_keywords

Browser operations performed:
- SELECT: yes
- INSERT: yes
- DELETE: yes

Current RLS:
- SELECT/INSERT/DELETE all allowed to anon

### tracked_committees

Browser operations performed:
- SELECT: yes
- INSERT: yes
- DELETE: yes

Current RLS:
- SELECT/INSERT/DELETE all allowed to anon

### tracked_sponsors

Browser operations performed:
- SELECT: yes
- INSERT: yes
- DELETE: yes

Current RLS:
- SELECT/INSERT/DELETE all allowed to anon

### tracked_agencies

Browser operations performed:
- SELECT: yes
- INSERT: yes
- DELETE: yes

Current RLS:
- SELECT/INSERT/DELETE all allowed to anon

### lims_bill_cache

Browser operations performed:
- SELECT: yes
- INSERT: no browser insert path in the app; reads are used for search suggestions
- UPDATE: no
- DELETE: no

Current RLS:
- SELECT TO anon USING (true)
- server-side writes only via cron/service role

### activity_log

Browser operations performed:
- SELECT: yes
- INSERT: yes
- UPDATE: no
- DELETE: no

Current RLS:
- SELECT TO anon USING (true)
- INSERT TO anon WITH CHECK (true)

### lims_cache_cursor

Browser operations performed:
- none

Current RLS:
- no anon access

### keyword_alert_log

Browser operations performed:
- none

Current RLS:
- no anon access

### Summary

The browser does direct SELECT/INSERT/UPDATE/DELETE work against the core application state tables, according to the RLS policy model. The browser is not merely reading data; it is mutating it directly.

---

## 3. Which browser operations genuinely need to happen from the browser?

This is the practical question for the auth/RLS boundary.

Browser-only operations that are genuinely user-facing and should remain in the browser:

- reading the current tracked-item list for display
- reading notes and activity log for display
- reading lookup tables such as committees, sponsors, agencies, team members
- local UI actions that are not sensitive:
  - sort/filtering
  - selection state
  - temporary drafts
  - presentation-only data

Browser operations that should not remain direct anonymous writes if we want a real auth boundary:

- insert/update/delete on `tracked_items`
- insert/update/delete on `item_notes`
- insert on `bill_status_history`
- update/delete on `team_members`
- insert/delete on `tracked_keywords`
- insert/delete on `tracked_committees`
- insert/delete on `tracked_sponsors`
- insert/delete on `tracked_agencies`
- insert/update/delete on `activity_log` if it is treated as operational audit data

The tricky distinction is that some of these are user-driven data-entry operations and are legitimate browser interactions, but they should be mediated by server endpoints or authenticated user sessions rather than being open to direct anonymous browser writes.

A realistic minimal boundary is:

- keep read-only browsing and lookup data available to the browser as needed
- require a real authenticated session for mutations and administrative updates
- leave static reference data and simple list reads open only if that is explicitly acceptable for the application

---

## 4. Comparison of remediation approaches

### Approach A: Keep the shared-password UX, but create a real server-validated session and move protected database mutations/reads behind Vercel API routes

This keeps the current staff workflow: one shared password, simple staff access, no per-user identity required.

Security improvement:
- Moderate to high, if implemented correctly
- The real boundary becomes server-issued session validation rather than browser-only sessionStorage
- Protected database writes/reads move behind API endpoints that validate the session and use the service role or a restricted server-side client
- Browsers no longer use the anon key for sensitive mutation paths

Code churn:
- Medium
- Requires a server-side session store or signed token validation helper
- Requires moving writes from direct Supabase calls in [index.html](index.html) to Vercel API endpoints
- Needs audit of every mutation path

Operational complexity:
- Moderate
- A shared session system needs secure cookie or header handling and expiry enforcement
- Still feasible for a small internal app

Impact on current shared-team workflow:
- Low
- Keeps the existing shared-team password behavior, which is attractive for a small team

Preview/dev testing implications:
- Good
- Preview environments can use the same pattern with distinct Vercel env vars and separate preview Supabase projects
- Easy to test with local mock auth or explicit server-side session validation

Migration risk:
- Moderate
- Requires moving direct browser writes to API handlers and validating all affected mutation paths
- Must be done carefully so existing features do not break

Future support for individual users/audit attribution:
- Limited
- Can be extended with user IDs later, but this approach is not inherently individual-user aware
- Good for a shared-team workflow, not a full IAM system

### Approach B: Adopt Supabase Auth and use authenticated RLS policies

This is the more conventional multi-user auth model.

Security improvement:
- High
- The browser operates with a real Supabase user session and RLS policies are tied to authenticated identities
- Stronger long-term signal for individual users and audit attribution

Code churn:
- High
- Requires reworking sign-in flow, session lifecycle, and potentially redirect/login UX
- Requires more changes in the browser client and database policies

Operational complexity:
- High
- Requires managing Supabase auth config, email or magic-link flows, external identity provider setup, or custom auth if the team wants password-based sign-in
- More moving parts in Preview/dev/staging

Impact on current shared-team workflow:
- Moderate to high
- A shared-password workflow is simpler for a tiny internal tool, but Supabase Auth brings more identity plumbing

Preview/dev testing implications:
- Good in principle, but there are more moving parts in preview environments
- Separate projects help isolate, but auth config still needs to be aligned across preview and production

Migration risk:
- High
- Because the browser app and table RLS policies are tightly coupled to current patterns, moving to Supabase Auth is a larger change than the server-session approach

Future support for individual users/audit attribution:
- Excellent
- This is the better long-term fit for audit trails and per-user accountability

---

## 5. Recommended approach for this specific small internal application

Recommended approach: Approach A — keep the shared-password UX, but create a real server-validated session and move protected database mutations/reads behind Vercel API routes.

Why this is the best fit here:

- The application is small, internal, and shared-team oriented.
- The current design already uses a shared app password and a simple session token model.
- The highest-value improvement is not migrating to a whole identity framework, but creating a genuine server-side authorization boundary.
- It is the least complex change that meaningfully reduces risk while preserving the existing product workflow.
- It is easier to implement in a phased PR sequence and easier to test in Preview versus a full Supabase Auth migration.

This recommendation is a deliberate tradeoff:

- It does not create per-user identity or attribution on day one.
- It does not fully replace the need for tighter RLS later if the app grows.
- But it creates a real authorization boundary without forcing the project to adopt a much heavier auth platform.

The key principle is: the browser should not directly mutate the application state using the public anon key when the app has a staff-only shared password flow.

---

## 6. Proposed phased PR-sized implementation sequence with rollback points

### PR 1 — Session boundary and API read/write split (no UX rewrite)

Scope:
- add a server-side session validation route or helper
- keep the current login password flow but make the token server-validated during protected API calls
- move only the most sensitive mutations behind Vercel API routes
- leave existing UI behavior intact

Why first:
- establishes the real auth boundary
- addresses the most material risk quickly

Rollback point:
- if API mutation coverage is incomplete, revert the route migration and keep the pre-existing browser mutation behavior while retaining the server validation helper in place for later use

Tests required before merge:
- valid shared-password login returning a token
- expired token rejected
- malformed session rejected
- protected mutation endpoint rejects missing/invalid session
- happy-path mutation through API succeeds

What should not change in this PR:
- no change to the user-facing login screen beyond the session semantics
- no change to the database schema
- no change to RLS policies yet
- no change to mail/report logic
- no change to browser dashboard behavior beyond API route usage

### PR 2 — Move the highest-risk browser writes behind protected endpoints

Scope:
- tracked item create/update/delete
- note create/update/delete
- keyword/committee/sponsor/agency add/delete flows
- audit log insertion via server endpoints

Rollback point:
- revert the mutation route wiring while preserving the server-issued session layer

Tests required before merge:
- each mutation route rejects unauthenticated clients
- each mutation endpoint returns structured errors on invalid data
- happy-path tests for each major mutation type

### PR 3 — Tighten RLS and browser access

Scope:
- reduce anon access to only the truly read-only or low-risk operations that remain browser-safe
- keep any remaining browser writes constrained to a narrow set of allowed tables

Rollback point:
- revert RLS tightening and keep the API boundary in place while the team reevaluates trusted browser access

Tests required before merge:
- policy tests showing anonymous clients cannot do forbidden writes
- regression tests for required browser read flows

### PR 4 — Optional later improvement: per-user identity or Supabase Auth

Scope:
- only after the app is stabilized and if the team wants individuals and audit attribution

Rollback point:
- maintain server session approach while deferred

Tests required:
- user-level access tests
- audit attribution checks

---

## 7. Tests to add before each phase

Required before Phase 1:
- login success/failure tests
- token expiry tests
- malformed token rejection tests
- protected endpoint rejection tests
- request/response contract tests for the session validation helper

Required before Phase 2:
- mutation endpoint tests for create/update/delete behaviors
- authorization tests for all high-risk browser actions
- regression tests ensuring the UI still renders with the same data contract

Required before Phase 3:
- RLS policy tests against the target Supabase project
- anonymous-write rejection tests
- read-only browser operations still work as expected

Required before Phase 4:
- per-user role and ownership checks
- audit attribution validation

---

## 8. Explicitly identify what should NOT be changed in the first implementation PR

The first implementation PR should avoid the following:

- Do not rewrite the browser login screen or UX model beyond adding server-side session validation.
- Do not change [index.html](index.html) behavior beyond replacing direct sensitive writes with API-backed calls where required.
- Do not change [migration.sql](migration.sql).
- Do not change [rls-migration.sql](rls-migration.sql) in the first PR, unless it is a follow-up to ensure safety after the API route split.
- Do not change the data model or add new schema objects.
- Do not refactor report or mail logic.
- Do not touch [api/check-password.js](api/check-password.js) beyond what is necessary to support a server-validated session if the team decides to keep that flow.
- Do not change the server-side cron jobs or their auth requirements.
- Do not implement Supabase Auth in the first PR.

---

## 9. Assumptions that require a product decision

The following points require a deliberate decision from the project owner before the implementation plan is finalized:

1. Is the application intended to remain a shared-team tool with one staff password, or does it need individual user identities in the near term?
2. Is there appetite for a server-issued session approach without migrating to Supabase Auth immediately?
3. Should the browser remain allowed to read most data directly, or should read paths also be moved behind authenticated API routes for full separation?
4. Are there any admin workflows that truly require service-role writes from the browser or should all writes be API-mediated?
5. Is there a formal expectation for audit attribution, or is the main concern simply preventing anonymous direct writes?

If the answer is “shared team, not per-user audit,” then Approach A is the least complex and most appropriate option.

If the answer is “individual accountability is required,” then Approach B becomes the better long-term direction, but it should be scheduled after the smaller server-session boundary is in place.

---

## Bottom line

The current app is not using the password screen as a true database authorization boundary. The browser directly accesses Supabase with the publishable key and broad RLS permissions. The least complex solution that creates a genuine boundary is to keep the existing shared-password UX, add server-validated sessions, and move sensitive writes behind Vercel API routes before tightening RLS. This preserves the current shared-team workflow while materially reducing the security risk.
