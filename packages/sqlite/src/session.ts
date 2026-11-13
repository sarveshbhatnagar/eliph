import Database from 'better-sqlite3'
import { ISessionStore, Session, SessionListOptions } from '@eliph/core'

type SessionRow = { data: string; updated_at?: string }

function rowToSession(row: SessionRow): Session {
  const parsed = JSON.parse(row.data)
  const session: Session = { ...parsed, createdAt: new Date(parsed.createdAt) }
  // The updated_at column exists for every row, including those saved before
  // updatedAt was part of the JSON blob.
  const updatedAt = row.updated_at ?? parsed.updatedAt
  if (updatedAt) session.updatedAt = new Date(updatedAt)
  else delete session.updatedAt
  return session
}

export class SqliteSessionStore implements ISessionStore {
  constructor(private db: Database.Database) {}

  async get(id: string): Promise<Session | null> {
    const row = this.db
      .prepare('SELECT data, updated_at FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined
    if (!row) return null
    return rowToSession(row)
  }

  async save(session: Session): Promise<void> {
    const now = new Date().toISOString()
    this.db
      .prepare(`
        INSERT INTO sessions (id, workflow_name, current_state, created_at, updated_at, data, owner_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workflow_name = excluded.workflow_name,
          current_state = excluded.current_state,
          updated_at    = excluded.updated_at,
          data          = excluded.data,
          owner_id      = excluded.owner_id
      `)
      .run(
        session.id,
        session.workflowName,
        session.currentState,
        session.createdAt.toISOString(),
        now,
        JSON.stringify(session),
        session.workflowOwnerId ?? null,
      )
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  async findByState(workflowName: string, state: string): Promise<Session[]> {
    const rows = this.db
      .prepare('SELECT data, updated_at FROM sessions WHERE workflow_name = ? AND current_state = ?')
      .all(workflowName, state) as SessionRow[]
    return rows.map(rowToSession)
  }

  async list(ownerIds: string[], opts: SessionListOptions = {}): Promise<Session[]> {
    if (ownerIds.length === 0) return []
    const params: (string | number)[] = [...ownerIds]
    let sql = `SELECT data, updated_at FROM sessions WHERE owner_id IN (${ownerIds.map(() => '?').join(', ')})`
    if (opts.workflowName !== undefined) {
      sql += ' AND workflow_name = ?'
      params.push(opts.workflowName)
    }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
    params.push(opts.limit ?? -1, opts.offset ?? 0)
    const rows = this.db.prepare(sql).all(...params) as SessionRow[]
    return rows.map(rowToSession)
  }
}
