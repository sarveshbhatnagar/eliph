import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { keyLookupHash } from '@eliph/core'
import { openDb } from '../src/db'
import { createStores, SqliteApiKeyStore, SqliteOrgKeyStore } from '../src/index'

// Schema of org_keys / api_keys before the key_lookup column existed
const OLD_SCHEMA = `
  CREATE TABLE org_keys (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    key_hash   TEXT NOT NULL,
    key_limit  INTEGER NOT NULL DEFAULT 100
  );
  CREATE TABLE api_keys (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    key_hash   TEXT NOT NULL,
    org_key_id TEXT REFERENCES org_keys(id)
  );
`

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
}

function indexes(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map(i => i.name)
}

function lookupOf(db: Database.Database, table: string, id: string): string | null {
  return (db.prepare(`SELECT key_lookup FROM ${table} WHERE id = ?`).get(id) as { key_lookup: string | null }).key_lookup
}

describe('key_lookup fast path', () => {
  let dir: string
  let compareSpy: jest.SpyInstance

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eliph-keylookup-'))
    compareSpy = jest.spyOn(bcrypt, 'compare')
  })

  afterEach(() => {
    compareSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  // Builds a database with the OLD schema containing bcrypt-only rows
  function buildLegacyDb(path: string) {
    const orgRaw = randomUUID()
    const apiRaw = randomUUID()
    const orgId = randomUUID()
    const apiId = randomUUID()
    const old = new Database(path)
    old.exec(OLD_SCHEMA)
    old.prepare('INSERT INTO org_keys (id, label, created_at, key_hash, key_limit) VALUES (?, ?, ?, ?, ?)')
      .run(orgId, 'legacy-org', new Date().toISOString(), bcrypt.hashSync(orgRaw, 4), 7)
    old.prepare('INSERT INTO api_keys (id, label, created_at, key_hash, org_key_id) VALUES (?, ?, ?, ?, ?)')
      .run(apiId, 'legacy-key', new Date().toISOString(), bcrypt.hashSync(apiRaw, 4), orgId)
    old.close()
    return { orgRaw, apiRaw, orgId, apiId }
  }

  it('fresh database has the key_lookup column and unique indexes', () => {
    const db = openDb(join(dir, 'fresh.db'))
    expect(columns(db, 'api_keys')).toContain('key_lookup')
    expect(columns(db, 'org_keys')).toContain('key_lookup')
    expect(indexes(db, 'api_keys')).toContain('idx_api_keys_lookup')
    expect(indexes(db, 'org_keys')).toContain('idx_org_keys_lookup')
    db.close()
  })

  it('migrates an old-schema database idempotently and old keys still authenticate', async () => {
    const path = join(dir, 'old.db')
    const legacy = buildLegacyDb(path)

    // open twice: the migration must be idempotent
    openDb(path).close()
    const db = openDb(path)
    expect(columns(db, 'api_keys')).toContain('key_lookup')
    expect(columns(db, 'org_keys')).toContain('key_lookup')
    expect(indexes(db, 'api_keys')).toContain('idx_api_keys_lookup')
    expect(indexes(db, 'org_keys')).toContain('idx_org_keys_lookup')
    expect(lookupOf(db, 'org_keys', legacy.orgId)).toBeNull()
    expect(lookupOf(db, 'api_keys', legacy.apiId)).toBeNull()

    const orgKeyStore = new SqliteOrgKeyStore(db)
    const apiKeyStore = new SqliteApiKeyStore(db)

    const org = await orgKeyStore.find(legacy.orgRaw)
    expect(org).toMatchObject({ id: legacy.orgId, label: 'legacy-org', keyLimit: 7 })
    const api = await apiKeyStore.find(legacy.apiRaw)
    expect(api).toMatchObject({ id: legacy.apiId, label: 'legacy-key', orgKeyId: legacy.orgId })

    // new keys can be created next to legacy rows in the migrated database
    const { rawKey } = await apiKeyStore.create('new-key', legacy.orgId)
    expect((await apiKeyStore.find(rawKey))?.label).toBe('new-key')
    db.close()
  })

  it('legacy rows are found via bcrypt fallback, then backfilled so the next lookup does no bcrypt', async () => {
    const path = join(dir, 'old.db')
    const legacy = buildLegacyDb(path)
    const db = openDb(path)
    const orgKeyStore = new SqliteOrgKeyStore(db)
    const apiKeyStore = new SqliteApiKeyStore(db)

    expect((await orgKeyStore.find(legacy.orgRaw))?.id).toBe(legacy.orgId)
    expect((await apiKeyStore.find(legacy.apiRaw))?.id).toBe(legacy.apiId)
    expect(compareSpy).toHaveBeenCalled()
    expect(lookupOf(db, 'org_keys', legacy.orgId)).toBe(keyLookupHash(legacy.orgRaw))
    expect(lookupOf(db, 'api_keys', legacy.apiId)).toBe(keyLookupHash(legacy.apiRaw))

    compareSpy.mockClear()
    expect((await orgKeyStore.find(legacy.orgRaw))?.id).toBe(legacy.orgId)
    expect((await apiKeyStore.find(legacy.apiRaw))?.id).toBe(legacy.apiId)
    expect(compareSpy).not.toHaveBeenCalled()
    db.close()
  })

  it('a wrong key against legacy rows returns null and backfills nothing', async () => {
    const path = join(dir, 'old.db')
    const legacy = buildLegacyDb(path)
    const db = openDb(path)
    expect(await new SqliteOrgKeyStore(db).find('wrong')).toBeNull()
    expect(await new SqliteApiKeyStore(db).find('wrong')).toBeNull()
    expect(lookupOf(db, 'org_keys', legacy.orgId)).toBeNull()
    expect(lookupOf(db, 'api_keys', legacy.apiId)).toBeNull()
    db.close()
  })

  it('freshly created keys are found without any bcrypt.compare call', async () => {
    const { orgKeyStore, apiKeyStore } = createStores(':memory:')
    const { rawKey: orgRaw, record: org } = await orgKeyStore.create('acme', 10)
    const { rawKey: apiRaw, record: api } = await apiKeyStore.create('k', org.id)
    compareSpy.mockClear()

    expect((await orgKeyStore.find(orgRaw))?.id).toBe(org.id)
    expect((await apiKeyStore.find(apiRaw))?.id).toBe(api.id)
    expect(compareSpy).not.toHaveBeenCalled()
  })

  it('create still stores a bcrypt hash alongside key_lookup', async () => {
    const db = openDb(':memory:')
    const orgKeyStore = new SqliteOrgKeyStore(db)
    const apiKeyStore = new SqliteApiKeyStore(db)
    const { rawKey: orgRaw, record: org } = await orgKeyStore.create('acme', 10)
    const { rawKey: apiRaw, record: api } = await apiKeyStore.create('k', org.id)
    const orgRow = db.prepare('SELECT key_hash, key_lookup FROM org_keys WHERE id = ?').get(org.id) as { key_hash: string; key_lookup: string }
    const apiRow = db.prepare('SELECT key_hash, key_lookup FROM api_keys WHERE id = ?').get(api.id) as { key_hash: string; key_lookup: string }
    expect(orgRow.key_lookup).toBe(keyLookupHash(orgRaw))
    expect(apiRow.key_lookup).toBe(keyLookupHash(apiRaw))
    compareSpy.mockRestore()
    expect(await bcrypt.compare(orgRaw, orgRow.key_hash)).toBe(true)
    expect(await bcrypt.compare(apiRaw, apiRow.key_hash)).toBe(true)
  })

  it('a miss with all rows backfilled performs zero bcrypt compares', async () => {
    const path = join(dir, 'old.db')
    const legacy = buildLegacyDb(path)
    const db = openDb(path)
    const orgKeyStore = new SqliteOrgKeyStore(db)
    const apiKeyStore = new SqliteApiKeyStore(db)
    await orgKeyStore.find(legacy.orgRaw)
    await apiKeyStore.find(legacy.apiRaw)
    await apiKeyStore.create('new', legacy.orgId)

    compareSpy.mockClear()
    expect(await orgKeyStore.find(randomUUID())).toBeNull()
    expect(await apiKeyStore.find(randomUUID())).toBeNull()
    expect(compareSpy).not.toHaveBeenCalled()
    db.close()
  })

  it('regenerate invalidates the old org key and the new one is found without bcrypt', async () => {
    const { orgKeyStore } = createStores(':memory:')
    const { rawKey: oldRaw, record } = await orgKeyStore.create('acme', 10)
    const { rawKey: newRaw } = await orgKeyStore.regenerate(record.id)
    compareSpy.mockClear()
    expect(await orgKeyStore.find(oldRaw)).toBeNull()
    expect((await orgKeyStore.find(newRaw))?.id).toBe(record.id)
    expect(compareSpy).not.toHaveBeenCalled()
  })

  it('a key regenerated by an older build (key_hash replaced, stale key_lookup left behind) is handled', async () => {
    const path = join(dir, 'rollback.db')
    const { orgKeyStore } = createStores(path)
    const { rawKey: oldRaw, record } = await orgKeyStore.create('acme', 10)
    expect((await orgKeyStore.find(oldRaw))?.id).toBe(record.id)

    // What the previous build's regenerate() does: it only knows about key_hash
    const newRaw = randomUUID()
    const other = new Database(path)
    other.prepare('UPDATE org_keys SET key_hash = ? WHERE id = ?').run(bcrypt.hashSync(newRaw, 4), record.id)
    other.close()

    expect(await orgKeyStore.find(oldRaw)).toBeNull()
    expect((await orgKeyStore.find(newRaw))?.id).toBe(record.id)
    // repaired: the new key now takes the fast path with no bcrypt
    compareSpy.mockClear()
    expect((await orgKeyStore.find(newRaw))?.id).toBe(record.id)
    expect(compareSpy).not.toHaveBeenCalled()
    expect(await orgKeyStore.find(oldRaw)).toBeNull()
  })

  it('a key_lookup match not yet confirmed in this process costs one bcrypt compare, then none', async () => {
    const path = join(dir, 'restart.db')
    const db = openDb(path)
    const raw = randomUUID()
    const id = randomUUID()
    db.prepare('INSERT INTO org_keys (id, label, created_at, key_hash, key_limit, key_lookup) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'from-earlier-process', new Date().toISOString(), bcrypt.hashSync(raw, 4), 5, keyLookupHash(raw))
    const store = new SqliteOrgKeyStore(db)
    expect((await store.find(raw))?.id).toBe(id)
    expect(compareSpy).toHaveBeenCalledTimes(1)
    expect((await store.find(raw))?.id).toBe(id)
    expect(compareSpy).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('regenerate of a legacy (not yet backfilled) org key invalidates the old key', async () => {
    const path = join(dir, 'old.db')
    const legacy = buildLegacyDb(path)
    const db = openDb(path)
    const orgKeyStore = new SqliteOrgKeyStore(db)
    const { rawKey: newRaw } = await orgKeyStore.regenerate(legacy.orgId)
    expect(await orgKeyStore.find(legacy.orgRaw)).toBeNull()
    expect((await orgKeyStore.find(newRaw))?.id).toBe(legacy.orgId)
    db.close()
  })

  it('deleted org and api keys stop working', async () => {
    const { orgKeyStore, apiKeyStore } = createStores(':memory:')
    const { rawKey: orgRaw, record: org } = await orgKeyStore.create('acme', 10)
    const { rawKey: apiRaw, record: api } = await apiKeyStore.create('k', org.id)
    await apiKeyStore.delete(api.id)
    await orgKeyStore.delete(org.id)
    expect(await apiKeyStore.find(apiRaw)).toBeNull()
    expect(await orgKeyStore.find(orgRaw)).toBeNull()
  })
})
