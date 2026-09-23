# DCPCA Policy Tracker — Technical Debt Audit

Audit date: 2026-09-22
Base commit: `bb6009c`

Status update (2026-09-23): SEC-01 and SEC-02 below are resolved. Authenticated fixed server actions now cover browser data access, anonymous tracker/cache reads have been removed, `/api/hello` is session/cron authenticated with three fixed LIMS contracts, and the browser Supabase client has been removed. Their original findings remain for audit history.

## Executive Summary

Phase 2 closed the most urgent integrity gap: the browser no longer accesses application tables directly. Signed, HttpOnly sessions gate explicit `/api/app-data` actions, and canonical RLS no longer permits anonymous tracker/cache access. Phase 3 also separated the browser LIMS helpers and the page shell from the application entry.

The two material security boundary gaps identified in this audit have since been closed. Remaining work is primarily product architecture and operations.

Council Period 27 is the nearest product risk. Interactive LIMS search is period-selectable, but the cache builder and cron keyword search are hard-coded to 26. Tracked B26/PR26 records do not have a separate council-period field and should remain independently trackable; changing active discovery must not become a bulk data migration or a filter that hides historical work.

The redesign should establish explicit lifecycle and queue concepts before its navigation becomes durable. Current `action_status` is simultaneously a workflow status, a report segment, and an alert eligibility rule, while urgency is inferred independently from activity, hearing, deadline, priority, and assignment fields.

## Resolved Since Prior Audit

- **Signed session boundary for mutations.** `lib/session.js` signs an expiring HMAC cookie and makes it HttpOnly and SameSite=Strict; `/api/app-data` validates it before accepting POSTs (`lib/session.js:20-87`, `api/app-data.js:39-49`, `api/app-data.js:135-175`).
- **Browser table writes migrated.** `frontend/app.jsx` uses the explicit app-data transport for mutation paths, while `api/app-data.js` has a fixed 27-action allowlist and exact request-key validation (`frontend/api-client.js:3-11`, `api/app-data.js:3-36`).
- **Anonymous write policies tightened in canonical RLS.** `rls-migration.sql` drops anonymous and legacy public write policies for application tables and recreates read policies only (for example `rls-migration.sql:14-25`, `29-40`, `44-50`).
- **Hearing persistence schema reconciliation.** `tracked_items.hearing_checked_at` is canonical `timestamptz` (`migration.sql:29-45`) and has an additive versioned migration.
- **Activity timestamps repaired.** `activity_log.created_at` is canonical `timestamptz` (`migration.sql:166-173`), with a UTC-preserving versioned conversion and New York display handling in the UI.
- **Browser LIMS helpers have explicit boundaries.** Normalization, activity/timeline, and browser hearing selection are separate same-origin classic scripts; `index.html` is now a shell and `frontend/app.jsx` is the Babel entry. Characterization tests intentionally protect browser versus cron differences (`PHASE3_LIMS_CHARACTERIZATION.md:3-15`).

## Current Findings

### SEC-01 — RESOLVED: anonymous read policies exposed the internal tracker dataset

- **Severity:** High — security risk / redesign prerequisite
- **Area:** Data-access boundary
- **Evidence:** The browser initializes a Supabase client from a public configuration endpoint and directly selects `tracked_items`, `item_notes`, tracking criteria, `team_members`, `bill_status_history`, `activity_log`, and `lims_bill_cache` (`api/client-config.js:1-13`, `frontend/app.jsx:304-420`, `frontend/app.jsx:613-646`). Canonical RLS grants `TO anon USING (true)` reads on those tables, including notes and team members (`rls-migration.sql:25`, `40`, `49`, `65`, `79`, `93`, `107`, `121`, `135`, `149`, `164`).
- **Why it matters:** Anyone with the public Supabase URL/key can read staff notes, assignment, activity/history, tracking criteria, and team email addresses without passing the password screen. The write boundary is fixed, but the password screen is not a confidentiality boundary for these reads.
- **Recommended direction:** Introduce session-gated server read endpoints or a real user identity/RLS model, then remove browser access to staff-only tables. Define which discovery/cache data may remain public before exposing it.
- **Blocks redesign:** Yes, before a richer Work Queue or assignment workflow increases sensitive content.
- **Before Council 27:** Recommended; it is not mechanically required for rollover.

### SEC-02 — RESOLVED: `/api/hello` was an unauthenticated, caller-parameterized LIMS proxy

