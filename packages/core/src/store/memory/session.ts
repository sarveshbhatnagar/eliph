import { ISessionStore, SessionListOptions } from '../interfaces'
import { Session } from '../../session/types'

export class InMemorySessionStore implements ISessionStore {
  private store = new Map<string, Session>()

  async get(id: string): Promise<Session | null> {
    return this.store.get(id) ?? null
  }

  async save(session: Session): Promise<void> {
    this.store.set(session.id, session)
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id)
  }

  async findByState(workflowName: string, state: string): Promise<Session[]> {
    return Array.from(this.store.values()).filter(
      s => s.workflowName === workflowName && s.currentState === state
    )
  }

  async list(ownerIds: string[], opts: SessionListOptions = {}): Promise<Session[]> {
    const owners = new Set(ownerIds)
    const offset = opts.offset ?? 0
    const matching = Array.from(this.store.values())
      .filter(s => owners.has(s.workflowOwnerId))
      .filter(s => opts.workflowName === undefined || s.workflowName === opts.workflowName)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    return opts.limit === undefined ? matching.slice(offset) : matching.slice(offset, offset + opts.limit)
  }
}
