# Technical Debt Audit: DC Policy Tracker

## Verified current state

The following checks were verified against the current branch state rather than assuming historical findings are still open:

- Protected cron endpoints require an exact bearer secret check against `process.env.CRON_SECRET`; there is no remaining `x-vercel-cron` acceptance path in the current code.
- The browser login flow validates `APP_PASSWORD` and stores `{ token, expires }` in `sessionStorage` from [api/check-password.js](api/check-password.js) and [index.html](index.html).
- That opaque token is not validated server-side anywhere in the current branch; the session is not used to authorize Supabase queries or to gate database operations.
- Browser database access is still handled through the Supabase anon/publishable key and the RLS policies in [rls-migration.sql](rls-migration.sql).
- The initial migration defect around `activity_log` is already fixed in [migration.sql](migration.sql); the remaining issue is migration discipline and verifying schema history across environments.
- Browser configuration is no longer hardcoded; the frontend fetches `/api/client-config` and initializes Supabase from that response in [index.html](index.html).
- The cache builder now uses `process.env.VERCEL_URL` to call its own deployment, not a hardcoded production URL in [api/build-bill-cache.js](api/build-bill-cache.js).

---

## 1. Architecture and data flow

### Finding 1.1 — Single-file frontend remains a maintainability risk
- Status: OPEN
- Severity: High
- Relevant files: [index.html](index.html), [README.md](README.md)
- Why it matters: The app still runs as one large React/Babel script with business logic, parsing, filters, data loading, and UI rendering all mixed together. This increases review risk and makes feature changes fragile.
- Smallest reasonable remediation: Extract stable helpers and page sections into a few modules, without changing behavior.
- Regression tests that should exist before changing it: render smoke test for authenticated dashboard, a login flow smoke test, and filter logic tests.

### Finding 1.2 — LIMS parsing and status-transition logic is duplicated between client and server code
- Status: PARTIALLY RESOLVED
- Severity: Medium
- Relevant files: [index.html](index.html), [api/check-hearings.js](api/check-hearings.js), [api/send-daily-report.js](api/send-daily-report.js)
- Why it matters: The same concepts — latest activity detection, hearing extraction, and status comparison — still exist in both browser and server code, which creates drift risk. The duplication is smaller than before in the current branch, but it remains.
- Smallest reasonable remediation: Move shared parsing logic into a minimal utility layer and reuse it in both contexts.
- Regression tests that should exist before changing it: fixture-based LIMS payload tests for hearing and activity extraction.

---

## 2. Frontend structure and maintainability

### Finding 2.1 — `index.html` is still an application file, not a light static shell
- Status: OPEN
- Severity: High
- Relevant files: [index.html](index.html)
- Why it matters: The file is large, hand-written, and heavily nested. That is not a correctness bug by itself, but it makes change, review, and test coverage much harder.
- Smallest reasonable remediation: Minimal extraction of data and rendering helper functions while keeping the current UI shape intact.
- Regression tests that should exist before changing it: login screen test, dashboard load test, and a test for data fetch failure rendering.

### Finding 2.2 — Email generation templates remain hand-assembled HTML in multiple files
- Status: OPEN
- Severity: Medium
- Relevant files: [api/send-daily-report.js](api/send-daily-report.js), [api/send-eod-report.js](api/send-eod-report.js), [api/send-weekly-report.js](api/send-weekly-report.js), [api/check-hearings.js](api/check-hearings.js)
- Why it matters: The report HTML is large and repeated, which increases the odds of inconsistent formatting or logic changes across job types.
- Smallest reasonable remediation: Centralize shared formatting helpers and a minimal email layout helper.
- Regression tests that should exist before changing it: snapshot tests for representative daily and weekly HTML emails.

---

## 3. Authentication and authorization boundaries

