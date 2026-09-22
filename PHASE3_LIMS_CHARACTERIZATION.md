# Phase 3 Stage 1: LIMS characterization

`tests/fixtures/lims-characterization.json` and `tests/lims-characterization.test.js` freeze the existing browser and cron behavior independently. They are characterization tests, not a shared parsing contract.

The browser tests evaluate date-dependent `isNewItem` source from `frontend/app.jsx`, normalization from `frontend/lims-normalization.js`, latest-activity and timeline logic from `frontend/lims-activity.js`, and browser hearing selection from `frontend/lims-hearings.js` inside a small VM. All three same-origin classic LIMS scripts load before the Babel entry and expose helpers through `window.DCPCAFrontend`. The cron tests evaluate the separate `api/check-hearings.js` source with mocked fetch and mail. API contracts are unchanged. The test clock is 2026-09-21 12:00 UTC; the test worker uses UTC for formatted dates. The cron delay is skipped only in the test harness.

Phase 3 API client Stage 1 adds `frontend/api-client.js` after the three LIMS scripts and before Babel. Its `window.DCPCAFrontend.appDataRequest(payload)` performs only the existing `/api/app-data` JSON POST and returns the raw response. Every caller in `frontend/app.jsx` retains its own response parsing, failure handling, and React state timing, including action-status partial success and best-effort hearing/activity calls.

API client Stage 2 also places the existing `/api/hello` `proxyFetch` implementation in `frontend/api-client.js`. It still sends the outer JSON POST without an explicit credentials option, parses every response as JSON, and logs and rethrows `data.error` or request/parsing failures. Council-period, search, and hearing callers keep their separate UI errors, per-keyword continuation, and hearing error handling in `frontend/app.jsx`.

Frontend modularization Stage 4A makes `index.html` the page shell and moves its unchanged Babel body into `frontend/app.jsx`, the single JSX entry loaded after the four classic helper scripts. State, request callers, and rendering still live together in that entry; source-inspecting tests now read `frontend/app.jsx`.

The first React presentation extraction keeps `HearingReportPanel` in `frontend/app.jsx`. `DCPolicyTracker` still owns hearing state, ordering, persistence, progress, and the visibility condition; the panel receives only hearing data, the ordered upcoming list, checking state, and recheck/close callbacks.

Fixtures that protect intentional differences:

| Fixture | Browser behavior | Cron behavior |
| --- | --- | --- |
| `hn26_0162` | Future introduction is `Introduced` activity and a future timeline event; no hearing from empty committee arrays | Future `Introduced` activity; no hearing |
| `past_only` | Selects the latest past hearing for display | Returns no hearing |
| `markup_divergence` | Uses markup `hearingDate` and LIMS `hearingType` | Uses `committeeActionDate` and `Committee Markup` |
| `flat_fallback`, `history_fallback` | Can select a flat or action/history hearing date | Does not use those fallbacks |
| `competing_ties` | Keeps a sorted display timeline, including future events | Returns only the latest activity date and label; equal-date candidate ordering is retained |

`empty_invalid` and `malformed_actions` record null/invalid handling and the current non-array `actions` failure. Search fixtures protect array, text, JSON-text, and null committee/member values. Cron scenarios protect literal status changes, trimmed title comparison, new versus same-calendar-day hearings, old-value fallback for missing additional information and empty re-referrals, history order and payloads, PATCH fields, and whether email is sent. Browser and cron outputs are asserted separately so a later extraction cannot silently reconcile their differing policies.

The VM harness exercises extracted source snippets and a mocked cron invocation. It does not render React or contact LIMS, Supabase, or an email provider. Stage 2 should start only after these fixtures pass in CI and any proposed shared helper preserves both outputs independently.
