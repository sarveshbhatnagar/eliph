import { IOrgKeyStore, OrgKey } from '../../index'
import { randomUUID } from 'crypto'
import { keyLookupHash } from '../keylookup'

export class InMemoryOrgKeyStore implements IOrgKeyStore {
  private keys = new Map<string, OrgKey & { rawKey: string }>()
  // sha256(rawKey) -> id, so find() is a Map lookup instead of a scan
  private byLookup = new Map<string, string>()
  private counts = new Map<string, number>()

  async create(label: string, keyLimit: number): Promise<{ rawKey: string; record: OrgKey }> {
    const id = randomUUID()
    const rawKey = randomUUID()
    const record: OrgKey = { id, label, createdAt: new Date(), keyLimit }
    this.keys.set(id, { ...record, rawKey })
    this.byLookup.set(keyLookupHash(rawKey), id)
    this.counts.set(id, 0)
    return { rawKey, record }
  }

  async find(rawKey: string): Promise<OrgKey | null> {
    const id = this.byLookup.get(keyLookupHash(rawKey))
    const entry = id ? this.keys.get(id) : undefined
    if (!entry || entry.rawKey !== rawKey) return null
    const { rawKey: _, ...record } = entry
    return record
  }

  async list(): Promise<Array<OrgKey & { keyCount: number }>> {
    return Array.from(this.keys.values()).map(({ rawKey: _, ...record }) => ({
      ...record,
      keyCount: this.counts.get(record.id) ?? 0,
    }))
  }

  async delete(id: string): Promise<void> {
    const entry = this.keys.get(id)
    if (entry) this.byLookup.delete(keyLookupHash(entry.rawKey))
    this.keys.delete(id)
    this.counts.delete(id)
  }

  async countKeys(orgKeyId: string): Promise<number> {
    return this.counts.get(orgKeyId) ?? 0
  }

  async updateLimit(id: string, keyLimit: number): Promise<void> {
    const entry = this.keys.get(id)
    if (entry) this.keys.set(id, { ...entry, keyLimit })
  }

  async regenerate(id: string): Promise<{ rawKey: string }> {
    const entry = this.keys.get(id)
    if (!entry) throw new Error('Org key not found')
    const rawKey = randomUUID()
    this.byLookup.delete(keyLookupHash(entry.rawKey))
    this.keys.set(id, { ...entry, rawKey })
    this.byLookup.set(keyLookupHash(rawKey), id)
    return { rawKey }
  }

  _increment(orgKeyId: string): void {
    this.counts.set(orgKeyId, (this.counts.get(orgKeyId) ?? 0) + 1)
  }
}
