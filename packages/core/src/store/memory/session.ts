import { ISessionStore } from '../interfaces'
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
}
