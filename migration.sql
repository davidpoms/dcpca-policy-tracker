-- DC Policy Tracker — Full Database Migration
-- Run this in the Supabase SQL Editor for a fresh installation.
-- Safe to re-run on an existing database; all statements use IF NOT EXISTS or ADD COLUMN IF NOT EXISTS.

-- ─── Core tracking table ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tracked_items (
  id                      text PRIMARY KEY,
  title                   text,
  bill_number             text,
  category                text,
  status                  text,
  last_status             text,
  committees              text,
  date                    text,
  description             text,
  link                    text,
  source                  text,
  agency                  text,
  introduced_by           text,
  co_introducers          text,
  assigned_to             text DEFAULT 'Unassigned',
  priority                text DEFAULT 'medium',
  action_status           text DEFAULT 'action_needed',
  is_new                  boolean DEFAULT false,
  is_manual_entry         boolean DEFAULT false,
  has_new_activity        boolean DEFAULT false,
  activity_summary        text,
  last_checked_at         timestamptz,
  tracked_at              timestamptz DEFAULT now(),
  notice_id               text,
  register_issue          text,
  register_notes          text,
  next_hearing_date       timestamptz,
  hearing_type            text,
  hearing_location        text,
  additional_information  text,
  manual_summary          text,
  committee_re_referral   jsonb,
  latest_activity_date    timestamptz,
  latest_activity_label   text,
  activity_count          integer DEFAULT 0,
  deadline                date,
  activity_timeline       jsonb
);

CREATE INDEX IF NOT EXISTS idx_tracked_items_tracked_at    ON tracked_items(tracked_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracked_items_action_status ON tracked_items(action_status);
CREATE INDEX IF NOT EXISTS idx_tracked_items_bill_number   ON tracked_items(bill_number);

-- ─── Notes ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS item_notes (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  item_id     text NOT NULL REFERENCES tracked_items(id) ON DELETE CASCADE,
  note_text   text,
  updated_at  timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_item_notes_item_id ON item_notes(item_id);

-- ─── Status history ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bill_status_history (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  item_id      text NOT NULL,
  old_status   text,
  new_status   text,
  change_label text,
  changed_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bill_status_history_item_id   ON bill_status_history(item_id);
CREATE INDEX IF NOT EXISTS idx_bill_status_history_changed_at ON bill_status_history(changed_at DESC);

-- ─── Team members ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS team_members (
  id     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name   text NOT NULL UNIQUE,
  active boolean DEFAULT true
);

-- ─── Search alert tables ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tracked_keywords (
  id       uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  keyword  text NOT NULL UNIQUE,
  added_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracked_committees (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  committee_name text NOT NULL UNIQUE,
  added_at       timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracked_sponsors (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  sponsor_name text NOT NULL UNIQUE,
  added_at     timestamptz DEFAULT now()
);

-- Prevents duplicate keyword alerts for the same bill+keyword combination
CREATE TABLE IF NOT EXISTS keyword_alert_log (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  bill_number text NOT NULL,
  keyword     text NOT NULL,
  alerted_at  timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_alert_log_unique ON keyword_alert_log(bill_number, keyword);

-- ─── LIMS bill cache (for sponsor/committee search) ───────────────────────────

CREATE TABLE IF NOT EXISTS lims_bill_cache (
  bill_number            text PRIMARY KEY,
  council_period_id      integer NOT NULL,
  title                  text,
  category               text,
  status                 text,
  introduced_by          text,
  co_introducers         text,
  committees             text,
  introduction_date      timestamptz,
  additional_information text,
  link                   text,
  raw_details            jsonb,
  cached_at              timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lims_bill_cache_period         ON lims_bill_cache(council_period_id);
CREATE INDEX IF NOT EXISTS idx_lims_bill_cache_introduced_by  ON lims_bill_cache(introduced_by);
CREATE INDEX IF NOT EXISTS idx_lims_bill_cache_co_introducers ON lims_bill_cache(co_introducers);
CREATE INDEX IF NOT EXISTS idx_lims_bill_cache_cached_at      ON lims_bill_cache(cached_at DESC);

-- Tracks progress of incremental cache build
CREATE TABLE IF NOT EXISTS lims_cache_cursor (
  council_period_id integer PRIMARY KEY,
  bill_numbers      jsonb NOT NULL DEFAULT '[]',
  position          integer NOT NULL DEFAULT 0,
  total             integer NOT NULL DEFAULT 0,
  completed         boolean NOT NULL DEFAULT false,
  started_at        timestamptz,
  updated_at        timestamptz DEFAULT now()
);
