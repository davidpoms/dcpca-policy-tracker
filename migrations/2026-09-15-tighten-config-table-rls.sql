-- DC Policy Tracker - tighten config-table anon writes
-- Run manually after the app-data mutation slice is deployed.
-- This migration changes policies only for the four config tables listed below.
-- The service role used by /api/app-data.js bypasses these anon policies.

BEGIN;

DROP POLICY IF EXISTS "anon can insert tracked_keywords" ON tracked_keywords;
DROP POLICY IF EXISTS "anon can update tracked_keywords" ON tracked_keywords;
DROP POLICY IF EXISTS "anon can delete tracked_keywords" ON tracked_keywords;
DROP POLICY IF EXISTS "anon can read tracked_keywords" ON tracked_keywords;
CREATE POLICY "anon can read tracked_keywords" ON tracked_keywords FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon can insert tracked_committees" ON tracked_committees;
DROP POLICY IF EXISTS "anon can update tracked_committees" ON tracked_committees;
DROP POLICY IF EXISTS "anon can delete tracked_committees" ON tracked_committees;
DROP POLICY IF EXISTS "anon can read tracked_committees" ON tracked_committees;
CREATE POLICY "anon can read tracked_committees" ON tracked_committees FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon can insert tracked_sponsors" ON tracked_sponsors;
DROP POLICY IF EXISTS "anon can update tracked_sponsors" ON tracked_sponsors;
DROP POLICY IF EXISTS "anon can delete tracked_sponsors" ON tracked_sponsors;
DROP POLICY IF EXISTS "anon can read tracked_sponsors" ON tracked_sponsors;
CREATE POLICY "anon can read tracked_sponsors" ON tracked_sponsors FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon can insert tracked_agencies" ON tracked_agencies;
DROP POLICY IF EXISTS "anon can update tracked_agencies" ON tracked_agencies;
DROP POLICY IF EXISTS "anon can delete tracked_agencies" ON tracked_agencies;
DROP POLICY IF EXISTS "anon can read tracked_agencies" ON tracked_agencies;
CREATE POLICY "anon can read tracked_agencies" ON tracked_agencies FOR SELECT TO anon USING (true);

COMMIT;