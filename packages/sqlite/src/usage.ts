import Database from 'better-sqlite3'
import { IUsageStore, UsageEventType, UsageByKey } from '@eliph/core'
import { randomUUID } from 'crypto'

export class SqliteUsageStore implements IUsageStore {
  constructor(private db: Database.Database) {}

  async record(event: { orgKeyId: string; apiKeyId: string; apiKeyLabel: string; eventType: UsageEventType }): Promise<void> {
    this.db.prepare(
      'INSERT INTO usage_events (id, org_key_id, api_key_id, api_key_label, event_type, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), event.orgKeyId, event.apiKeyId, event.apiKeyLabel, event.eventType, new Date().toISOString())
  }

  async query(orgKeyId: string, from?: Date, to?: Date): Promise<UsageByKey[]> {
    const fromStr = (from ?? new Date(0)).toISOString()
    const toStr = (to ?? new Date()).toISOString()

    const rows = this.db.prepare(`
      SELECT
        api_key_id,
        api_key_label,
        SUM(CASE WHEN event_type = 'advance' THEN 1 ELSE 0 END) AS advances,
        SUM(CASE WHEN event_type = 'session_created' THEN 1 ELSE 0 END) AS sessions_created
      FROM usage_events
      WHERE org_key_id = ?
        AND created_at >= ?
        AND created_at <= ?
      GROUP BY api_key_id, api_key_label
      ORDER BY advances DESC
    `).all(orgKeyId, fromStr, toStr) as {
      api_key_id: string
      api_key_label: string
      advances: number
      sessions_created: number
    }[]

    return rows.map(r => ({
      apiKeyId: r.api_key_id,
      apiKeyLabel: r.api_key_label,
      advances: r.advances,
      sessionsCreated: r.sessions_created,
    }))
  }
}
