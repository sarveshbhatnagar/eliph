import { WorkflowGraph } from '../graph/types'
import { Session } from './types'
import { getNextTransitions, sampleNext } from '../graph/engine'

export function computeNextState(
  graph: WorkflowGraph,
  session: Session,
  completedAction?: string
): string {
  const outgoing = getNextTransitions(graph, session.currentState)

  if (outgoing.length === 0) {
    throw new Error(`No outgoing transitions from state "${session.currentState}"`)
  }

  if (completedAction !== undefined) {
    const match = outgoing.find(t => t.type === 'symbolic' && t.action === completedAction)
    if (!match) {
      throw new Error(
        `Action "${completedAction}" does not match any valid transition from "${session.currentState}"`
      )
    }
    return match.to
  }

  const probabilistic = outgoing.filter(t => t.type === 'probabilistic')
  if (probabilistic.length > 0) {
    return sampleNext(probabilistic)
  }

  const deterministic = outgoing.filter(t => t.type === 'deterministic')
  if (deterministic.length === 1) {
    return deterministic[0].to
  }

  if (outgoing.some(t => t.type === 'symbolic')) {
    throw new Error(
      `State "${session.currentState}" requires a completed_action to advance`
    )
  }

  throw new Error(`Cannot determine next state from "${session.currentState}"`)
}

export function applyAdvance(session: Session, newState: string): Session {
  return { ...session, currentState: newState, history: [...session.history, newState] }
}

export function applyReset(session: Session, targetState: string): Session {
  return { ...session, currentState: targetState, history: [...session.history, targetState] }
}