### Finding 3.1 — Password gate is a client-side UX gate, not a true server-authorized database session
- Status: OPEN
- Severity: Critical
- Relevant files: [api/check-password.js](api/check-password.js), [index.html](index.html), [rls-migration.sql](rls-migration.sql)
- Why it matters: The current flow validates `APP_PASSWORD` and returns a random opaque token with expiry in `sessionStorage`. There is no server-side validation path for that token in the current codebase. The browser then talks directly to Supabase using the publishable key and RLS rules. In other words, the shared-password login is not used as the database authorization boundary; it only gates the UI. This is an important distinction.
- Smallest reasonable remediation: Keep the current login UX for now, but document the boundary clearly and add server-side session validation if the login is intended to authorize more than the UI. If database access must be protected by a true session, it needs a server-issued auth flow rather than a browser-only token.
- Regression tests that should exist before changing it: valid-password login, expired-token handling, invalid token rejection, and a test that browser-only auth does not pretend to authorize database access.

### Finding 3.2 — Protected cron endpoints now require only the exact bearer secret
- Status: RESOLVED
- Severity: Critical
- Relevant files: [api/build-bill-cache.js](api/build-bill-cache.js), [api/check-hearings.js](api/check-hearings.js), [api/send-daily-report.js](api/send-daily-report.js), [api/send-eod-report.js](api/send-eod-report.js), [api/send-weekly-report.js](api/send-weekly-report.js)
- Why it matters: The current code checks `req.headers['authorization'] === \'Bearer ${CRON_SECRET}\'` and does not accept `x-vercel-cron` or any other alternative. This is the expected security model for manual cron calls.
- Smallest reasonable remediation: Keep this requirement as-is and consider a shared auth helper to avoid future copy/paste drift.
- Regression tests that should exist before changing it: valid bearer test, missing header rejection, wrong scheme rejection, and spoofed `x-vercel-cron` rejection.

### Finding 3.3 — The browser session is not validated against a server-side session store
- Status: NEEDS VERIFICATION
- Severity: High
- Relevant files: [api/check-password.js](api/check-password.js), [index.html](index.html)
- Why it matters: The current code stores the token in `sessionStorage`, but there is no server-side session verification route or server-side token lookup. This means the app is relying on a client-only token for UX gating and not for database authorization.
- Smallest reasonable remediation: If this is meant to be a real access control mechanism, add server-side validation or move to a proper auth flow. If it is only UI gating, document it clearly and avoid implying it secures Supabase access.
- Regression tests that should exist before changing it: tests covering malformed session payloads, expiration, and that the UI does not grant data access without an authenticated client state.

---

## 4. Supabase/RLS security model

### Finding 4.1 — Browser anon policies remain broad enough to permit significant direct access from a leaked publishable key
- Status: OPEN
- Severity: Critical
- Relevant files: [rls-migration.sql](rls-migration.sql)
- Why it matters: The current RLS model grants anonymous clients SELECT/INSERT/UPDATE/DELETE access to a large set of tables: `tracked_items`, `item_notes`, `bill_status_history`, `tracked_keywords`, `tracked_committees`, `tracked_sponsors`, `tracked_agencies`, `team_members`, `activity_log`, and `lims_bill_cache` read access. A caller with the browser publishable key can perform those operations if the application allows it, subject to the table policies. The browser login is not a database auth boundary; the anon key is.
- Smallest reasonable remediation: Reduce anon permissions to the minimum required for the product’s actual browser workflow, and move sensitive writes to server-side endpoints where possible.
- Regression tests that should exist before changing it: RLS policy tests covering read/write limits for anon users and verifying that server-only tables remain inaccessible.

### Finding 4.2 — There are no foreign-key constraints on history/log rows
- Status: OPEN
- Severity: Medium
- Relevant files: [migration.sql](migration.sql), [rls-migration.sql](rls-migration.sql)
- Why it matters: The schema still allows `bill_status_history.item_id` and `activity_log.item_id` to be orphaned or inconsistent with `tracked_items.id` because the schema does not enforce a foreign key relationship.
- Smallest reasonable remediation: Add foreign keys or a server-side validation layer so history rows cannot point to missing items.
- Regression tests that should exist before changing it: attempt to insert invalid item IDs and assert rejection or cleanup.

