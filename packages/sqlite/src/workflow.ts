import Database from 'better-sqlite3'
import { IWorkflowStore, WorkflowGraph } from '@eliph/core'
export class SqliteWorkflowStore implements IWorkflowStore {
  constructor(private db: Database.Database) {}
  async get(_name: string): Promise<WorkflowGraph | null> { throw new Error('not implemented') }
  async list(): Promise<string[]> { throw new Error('not implemented') }
  async search(_query: string): Promise<string[]> { throw new Error('not implemented') }
  async save(_graph: WorkflowGraph): Promise<void> { throw new Error('not implemented') }
  async delete(_name: string): Promise<void> { throw new Error('not implemented') }
}
