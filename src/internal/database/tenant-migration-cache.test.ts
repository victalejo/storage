import { encrypt } from '@internal/auth'
import type { PubSubAdapter } from '@internal/pubsub'
import { vi } from 'vitest'
import {
  deleteTenantConfig,
  getTenantConfig,
  getTenantMigrationState,
  listenForTenantUpdate,
  TenantMigrationStatus,
} from './tenant'
import { TenantConfigStorePg } from './tenant-store-pg'

const tenantId = 'migration-cache-test'
const row = {
  id: tenantId,
  anon_key: encrypt('anon'),
  database_url: encrypt('database'),
  jwt_secret: encrypt('secret'),
  service_key: encrypt('service'),
  migrations_version: 'initialmigration',
  migrations_status: 'FAILED',
  updated_at_us: '1700000000000000',
}

describe('tenant migration state cache', () => {
  const listeners = new Map<string, (payload: unknown) => void>()

  beforeEach(async () => {
    deleteTenantConfig(tenantId)
    listeners.clear()
    await listenForTenantUpdate({
      subscribe: async (channel: string, callback: (payload: unknown) => void) => {
        listeners.set(channel, callback)
      },
    } as PubSubAdapter)
  })

  afterEach(() => deleteTenantConfig(tenantId))

  const notify = (channel: string, message: unknown = tenantId) => {
    const listener = listeners.get(channel)
    expect(listener).toBeDefined()
    listener!(message)
  }
  const completed = {
    migrations_version: 'storage-schema',
    migrations_status: 'COMPLETED',
    updated_at_us: '1700000000000001',
  }

  it('updates cached migration state from a notification without a database read', async () => {
    const configRead = vi.spyOn(TenantConfigStorePg.prototype, 'findById').mockResolvedValue(row)
    const migrationRead = vi.spyOn(TenantConfigStorePg.prototype, 'findMigrationsInfo')
    const config = await getTenantConfig(tenantId)
    const previous = await getTenantMigrationState(tenantId)
    previous.syncMigrationsDone = true

    notify('tenants_migrations_update', {
      tenantId,
      type: 'update',
      migrationVersion: 'storage-schema',
      migrationStatus: 'COMPLETED',
      eventId: 'event-1',
      updatedAtUs: '1700000000000001',
    })

    expect(await getTenantConfig(tenantId)).toBe(config)
    const current = await getTenantMigrationState(tenantId)
    expect(current).not.toBe(previous)
    expect(current).toMatchObject({
      migrationVersion: 'storage-schema',
      migrationStatus: 'COMPLETED',
    })
    expect(current.syncMigrationsDone).toBeUndefined()
    expect(configRead).toHaveBeenCalledTimes(1)
    expect(migrationRead).not.toHaveBeenCalled()
  })

  it.each([
    ['older', '1699999999999999'],
    ['equal', '1700000000000000'],
    ['missing', undefined],
    ['invalid', 'not-a-timestamp'],
  ])('reloads instead of applying an %s notification timestamp', async (_, updatedAtUs) => {
    vi.spyOn(TenantConfigStorePg.prototype, 'findById').mockResolvedValue(row)
    const read = vi
      .spyOn(TenantConfigStorePg.prototype, 'findMigrationsInfo')
      .mockResolvedValue(completed)
    await getTenantConfig(tenantId)
    notify('tenants_migrations_update', {
      tenantId,
      type: 'update',
      eventId: 'older-event',
      migrationVersion: 'initialmigration',
      migrationStatus: 'FAILED',
      updatedAtUs,
    })
    expect(await getTenantMigrationState(tenantId)).toMatchObject({
      migrationVersion: 'storage-schema',
      migrationStatus: 'COMPLETED',
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('reloads when the cached row has no timestamp', async () => {
    vi.spyOn(TenantConfigStorePg.prototype, 'findById').mockResolvedValue({
      ...row,
      updated_at_us: null,
    })
    const read = vi
      .spyOn(TenantConfigStorePg.prototype, 'findMigrationsInfo')
      .mockResolvedValue(completed)
    await getTenantConfig(tenantId)
    notify('tenants_migrations_update', {
      tenantId,
      type: 'update',
      eventId: 'unknown-cached-timestamp',
      migrationVersion: 'initialmigration',
      migrationStatus: 'FAILED',
      updatedAtUs: '1700000000000001',
    })
    expect(await getTenantMigrationState(tenantId)).toMatchObject({
      migrationVersion: 'storage-schema',
    })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it.each(['resolve', 'reject'])(
    'reloads safely when a prior migration read %ss after a notification',
    async (outcome) => {
      vi.spyOn(TenantConfigStorePg.prototype, 'findById').mockResolvedValue(row)
      await getTenantConfig(tenantId)
      notify('tenants_migrations_update')

      const stale =
        Promise.withResolvers<Awaited<ReturnType<TenantConfigStorePg['findMigrationsInfo']>>>()
      const read = vi
        .spyOn(TenantConfigStorePg.prototype, 'findMigrationsInfo')
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValue(completed)
      const pending = getTenantMigrationState(tenantId)
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))

      notify('tenants_migrations_update', {
        tenantId,
        type: 'update',
        eventId: 'event-2',
        updatedAtUs: '1700000000000001',
        migrationVersion: 'storage-schema',
        migrationStatus: 'COMPLETED',
      })
      const current = await pending
      expect(current).toMatchObject({
        migrationVersion: 'storage-schema',
        migrationStatus: 'COMPLETED',
      })
      if (outcome === 'resolve') stale.resolve(row)
      else stale.reject(new Error('stale read failed'))
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(await getTenantMigrationState(tenantId)).toBe(current)
      expect(read).toHaveBeenCalledTimes(2)
    }
  )

  it('invalidates cached config on a distinct delete notification', async () => {
    const configRead = vi.spyOn(TenantConfigStorePg.prototype, 'findById').mockResolvedValue(row)
    const previous = await getTenantConfig(tenantId)
    notify('tenants_migrations_update', { type: 'delete', tenantId, eventId: 'delete-1' })
    expect(await getTenantConfig(tenantId)).not.toBe(previous)
    expect(configRead).toHaveBeenCalledTimes(2)
  })

  it('invalidates migration state for a fallback or malformed value payload', async () => {
    vi.spyOn(TenantConfigStorePg.prototype, 'findById').mockResolvedValue(row)
    const read = vi
      .spyOn(TenantConfigStorePg.prototype, 'findMigrationsInfo')
      .mockResolvedValue(completed)
    await getTenantConfig(tenantId)
    notify('tenants_migrations_update', { type: 'update', tenantId, eventId: 'event-3' })
    expect(await getTenantMigrationState(tenantId)).toMatchObject({
      migrationVersion: 'storage-schema',
    })
    notify('tenants_migrations_update', { type: 'invalidate', tenantId, eventId: 'event-4' })
    expect(await getTenantMigrationState(tenantId)).toMatchObject({
      migrationVersion: 'storage-schema',
    })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not load an uncached tenant for a value notification', async () => {
    const configRead = vi.spyOn(TenantConfigStorePg.prototype, 'findById')
    const migrationRead = vi.spyOn(TenantConfigStorePg.prototype, 'findMigrationsInfo')
    notify('tenants_migrations_update', {
      tenantId,
      type: 'update',
      eventId: 'event-5',
      updatedAtUs: '1700000000000001',
      migrationVersion: 'storage-schema',
      migrationStatus: null,
    })
    expect(configRead).not.toHaveBeenCalled()
    expect(migrationRead).not.toHaveBeenCalled()
  })

  it('normalizes an unknown migration version in a notification', async () => {
    vi.spyOn(TenantConfigStorePg.prototype, 'findById').mockResolvedValue(row)
    await getTenantConfig(tenantId)
    notify('tenants_migrations_update', {
      tenantId,
      type: 'update',
      eventId: 'event-6',
      updatedAtUs: '1700000000000001',
      migrationVersion: 'future-migration',
      migrationStatus: null,
    })
    expect(await getTenantMigrationState(tenantId)).toMatchObject({
      migrationVersionAhead: true,
      migrationStatus: null,
    })
  })

  it('invalidates only migration state for migration notifications and both for legacy notifications', async () => {
    const configRead = vi.spyOn(TenantConfigStorePg.prototype, 'findById').mockResolvedValue(row)
    const migrationRead = vi
      .spyOn(TenantConfigStorePg.prototype, 'findMigrationsInfo')
      .mockResolvedValue(completed)

    const config = await getTenantConfig(tenantId)
    const previous = await getTenantMigrationState(tenantId)
    expect(previous).toMatchObject({
      migrationVersion: 'initialmigration',
      migrationStatus: 'FAILED',
    })
    expect(migrationRead).not.toHaveBeenCalled()
    previous.syncMigrationsDone = true
    expect(await getTenantMigrationState(tenantId)).toBe(previous)
    notify('tenants_migrations_update')

    expect(await getTenantConfig(tenantId)).toBe(config)
    const updated = await getTenantMigrationState(tenantId)
    expect(updated).toMatchObject({
      migrationVersion: 'storage-schema',
      migrationStatus: TenantMigrationStatus.COMPLETED,
    })
    expect(updated.syncMigrationsDone).toBeUndefined()
    expect(configRead).toHaveBeenCalledTimes(1)
    expect(migrationRead).toHaveBeenCalledTimes(1)

    updated.syncMigrationsDone = true
    notify('tenants_update')
    expect(await getTenantConfig(tenantId)).not.toBe(config)
    const reloaded = await getTenantMigrationState(tenantId)
    expect(reloaded).not.toBe(updated)
    expect(reloaded.syncMigrationsDone).toBeUndefined()
    expect(reloaded).toMatchObject({ migrationVersion: 'initialmigration' })
    expect(configRead).toHaveBeenCalledTimes(2)
    expect(migrationRead).toHaveBeenCalledTimes(1)
  })

  it('shares an in-flight config row with a migration-state read', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<TenantConfigStorePg['findById']>>>()
    const configRead = vi
      .spyOn(TenantConfigStorePg.prototype, 'findById')
      .mockReturnValue(pending.promise)
    const migrationRead = vi.spyOn(TenantConfigStorePg.prototype, 'findMigrationsInfo')
    const config = getTenantConfig(tenantId)
    const state = getTenantMigrationState(tenantId)
    pending.resolve(row)

    await config
    expect(await state).toMatchObject({
      migrationVersion: 'initialmigration',
      migrationStatus: 'FAILED',
    })
    expect(configRead).toHaveBeenCalledTimes(1)
    expect(migrationRead).not.toHaveBeenCalled()
  })

  it('loads a cold migration state from a single config row', async () => {
    const configRead = vi.spyOn(TenantConfigStorePg.prototype, 'findById').mockResolvedValue(row)
    const migrationRead = vi.spyOn(TenantConfigStorePg.prototype, 'findMigrationsInfo')

    expect(await getTenantMigrationState(tenantId)).toMatchObject({
      migrationVersion: 'initialmigration',
      migrationStatus: 'FAILED',
    })
    expect(configRead).toHaveBeenCalledTimes(1)
    expect(migrationRead).not.toHaveBeenCalled()
  })

  it.each([
    tenantId,
    {
      tenantId,
      type: 'update',
      eventId: 'event-7',
      updatedAtUs: '1700000000000001',
      migrationVersion: 'storage-schema',
      migrationStatus: 'COMPLETED',
    },
  ])('does not publish a config row read before a migration notification', async (message) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<TenantConfigStorePg['findById']>>>()
    const configRead = vi
      .spyOn(TenantConfigStorePg.prototype, 'findById')
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ ...row, ...completed })
    const migrationRead = vi.spyOn(TenantConfigStorePg.prototype, 'findMigrationsInfo')
    const config = getTenantConfig(tenantId)
    const state = getTenantMigrationState(tenantId)
    notify('tenants_migrations_update', message)
    pending.resolve(row)

    await config
    expect(await state).toMatchObject({
      migrationVersion: 'storage-schema',
      migrationStatus: 'COMPLETED',
    })
    expect(await getTenantMigrationState(tenantId)).toMatchObject({
      migrationVersion: 'storage-schema',
    })
    expect(configRead).toHaveBeenCalledTimes(2)
    expect(migrationRead).not.toHaveBeenCalled()
  })

  it('retries an in-flight migration read after a legacy notification', async () => {
    const configRead = vi
      .spyOn(TenantConfigStorePg.prototype, 'findById')
      .mockResolvedValueOnce(row)
      .mockResolvedValue({ ...row, ...completed })
    await getTenantConfig(tenantId)
    notify('tenants_migrations_update')

    const stale =
      Promise.withResolvers<Awaited<ReturnType<TenantConfigStorePg['findMigrationsInfo']>>>()
    const migrationRead = vi
      .spyOn(TenantConfigStorePg.prototype, 'findMigrationsInfo')
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(completed)

    const first = getTenantMigrationState(tenantId)
    await vi.waitFor(() => expect(migrationRead).toHaveBeenCalledTimes(1))
    notify('tenants_update')
    stale.resolve({ migrations_version: 'initialmigration', migrations_status: 'FAILED' })

    expect(await first).toMatchObject({
      migrationVersion: 'storage-schema',
      migrationStatus: 'COMPLETED',
    })
    expect(configRead).toHaveBeenCalledTimes(2)
    expect(migrationRead).toHaveBeenCalledTimes(1)
  })

  it.each(['resolve', 'reject'])(
    'retries a %s stale read after migration invalidation',
    async (outcome) => {
      vi.spyOn(TenantConfigStorePg.prototype, 'findById').mockResolvedValue(row)
      await getTenantConfig(tenantId)
      notify('tenants_migrations_update')

      const stale =
        Promise.withResolvers<Awaited<ReturnType<TenantConfigStorePg['findMigrationsInfo']>>>()
      const read = vi
        .spyOn(TenantConfigStorePg.prototype, 'findMigrationsInfo')
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValue(completed)

      const first = getTenantMigrationState(tenantId)
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      notify('tenants_migrations_update')
      const current = getTenantMigrationState(tenantId)
      if (outcome === 'resolve') {
        stale.resolve({ migrations_version: 'initialmigration', migrations_status: 'FAILED' })
      } else {
        stale.reject(new Error('stale read failed'))
      }
      const [a, b] = await Promise.all([first, current])
      expect(a).toBe(b)
      expect(a).toMatchObject({ migrationVersion: 'storage-schema', migrationStatus: 'COMPLETED' })
      expect(await getTenantMigrationState(tenantId)).toBe(b)
      expect(read).toHaveBeenCalledTimes(2)
    }
  )
})