### Finding 4.3 — The earlier fresh-install `activity_log` gap is already fixed in the current branch
- Status: RESOLVED
- Severity: High
- Relevant files: [migration.sql](migration.sql), [rls-migration.sql](rls-migration.sql)
- Why it matters: `activity_log` is present in the current `migration.sql` and is enabled in [rls-migration.sql](rls-migration.sql). That specific defect is no longer open on this branch. The remaining issue is not that the table is absent, but that there is still no formal migration history or environment validation process.
- Smallest reasonable remediation: Add a migration framework or schema check script to avoid future drift, while keeping the current table in place.
- Regression tests that should exist before changing it: an idempotent migration test verifying table presence in a clean database and a schema-coverage test for required tables.

---

## 5. Database schema/migration consistency

### Finding 5.1 — Migration discipline remains weak despite the `activity_log` fix
- Status: OPEN
- Severity: High
- Relevant files: [migration.sql](migration.sql), [rls-migration.sql](rls-migration.sql), [README.md](README.md)
- Why it matters: The project still relies on manually run SQL files rather than versioned schema migrations. This is a risk even though the current branch includes the `activity_log` table.
- Smallest reasonable remediation: Add a versioned migration directory and a schema validation script for each environment.
- Regression tests that should exist before changing it: schema drift test and a fresh install verification run.

### Finding 5.2 — Schema and RLS policy changes are still not enforced at deploy time
- Status: OPEN
- Severity: Medium
- Relevant files: [migration.sql](migration.sql), [rls-migration.sql](rls-migration.sql)
- Why it matters: The app can be deployed without an explicit check that the required tables and policies exist in the target Supabase project.
- Smallest reasonable remediation: Add a startup or deployment validation script that checks for required schema objects and fails loudly when they are missing.
- Regression tests that should exist before changing it: migration validation tests in CI and a preflight check on deployment.

---

## 6. LIMS integration and caching

### Finding 6.1 — Council period remains a hardcoded operational constant
- Status: OPEN
- Severity: Medium
- Relevant files: [api/build-bill-cache.js](api/build-bill-cache.js), [README.md](README.md), [index.html](index.html)
- Why it matters: `COUNCIL_PERIOD = 26` is still hardcoded in the cache builder and is part of the operational model. This is not an immediate security bug, but it is a correctness and maintenance risk during council transitions.
- Smallest reasonable remediation: Move council period to config and validate it at startup.
- Regression tests that should exist before changing it: a config validation test for council period and a test that fails when mismatch is present.

### Finding 6.2 — LIMS parsing logic remains duplicated across client and server code
- Status: PARTIALLY RESOLVED
- Severity: Medium
- Relevant files: [index.html](index.html), [api/check-hearings.js](api/check-hearings.js), [api/build-bill-cache.js](api/build-bill-cache.js)
- Why it matters: The pattern is still duplicated, though the app has already improved some of the logic. It remains a risk for drift between browser-visible and cron-generated data.
- Smallest reasonable remediation: Consolidate shared parsing logic in a utility module.
- Regression tests that should exist before changing it: fixture-based parsing tests covering multiple LIMS response variants.

### Finding 6.3 — Cache freshness is still not protected by a clear health check
- Status: OPEN
- Severity: Medium
- Relevant files: [api/build-bill-cache.js](api/build-bill-cache.js)
- Why it matters: The cache build remains operationally important but there is no strong health signal for stale or partial data beyond logs.
- Smallest reasonable remediation: Add a cache-health endpoint or a startup check that validates coverage and `cached_at` freshness.
- Regression tests that should exist before changing it: a partial-cache detection test and a stale-cache warning test.

