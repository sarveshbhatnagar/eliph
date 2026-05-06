import { IWorkflowStore } from '../interfaces'
import { WorkflowGraph } from '../../graph/types'

export class InMemoryWorkflowStore implements IWorkflowStore {
  private store = new Map<string, WorkflowGraph>()

  async get(name: string): Promise<WorkflowGraph | null> {
    return this.store.get(name) ?? null
  }

  async list(): Promise<string[]> {
    return Array.from(this.store.keys())
  }

  async search(query: string): Promise<string[]> {
    const q = query.toLowerCase()
    return Array.from(this.store.values())
      .filter(g => g.name.toLowerCase().includes(q) || g.description.toLowerCase().includes(q))
      .map(g => g.name)
  }

  async save(graph: WorkflowGraph): Promise<void> {
    this.store.set(graph.name, graph)
  }

  async delete(name: string): Promise<void> {
    this.store.delete(name)
  }
}
