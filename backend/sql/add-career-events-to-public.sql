-- Adds the career_events table to the public schema (SAHEL/Tunisia tenant),
-- using schema_fr.career_events as the template -- mirrors the same pattern
-- used in create-country-schemas-from-france.sql for the other country schemas.
-- Career development was previously unavailable for SAHEL because this table
-- didn't exist in public.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'career_events'
  ) THEN
    CREATE TABLE public.career_events (LIKE schema_fr.career_events INCLUDING ALL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.sequences
    WHERE sequence_schema = 'public' AND sequence_name = 'career_events_id_seq'
  ) THEN
    CREATE SEQUENCE public.career_events_id_seq;
    ALTER SEQUENCE public.career_events_id_seq OWNED BY public.career_events.id;
    ALTER TABLE public.career_events ALTER COLUMN id SET DEFAULT nextval('public.career_events_id_seq'::regclass);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND conname = 'career_events_employee_id_fkey'
  ) THEN
    ALTER TABLE public.career_events
      ADD CONSTRAINT career_events_employee_id_fkey
      FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;
  END IF;
END $$;

COMMIT;
