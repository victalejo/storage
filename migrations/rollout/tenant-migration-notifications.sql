-- Phase 2 only: add this as a numbered multitenant migration after every
-- consumer of tenant notifications from this database supports
-- tenants_migrations_update. Do not run it as part of the listener rollout.
CREATE OR REPLACE FUNCTION public.tenants_update_notify_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    previous_config public.tenants%ROWTYPE;
BEGIN
    -- Compare every other column using the existing binary row comparison,
    -- including columns added by later migrations.
    previous_config := OLD;
    previous_config.migrations_version := NEW.migrations_version;
    previous_config.migrations_status := NEW.migrations_status;
    IF previous_config *<> NEW THEN
        -- tenants_update also invalidates migration state.
        PERFORM pg_notify('tenants_update', '"' || NEW.id || '"');
    ELSIF OLD *<> NEW THEN
        PERFORM pg_notify('tenants_migrations_update', '"' || NEW.id || '"');
    END IF;
    RETURN NULL;
END;
$$;
