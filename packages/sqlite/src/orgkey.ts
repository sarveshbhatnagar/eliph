import Database from 'better-sqlite3'
import { IOrgKeyStore, OrgKey } from '@eliph/core'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

export class SqliteOrgKeyStore implements IOrgKeyStore {
  constructor(private db: Database.Database) {}

  async create(label: string, keyLimit: number): Promise<{ rawKey: string; record: OrgKey }> {
    const rawKey = randomUUID()
    const keyHash = await bcrypt.hash(rawKey, 10)
    const id = randomUUID()
    const now = new Date()

    this.db
      .prepare('INSERT INTO org_keys (id, label, created_at, key_hash, key_limit) VALUES (?, ?, ?, ?, ?)')
      .run(id, label, now.toISOString(), keyHash, keyLimit)

    const record: OrgKey = { id, label, createdAt: now, keyLimit }
    return { rawKey, record }
  }

  async find(rawKey: string): Promise<OrgKey | null> {
    const rows = this.db
      .prepare('SELECT id, label, created_at, key_hash, key_limit FROM org_keys')
      .all() as { id: string; label: string; created_at: string; key_hash: string; key_limit: number }[]

    for (const row of rows) {
      if (await bcrypt.compare(rawKey, row.key_hash)) {
        return {
          id: row.id,
          label: row.label,
          createdAt: new Date(row.created_at),
          keyLimit: row.key_limit,
        }
      }
    }
    return null
  }

  async list(): Promise<Array<OrgKey & { keyCount: number }>> {
    const rows = this.db.prepare(`
      SELECT o.id, o.label, o.created_at, o.key_limit,
             COUNT(a.id) AS key_count
      FROM org_keys o
      LEFT JOIN api_keys a ON a.org_key_id = o.id
      GROUP BY o.id
    `).all() as { id: string; label: string; created_at: string; key_limit: number; key_count: number }[]

    return rows.map(row => ({
      id: row.id,
      label: row.label,
      createdAt: new Date(row.created_at),
      keyLimit: row.key_limit,
      keyCount: row.key_count,
    }))
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM org_keys WHERE id = ?').run(id)
  }

  async countKeys(orgKeyId: string): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM api_keys WHERE org_key_id = ?')
      .get(orgKeyId) as { cnt: number }
    return row.cnt
  }

  async updateLimit(id: string, keyLimit: number): Promise<void> {
    this.db.prepare('UPDATE org_keys SET key_limit = ? WHERE id = ?').run(keyLimit, id)
  }

  async regenerate(id: string): Promise<{ rawKey: string }> {
    const rawKey = randomUUID()
    const keyHash = await bcrypt.hash(rawKey, 10)
    this.db.prepare('UPDATE org_keys SET key_hash = ? WHERE id = ?').run(keyHash, id)
    return { rawKey }
  }
}
