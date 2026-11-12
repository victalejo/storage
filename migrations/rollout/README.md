# Staged tenant migration notifications

`tenant-migration-notifications.sql` is the second phase of the tenant migration
cache change. It is intentionally outside `migrations/multitenant`: Storage runs
those migrations on startup, while old servers and workers can still be running.
1. Apply the `updated_at` migration before deploying workers that query the
   column. Deploy listeners that support both the tenant-ID string and the structured
   payload to every Storage server and worker. Verify any other consumers of
   `tenants_migrations_update` understand the structured payload, and that no
   other `tenants_update` consumer relies on migration-only updates. The existing
   trigger continues to send `tenants_update`, which old and new Storage binaries
   handle.
2. In a later release, add the SQL as the next numbered multitenant migration
   after verifying every listener is upgraded. A migration-only update sends
   its values on `tenants_migrations_update`. Mixed updates send both channels;
   deletes send `tenants_update` and a distinct delete message on the migration
   channel. The extra messages preserve ordering when PostgreSQL folds repeated
   identical `tenants_update` notifications within a transaction. Large migration
   values fall back to an invalidation message and a lazy read.
3. Before rolling back to a binary without the structured-payload listener,
   restore the latest pre-split bodies of both `tenants_update_notify_trigger`
   and `tenants_delete_notify_trigger` directly in the multitenant database,
   then add a forward migration with the same bodies so later boots converge.

The staged SQL is not applied automatically, and the first release alone does
not reduce migration-triggered config invalidations.

Notifications carry committed values but can lag a newer database read. A
notification with an older, equal, missing, or invalid timestamp invalidates
migration state for a lazy read. Timestamps are not strictly monotonic, so this
is a best-effort guard rather than a revision or a commit-order guarantee.
Existing rows with a null timestamp also fall back to a read. Missed notifications
during a disconnect remain subject to the existing cache TTL behavior.