- **Severity:** High — security and operational risk
- **Area:** Server API boundary
- **Evidence:** The route enables `Access-Control-Allow-Origin: *`, accepts `endpoint`, `method`, and `body` from POST or query parameters, concatenates the endpoint onto the LIMS PublicData base URL, and forwards it with `LIMS_API_KEY` (`api/hello.js:1-57`). It has no signed-session or endpoint/method allowlist check. Browser callers use it for council periods, search, and detail reads (`frontend/api-client.js:13-31`, `frontend/app.jsx:423-443`, `590-784`).
- **Why it matters:** The fixed LIMS hostname prevents generic SSRF, but any Internet caller can consume the credentialed LIMS proxy and invoke any LIMS PublicData operation the key permits. This can exhaust quota, make abuse hard to attribute, and exposes upstream error bodies through the route (`api/hello.js:59-80`).
- **Recommended direction:** Define the actual browser operations, then make the route session-gated and enforce a narrow path/method/body schema per operation. Preserve caller-specific response semantics behind a small server contract instead of retaining a generic proxy.
- **Blocks redesign:** Yes; Discover will increase traffic and add sources.
- **Before Council 27:** Yes, especially if cache/search traffic rises.

### CP-01 — Active discovery and keyword monitoring are hard-coded to Council 26

- **Severity:** High — current rollover blocker
- **Area:** Council-period handling / operations
- **Evidence:** `api/build-bill-cache.js` fixes `COUNCIL_PERIOD = 26`, generates only `B26-`/`PR26-` identifiers, and stores its cursor under 26 (`api/build-bill-cache.js:25-32`, `106-142`, `207-212`). `api/check-hearings.js` also fixes `COUNCIL_PERIOD = 26` for keyword `SearchLegislation` (`api/check-hearings.js:19-26`, `400-413`). README rollover instructions still describe manual source edits (`README.md:259-270`).
- **Why it matters:** Interactive search can select a period, but scheduled discovery will continue finding only Council 26 items after rollover. Cache freshness and keyword alerts will silently diverge from the UI.
- **Recommended direction:** Establish one configuration source for the *active discovery period*, its bill/resolution namespaces and ranges, and make cache/cursor/keyword jobs consume it. Retain period-specific cache rows and cursors during transition.
- **Blocks redesign:** Yes, for a Discover experience that promises current candidates.
- **Before Council 27:** Yes.

### CP-02 — Tracked-item lifecycle is not distinct from the active discovery period

- **Severity:** High — redesign prerequisite / Council 27 design blocker
- **Area:** Domain model
- **Evidence:** `tracked_items` has `bill_number` but no council-period, lifecycle, archived-at, closed-at, or source-record identity columns (`migration.sql:7-45`). The UI merges LIMS results with tracked records by ID and preserves tracking fields (`frontend/app.jsx:690-708`, `755-770`); untracking physically deletes the record (`api/app-data.js:715-733`).
- **Why it matters:** B26/PR26 items need to remain monitored while active discovery moves to 27. Today that distinction is implicit in identifier strings and an `action_completed` label, which cannot represent retained historical, closed, ignored, or archived records safely.
- **Recommended direction:** Define lifecycle states and retention rules separately from a current-period setting. Decide whether all source types carry a normalized period, and whether archive is a lifecycle transition rather than deletion.
- **Blocks redesign:** Yes.
- **Before Council 27:** The design decision is required; implementation should precede navigation that filters by period or archive.

### OPS-01 — Scheduled work has no run ledger, overlap control, retry policy, or failure notification

- **Severity:** High — operational risk
- **Area:** Crons and reliability
- **Evidence:** Five schedules run from `vercel.json:2-22`, including hearings at 13:00 UTC and a daily report at 13:30 UTC. Jobs authenticate with repeated bearer comparisons, fetch external services without AbortController deadlines, and rely on console output/HTTP response handling (`api/check-hearings.js:37-74`, `api/build-bill-cache.js:43-84`, `api/send-daily-report.js:21-30`). Hearing checks catch errors per item and continue (`api/check-hearings.js:184-272`); cache builds advance a shared cursor after a batch (`api/build-bill-cache.js:113-214`). No table records a run start, finish, partial failure, notification outcome, or last known-good cache.
- **Why it matters:** A slow or overlapping hearing run can collide with reporting, duplicated manual invocations can race the cursor, and operators cannot distinguish a quiet day from a failed job. Retry after a partial run can resend emails because report delivery has no idempotency record.
- **Recommended direction:** Add a minimal server-side job-run/lease model, bounded upstream timeouts, structured summaries, and an alert on terminal failure/staleness. Confirm schedule-count and duration behavior against the actual Vercel plan before depending on the cadence.
- **Blocks redesign:** Not initially, but blocks dependable queue and alert promises.
- **Before Council 27:** Yes for cache/keyword job observability; the rest can follow in small slices.

