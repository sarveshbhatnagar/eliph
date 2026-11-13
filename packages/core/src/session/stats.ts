import { WorkflowGraph } from '../graph/types'
import { Session, SessionEvent } from './types'

export interface StateExitStats {
  to: string
  /** completed_action of the advance, or null when none was given. */
  action: string | null
  count: number
}

export interface StateStats {
  state: string
  /** Times sessions entered the state (created, advance or reset into it). */
  entered: number
  /** Sessions whose current state it is. */
  currentlyHere: number
  /** Advances out of the state, grouped by target and action, most frequent first. */
  exits: StateExitStats[]
  /** Resets whose `from` is this state. */
  resetsAway: number
  /** Mean ms between entering the state and the event that left it; null if never left. */
  avgDwellMs: number | null
}

export interface ProcedureStats {
  workflow: string
  sessionsAnalyzed: number
  truncated: boolean
  totals: { sessions: number; completed: number; active: number }
  states: StateStats[]
}

interface Acc {
  entered: number
  currentlyHere: number
  exits: Map<string, StateExitStats>
  resetsAway: number
  dwellSum: number
  dwellCount: number
}

const ENTERS: ReadonlySet<SessionEvent['type']> = new Set(['created', 'advance', 'reset'])

/**
 * Per-state statistics for one workflow, from its sessions' event logs.
 * Sessions saved before the event log existed (no events) count in the totals,
 * in currentlyHere and, through their history, in entered; they contribute
 * nothing to exits or dwell times. Whether a session is completed is judged
 * against its pinned snapshot when it has one, else against `graph`.
 * States are listed in the graph's order, then any other state seen in the
 * sessions (e.g. one since removed from the procedure) in order of appearance.
 */
export function computeProcedureStats(
  workflow: string,
  graph: WorkflowGraph,
  sessions: Session[],
  truncated = false,
): ProcedureStats {
  const accs = new Map<string, Acc>()
  const acc = (state: string): Acc => {
    let a = accs.get(state)
    if (!a) {
      a = { entered: 0, currentlyHere: 0, exits: new Map(), resetsAway: 0, dwellSum: 0, dwellCount: 0 }
      accs.set(state, a)
    }
    return a
  }
  for (const name of Object.keys(graph.states)) acc(name)

  let completed = 0
  for (const session of sessions) {
    acc(session.currentState).currentlyHere++
    const sessionGraph = session.pinnedGraph ?? graph
    const current = Object.prototype.hasOwnProperty.call(sessionGraph.states, session.currentState)
      ? sessionGraph.states[session.currentState]
      : undefined
    if (current?.isTerminal) completed++

    const events = session.events ?? []
    if (events.length === 0) {
      for (const state of session.history ?? []) acc(state).entered++
      continue
    }

    // The state the session is in and when it got there, as far as the log tells
    let here: { state: string; at: number } | null = null
    for (const event of events) {
      const at = Date.parse(event.at)
      if ((event.type === 'advance' || event.type === 'reset') && event.from !== undefined) {
        const from = acc(event.from)
        if (event.type === 'advance') {
          const action = event.action ?? null
          const key = JSON.stringify([event.to ?? null, action])
          const exit = from.exits.get(key)
          if (exit) exit.count++
          else if (event.to !== undefined) from.exits.set(key, { to: event.to, action, count: 1 })
        } else {
          from.resetsAway++
        }
        if (here && here.state === event.from && !isNaN(at) && !isNaN(here.at)) {
          from.dwellSum += Math.max(0, at - here.at)
          from.dwellCount++
        }
      }
      if (ENTERS.has(event.type) && event.to !== undefined) {
        acc(event.to).entered++
        here = { state: event.to, at }
      }
    }
  }

  const states: StateStats[] = [...accs.entries()].map(([state, a]) => ({
    state,
    entered: a.entered,
    currentlyHere: a.currentlyHere,
    exits: [...a.exits.values()].sort(
      (x, y) => y.count - x.count || x.to.localeCompare(y.to) || (x.action ?? '').localeCompare(y.action ?? '')
    ),
    resetsAway: a.resetsAway,
    avgDwellMs: a.dwellCount > 0 ? Math.round(a.dwellSum / a.dwellCount) : null,
  }))

  return {
    workflow,
    sessionsAnalyzed: sessions.length,
    truncated,
    totals: { sessions: sessions.length, completed, active: sessions.length - completed },
    states,
  }
}
