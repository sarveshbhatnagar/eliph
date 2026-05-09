import Database from 'better-sqlite3'
import { ISessionStore, Session } from '@eliph/core'

export class SqliteSessionStore implements ISessionStore {
  constructor(private db: Database.Database) {}

  async get(id: string): Promise<Session | null> {
    const row = this.db
      .prepare('SELECT data FROM sessions WHERE id = ?')
      .get(id) as { data: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.data)
    return { ...parsed, createdAt: new Date(parsed.createdAt) }
  }

  async save(session: Session): Promise<void> {
    const now = new Date().toISOString()
    this.db
      .prepare(`
        INSERT INTO sessions (id, workflow_name, current_state, created_at, updated_at, data)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workflow_name = excluded.workflow_name,
          current_state = excluded.current_state,
          updated_at    = excluded.updated_at,
          data          = excluded.data
      `)
      .run(
        session.id,
        session.workflowName,
        session.currentState,
        session.createdAt.toISOString(),
        now,
        JSON.stringify(session),
      )
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  async findByState(workflowName: string, state: string): Promise<Session[]> {
    const rows = this.db
      .prepare('SELECT data FROM sessions WHERE workflow_name = ? AND current_state = ?')
      .all(workflowName, state) as { data: string }[]
    return rows.map(row => {
      const parsed = JSON.parse(row.data)
      return { ...parsed, createdAt: new Date(parsed.createdAt) }
    })
  }
}
