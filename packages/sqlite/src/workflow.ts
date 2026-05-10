import Database from 'better-sqlite3'
import { IWorkflowStore, WorkflowGraph, WorkflowSummary } from '@eliph/core'

export class SqliteWorkflowStore implements IWorkflowStore {
  constructor(private db: Database.Database) {}

  async get(name: string, ownerId: string): Promise<WorkflowGraph | null> {
    const row = this.db
      .prepare('SELECT data FROM workflows WHERE name = ? AND api_key_id = ?')
      .get(name, ownerId) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as WorkflowGraph) : null
  }

  async list(ownerId: string): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT name FROM workflows WHERE api_key_id = ?')
      .all(ownerId) as { name: string }[]
    return rows.map(r => r.name)
  }

  async search(query: string, ownerId: string): Promise<WorkflowSummary[]> {
    const q = query.toLowerCase()
    const rows = this.db
      .prepare('SELECT name, description FROM workflows WHERE api_key_id = ?')
      .all(ownerId) as { name: string; description: string }[]
    return rows
      .filter(r => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
      .map(r => ({ name: r.name, description: r.description }))
  }

  async save(graph: WorkflowGraph, ownerId: string): Promise<void> {
    const now = new Date().toISOString()
    this.db
      .prepare(`
        INSERT INTO workflows (name, api_key_id, description, created_at, updated_at, data)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name, api_key_id) DO UPDATE SET
          description = excluded.description,
          updated_at  = excluded.updated_at,
          data        = excluded.data
      `)
      .run(graph.name, ownerId, graph.description, now, now, JSON.stringify(graph))
  }

  async delete(name: string, ownerId: string): Promise<void> {
    this.db.prepare('DELETE FROM workflows WHERE name = ? AND api_key_id = ?').run(name, ownerId)
  }
}
