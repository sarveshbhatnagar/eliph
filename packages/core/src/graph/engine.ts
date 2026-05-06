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
