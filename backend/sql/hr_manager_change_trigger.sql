-- Sends hr_manager_change when an employee's manager ("responsable 1",
-- employees.mail_responsable1) changes in HR, so hr_kpi_sync_worker.py can
-- update reports_to on their active primary role assignment in KPI.
-- Before this, the manager only reached KPI when the employee was created.
--
-- Run against hr_db (rh_application). Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION public.notify_manager_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM pg_notify(
    'hr_manager_change',
    json_build_object(
      'hr_schema', TG_TABLE_SCHEMA,
      'matricule', NEW.matricule,
      'mail_responsable1', NEW.mail_responsable1
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
    EXECUTE format('DROP TRIGGER IF EXISTS trg_notify_manager_change ON %I.employees', s);
    EXECUTE format(
      'CREATE TRIGGER trg_notify_manager_change
       AFTER UPDATE OF mail_responsable1 ON %I.employees
       FOR EACH ROW WHEN (NEW.mail_responsable1 IS DISTINCT FROM OLD.mail_responsable1)
       EXECUTE FUNCTION public.notify_manager_change()', s);
  END LOOP;
END $$;

COMMIT;
