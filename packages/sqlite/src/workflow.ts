import Database from 'better-sqlite3'
import { IWorkflowStore, WorkflowGraph, WorkflowSummary } from '@eliph/core'

export class SqliteWorkflowStore implements IWorkflowStore {
  constructor(private db: Database.Database) {}

  async get(name: string): Promise<WorkflowGraph | null> {
    const row = this.db
      .prepare('SELECT data FROM workflows WHERE name = ?')
      .get(name) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as WorkflowGraph) : null
  }

  async list(): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT name FROM workflows')
      .all() as { name: string }[]
    return rows.map(r => r.name)
  }

  async search(query: string): Promise<WorkflowSummary[]> {
    const q = query.toLowerCase()
    const rows = this.db
      .prepare('SELECT name, description FROM workflows')
      .all() as { name: string; description: string }[]
    return rows
      .filter(r => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
      .map(r => ({ name: r.name, description: r.description }))
  }

  async save(graph: WorkflowGraph): Promise<void> {
    const now = new Date().toISOString()
    this.db
      .prepare(`
        INSERT INTO workflows (name, description, created_at, updated_at, data)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          description = excluded.description,
          updated_at  = excluded.updated_at,
          data        = excluded.data
      `)
      .run(graph.name, graph.description, now, now, JSON.stringify(graph))
  }

  async delete(name: string): Promise<void> {
    this.db.prepare('DELETE FROM workflows WHERE name = ?').run(name)
  }
}
