import { IWorkflowStore, WorkflowSummary } from '../interfaces'
import { WorkflowGraph } from '../../graph/types'

export class InMemoryWorkflowStore implements IWorkflowStore {
  private store = new Map<string, WorkflowGraph>()

  private key(name: string, ownerId: string) { return `${ownerId}:${name}` }

  async get(name: string, ownerId: string): Promise<WorkflowGraph | null> {
    return this.store.get(this.key(name, ownerId)) ?? null
  }

  async list(ownerId: string): Promise<string[]> {
    return Array.from(this.store.entries())
      .filter(([k]) => k.startsWith(`${ownerId}:`))
      .map(([, g]) => g.name)
  }

  async search(query: string, ownerId: string): Promise<WorkflowSummary[]> {
    const q = query.toLowerCase()
    return Array.from(this.store.entries())
      .filter(([k]) => k.startsWith(`${ownerId}:`))
      .map(([, g]) => g)
      .filter(g => g.name.toLowerCase().includes(q) || g.description.toLowerCase().includes(q))
      .map(g => ({ name: g.name, description: g.description }))
  }

  async save(graph: WorkflowGraph, ownerId: string): Promise<void> {
    this.store.set(this.key(graph.name, ownerId), graph)
  }

  async delete(name: string, ownerId: string): Promise<void> {
    this.store.delete(this.key(name, ownerId))
  }
}
