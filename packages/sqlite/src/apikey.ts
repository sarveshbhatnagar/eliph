import Database from 'better-sqlite3'
import { IApiKeyStore, ApiKey, keyLookupHash } from '@eliph/core'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'
import { findKeyRow, markKeyLookupVerified } from './keylookup'

type ApiKeyRow = { id: string; label: string; created_at: string; key_hash: string; org_key_id: string }

const COLUMNS = 'id, label, created_at, key_hash, org_key_id'

function toApiKey(row: ApiKeyRow): ApiKey {
  return { id: row.id, key: row.key_hash, label: row.label, createdAt: new Date(row.created_at), orgKeyId: row.org_key_id }
}

export class SqliteApiKeyStore implements IApiKeyStore {
  constructor(private db: Database.Database) {}

  async findById(id: string): Promise<ApiKey | null> {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM api_keys WHERE id = ?`)
      .get(id) as ApiKeyRow | undefined
    return row ? toApiKey(row) : null
  }

  async find(rawKey: string): Promise<ApiKey | null> {
    const row = await findKeyRow<ApiKeyRow>(this.db, 'api_keys', COLUMNS, rawKey)
    return row ? toApiKey(row) : null
  }

  async create(label: string, orgKeyId: string): Promise<{ rawKey: string; record: ApiKey }> {
    const rawKey = randomUUID()
    const keyHash = await bcrypt.hash(rawKey, 10)
    const id = randomUUID()
    const now = new Date()

    this.db
      .prepare('INSERT INTO api_keys (id, label, created_at, key_hash, org_key_id, key_lookup) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, label, now.toISOString(), keyHash, orgKeyId, keyLookupHash(rawKey))
    markKeyLookupVerified(id, keyHash)

    const record: ApiKey = { id, key: keyHash, label, createdAt: now, orgKeyId }
    return { rawKey, record }
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id)
  }

  async list(orgKeyId?: string): Promise<Omit<ApiKey, 'key'>[]> {
    const rows = orgKeyId
      ? this.db
          .prepare('SELECT id, label, created_at, org_key_id FROM api_keys WHERE org_key_id = ?')
          .all(orgKeyId) as { id: string; label: string; created_at: string; org_key_id: string }[]
      : this.db
          .prepare('SELECT id, label, created_at, org_key_id FROM api_keys')
          .all() as { id: string; label: string; created_at: string; org_key_id: string }[]

    return rows.map(row => ({
      id: row.id,
      label: row.label,
      createdAt: new Date(row.created_at),
      orgKeyId: row.org_key_id,
    }))
  }
}
