import Database from 'better-sqlite3'
import { IApiKeyStore, ApiKey } from '@eliph/core'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

export class SqliteApiKeyStore implements IApiKeyStore {
  constructor(private db: Database.Database) {}

  async find(rawKey: string): Promise<ApiKey | null> {
    const rows = this.db
      .prepare('SELECT id, label, created_at, key_hash FROM api_keys')
      .all() as { id: string; label: string; created_at: string; key_hash: string }[]

    for (const row of rows) {
      if (await bcrypt.compare(rawKey, row.key_hash)) {
        return {
          id: row.id,
          key: row.key_hash,
          label: row.label,
          createdAt: new Date(row.created_at),
        }
      }
    }
    return null
  }

  async create(label: string): Promise<{ rawKey: string; record: ApiKey }> {
    const rawKey = randomUUID()
    const keyHash = await bcrypt.hash(rawKey, 10)
    const id = randomUUID()
    const now = new Date()

    this.db
      .prepare('INSERT INTO api_keys (id, label, created_at, key_hash) VALUES (?, ?, ?, ?)')
      .run(id, label, now.toISOString(), keyHash)

    const record: ApiKey = { id, key: keyHash, label, createdAt: now }
    return { rawKey, record }
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id)
  }

  async list(): Promise<Omit<ApiKey, 'key'>[]> {
    const rows = this.db
      .prepare('SELECT id, label, created_at FROM api_keys')
      .all() as { id: string; label: string; created_at: string }[]
    return rows.map(row => ({
      id: row.id,
      label: row.label,
      createdAt: new Date(row.created_at),
    }))
  }
}
