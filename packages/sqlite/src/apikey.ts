import Database from 'better-sqlite3'
import { IApiKeyStore, ApiKey } from '@eliph/core'
export class SqliteApiKeyStore implements IApiKeyStore {
  constructor(private db: Database.Database) {}
  async find(_rawKey: string): Promise<ApiKey | null> { throw new Error('not implemented') }
  async create(_label: string): Promise<{ rawKey: string; record: ApiKey }> { throw new Error('not implemented') }
  async delete(_id: string): Promise<void> { throw new Error('not implemented') }
  async list(): Promise<Omit<ApiKey, 'key'>[]> { throw new Error('not implemented') }
}
