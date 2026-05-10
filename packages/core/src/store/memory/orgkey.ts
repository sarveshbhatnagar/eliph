import { IOrgKeyStore, OrgKey } from '../../index'
import { randomUUID } from 'crypto'

export class InMemoryOrgKeyStore implements IOrgKeyStore {
  private keys = new Map<string, OrgKey & { rawKey: string }>()
  private counts = new Map<string, number>()

  async create(label: string, keyLimit: number): Promise<{ rawKey: string; record: OrgKey }> {
    const id = randomUUID()
    const rawKey = randomUUID()
    const record: OrgKey = { id, label, createdAt: new Date(), keyLimit }
    this.keys.set(id, { ...record, rawKey })
    this.counts.set(id, 0)
    return { rawKey, record }
  }

  async find(rawKey: string): Promise<OrgKey | null> {
    for (const entry of this.keys.values()) {
      if (entry.rawKey === rawKey) {
        const { rawKey: _, ...record } = entry
        return record
      }
    }
    return null
  }

  async list(): Promise<Array<OrgKey & { keyCount: number }>> {
    return Array.from(this.keys.values()).map(({ rawKey: _, ...record }) => ({
      ...record,
      keyCount: this.counts.get(record.id) ?? 0,
    }))
  }

  async delete(id: string): Promise<void> {
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

  _increment(orgKeyId: string): void {
    this.counts.set(orgKeyId, (this.counts.get(orgKeyId) ?? 0) + 1)
  }
}
