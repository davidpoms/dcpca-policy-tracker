-- Preserve anonymous history reads; history writes use the server-side service role.
ALTER TABLE bill_status_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can insert bill_status_history" ON bill_status_history;
DROP POLICY IF EXISTS "anon can read bill_status_history" ON bill_status_history;

CREATE POLICY "anon can read bill_status_history"
  ON bill_status_history FOR SELECT TO anon USING (true);
