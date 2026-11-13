import { IApiKeyStore } from '../interfaces'
import { ApiKey } from '../../session/types'
import { InMemoryOrgKeyStore } from './orgkey'
import { keyLookupHash } from '../keylookup'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

export class InMemoryApiKeyStore implements IApiKeyStore {
  private store = new Map<string, ApiKey>()
  // sha256(rawKey) -> id, so find() is a Map lookup with no bcrypt
  private byLookup = new Map<string, string>()

  constructor(private orgKeyStore?: InMemoryOrgKeyStore) {}

  async findById(id: string): Promise<ApiKey | null> {
    return this.store.get(id) ?? null
  }

  async find(rawKey: string): Promise<ApiKey | null> {
    const id = this.byLookup.get(keyLookupHash(rawKey))
    return id ? this.store.get(id) ?? null : null
  }

  async create(label: string, orgKeyId: string): Promise<{ rawKey: string; record: ApiKey }> {
    const rawKey = randomUUID()
    const hashed = await bcrypt.hash(rawKey, 10)
    const record: ApiKey = { id: randomUUID(), key: hashed, label, createdAt: new Date(), orgKeyId }
    this.store.set(record.id, record)
    this.byLookup.set(keyLookupHash(rawKey), record.id)
    this.orgKeyStore?._increment(orgKeyId)
    return { rawKey, record }
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id)
    for (const [lookup, keyId] of this.byLookup) {
      if (keyId === id) this.byLookup.delete(lookup)
    }
  }

  async list(orgKeyId?: string): Promise<Omit<ApiKey, 'key'>[]> {
    const all = Array.from(this.store.values())
    const filtered = orgKeyId ? all.filter(k => k.orgKeyId === orgKeyId) : all
    return filtered.map(({ key: _key, ...rest }) => rest)
  }
}