---

## 7. Cron scheduling and timezone correctness

### Finding 7.1 — Timezone assumptions are still split between comments and actual runtime calculations
- Status: OPEN
- Severity: Medium
- Relevant files: [vercel.json](vercel.json), [README.md](README.md), [api/check-hearings.js](api/check-hearings.js), [api/send-daily-report.js](api/send-daily-report.js), [api/send-eod-report.js](api/send-eod-report.js), [api/send-weekly-report.js](api/send-weekly-report.js)
- Why it matters: The code and comments talk in ET terms while the Vercel cron schedule is defined in UTC. This still creates a maintenance risk even if the current branch is functionally operational.
- Smallest reasonable remediation: Centralize timezone logic and document the actual schedule conversion in one place.
- Regression tests that should exist before changing it: tests for ET-to-UTC conversion and schedule validation for the intended windows.

---

## 8. Email/report architecture

### Finding 8.1 — Email provider stack remains inconsistent and partially mixed
- Status: PARTIALLY RESOLVED
- Severity: High
- Relevant files: [api/_mailer.js](api/_mailer.js), [api/check-hearings.js](api/check-hearings.js), [api/send-daily-report.js](api/send-daily-report.js), [api/send-weekly-report.js](api/send-weekly-report.js), [README.md](README.md)
- Why it matters: There is a Microsoft Graph mailer, but [api/check-hearings.js](api/check-hearings.js) still uses Gmail SMTP and the README still documents a mixed stack in places. That is a real operational and maintenance risk.
- Smallest reasonable remediation: Standardize on one mail provider and one sender config path.
- Regression tests that should exist before changing it: provider smoke tests and config-validation tests for each email route.

### Finding 8.2 — Mail config validation is not fully consistent across routes
- Status: OPEN
- Severity: Medium
- Relevant files: [api/_mailer.js](api/_mailer.js), [api/check-hearings.js](api/check-hearings.js), [api/send-daily-report.js](api/send-daily-report.js), [api/send-eod-report.js](api/send-eod-report.js), [api/send-weekly-report.js](api/send-weekly-report.js)
- Why it matters: Some routes fail early; some warn and continue. This still hides operational failures and makes delivery reliability harder to understand.
- Smallest reasonable remediation: Add a single mail-config validation helper and fail clearly when required env vars are absent.
- Regression tests that should exist before changing it: tests for missing config and provider failure responses.

---

## 9. Duplicated code

### Finding 9.1 — Repeated boilerplate remains across protected routes
- Status: OPEN
- Severity: Medium
- Relevant files: [api/build-bill-cache.js](api/build-bill-cache.js), [api/check-hearings.js](api/check-hearings.js), [api/send-daily-report.js](api/send-daily-report.js), [api/send-eod-report.js](api/send-eod-report.js), [api/send-weekly-report.js](api/send-weekly-report.js)
- Why it matters: The authorization check and Supabase helper pattern are repeated across handlers. This is not unusual for small serverless code, but it is a maintenance risk and can drift if one route is changed without the others.
- Smallest reasonable remediation: Introduce a common helper for bearer-header validation and shared Supabase access logic.
- Regression tests that should exist before changing it: table-driven auth tests across all cron handlers.

### Finding 9.2 — Browser and server logic still duplicate LIMS-specific logic
- Status: PARTIALLY RESOLVED
- Severity: Medium
- Relevant files: [index.html](index.html), [api/check-hearings.js](api/check-hearings.js)
- Why it matters: The logic still exists in more than one place, even though the branch improved some of it. Shared behavior should be extracted when risk is clear.
- Smallest reasonable remediation: Build a small shared parsing module.
- Regression tests that should exist before changing it: parser fixture tests.

---

## 10. Hardcoded configuration