### OPS-02 — Email delivery uses two active transports and duplicated report composition

- **Severity:** Medium — operational and maintainability debt
- **Area:** Email/reporting
- **Evidence:** `check-hearings.js` imports Nodemailer and sends Gmail SMTP alerts (`api/check-hearings.js:17`, `145-164`, `345-389`, `476-481`). Daily, EOD, and weekly reports import the Microsoft Graph mailer (`api/send-daily-report.js:14`, `api/send-eod-report.js:8`, `api/send-weekly-report.js:15`, `lib/mailer.js:1-47`). Each report constructs its own HTML and recipient/config handling. `package.json` declares no dependencies or lockfile, despite the Nodemailer import.
- **Why it matters:** Credentials, failure behavior, sender identity, and delivery observability differ by job. The undeclared Nodemailer dependency is a deployment reproducibility risk. Reports also encode the current action-status taxonomy directly.
- **Recommended direction:** Choose and document one delivery provider, make dependencies reproducible, centralize transport and recipient policy, then factor common report primitives only after the new lifecycle/queue definitions exist.
- **Blocks redesign:** Should be addressed during redesign, before changing report semantics.
- **Before Council 27:** Fix dependency reproducibility and document the active sender; full consolidation can wait.

### DATA-01 — History, audit, and assignment relationships can drift or orphan

- **Severity:** Medium — data integrity risk
- **Area:** Schema
- **Evidence:** `item_notes.item_id` correctly references `tracked_items` with cascade (`migration.sql:54-61`), but `bill_status_history.item_id` and `activity_log.item_id` have no foreign key (`65-75`, `166-179`). `tracked_items.assigned_to` is free text rather than a team-member identity (`migration.sql:22`, `79-84`); the team rename action compensates by patching rows by old name (`api/app-data.js:886-929`).
- **Why it matters:** Deleted/untracked items can leave history and audit rows whose relationship cannot be verified. Renames and duplicate-like names make assignment reporting fragile. A future Archive should retain an intentional audit relation, not depend on accidental orphaning.
- **Recommended direction:** Define retention and attribution semantics first. Then add identifiers/foreign keys or explicit nullable historical references through additive, backfilled migrations; do not cascade-delete audit history by default.
- **Blocks redesign:** Yes for Archive and accountable assignments.
- **Before Council 27:** Design now; migration can accompany lifecycle work.

### DATA-02 — Workflow, urgency, and source facts are overloaded into nullable fields and duplicated flags

- **Severity:** Medium — redesign prerequisite
- **Area:** Workflow/status model
- **Evidence:** `tracked_items` defaults `action_status` to `action_needed`, priority to `medium`, assignment to `Unassigned`, and stores independent activity/hearing/deadline fields (`migration.sql:22-45`). UI filters and controls hard-code the three action-status values (`frontend/app.jsx:1209-1212`, `1387-1392`, `1817-1829`, `2075-2088`). Alert eligibility and reports also filter `action_needed`/`monitor_and_assess` (`api/check-hearings.js:214-249`; report handlers).
- **Why it matters:** “Action Needed” is used as a persistent disposition and a near-term queue signal, while priority, hearing, deadline, `has_new_activity`, and last activity supply competing urgency signals. Reports and alerts will change unintentionally if labels are renamed without an adapter period.
- **Recommended direction:** Define immutable source facts, persistent lifecycle/workflow state, ownership, and derived urgency separately. Keep compatibility mapping for old status values in APIs, filters, email, and history during transition.
- **Blocks redesign:** Yes.
- **Before Council 27:** The semantic contract should be decided first; a safe migration may follow rollover.

### LIMS-01 — Latest-activity extraction is duplicated; hearing differences are intentionally distinct

- **Severity:** Medium — maintainability debt
- **Area:** LIMS integration
- **Evidence:** Browser `extractLatestActivityDate` in `frontend/lims-activity.js:3-56` and cron `extractLatestActivityDate` in `api/check-hearings.js:88-124` collect the same ordered candidate sources and labels but return different shapes. Browser and cron hearing selection remain different by design: browser returns earliest future or latest past and supports more fallbacks, while cron returns only a future committee hearing/markup (`frontend/lims-hearings.js`; `api/check-hearings.js:126-140`). Characterization tests explicitly preserve both contracts.
- **Why it matters:** Identical activity logic can drift through maintenance. Conversely, unifying hearing logic would change browser UI or alert semantics.
- **Recommended direction:** Extract only characterization-proven candidate collection into a server/browser-compatible pure artifact once the zero-build loading contract is chosen. Keep hearing selection separate unless product semantics change intentionally.
- **Blocks redesign:** No.
- **Before Council 27:** Safe to defer.

