-- Restrict LIMS cache reads to authenticated server endpoints.
BEGIN;

ALTER TABLE public.lims_bill_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read lims_bill_cache" ON public.lims_bill_cache;

COMMIT;
