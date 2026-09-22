-- Close browser writes after tracked-item and activity-log mutations moved to app-data.
BEGIN;

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public insert" ON activity_log;
DROP POLICY IF EXISTS "Allow public read access" ON activity_log;
DROP POLICY IF EXISTS "anon can insert activity_log" ON activity_log;
DROP POLICY IF EXISTS "anon can read activity_log" ON activity_log;

DROP POLICY IF EXISTS "Allow public delete" ON tracked_items;
DROP POLICY IF EXISTS "Allow public insert" ON tracked_items;
DROP POLICY IF EXISTS "Allow public read access" ON tracked_items;
DROP POLICY IF EXISTS "Allow public update" ON tracked_items;
DROP POLICY IF EXISTS "anon can delete tracked_items" ON tracked_items;
DROP POLICY IF EXISTS "anon can insert tracked_items" ON tracked_items;
DROP POLICY IF EXISTS "anon can read tracked_items" ON tracked_items;
DROP POLICY IF EXISTS "anon can update tracked_items" ON tracked_items;

CREATE POLICY "anon can read activity_log"
  ON activity_log FOR SELECT TO anon USING (true);
CREATE POLICY "anon can read tracked_items"
  ON tracked_items FOR SELECT TO anon USING (true);

COMMIT;
