BEGIN;

ALTER TABLE public.activity_log
  ALTER COLUMN created_at DROP DEFAULT;

DO $$
DECLARE
  current_type text;
BEGIN
  SELECT format_type(atttypid, atttypmod)
    INTO current_type
    FROM pg_attribute
   WHERE attrelid = 'public.activity_log'::regclass
     AND attname = 'created_at'
     AND NOT attisdropped;

  IF current_type = 'timestamp without time zone' THEN
    ALTER TABLE public.activity_log
      ALTER COLUMN created_at TYPE timestamptz
      USING created_at AT TIME ZONE 'UTC';
  ELSIF current_type IS DISTINCT FROM 'timestamp with time zone' THEN
    RAISE EXCEPTION 'Unexpected activity_log.created_at type: %', current_type;
  END IF;
END $$;

ALTER TABLE public.activity_log
  ALTER COLUMN created_at SET DEFAULT now();

COMMIT;
