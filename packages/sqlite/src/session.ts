import Database from 'better-sqlite3'
import { ISessionStore, Session } from '@eliph/core'
export class SqliteSessionStore implements ISessionStore {
  constructor(private db: Database.Database) {}
  async get(_id: string): Promise<Session | null> { throw new Error('not implemented') }
  async save(_session: Session): Promise<void> { throw new Error('not implemented') }
  async delete(_id: string): Promise<void> { throw new Error('not implemented') }
  async findByState(_workflowName: string, _state: string): Promise<Session[]> { throw new Error('not implemented') }
}
