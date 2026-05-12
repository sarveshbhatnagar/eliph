import { IApiKeyStore } from '../interfaces'
import { ApiKey } from '../../session/types'
import { InMemoryOrgKeyStore } from './orgkey'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

export class InMemoryApiKeyStore implements IApiKeyStore {
  private store = new Map<string, ApiKey>()

  constructor(private orgKeyStore?: InMemoryOrgKeyStore) {}

  async findById(id: string): Promise<ApiKey | null> {
    return this.store.get(id) ?? null
  }

  async find(rawKey: string): Promise<ApiKey | null> {
    for (const record of this.store.values()) {
      if (await bcrypt.compare(rawKey, record.key)) return record
    }
    return null
  }

  async create(label: string, orgKeyId: string): Promise<{ rawKey: string; record: ApiKey }> {
    const rawKey = randomUUID()
    const hashed = await bcrypt.hash(rawKey, 10)
    const record: ApiKey = { id: randomUUID(), key: hashed, label, createdAt: new Date(), orgKeyId }
    this.store.set(record.id, record)
    this.orgKeyStore?._increment(orgKeyId)
    return { rawKey, record }
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id)
  }

  async list(orgKeyId?: string): Promise<Omit<ApiKey, 'key'>[]> {
    const all = Array.from(this.store.values())
    const filtered = orgKeyId ? all.filter(k => k.orgKeyId === orgKeyId) : all
    return filtered.map(({ key: _key, ...rest }) => rest)
  }
}
