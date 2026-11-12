-- Phase 2 only: add this as a numbered multitenant migration after every
-- consumer of tenant notifications from this database supports the value payload.
CREATE OR REPLACE FUNCTION public.tenants_update_notify_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    previous_config public.tenants%ROWTYPE;
    event_id uuid;
    update_payload text;
BEGIN
    previous_config := OLD;
    previous_config.migrations_version := NEW.migrations_version;
    previous_config.migrations_status := NEW.migrations_status;
    previous_config.updated_at := NEW.updated_at;
    IF previous_config *<> NEW THEN
        PERFORM pg_notify('tenants_update', '"' || NEW.id || '"');
    END IF;

    IF OLD.migrations_version IS DISTINCT FROM NEW.migrations_version
       OR OLD.migrations_status IS DISTINCT FROM NEW.migrations_status THEN
        event_id := gen_random_uuid();
        update_payload := json_build_object(
            'type', 'update', 'tenantId', NEW.id, 'eventId', event_id,
            'migrationVersion', NEW.migrations_version,
            'migrationStatus', NEW.migrations_status,
            'updatedAtUs', floor(extract(epoch FROM NEW.updated_at) * 1000000)::text
        )::text;

        IF octet_length(update_payload) >= 8000 THEN
            PERFORM pg_notify('tenants_migrations_update', json_build_object(
                'type', 'invalidate', 'tenantId', NEW.id, 'eventId', event_id
            )::text);
        ELSE
            PERFORM pg_notify('tenants_migrations_update', update_payload);
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.tenants_delete_notify_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('tenants_update', '"' || OLD.id || '"');
    -- A distinct delete message must follow any earlier migration messages in
    -- this transaction, even if identical legacy notifications were folded.
    PERFORM pg_notify('tenants_migrations_update', json_build_object(
        'type', 'delete', 'tenantId', OLD.id, 'eventId', gen_random_uuid()
    )::text);
    RETURN NULL;
END;
$$;