### FE-01 — `DCPolicyTracker` remains a single high-coupling feature controller

- **Severity:** Medium — redesign prerequisite
- **Area:** Frontend architecture
- **Evidence:** `frontend/app.jsx` is 2,182 lines. `DCPolicyTracker` owns roughly 67 state values/setters, data loading, Supabase reads, LIMS search, hearing progress, all mutations, export/email preview, filters, and most presentation (`frontend/app.jsx:229-1350`, `1394-2182`). Only `HearingReportPanel` and `ActivityLogModal` are presentation components (`111-227`).
- **Why it matters:** New Work Queue, Tracked, Discover, and Archive views will otherwise share a large mutable `items` collection and handlers coupling source search, tracking, selection, and UI panels. Small visual extractions alone do not solve this.
- **Recommended direction:** Establish domain data seams first: tracker repository/read model, discovery result model, lifecycle actions, and queue derivation. Then extract feature sections that consume explicit props while state remains in the controller, one CI/Preview slice at a time.
- **Blocks redesign:** Yes.
- **Before Council 27:** Start the data seam, but UI component migration can be staged.

### FE-02 — Browser direct reads and source-sliced tests constrain the next frontend boundary

- **Severity:** Medium — maintainability debt
- **Area:** Frontend/testing
- **Evidence:** The browser directly calls Supabase for its read model (`frontend/app.jsx:304-420`, `613-646`), while tests evaluate or source-slice the classic scripts and Babel entry (`tests/browser-lims-normalization.test.js`, `tests/lims-characterization.test.js`, `tests/security-regressions.test.js`). `index.html` intentionally uses CDN React, Babel, Tailwind, Supabase, and classic scripts before `frontend/app.jsx`.
- **Why it matters:** Moving reads server-side or splitting presentation changes both the data contract and static-test locations. The zero-build arrangement is viable, but global script order and browser/server helper compatibility must remain explicit.
- **Recommended direction:** Keep pure browser helpers as classic scripts for now. When extracting a read client, add contract tests at the new boundary and update source-location guards rather than weakening them.
- **Blocks redesign:** Yes, paired with SEC-01.
- **Before Council 27:** Not by itself.

### DOC-01 — README and AUTH/RLS plan materially contradict the deployed architecture

- **Severity:** Medium — operational/documentation debt
- **Area:** Documentation drift
- **Evidence:** README says the frontend is entirely `index.html`, documents Gmail/Resend and a pending Graph migration, and says anon browser access remains unchanged (`README.md:25-45`, `126-144`). `AUTH_RLS_PLAN.md` still describes sessionStorage, browser writes, and anon INSERT/UPDATE/DELETE policies (`AUTH_RLS_PLAN.md:5-19`, `50-175`). Current code uses an HttpOnly signed cookie, app-data mutations, Graph for reports, and canonical read-only anon policies.
- **Why it matters:** An operator following these docs can configure the wrong mail stack, make an incorrect RLS change, or misunderstand the production security boundary.
- **Recommended direction:** Replace these documents with a concise current deployment/access runbook after deciding the read-boundary target. Keep Phase 2/3 maps as implementation records, not operational truth.
- **Blocks redesign:** No, but should be corrected before handoff or broader staff use.
- **Before Council 27:** Yes for rollover and mail/runbook instructions.

### LEG-01 — The repository still contains an obsolete, unsafe DCRegs prototype route

- **Severity:** Medium — security/maintenance debt
- **Area:** Dead or obsolete code
- **Evidence:** `api/scrape-dcregs.js` is publicly CORS-enabled, reads a caller-supplied `limit`, requires ScrapingBee, constructs a URL containing its API key, and is not scheduled or called by the current frontend (`api/scrape-dcregs.js:1-42`; `vercel.json:2-22`; `frontend/app.jsx`). The separately proven DCRegs feasibility work is explicitly on another spike branch and should not be merged implicitly.
- **Why it matters:** This route conflicts with the validated direction (direct Vercel access, no ScrapingBee requirement), can consume paid proxy traffic, and is outside the current session/auth posture.
- **Recommended direction:** Remove or disable the legacy route in its own security-reviewed slice. Design production DCRegs ingestion from the spike’s bounded, authenticated, read-only lessons rather than reviving this prototype.
- **Blocks redesign:** No, but it should not survive into a Discover launch.
- **Before Council 27:** Recommended if the deployment exposes it.

