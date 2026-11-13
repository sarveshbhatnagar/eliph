export type TransitionType = 'deterministic' | 'probabilistic' | 'symbolic'

export interface Transition {
  from: string
  to: string
  type: TransitionType
  weight?: number   // probabilistic only (0–1)
  action?: string   // symbolic only (e.g. "check_todo_done")
  /**
   * Session-data keys that must hold a value (not null, undefined or a blank
   * string) before this transition can be taken. Missing on transitions
   * without a requirement (and on graphs stored before it existed).
   */
  requires?: string[]
}

export interface State {
  name: string
  isTerminal: boolean  // true when name === 'end'
  description?: string // what the agent should do / context for this state
}

export interface WorkflowGraph {
  name: string
  description: string
  states: Record<string, State>
  transitions: Transition[]
}
