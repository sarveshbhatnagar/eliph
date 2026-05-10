import { WorkflowGraph } from '../graph/types'
import { Session } from './types'
import { getNextTransitions, sampleNext } from '../graph/engine'

export function computeNextState(
  graph: WorkflowGraph,
  session: Session,
  completedAction?: string
): string {
  const currentState = graph.states[session.currentState]
  if (currentState?.isTerminal) {
    throw new Error(
      `Session is already in terminal state "${session.currentState}". The workflow is complete — no further advances are possible.`
    )
  }

  const outgoing = getNextTransitions(graph, session.currentState)

  if (outgoing.length === 0) {
    throw new Error(`No outgoing transitions from state "${session.currentState}"`)
  }

  if (completedAction !== undefined) {
    const match = outgoing.find(t => t.type === 'symbolic' && t.action === completedAction)
    if (!match) {
      const validActions = outgoing.filter(t => t.type === 'symbolic').map(t => `"${t.action}"`)
      const deterministicPaths = outgoing.filter(t => t.type === 'deterministic').map(t => `"${t.from} -> ${t.to}"`)
      throw new Error(
        `Action "${completedAction}" does not match any transition from "${session.currentState}". ` +
        (validActions.length > 0 ? `Valid actions: ${validActions.join(', ')}. ` : `No symbolic transitions from this state — `) +
        (deterministicPaths.length > 0 ? `Deterministic transitions (advance with no completed_action): ${deterministicPaths.join(', ')}.` : '')
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
    const actions = outgoing.filter(t => t.type === 'symbolic').map(t => `"${t.action}" → "${t.to}"`)
    throw new Error(
      `State "${session.currentState}" requires a completed_action to advance. ` +
      `Valid actions: ${actions.join(', ')}.`
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
