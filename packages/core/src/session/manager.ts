import { Transition, WorkflowGraph } from '../graph/types'
import { Session, SessionEvent } from './types'
import { appendSessionEvent, mergeSessionData } from './data'
import { getNextTransitions, sampleTransition } from '../graph/engine'

export function computeNextState(
  graph: WorkflowGraph,
  session: Session,
  completedAction?: string
): string {
  return chooseTransition(graph, session, completedAction).to
}

/**
 * The transition an advance takes from the session's current state (sampled
 * for probabilistic exits). Throws with an agent-readable message when none can
 * be taken.
 */
export function chooseTransition(
  graph: WorkflowGraph,
  session: Session,
  completedAction?: string
): Transition {
  const currentState = graph.states[session.currentState]
  if (currentState?.isTerminal) {
    throw new Error(
      `Session is already in terminal state "${session.currentState}". The workflow is complete — no further advances are possible.`
    )
  }

  const outgoing = getNextTransitions(graph, session.currentState)

  if (outgoing.length === 0) {
    throw new Error(
      `State "${session.currentState}" has no outgoing transitions — it is effectively terminal. ` +
      `If this is an end state, call mark_terminal("${graph.name}", "${session.currentState}") to mark it correctly.`
    )
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
    return match
  }

  const probabilistic = outgoing.filter(t => t.type === 'probabilistic')
  if (probabilistic.length > 0) {
    return sampleTransition(probabilistic)
  }

  const deterministic = outgoing.filter(t => t.type === 'deterministic')
  if (deterministic.length === 1) {
    return deterministic[0]
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

/** Optional extras for an advance or reset: a data patch and a note for the event log. */
export interface StepOptions {
  action?: string
  note?: string
  data?: unknown
  now?: Date
}

function applyStep(session: Session, type: 'advance' | 'reset', newState: string, opts: StepOptions): Session {
  const now = opts.now ?? new Date()
  const event: SessionEvent = { type, from: session.currentState, to: newState, at: now.toISOString() }
  if (opts.action !== undefined) event.action = opts.action
  if (opts.note !== undefined) event.note = opts.note
  const updated: Session = {
    ...session,
    currentState: newState,
    history: [...session.history, newState],
    updatedAt: now,
    events: appendSessionEvent(session.events, event),
  }
  if (opts.data !== undefined) updated.data = mergeSessionData(session.data, opts.data)
  return updated
}

export function applyAdvance(session: Session, newState: string, opts: StepOptions = {}): Session {
  return applyStep(session, 'advance', newState, opts)
}

export function applyReset(session: Session, targetState: string, opts: Omit<StepOptions, 'action'> = {}): Session {
  return applyStep(session, 'reset', targetState, opts)
}
