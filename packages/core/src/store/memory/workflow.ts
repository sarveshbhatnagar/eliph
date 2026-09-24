import { IWorkflowStore, WorkflowSummary } from '../interfaces'
import { WorkflowGraph } from '../../graph/types'

function stateText(graph: WorkflowGraph): string {
  return Object.values(graph.states)
    .map(s => [s.name, s.description].filter(Boolean).join(' '))
    .join(' ')
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

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
    const graphs = Array.from(this.store.entries())
      .filter(([k]) => k.startsWith(`${ownerId}:`))
      .map(([, g]) => g)

    const tokens = tokenize(query.trim())
    // Empty/no-token query -> browse mode: return all for owner, ordered by name.
    if (tokens.length === 0) {
      return graphs
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(g => ({ name: g.name, description: g.description }))
    }

    // Score each graph by how many query tokens appear, weighting name hits higher
    // than description/state-text hits so a name match ranks above a body-only match.
    const NAME_WEIGHT = 10
    const BODY_WEIGHT = 1
    const scored = graphs
      .map(g => {
        const nameHay = g.name.toLowerCase()
        const bodyHay = `${g.description} ${stateText(g)}`.toLowerCase()
        let score = 0
        for (const t of tokens) {
          if (nameHay.includes(t)) score += NAME_WEIGHT
          else if (bodyHay.includes(t)) score += BODY_WEIGHT
        }
        return { g, score }
      })
      .filter(s => s.score > 0)

    // Stable sort by score desc (Array.prototype.sort is stable in V8/Node).
    scored.sort((a, b) => b.score - a.score)
    return scored.map(s => ({ name: s.g.name, description: s.g.description }))
  }

  async save(graph: WorkflowGraph, ownerId: string): Promise<void> {
    this.store.set(this.key(graph.name, ownerId), graph)
  }

  async delete(name: string, ownerId: string): Promise<void> {
    this.store.delete(this.key(name, ownerId))
  }
}
