import { IApiKeyStore } from '../interfaces'
import { ApiKey } from '../../session/types'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

export class InMemoryApiKeyStore implements IApiKeyStore {
  private store = new Map<string, ApiKey>()

  async find(rawKey: string): Promise<ApiKey | null> {
    for (const record of this.store.values()) {
      if (await bcrypt.compare(rawKey, record.key)) return record
    }
    return null
  }

  async create(label: string): Promise<{ rawKey: string; record: ApiKey }> {
    const rawKey = randomUUID()
    const hashed = await bcrypt.hash(rawKey, 10)
    const record: ApiKey = { id: randomUUID(), key: hashed, label, createdAt: new Date() }
    this.store.set(record.id, record)
    return { rawKey, record }
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id)
  }

  async list(): Promise<Omit<ApiKey, 'key'>[]> {
    return Array.from(this.store.values()).map(({ key: _key, ...rest }) => rest)
  }
}
