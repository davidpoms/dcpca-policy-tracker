[README.md](https://github.com/user-attachments/files/25751261/README.md)
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
| Email | Gmail SMTP (nodemailer) | Daily/weekly/EOD reports |
| Weekly report email | Resend API | Weekly report (pending migration to Microsoft Graph API) |

---

## Repository Structure

```
/
├── index.html                    # Single-page React app (entire frontend)
├── api/
│   ├── hello.js                  # LIMS proxy (handles CORS)
│   ├── check-hearings.js         # Daily cron: checks LIMS status + hearings, sends alert emails on change
│   ├── send-daily-report.js      # Cron: morning email report (Mon–Fri 8:30am ET)
│   ├── send-eod-report.js        # Cron: end-of-day report if any updates (Mon–Fri 5pm ET)
│   ├── send-weekly-report.js     # Cron: weekly summary (Monday 5pm ET)
│   ├── build-bill-cache.js       # Cron + manual: builds LIMS bill cache for search
│   └── backfill-status-history.js # One-time utility: seeds bill_status_history
└── vercel.json                   # Cron schedules
```

---

## Supabase Database Schema

Run `migration.sql` (included in the root of the repository) in the Supabase SQL Editor before first deploy. All statements use `IF NOT EXISTS` so it is safe to re-run on an existing database.

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

Set all of these in the Vercel project settings under **Settings → Environment Variables**.

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | ✅ | Your Supabase project URL (e.g. `https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | ✅ | Supabase service role key (not the anon key) |
| `CRON_SECRET` | ✅ | A secret string to authorize manual API calls (e.g. any strong passphrase) |
| `GMAIL_USER` | ✅ | Gmail address used to send reports |
| `GMAIL_APP_PASSWORD` | ✅ | 16-character Gmail app password ([generate here](https://myaccount.google.com/apppasswords)) |
| `DAILY_REPORT_TO` | ✅ | Recipient email(s) for daily and EOD reports (comma-separated) |
| `WEEKLY_REPORT_TO` | ✅ | Recipient email(s) for weekly report (comma-separated) |
| `RESEND_API_KEY` | ⚠️ | Required for weekly report until Microsoft Graph migration |

> **Note on email:** The weekly report currently uses Resend. Daily, EOD, and alert emails use Gmail SMTP. A migration to Microsoft Graph API is planned to unify all email sending under organizational accounts.

---

## Cron Schedule

| Job | Schedule | What it does |
|---|---|---|
| `build-bill-cache` | Midnight ET daily | Refreshes LIMS bill cache |
| `check-hearings` | 8:00am ET Mon–Fri | Checks all tracked LIMS bills for status/hearing/title changes; sends a focused alert email if any `action_needed` or `monitor_and_assess` items changed |
| `send-daily-report` | 8:30am ET Mon–Fri | Sends morning email with full tracked item status |
| `send-eod-report` | 5:00pm ET Mon–Fri | Sends EOD email only if there were updates that day |
| `send-weekly-report` | 5:00pm ET Monday | Sends weekly summary with 30-day updates |

---

## Initial Setup (New Deployment)

### 1. Fork and deploy to Vercel

1. Push the code to a GitHub repository
2. Import the repository in Vercel
3. Set all environment variables listed above
4. Deploy

### 2. Set up Supabase

1. Create a new Supabase project
2. Open the **SQL Editor**
3. Run the contents of `migration.sql`

### 3. Build the bill cache

The sponsor and committee search features require a local cache of all LIMS bills. Run this PowerShell loop once after first deploy (takes ~15–20 minutes):

```powershell
$secret = "YOUR_CRON_SECRET"
$headers = @{ "Authorization" = "Bearer $secret" }
$baseUrl = "https://YOUR-APP.vercel.app/api/build-bill-cache"

# Initialize
$r = Invoke-WebRequest -Uri "$baseUrl`?reset=true" -Method POST -Headers $headers -UseBasicParsing
$body = $r.Content | ConvertFrom-Json
Write-Host "Initialized: $($body.total) bills — $($body.message)"

# Run until complete
do {
    Start-Sleep 5
    $r = Invoke-WebRequest -Uri $baseUrl -Method POST -Headers $headers -UseBasicParsing -ErrorAction Stop
    $body = $r.Content | ConvertFrom-Json
    Write-Host "$($body.position)/$($body.total) — upserted: $($body.upserted) skipped: $($body.skipped) — $($body.status)"
} while ($body.status -eq "in_progress")
```

### 4. Backfill status history

Run once to seed `bill_status_history` with a baseline entry for all currently tracked items (required for the "Status Since" date in reports to show correctly):

```powershell
Invoke-WebRequest -Uri "https://YOUR-APP.vercel.app/api/backfill-status-history" -Method POST -Headers @{ "Authorization" = "Bearer YOUR_CRON_SECRET" } -UseBasicParsing
```

---

## Manual Triggers (PowerShell)

Replace `YOUR_CRON_SECRET` and the URL with your own values in all commands.

```powershell
$headers = @{ "Authorization" = "Bearer YOUR_CRON_SECRET" }
$base = "https://YOUR-APP.vercel.app/api"

# Trigger morning daily report
Invoke-WebRequest -Uri "$base/send-daily-report" -Method POST -Headers $headers -UseBasicParsing

# Trigger EOD report (only sends if there were updates today)
Invoke-WebRequest -Uri "$base/send-eod-report" -Method POST -Headers $headers -UseBasicParsing

# Trigger weekly report
Invoke-WebRequest -Uri "$base/send-weekly-report" -Method POST -Headers $headers -UseBasicParsing

# Manually run hearing check
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

**Why is `check-hearings` separate from the daily report?** It runs at 8am and the report at 8:30am to ensure status data is fresh before the report sends. It also sends a focused alert email listing only the changed items — separate from the full daily report — so changes surface immediately without having to scan the full briefing. Alert emails only go out for LIMS bills (not DC Register manual entries) and only when the LIMS status string literally changes, so you may go stretches without receiving one if your tracked bills are quiet.

---

## Troubleshooting

**Sponsor/committee search returns no results**
→ The bill cache hasn't been built yet. Run the PowerShell build loop above.

**"Status Since" shows today's date for all items**
→ The backfill ran today (expected). The date will reflect actual detection times for all future changes.

**EOD report returns `{"sent":false,"reason":"no_updates"}`**
→ No status changes, new hearings, or newly tracked items were recorded in `bill_status_history` or `tracked_items` today. This is expected on quiet days.

**Hearing notice not showing up after publish**
→ `check-hearings` runs at 8am ET. If the notice was published after that, click the **📅 Check Hearings** button in the app to trigger an immediate check, then run the EOD report manually if needed.

**500 error on a report endpoint**
→ Add a try/catch to the handler (see `send-daily-report.js` for the pattern) and redeploy. The error message will appear in the JSON response body. Also check Vercel's **Logs** tab for the full stack trace.
