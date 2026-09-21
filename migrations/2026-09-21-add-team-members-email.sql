-- DC Policy Tracker - add team member email
-- Add the nullable field already used by the frontend without changing IDs, RLS, or other team-member behavior.

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS email text;