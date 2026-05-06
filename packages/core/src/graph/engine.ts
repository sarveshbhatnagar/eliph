import { Transition, WorkflowGraph, State } from './types'
import { Requirement } from '../session/types'

export function parseTransition(str: string): Transition {
  // Labeled: "from -label-> to"
  const labeled = str.match(/^(\w+)\s*-([^->]+)->\s*(\w+)$/)
  if (labeled) {
    const [, from, label, to] = labeled
    const trimmed = label.trim()
    const weight = parseFloat(trimmed)
    if (!isNaN(weight)) {
      return { from, to, type: 'probabilistic', weight }
    }
    return { from, to, type: 'symbolic', action: trimmed }
  }

  // Deterministic: "from -> to"
  const det = str.match(/^(\w+)\s*->\s*(\w+)$/)
  if (det) {
    const [, from, to] = det
    return { from, to, type: 'deterministic' }
  }

  throw new Error(`Invalid transition string: "${str}"`)
}

export function validateGraph(graph: WorkflowGraph): string[] {
  const errors: string[] = []

  if (!graph.states['start']) {
    errors.push('Graph must have a "start" state')
  }

  for (const stateName of Object.keys(graph.states)) {
    const probabilistic = graph.transitions.filter(
      t => t.from === stateName && t.type === 'probabilistic'
    )
    if (probabilistic.length > 0) {
      const sum = probabilistic.reduce((acc, t) => acc + (t.weight ?? 0), 0)
      if (Math.abs(sum - 1.0) > 0.001) {
        errors.push(
          `Probabilistic transitions from "${stateName}" must sum to 1.0, got ${sum.toFixed(3)}`
        )
      }
    }
  }

  return errors
}

export function addTransition(graph: WorkflowGraph, transitionStr: string): WorkflowGraph {
  const transition = parseTransition(transitionStr)
  const states: Record<string, State> = { ...graph.states }

  if (!states[transition.from]) {
    states[transition.from] = { name: transition.from, isTerminal: transition.from === 'end' }
  }
  if (!states[transition.to]) {
    states[transition.to] = { name: transition.to, isTerminal: transition.to === 'end' }
  }

  return { ...graph, states, transitions: [...graph.transitions, transition] }
}

export function removeTransition(graph: WorkflowGraph, transitionStr: string): WorkflowGraph {
  const target = parseTransition(transitionStr)
  return {
    ...graph,
    transitions: graph.transitions.filter(
      t =>
        !(
          t.from === target.from &&
          t.to === target.to &&
          t.type === target.type &&
          t.action === target.action
        )
    ),
  }
}

export function removeState(graph: WorkflowGraph, name: string): WorkflowGraph {
  if (name === 'start' || name === 'end') {
    throw new Error(`Cannot remove reserved state "${name}"`)
  }
  if (!graph.states[name]) {
    throw new Error(`State "${name}" does not exist`)
  }
  const states = { ...graph.states }
  delete states[name]
  return {
    ...graph,
    states,
    transitions: graph.transitions.filter(t => t.from !== name && t.to !== name),
  }
}
