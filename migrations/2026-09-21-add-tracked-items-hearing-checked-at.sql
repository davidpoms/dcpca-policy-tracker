-- Reconcile Preview with Production before hearing persistence testing.
ALTER TABLE tracked_items
  ADD COLUMN IF NOT EXISTS hearing_checked_at timestamptz;