### Finding 10.1 — Browser hardcoded production Supabase configuration is resolved
- Status: RESOLVED
- Severity: High
- Relevant files: [index.html](index.html), [api/client-config.js](api/client-config.js)
- Why it matters: The current frontend fetches `/api/client-config` and initializes Supabase from environment-backed config rather than static production values.
- Smallest reasonable remediation: Keep this pattern and add config validation to fail clearly when values are absent.
- Regression tests that should exist before changing it: a test that missing config returns a clear error and prevents client initialization.

### Finding 10.2 — build-bill-cache no longer calls a hardcoded production deployment
- Status: RESOLVED
- Severity: High
- Relevant files: [api/build-bill-cache.js](api/build-bill-cache.js)
- Why it matters: It now uses `process.env.VERCEL_URL` and a same-deployment proxy URL, which is the correct Preview-isolated pattern.
- Smallest reasonable remediation: Keep this model and add a startup validation that fails if `VERCEL_URL` is missing.
- Regression tests that should exist before changing it: config validation tests for the deployment URL path.

### Finding 10.3 — Some operational examples still contain production-like URLs in comments and sample docs
- Status: PARTIALLY RESOLVED
- Severity: Low
- Relevant files: [README.md](README.md), [api/backfill-status-history.js](api/backfill-status-history.js)
- Why it matters: The app is better than it was historically, but examples and docs still contain deployment-style URLs and secret placeholders that can be copied under pressure.
- Smallest reasonable remediation: Standardize examples on generic placeholders and remove stale production examples where possible.
- Regression tests that should exist before changing it: repo-scanning checks for forbidden patterns and explicit production domains.

---

## 11. Dead/temporary/obsolete code

### Finding 11.1 — The one-time backfill utility still exists in the repo
- Status: PARTIALLY RESOLVED
- Severity: Medium
- Relevant files: [api/backfill-status-history.js](api/backfill-status-history.js), [README.md](README.md)
- Why it matters: The code still exists and is still deployed as part of the route set. The project documentation still says it should be removed after use, and there is no evidence it was deleted from the current branch. That is operational debt and an unnecessary route surface.
- Smallest reasonable remediation: Remove it if no longer needed or gate it to local-only use with a clear “do not deploy” annotation.
- Regression tests that should exist before changing it: a deploy guard that fails if one-off scripts remain in the default route set.

### Finding 11.2 — `test-mail.js` remains a utility script and is not clearly local-only
- Status: OPEN
- Severity: Low
- Relevant files: [api/test-mail.js](api/test-mail.js)
- Why it matters: It is valuable for debugging but should not be part of a production route contract or a default deployment scenario.
- Smallest reasonable remediation: Mark it local-only or move it outside the route set.
- Regression tests that should exist before changing it: route-set validation ensuring only intended production handlers are deployed.

---

## 12. Error handling and observability

### Finding 12.1 — Error handling remains inconsistent across cron handlers
- Status: OPEN
- Severity: High
- Relevant files: [api/check-hearings.js](api/check-hearings.js), [api/send-daily-report.js](api/send-daily-report.js), [api/send-eod-report.js](api/send-eod-report.js), [api/send-weekly-report.js](api/send-weekly-report.js)
- Why it matters: Some routes return clear JSON errors and others log and continue. That inconsistency makes production debugging slower and hides provider failures.
- Smallest reasonable remediation: Standardize an error contract and log format across the route handlers.
- Regression tests that should exist before changing it: error-path tests for missing config and downstream provider failures.

