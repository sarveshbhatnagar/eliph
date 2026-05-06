export type TransitionType = 'deterministic' | 'probabilistic' | 'symbolic'

export interface Transition {
  from: string
  to: string
  type: TransitionType
  weight?: number   // probabilistic only (0–1)
  action?: string   // symbolic only (e.g. "check_todo_done")
}

export interface State {
  name: string
  isTerminal: boolean  // true when name === 'end'
}

export interface WorkflowGraph {
  name: string
  description: string
  states: Record<string, State>
  transitions: Transition[]
}
