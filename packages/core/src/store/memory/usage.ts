import { IUsageStore, UsageEventType, UsageByKey } from '../interfaces'

export class InMemoryUsageStore implements IUsageStore {
  private events: Array<{ orgKeyId: string; apiKeyId: string; apiKeyLabel: string; eventType: UsageEventType; createdAt: Date }> = []

  async record(event: { orgKeyId: string; apiKeyId: string; apiKeyLabel: string; eventType: UsageEventType }): Promise<void> {
    this.events.push({ ...event, createdAt: new Date() })
  }

  async query(orgKeyId: string, from?: Date, to?: Date): Promise<UsageByKey[]> {
    const f = from ?? new Date(0)
    const t = to ?? new Date()
    const filtered = this.events.filter(e =>
      e.orgKeyId === orgKeyId && e.createdAt >= f && e.createdAt <= t
    )
    const map = new Map<string, UsageByKey>()
    for (const e of filtered) {
      const key = e.apiKeyId
      if (!map.has(key)) map.set(key, { apiKeyId: e.apiKeyId, apiKeyLabel: e.apiKeyLabel, advances: 0, sessionsCreated: 0 })
      const entry = map.get(key)!
      if (e.eventType === 'advance') entry.advances++
      else entry.sessionsCreated++
    }
    return Array.from(map.values()).sort((a, b) => b.advances - a.advances)
  }
}
