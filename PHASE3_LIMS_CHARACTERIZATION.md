# Phase 3 Stage 1: LIMS characterization

`tests/fixtures/lims-characterization.json` and `tests/lims-characterization.test.js` freeze the existing browser and cron behavior independently. They are characterization tests, not a shared parsing contract.

The browser tests evaluate date-dependent `isNewItem` source from `index.html`, normalization from `frontend/lims-normalization.js`, latest-activity and timeline logic from `frontend/lims-activity.js`, and browser hearing selection from `frontend/lims-hearings.js` inside a small VM. All three same-origin classic scripts load before the inline Babel entry and expose helpers through `window.DCPCAFrontend`. The cron tests evaluate the separate `api/check-hearings.js` source with mocked fetch and mail. API contracts are unchanged. The test clock is 2026-09-21 12:00 UTC; the test worker uses UTC for formatted dates. The cron delay is skipped only in the test harness.

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
