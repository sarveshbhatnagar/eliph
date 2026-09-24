import Database from 'better-sqlite3'
import { IWorkflowStore, WorkflowGraph, WorkflowSummary } from '@eliph/core'

function stateText(graph: WorkflowGraph): string {
  return Object.values(graph.states)
    .map(s => [s.name, s.description].filter(Boolean).join(' '))
    .join(' ')
}

export class SqliteWorkflowStore implements IWorkflowStore {
  constructor(private db: Database.Database) {
    this.backfillFts()
  }

  /**
   * Populate workflows_fts for any workflow rows missing from the index. The FTS
   * table is standalone, so a pre-existing database (or one created before FTS
   * existed) has rows in `workflows` but none in `workflows_fts`. state_text must
   * be computed in JS from the JSON graph, so this can't be a pure-SQL migration.
   * Idempotent: guarded by a rowid NOT IN check, so it is a no-op once backfilled.
   */
  private backfillFts(): void {
    const missing = this.db
      .prepare(`
        SELECT rowid, name, description, api_key_id, data FROM workflows
        WHERE rowid NOT IN (SELECT rowid FROM workflows_fts)
      `)
      .all() as { rowid: number; name: string; description: string; api_key_id: string; data: string }[]
    if (missing.length === 0) return

    const insert = this.db.prepare(`
      INSERT INTO workflows_fts (rowid, name, description, state_text, api_key_id)
      VALUES (?, ?, ?, ?, ?)
    `)
    const tx = this.db.transaction(() => {
      for (const r of missing) {
        const graph = JSON.parse(r.data) as WorkflowGraph
        insert.run(r.rowid, r.name, r.description, stateText(graph), r.api_key_id)
      }
    })
    tx()
  }

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
    const trimmed = query.trim()

    const browse = (): WorkflowSummary[] =>
      this.db
        .prepare('SELECT name, description FROM workflows WHERE api_key_id = ? ORDER BY name')
        .all(ownerId) as WorkflowSummary[]

    if (trimmed === '') return browse()

    const tokens = trimmed.toLowerCase().match(/[\p{L}\p{N}]+/gu)
    if (!tokens || tokens.length === 0) return browse()

    const matchExpr = tokens.map(t => '"' + t + '"*').join(' OR ')

    try {
      return this.db
        .prepare(`
          SELECT name, description FROM workflows_fts
          WHERE workflows_fts MATCH ? AND api_key_id = ?
          ORDER BY bm25(workflows_fts, 10.0, 5.0, 1.0)
          LIMIT 50
        `)
        .all(matchExpr, ownerId) as WorkflowSummary[]
    } catch {
      // Fall back to substring filter so search never throws to the caller.
      const q = trimmed.toLowerCase()
      const rows = this.db
        .prepare('SELECT name, description FROM workflows WHERE api_key_id = ?')
        .all(ownerId) as { name: string; description: string }[]
      return rows
        .filter(r => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
        .map(r => ({ name: r.name, description: r.description }))
    }
  }

  async save(graph: WorkflowGraph, ownerId: string): Promise<void> {
    const now = new Date().toISOString()
    const tx = this.db.transaction(() => {
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

      const { rowid } = this.db
        .prepare('SELECT rowid FROM workflows WHERE name = ? AND api_key_id = ?')
        .get(graph.name, ownerId) as { rowid: number }

      this.db.prepare('DELETE FROM workflows_fts WHERE rowid = ?').run(rowid)

      this.db
        .prepare(`
          INSERT INTO workflows_fts (rowid, name, description, state_text, api_key_id)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(rowid, graph.name, graph.description, stateText(graph), ownerId)
    })
    tx()
  }

  async delete(name: string, ownerId: string): Promise<void> {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT rowid FROM workflows WHERE name = ? AND api_key_id = ?')
        .get(name, ownerId) as { rowid: number } | undefined

      if (row) {
        this.db.prepare('DELETE FROM workflows_fts WHERE rowid = ?').run(row.rowid)
      }

      this.db.prepare('DELETE FROM workflows WHERE name = ? AND api_key_id = ?').run(name, ownerId)
    })
    tx()
  }
}