## Council Period 27 Readiness

**Must complete before active discovery rolls over**

1. Replace the hard-coded 26 configuration in cache building and cron keyword search with a controlled active-period source; carry bill/resolution range policy with it.
2. Prove a transition run: build/use the 27 cache while retaining the 26 cache and cursor, then verify keyword alerts search 27.
3. Decide lifecycle/archive handling so B26/PR26 items remain visible and monitored independently of selected discovery period.
4. Update the runbook, including current UTC schedules, manual cache recovery, credentials, and exact 27 activation steps.
5. Add job-run visibility/alerting for cache freshness and failed keyword discovery.

**Verified as already period-ready**

- Browser search loads available periods from LIMS and passes the selected ID to LIMS/cache queries (`frontend/app.jsx:423-431`, `590-646`, `729-784`).
- Hearing checks load all tracked non-manual items by their existing bill number, so they do not need B26 records deleted or reassigned to continue monitoring (`api/check-hearings.js:173-185`).

## Redesign Preconditions

### Must address before redesign

1. Close the read confidentiality gap (SEC-01) and constrain/authenticate the LIMS proxy (SEC-02).
2. Define the lifecycle, archive, and active-discovery-period contract (CP-01, CP-02, DATA-02).
3. Establish a tracker read model/API boundary so new views do not depend on anonymous raw-table reads (SEC-01, FE-02).
4. Decide history/audit retention and stable assignment identity before Archive and ownership views (DATA-01).
5. Add minimum job health/lease observability before Work Queue relies on automated updates (OPS-01).

### Should address during redesign

- Replace overloaded action-status vocabulary through a backward-compatible adapter in filters, history, alerts, and reports.
- Split `DCPolicyTracker` along data-domain seams, then move presentation sections with small prop contracts.
- Consolidate mail transport/configuration and rebuild reports around lifecycle and urgency.
- Specify discovery candidate provenance, Track/Ignore decisions, and future DCRegs source boundaries.

### Safe to defer

- Sharing latest-activity helper mechanics once browser/server loading is deliberately designed.
- Further classic-script/component extraction that does not establish a useful domain boundary.
- UI cleanup not required by the Work Queue/Tracked/Discover/Archive contract.

## Suggested Implementation Sequence

1. **Security boundary:** session-gate and narrow `/api/hello`; add server read contracts for staff data; test anonymous direct reads are denied after the corresponding RLS migration. Deploy Preview first.
2. **Council rollover:** introduce one active-period configuration and controlled 26→27 cache/keyword transition; add run status and cache freshness diagnostics; validate Preview with both periods retained.
3. **Domain contract:** write and test lifecycle, archive, urgency, ownership, and discovery-candidate invariants. Add no UI redesign until the compatibility mapping for current `action_status` is explicit.
4. **Data migration:** add lifecycle/period/identity fields additively, backfill B26/PR26, and preserve history/audit retention. Preview validation must include existing manual and LIMS items.
5. **Read-model/frontend:** create explicit Work Queue, Tracked, Discover, and Archive read models; migrate one feature section at a time from `DCPolicyTracker` without altering queue semantics.
6. **Automation/reporting:** lease/record cron runs, add bounded retries/timeouts and failure notification, then consolidate email transport and redesign report templates.
7. **DCRegs production design:** separately convert the feasibility spike into an authenticated, bounded ingestion design after deciding candidate provenance and notice-text requirements. Do not merge the spike wholesale.

Each slice should remain branch → CI → Preview → merge, with production rollout only after targeted data, RLS, and cron checks pass.

## Items Investigated but Not Considered Current Debt

- **Browser direct writes:** none found outside `/api/app-data`; existing static guards cover migrated tracked-item and activity-log paths.
- **Anonymous write policies:** no canonical anon/public INSERT, UPDATE, or DELETE policy remains for browser tables examined. This does not resolve anonymous read exposure.
- **Signed mutation session:** the cookie is signed, HttpOnly, SameSite=Strict, short-lived, and verified server-side. This audit found no regression in that mechanism.
- **Browser versus cron hearing selection:** differences are intentional and characterized. Cron selects only a future committee hearing/markup, whereas browser preserves richer display/fallback behavior. Do not unify them by name alone.
- **DCRegs feasibility:** the successful direct-fetch/issue-enumeration spike is future architecture evidence only. It is not part of this branch’s production design.
- **`activity_log.created_at` timezone:** canonical schema and versioned migration now use `timestamptz`; the UI safely renders legacy UTC wall-clock values in `America/New_York`.

## Finding Count

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 5 |
| Medium | 8 |
| Low | 0 |