### Finding 12.2 — Logs are still ad hoc and not structured
- Status: OPEN
- Severity: Medium
- Relevant files: [api/*.js](api)
- Why it matters: Without consistent logging, it is harder to correlate a failed send or cache build with a specific request or environment state.
- Smallest reasonable remediation: Add a basic request ID and structured log helper.
- Regression tests that should exist before changing it: log-format tests for success and failure cases.

---

## 13. Testing gaps

### Finding 13.1 — There is still no meaningful automated tests for auth, LIMS parsing, or cron routes
- Status: OPEN
- Severity: Critical
- Relevant files: [package.json](package.json), [api/*.js](api), [index.html](index.html)
- Why it matters: The branch improvement reduced some obvious risk, but the application still has no real automated guard rails for auth behavior, cron security, schema assumptions, or parsing logic.
- Smallest reasonable remediation: Add a minimal test harness using the project’s existing runtime. Do not redesign the app; just add auth and parser tests first.
- Regression tests that should exist before changing it: route auth tests, parser tests, and a login dashboard smoke test.

### Finding 13.2 — The repo still lacks a CI safety check for secret leakage and production-domain leakage
- Status: OPEN
- Severity: High
- Relevant files: [package.json](package.json), [README.md](README.md)
- Why it matters: A scanning or lint step would catch the exact class of issue that caused the earlier secret exposure and preview/prod misconfiguration.
- Smallest reasonable remediation: Add a CI-level grep or secret-scan job to block suspicious patterns before deploy.
- Regression tests that should exist before changing it: a repository scan test that fails when a production URL or secret-like value is added accidentally.

---

## 14. Documentation/code discrepancies

### Finding 14.1 — The README is more current than some of the operational comments, but still not fully authoritative
- Status: PARTIALLY RESOLVED
- Severity: Medium
- Relevant files: [README.md](README.md), [api/*.js](api), [vercel.json](vercel.json)
- Why it matters: The README is improved, but some runtime comments still describe older assumptions and the project still lacks a single definitive source of truth for setup and deployment behavior.
- Smallest reasonable remediation: Keep the README as the current reference and add a short “source of truth” note or a deployment checklist script.
- Regression tests that should exist before changing it: a docs drift review in release checks.

---

## 15. Dependency/build-tooling issues

### Finding 15.1 — There is still no real build-validation harness beyond manual inspection
- Status: OPEN
- Severity: Medium
- Relevant files: [package.json](package.json), [index.html](index.html), [api/*.js](api)
- Why it matters: The app is small but still has no formal lint/test/build command. This is a risk even without a rewrite.
- Smallest reasonable remediation: Add a minimal `npm test` script and a syntax-health command to establish a baseline without changing runtime behavior.
- Regression tests that should exist before changing it: a CI command that runs auth/parser tests and validates syntax.

### Finding 15.2 — The current browser runtime still relies on Babel/React CDN loading and inline scripting
- Status: OPEN
- Severity: Medium
- Relevant files: [index.html](index.html), [vercel.json](vercel.json)
- Why it matters: This is not a current immediate failure, but it remains a valuable target for a later hardening pass to reduce runtime complexity and CSP exposure.
- Smallest reasonable remediation: Keep the current app stable but add a backlog item to move to a simpler static asset pipeline when feasible.
- Regression tests that should exist before changing it: startup smoke test for the page boot path.

---

## 16. Performance/scalability concerns

### Finding 16.1 — The report and hearing jobs still perform large, repeated data fetches and HTML rendering passes
- Status: OPEN
- Severity: Medium
- Relevant files: [api/check-hearings.js](api/check-hearings.js), [api/send-daily-report.js](api/send-daily-report.js), [api/send-eod-report.js](api/send-eod-report.js), [api/send-weekly-report.js](api/send-weekly-report.js)
- Why it matters: The app can scale for current volume, but as tracked items and history grow, the job volume can become slower and more expensive.
- Smallest reasonable remediation: Batch fetches and measure representative runtime before schedule changes or data volume growth.
- Regression tests that should exist before changing it: performance smoke tests under representative sample sizes.

### Finding 16.2 — Cache freshness still lacks explicit health validation
- Status: OPEN
- Severity: Medium
- Relevant files: [api/build-bill-cache.js](api/build-bill-cache.js)
- Why it matters: The search/cache system still assumes a healthy cursor and full coverage without a dedicated health signal.
- Smallest reasonable remediation: Add a cache-health check and fail clearly when the cache is stale or incomplete.
- Regression tests that should exist before changing it: partial-cache and stale-cache tests.

---

## 17. Accessibility and UX issues

### Finding 17.1 — The app remains visually rich but not strongly accessibility-tested
- Status: OPEN
- Severity: Medium
- Relevant files: [index.html](index.html)
- Why it matters: It relies on custom inline styles and complex interactive panels without an accessibility test harness.
- Smallest reasonable remediation: Add a basic accessibility review and keyboard/focus checks around the login and dashboard interactions.
- Regression tests that should exist before changing it: keyboard navigation and focus-order tests.

### Finding 17.2 — Error states are still limited in the browser UI
- Status: PARTIALLY RESOLVED
- Severity: Medium
- Relevant files: [index.html](index.html)
- Why it matters: The current frontend does display explicit login errors and a config failure message in initialization, which is an improvement. It still lacks a fuller user-visible error contract for stale data or failed load states.
- Smallest reasonable remediation: Add a standard “configuration failed / try again later” state and more explicit data-load failure messaging.
- Regression tests that should exist before changing it: UI tests for bad config and load failure states.

---

## 18. Feature opportunities that fit the existing product

### Opportunity 18.1 — Add an operational health view
- Status: OPEN
- Severity: Low
- Relevant files: [index.html](index.html), [api/*.js](api)
- Why it matters: The app already tracks status, cache, and reports; a health view would reduce operational uncertainty and help support a shared internal workflow.
- Smallest reasonable remediation: Add summary values for last successful cron run and last cache refresh.
- Regression tests that should exist before changing it: status-value tests for success and failure flows.

### Opportunity 18.2 — Add config validation and startup safety checks
- Status: PARTIALLY RESOLVED
- Severity: Low
- Relevant files: [api/client-config.js](api/client-config.js), [index.html](index.html), [README.md](README.md)
- Why it matters: This is partly addressed through `/api/client-config`, but there is still room for broader startup validation and more deterministic failure states.
- Smallest reasonable remediation: Add a preflight validation for required environment config and stale council period assumptions.
- Regression tests that should exist before changing it: config validation tests for missing env vars and successful startup path.

---

## Recommended Execution Order

1. Regression tests / CI needed before risky security changes
   - Add auth tests for bearer-secret routes and login/session behavior.
   - Add RLS and config validation tests.
   - Add secret-leak and production-domain scanning checks in CI.

2. Authentication and database authorization
   - Reconcile the shared-password login with the actual database auth boundary.
   - Tighten RLS for anon access where possible.
   - Clarify whether the session token is only a UI gate or a true server-authorized session.

3. Email-stack consolidation and dead-code removal
   - Standardize on one provider and one sender config path.
   - Remove or localize one-off scripts such as the backfill utility and test mail route.

4. Migration discipline
   - Adopt a migration or schema-check process even without a large framework.
   - Keep `activity_log` in the canonical migration and validate schema consistency across environments.

5. Frontend modularization
   - Extract stable helper logic and render patterns without changing the current user experience.
   - Keep the existing app intact while making review and test coverage easier.

6. Feature improvements
   - Add health/ops views, config warnings, and workflow enhancements after security and test gaps are covered.

---

## Bottom line

The current branch is materially improved compared with the historical state: it no longer hardcodes production browser Supabase config, it no longer accepts `x-vercel-cron` as an auth mechanism, and it includes the missing `activity_log` table in [migration.sql](migration.sql). However, the app still has a major conceptual gap: the front-end login is not the same as a database auth boundary. The browser still accesses Supabase through the publishable key and RLS, and the shared-password session is not used to authorize server/database actions. That distinction should remain explicit in documentation and release review.

The next priority is not a rewrite. It is a disciplined sequence of security and validation work: test coverage first, then auth/RLS boundary clarity, then provider cleanup and migration discipline, and only then broader maintainability or feature work.
