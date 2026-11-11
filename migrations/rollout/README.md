# Staged tenant migration notifications

`tenant-migration-notifications.sql` is the second phase of the tenant migration
cache change. It is intentionally outside `migrations/multitenant`: Storage runs
those migrations on startup, while old servers and workers can still be running.
1. Deploy the listener to every Storage server and worker, and verify any other
   consumers of these notifications also understand the new channel. The
   existing trigger still sends `tenants_update`, which both old and new
   Storage binaries handle.
2. In a later release, add the SQL as the next numbered multitenant migration
   after verifying every listener is upgraded. A migration-only change then
   sends only `tenants_migrations_update`. Any other change, including a mixed
   update or a delete, sends only `tenants_update`, so every consumer must drop
   migration state on `tenants_update` too.
3. Before rolling back to a binary without the new listener, restore the latest
   pre-split `tenants_update_notify_trigger` body (0032 today, plus any later
   changes to it) directly in the multitenant database, then add a forward
   migration with the same body so later boots converge.

The staged SQL is not applied automatically, and the first release alone does
not reduce migration-triggered config invalidations.
