-- DC Policy Tracker — Row Level Security Migration
-- Run this after migration.sql.
-- Safe to re-run: uses DROP POLICY IF EXISTS before each CREATE POLICY.
--
-- What this does:
--   - Enables RLS on every table the app uses
--   - Grants the anon key (used in the browser) exactly the operations each table needs
--   - Server-side-only tables (lims_cache_cursor, keyword_alert_log) get no anon access
--   - lims_bill_cache is read-only from the browser
--   - The service role key (used in API functions) bypasses RLS and retains full access

-- ─── tracked_items ────────────────────────────────────────────────────────────

ALTER TABLE tracked_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read tracked_items"   ON tracked_items;
DROP POLICY IF EXISTS "anon can insert tracked_items" ON tracked_items;
DROP POLICY IF EXISTS "anon can update tracked_items" ON tracked_items;
DROP POLICY IF EXISTS "anon can delete tracked_items" ON tracked_items;

CREATE POLICY "anon can read tracked_items"   ON tracked_items FOR SELECT TO anon USING (true);
CREATE POLICY "anon can insert tracked_items" ON tracked_items FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can update tracked_items" ON tracked_items FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon can delete tracked_items" ON tracked_items FOR DELETE TO anon USING (true);

-- ─── item_notes ───────────────────────────────────────────────────────────────

ALTER TABLE item_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read item_notes"   ON item_notes;
DROP POLICY IF EXISTS "anon can upsert item_notes" ON item_notes;
DROP POLICY IF EXISTS "anon can update item_notes" ON item_notes;
DROP POLICY IF EXISTS "anon can delete item_notes" ON item_notes;

CREATE POLICY "anon can read item_notes"   ON item_notes FOR SELECT TO anon USING (true);
CREATE POLICY "anon can upsert item_notes" ON item_notes FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can update item_notes" ON item_notes FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon can delete item_notes" ON item_notes FOR DELETE TO anon USING (true);

-- ─── bill_status_history ──────────────────────────────────────────────────────

ALTER TABLE bill_status_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read bill_status_history"   ON bill_status_history;
DROP POLICY IF EXISTS "anon can insert bill_status_history" ON bill_status_history;

CREATE POLICY "anon can read bill_status_history"   ON bill_status_history FOR SELECT TO anon USING (true);
CREATE POLICY "anon can insert bill_status_history" ON bill_status_history FOR INSERT TO anon WITH CHECK (true);
-- No update or delete — history is immutable from the browser

-- ─── team_members ─────────────────────────────────────────────────────────────

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read team_members"   ON team_members;
DROP POLICY IF EXISTS "anon can update team_members" ON team_members;

CREATE POLICY "anon can read team_members"   ON team_members FOR SELECT TO anon USING (true);
CREATE POLICY "anon can update team_members" ON team_members FOR UPDATE TO anon USING (true) WITH CHECK (true);
-- Insert/delete managed via Supabase dashboard or service_role only

-- ─── tracked_keywords ─────────────────────────────────────────────────────────

ALTER TABLE tracked_keywords ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read tracked_keywords"   ON tracked_keywords;
DROP POLICY IF EXISTS "anon can insert tracked_keywords" ON tracked_keywords;
DROP POLICY IF EXISTS "anon can delete tracked_keywords" ON tracked_keywords;

CREATE POLICY "anon can read tracked_keywords"   ON tracked_keywords FOR SELECT TO anon USING (true);
CREATE POLICY "anon can insert tracked_keywords" ON tracked_keywords FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can delete tracked_keywords" ON tracked_keywords FOR DELETE TO anon USING (true);

-- ─── tracked_committees ───────────────────────────────────────────────────────

ALTER TABLE tracked_committees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read tracked_committees"   ON tracked_committees;
DROP POLICY IF EXISTS "anon can insert tracked_committees" ON tracked_committees;
DROP POLICY IF EXISTS "anon can delete tracked_committees" ON tracked_committees;

CREATE POLICY "anon can read tracked_committees"   ON tracked_committees FOR SELECT TO anon USING (true);
CREATE POLICY "anon can insert tracked_committees" ON tracked_committees FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can delete tracked_committees" ON tracked_committees FOR DELETE TO anon USING (true);

-- ─── tracked_sponsors ─────────────────────────────────────────────────────────

ALTER TABLE tracked_sponsors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read tracked_sponsors"   ON tracked_sponsors;
DROP POLICY IF EXISTS "anon can insert tracked_sponsors" ON tracked_sponsors;
DROP POLICY IF EXISTS "anon can delete tracked_sponsors" ON tracked_sponsors;

CREATE POLICY "anon can read tracked_sponsors"   ON tracked_sponsors FOR SELECT TO anon USING (true);
CREATE POLICY "anon can insert tracked_sponsors" ON tracked_sponsors FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can delete tracked_sponsors" ON tracked_sponsors FOR DELETE TO anon USING (true);

-- ─── tracked_agencies ─────────────────────────────────────────────────────────

ALTER TABLE tracked_agencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read tracked_agencies"   ON tracked_agencies;
DROP POLICY IF EXISTS "anon can insert tracked_agencies" ON tracked_agencies;
DROP POLICY IF EXISTS "anon can delete tracked_agencies" ON tracked_agencies;

CREATE POLICY "anon can read tracked_agencies"   ON tracked_agencies FOR SELECT TO anon USING (true);
CREATE POLICY "anon can insert tracked_agencies" ON tracked_agencies FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon can delete tracked_agencies" ON tracked_agencies FOR DELETE TO anon USING (true);

-- ─── lims_bill_cache ──────────────────────────────────────────────────────────
-- Read-only from the browser; writes happen only via server-side cron

ALTER TABLE lims_bill_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read lims_bill_cache" ON lims_bill_cache;

CREATE POLICY "anon can read lims_bill_cache" ON lims_bill_cache FOR SELECT TO anon USING (true);

-- ─── activity_log ─────────────────────────────────────────────────────────────

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read activity_log"   ON activity_log;
DROP POLICY IF EXISTS "anon can insert activity_log" ON activity_log;

CREATE POLICY "anon can read activity_log"   ON activity_log FOR SELECT TO anon USING (true);
CREATE POLICY "anon can insert activity_log" ON activity_log FOR INSERT TO anon WITH CHECK (true);

-- ─── keyword_alert_log ────────────────────────────────────────────────────────
-- Server-side only — no anon access

ALTER TABLE keyword_alert_log ENABLE ROW LEVEL SECURITY;

-- ─── lims_cache_cursor ────────────────────────────────────────────────────────
-- Server-side only — no anon access

ALTER TABLE lims_cache_cursor ENABLE ROW LEVEL SECURITY;
