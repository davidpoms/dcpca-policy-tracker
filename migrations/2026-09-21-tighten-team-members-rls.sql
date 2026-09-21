-- DC Policy Tracker - tighten team_members anon writes
-- Apply only after the authenticated team-member mutation path is deployed and tested.

BEGIN;

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read team_members" ON team_members;
DROP POLICY IF EXISTS "anon can update team_members" ON team_members;
DROP POLICY IF EXISTS "anon can insert team_members" ON team_members;
DROP POLICY IF EXISTS "anon can delete team_members" ON team_members;
DROP POLICY IF EXISTS "Allow public read access" ON team_members;
DROP POLICY IF EXISTS "Allow public insert" ON team_members;
DROP POLICY IF EXISTS "Allow public update" ON team_members;
DROP POLICY IF EXISTS "Allow public delete" ON team_members;

CREATE POLICY "anon can read team_members"
  ON team_members
  FOR SELECT
  TO anon
  USING (true);

COMMIT;