# DC Policy Tracker

A self-hosted web application for tracking DC Council legislation and DC Register notices relevant to your organization's policy work. Built on Vercel (serverless), Supabase (database), and the DC Council LIMS API.

---

## What It Does

- **Browse and search** all DC Council bills and resolutions via the LIMS API
- **Track items** you care about — LIMS bills and DC Register manual entries
- **Monitor status changes** automatically via a daily cron job
- **Search by sponsor, committee, or keyword** across all legislation in the current council period
- **Email reports** — morning daily, end-of-day update (only if there were changes), and Monday weekly
- **Alert emails** sent at 8am when a tracked LIMS bill changes status, gets a hearing scheduled, or has its title updated — only fires for `Action Needed` and `Monitor & Assess` items, and only when the LIMS status string actually changes

---

## Tech Stack

| Layer | Service | Purpose |
|---|---|---|
| Frontend + API | [Vercel](https://vercel.com) | Hosts the app and serverless API routes |
| Database | [Supabase](https://supabase.com) | Stores tracked items, status history, notes, keywords |
| Data source | [DC Council LIMS API](https://lims.dccouncil.gov) | Bill details, status, hearings |
| Email | Gmail SMTP (nodemailer) | Daily/weekly/EOD reports and alerts |
| Weekly report email | Resend API | Weekly report (pending migration to Microsoft Graph API) |

---

## Repository Structure

```
/
├── index.html                      # Single-page React app (entire frontend)
├── migration.sql                   # Full database schema — run once in Supabase SQL Editor
├── rls_migration.sql               # Row Level Security policies — run after migration.sql
├── vercel.json                     # Cron schedules and HTTP security headers
├── api/
│   ├── hello.js                    # LIMS proxy (handles CORS)
│   ├── check-password.js           # Password gate endpoint — issues session tokens
│   ├── check-hearings.js           # Daily cron: checks LIMS bills for changes, sends alerts
│   ├── send-daily-report.js        # Cron: morning email report (Mon–Fri 8:30am ET)
│   ├── send-eod-report.js          # Cron: end-of-day report if any updates (Mon–Fri 5pm ET)
│   ├── send-weekly-report.js       # Cron: weekly summary (Monday 5pm ET)
│   ├── build-bill-cache.js         # Cron + manual: builds LIMS bill cache for search
│   └── backfill-status-history.js  # One-time utility — DELETE FROM REPO AFTER USE
```

> **`backfill-status-history.js` should be deleted from the repository after the one-time backfill is run.** Leaving a permanently deployed endpoint with no ongoing purpose is unnecessary attack surface.

---

## Supabase Database Schema

Run `migration.sql` then `rls_migration.sql` (both in the repo root) in the Supabase SQL Editor before first deploy. All statements use `IF NOT EXISTS` so both files are safe to re-run.

### Core tables

**`tracked_items`** — Bills and notices you are actively monitoring.

| Column | Type | Notes |
|---|---|---|
| id | text PK | UUID |
| title | text | Bill title (auto-updated from LIMS) |
| bill_number | text | e.g. B26-0042 |
| category | text | Bill, Resolution, etc. |
| status | text | Current LIMS status |
| action_status | text | `action_needed`, `monitor_and_assess`, `action_completed` |
| priority | text | `high`, `medium`, `low` |
| assigned_to | text | Team member name |
| committees | text | Referred committee(s) |
| introduced_by | text | Primary sponsor |
| co_introducers | text | Co-sponsors |
| next_hearing_date | timestamptz | Upcoming hearing if any |
| hearing_type | text | e.g. Public Hearing |
| hearing_location | text | |
| latest_activity_date | timestamptz | Most recent LIMS activity date |
| latest_activity_label | text | Description of latest activity |
| manual_summary | text | Your notes/summary (manual entries) |
| additional_information | text | LIMS additionalInformation field |
| committee_re_referral | jsonb | Array of re-referral objects |
| is_manual_entry | boolean | True for DC Register items |
| tracked_at | timestamptz | When you added it to the tracker |

**`bill_status_history`** — Audit log of every status change, hearing notice, title change, and tracker status change.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| item_id | text | FK → tracked_items.id |
| old_status | text | Previous value |
| new_status | text | New value |
| change_label | text | Human-readable description |
| changed_at | timestamptz | Wall-clock time the change was detected |

**`item_notes`** — Free-text notes per tracked item.

**`tracked_keywords`** — Keywords that trigger alerts when new matching bills are introduced.

**`tracked_committees`** — Committees to watch.

**`tracked_sponsors`** — Sponsors to watch.

**`team_members`** — List of assignable team members.

**`lims_bill_cache`** — Local cache of all LIMS bill details, used for sponsor/committee search.

**`lims_cache_cursor`** — Tracks progress of incremental cache build.

---

## Environment Variables

Set all of these in Vercel under **Settings → Environment Variables**.

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | ✅ | Your Supabase project URL (e.g. `https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | ✅ | Supabase service role key — server-side API functions only, never sent to the browser |
| `CRON_SECRET` | ✅ | Strong passphrase authorizing manual API calls; also used to sign session tokens |
| `APP_PASSWORD` | ✅ | Shared password staff use to access the tracker app |
| `GMAIL_USER` | ✅ | Gmail address used to send reports |
| `GMAIL_APP_PASSWORD` | ✅ | 16-character Gmail app password ([generate here](https://myaccount.google.com/apppasswords)) |
| `DAILY_REPORT_TO` | ✅ | Recipient email(s) for daily and EOD reports (comma-separated) |
| `WEEKLY_REPORT_TO` | ✅ | Recipient email(s) for weekly report (comma-separated) |
| `RESEND_API_KEY` | ⚠️ | Required for weekly report until Microsoft Graph migration is complete |

> **Note on email:** The weekly report currently uses Resend. Daily, EOD, and alert emails use Gmail SMTP. A migration to Microsoft Graph API is planned to unify all sending under organizational accounts.

---

## Security

### How it works

**Password gate** — the app requires a shared password before rendering anything. `/api/check-password` validates the password against `APP_PASSWORD` and issues a signed 8-hour session token stored in `sessionStorage`. Sessions expire automatically when the browser tab closes or after 8 hours.

**Row Level Security (RLS)** — `rls_migration.sql` enables Supabase RLS on all tables and grants the anon key (used in the browser) only the specific operations each table needs. Server-side-only tables (`lims_cache_cursor`, `keyword_alert_log`) have no anon policies at all — the browser cannot touch them. `lims_bill_cache` is read-only from the browser. Anyone who extracts the anon key from DevTools can only perform the same operations as a logged-in user.

**Service role key is server-side only** — `SUPABASE_SERVICE_KEY` exists only in Vercel environment variables and is used exclusively in API functions. It never reaches the browser.

**HTTP security headers** — `vercel.json` sets `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and a `Content-Security-Policy` that restricts script loading to known CDNs (unpkg, jsDelivr, Tailwind).

**API authorization** — all cron and utility endpoints require `Authorization: Bearer CRON_SECRET`. Requests without a valid secret return 401.

### New deployment security checklist

- [ ] GitHub repository is set to **private**
- [ ] MFA enabled on GitHub, Vercel, and Supabase accounts
- [ ] `APP_PASSWORD` set in Vercel and shared only with authorized staff
- [ ] `CRON_SECRET` is a strong unique passphrase (not reused from other projects)
- [ ] `rls_migration.sql` has been run in Supabase SQL Editor
- [ ] Supabase → Authentication → Settings: "Enable sign ups" is **disabled**
- [ ] Supabase database password saved securely (e.g. 1Password)
- [ ] `backfill-status-history.js` deleted from repo after one-time use

### Credential rotation

When rotating credentials (staff departure, suspected compromise, etc.):

1. Update `APP_PASSWORD` and/or `CRON_SECRET` in Vercel → Environment Variables
2. Redeploy so new values take effect (existing sessions will expire within 8 hours)
3. Inform active staff of the new app password
4. If `SUPABASE_SERVICE_KEY` was exposed, regenerate it in Supabase → Settings → API and update the Vercel variable immediately

---

## Cron Schedule

| Job | Schedule | What it does |
|---|---|---|
| `build-bill-cache` | Midnight ET daily | Refreshes LIMS bill cache |
| `check-hearings` | 8:00am ET Mon–Fri | Checks all tracked LIMS bills for status/hearing/title changes; sends alert email if any `action_needed` or `monitor_and_assess` items changed |
| `send-daily-report` | 8:30am ET Mon–Fri | Sends morning email with full tracked item status |
| `send-eod-report` | 5:00pm ET Mon–Fri | Sends EOD email only if there were updates that day |
| `send-weekly-report` | 5:00pm ET Monday | Sends weekly summary with 30-day updates |

---

## Initial Setup (New Deployment)

### 1. Create a private GitHub repository and push the code

### 2. Enable MFA on GitHub, Vercel, and Supabase before proceeding

### 3. Deploy to Vercel

1. Import the repository in Vercel
2. Set all environment variables listed above
3. Deploy

### 4. Set up Supabase

1. Create a new Supabase project
2. Save the database password somewhere secure
3. Open the **SQL Editor** and run `migration.sql`
4. Run `rls_migration.sql`
5. Go to **Authentication → Settings** and disable "Enable sign ups"

### 5. Build the bill cache

The sponsor and committee search features require a local cache of all LIMS bills. Run this PowerShell loop once after first deploy (takes ~15–20 minutes):

```powershell
$secret  = "YOUR_CRON_SECRET"
$headers = @{ "Authorization" = "Bearer $secret" }
$baseUrl = "https://YOUR-APP.vercel.app/api/build-bill-cache"

# Initialize
$r    = Invoke-WebRequest -Uri "$baseUrl`?reset=true" -Method POST -Headers $headers -UseBasicParsing
$body = $r.Content | ConvertFrom-Json
Write-Host "Initialized: $($body.total) items found"

# Run until complete
do {
    Start-Sleep 5
    $r    = Invoke-WebRequest -Uri $baseUrl -Method POST -Headers $headers -UseBasicParsing
    $body = $r.Content | ConvertFrom-Json
    Write-Host "$($body.position)/$($body.total) — $($body.status)"
} while ($body.status -eq "in_progress")
```

### 6. Backfill status history

Run once to seed `bill_status_history` for all currently tracked items:

```powershell
Invoke-WebRequest -Uri "https://YOUR-APP.vercel.app/api/backfill-status-history" -Method POST -Headers @{ "Authorization" = "Bearer YOUR_CRON_SECRET" } -UseBasicParsing
```

After confirming it ran successfully, **delete `backfill-status-history.js` from the repository**.

---

## Manual Triggers (PowerShell)

```powershell
$headers = @{ "Authorization" = "Bearer YOUR_CRON_SECRET" }
$base    = "https://YOUR-APP.vercel.app/api"

# Morning daily report
Invoke-WebRequest -Uri "$base/send-daily-report" -Method POST -Headers $headers -UseBasicParsing

# EOD report (only sends if updates exist today)
Invoke-WebRequest -Uri "$base/send-eod-report" -Method POST -Headers $headers -UseBasicParsing

# Weekly report
Invoke-WebRequest -Uri "$base/send-weekly-report" -Method POST -Headers $headers -UseBasicParsing

# Run hearing check manually
Invoke-WebRequest -Uri "$base/check-hearings" -Method POST -Headers $headers -UseBasicParsing

# Rebuild bill cache from scratch
Invoke-WebRequest -Uri "$base/build-bill-cache?reset=true" -Method POST -Headers $headers -UseBasicParsing
```

---

## Adapting for a New Council Period

When DC Council begins a new period (e.g. Period 27), update the following:

1. **`build-bill-cache.js`** — change `COUNCIL_PERIOD = 26` to the new period number and adjust the bill number ranges (`B27-`, `PR27-`, etc.)
2. **`index.html`** — search for `council_period_id: 26` and update to the new period
3. **Rebuild the cache** using the PowerShell loop above with `?reset=true`

---

## Key Design Decisions

**Why a local bill cache?** The LIMS `SearchLegislation` API caps results at ~100 items regardless of pagination. The cache iterates bill numbers directly (B26-0001 through B26-1500, PR26-0001 through PR26-1000) to ensure complete coverage of all legislation in the council period.

**Why `bill_status_history` uses wall-clock dates?** LIMS activity dates reflect when things were introduced or scheduled, not when they changed — a hearing notice can be posted today but show a date two weeks in the future. The `changed_at` column records when the cron actually detected the change, giving reports a reliable "status since" date.

**Why is `check-hearings` separate from the daily report?** It runs at 8am and the report at 8:30am to ensure status data is fresh before the report sends. It also sends a focused alert email listing only the changed items. Alert emails only go out for LIMS bills (not DC Register manual entries) and only when the LIMS status string literally changes, so you may go stretches without receiving one if your tracked bills are quiet.

**Why a shared password instead of user accounts?** The tracker is an internal tool used by a small team. A full authentication system would add significant complexity for minimal benefit. A shared app password with time-limited session tokens provides meaningful access control without requiring individual accounts, password resets, or an identity provider.

---

## Troubleshooting

**Password screen appears even after entering the correct password**
→ Confirm `APP_PASSWORD` is set in Vercel environment variables and that a redeploy has happened since adding it. Also confirm `CRON_SECRET` is set — it doubles as the session signing key.

**Supabase returning 403 errors for normal app operations**
→ RLS is blocking the request. Confirm `rls_migration.sql` ran successfully. Check policies in Supabase → Authentication → Policies.

**Sponsor/committee search returns no results**
→ The bill cache hasn't been built yet. Run the PowerShell build loop in the setup steps.

**"Status Since" shows today's date for all items**
→ Expected after the backfill runs. Future changes will carry accurate detection timestamps.

**EOD report returns `{"sent":false,"reason":"no_updates"}`**
→ Nothing changed today. Expected on quiet days.

**Hearing notice not showing up after publish**
→ `check-hearings` runs at 8am ET. Trigger a manual check via PowerShell if the notice appeared after that.

**500 error on a report endpoint**
→ Check Vercel's **Logs** tab for the full stack trace. Wrap the PowerShell call in a try/catch to read the response body.

**Reports stopped arriving entirely**
→ Common causes: expired Gmail app password, Supabase service key rotated without updating Vercel, or a code error introduced in a recent deploy. Check Vercel Logs for the relevant cron invocation.
