-- Restrict internal tracker reads to authenticated server endpoints.
BEGIN;

ALTER TABLE tracked_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_committees ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_sponsors ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_agencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read tracked_items" ON tracked_items;
DROP POLICY IF EXISTS "Allow public read access" ON tracked_items;

DROP POLICY IF EXISTS "anon can read item_notes" ON item_notes;
DROP POLICY IF EXISTS "Allow public read access" ON item_notes;

DROP POLICY IF EXISTS "anon can read bill_status_history" ON bill_status_history;

DROP POLICY IF EXISTS "anon can read activity_log" ON activity_log;
DROP POLICY IF EXISTS "Allow public read access" ON activity_log;

DROP POLICY IF EXISTS "anon can read team_members" ON team_members;
DROP POLICY IF EXISTS "Allow public read access" ON team_members;

DROP POLICY IF EXISTS "anon can read tracked_keywords" ON tracked_keywords;
DROP POLICY IF EXISTS "Allow public read access" ON tracked_keywords;

DROP POLICY IF EXISTS "anon can read tracked_committees" ON tracked_committees;
DROP POLICY IF EXISTS "Allow public read access" ON tracked_committees;

DROP POLICY IF EXISTS "anon can read tracked_sponsors" ON tracked_sponsors;
DROP POLICY IF EXISTS "Allow public read access" ON tracked_sponsors;

DROP POLICY IF EXISTS "anon can read tracked_agencies" ON tracked_agencies;
DROP POLICY IF EXISTS "Allow public read access" ON tracked_agencies;

COMMIT;
