-- Sends hr_employee_reactivated when an archived employee is set back to
-- active in HR (statut 'archive' -> anything else, from the app or directly
-- in the database), so the HR <-> KPI sync (services/hrKpiSync/worker.js)
-- can reopen the role assignment that archiving ended in KPI. Before this,
-- only the archive itself reached KPI and a reactivation was silently lost.
--
-- Run against hr_db (rh_application). Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION public.notify_employee_reactivated()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM pg_notify(
    'hr_employee_reactivated',
    json_build_object(
      'hr_schema', TG_TABLE_SCHEMA,
      'matricule', NEW.matricule,
      'poste', NEW.poste,
      'statut', NEW.statut
    )::text
  );
  RETURN NEW;
END;
$function$;

DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['public', 'schema_cn', 'schema_de', 'schema_fr', 'schema_in',
                           'schema_kr', 'schema_lu', 'schema_mx', 'schema_tn']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_notify_employee_reactivated ON %I.employees', s);
    EXECUTE format(
      'CREATE TRIGGER trg_notify_employee_reactivated
       AFTER UPDATE OF statut ON %I.employees
       FOR EACH ROW WHEN (OLD.statut = ''archive'' AND NEW.statut IS DISTINCT FROM ''archive'')
       EXECUTE FUNCTION public.notify_employee_reactivated()', s);
  END LOOP;
END $$;

COMMIT;
