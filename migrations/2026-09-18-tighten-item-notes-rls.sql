-- DC Policy Tracker - tighten item_notes anon writes
-- Apply only after the authenticated note mutation path is deployed and tested.

BEGIN;

DROP POLICY IF EXISTS "anon can upsert item_notes" ON item_notes;
DROP POLICY IF EXISTS "anon can update item_notes" ON item_notes;
DROP POLICY IF EXISTS "anon can delete item_notes" ON item_notes;
DROP POLICY IF EXISTS "anon can read item_notes" ON item_notes;

DROP POLICY IF EXISTS "Allow public read access" ON item_notes;
DROP POLICY IF EXISTS "Allow public insert" ON item_notes;
DROP POLICY IF EXISTS "Allow public update" ON item_notes;
DROP POLICY IF EXISTS "Allow public delete" ON item_notes;

CREATE POLICY "anon can read item_notes"
  ON item_notes
  FOR SELECT
  TO anon
  USING (true);

COMMIT;
