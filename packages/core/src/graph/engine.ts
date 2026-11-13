import { Transition, WorkflowGraph, State } from './types'
import { Requirement } from '../session/types'

// A transition label: any run of characters that does not contain "->" or ">".
// Hyphens are allowed inside it ("tests-pass"), so "a -x-y-> b" has label "x-y".
const LABEL = '(?:[^->]|-(?!>))+'
const LABELED_RE = new RegExp(`^(\\w+)\\s*-(${LABEL})->\\s*(\\w+)$`)
const DETERMINISTIC_RE = /^(\w+)\s*->\s*(\w+)$/
const CHAIN_SEGMENT_RE = new RegExp(`^(\\w+)\\s*(-${LABEL}->|->)\\s*(\\w+)(.*)$`)
// The whole label must be a decimal number (e.g. ".5", "0.25", "1", "1e-3"); "2fa_done" is not.
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** Tolerance used when comparing sums of probabilistic weights against 1.0. */
export const WEIGHT_TOLERANCE = 0.001

/** True when the graph really has this state (ignores inherited object members such as "constructor"). */
export function hasState(graph: Pick<WorkflowGraph, 'states'>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(graph.states, name)
}

/** Names that collide with built-in object members (e.g. "__proto__", "constructor", "toString"). */
export function isReservedStateName(name: string): boolean {
  return name in Object.prototype
}

export function parseTransition(str: string): Transition {
  return parseSingleTransition(str, true)
}

/**
 * Parses one "from -label-> to" / "from -> to" segment. With validateWeight
 * false, out-of-range probabilistic weights are accepted so that edges stored
 * before weights were validated can still be named (e.g. for removal).
 */
function parseSingleTransition(str: string, validateWeight: boolean): Transition {
  // Labeled: "from -label-> to"
  const labeled = str.match(LABELED_RE)
  if (labeled) {
    const [, from, label, to] = labeled
    const trimmed = label.trim()
    if (NUMBER_RE.test(trimmed)) {
      const weight = Number(trimmed)
      if (validateWeight && !(weight > 0 && weight <= 1)) {
        throw new Error(
          `Invalid probabilistic weight "${trimmed}" in "${str}": weights must be greater than 0 and at most 1 (e.g. "${from} -.5-> ${to}"). ` +
          `To use a symbolic action, give it a name that is not a number.`
        )
      }
      return { from, to, type: 'probabilistic', weight }
    }
    return { from, to, type: 'symbolic', action: trimmed }
  }

  // Deterministic: "from -> to"
  const det = str.match(DETERMINISTIC_RE)
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
      if (Math.abs(sum - 1.0) > WEIGHT_TOLERANCE) {
        errors.push(
          `Probabilistic transitions from "${stateName}" must sum to 1.0, got ${sum.toFixed(3)}`
        )
      }
    }
  }

  return errors
}

function formatWeight(n: number): string {
  return String(Number(n.toFixed(3)))
}

function describeTransition(t: Transition): string {
  if (t.type === 'probabilistic') return `${t.from} -${t.weight}-> ${t.to}`
  if (t.type === 'symbolic') return `${t.from} -${t.action}-> ${t.to}`
  return `${t.from} -> ${t.to}`
}

/**
 * Human-readable warnings about a workflow graph. Graphs are built one edge at
 * a time, so these describe problems that will surface when a session runs
 * (an ambiguous or impossible advance), not reasons to reject an edit.
 * Includes everything validateGraph reports.
 */
export function graphWarnings(graph: WorkflowGraph): string[] {
  const warnings = validateGraph(graph)
  const stateNames = Object.keys(graph.states)

  for (const stateName of stateNames) {
    const state = graph.states[stateName]
    const outgoing = graph.transitions.filter(t => t.from === stateName)
    const probabilistic = outgoing.filter(t => t.type === 'probabilistic')
    const deterministic = outgoing.filter(t => t.type === 'deterministic')
    const symbolic = outgoing.filter(t => t.type === 'symbolic')

    if (deterministic.length > 1) {
      warnings.push(
        `State "${stateName}" has ${deterministic.length} deterministic exits (${deterministic.map(describeTransition).join(', ')}); ` +
        `advance() cannot choose between them. Keep one, or turn the others into symbolic ("${stateName} -action-> target") or probabilistic transitions.`
      )
    }

    if (probabilistic.length > 0 && (deterministic.length > 0 || symbolic.length > 0)) {
      const others = [...deterministic, ...symbolic].map(describeTransition).join(', ')
      warnings.push(
        `State "${stateName}" mixes probabilistic exits with deterministic/symbolic ones (${others}); ` +
        `advance() without completed_action always samples the probabilistic exits, so deterministic exits are never taken. ` +
        `Use only one kind of exit per state.`
      )
    }

    if (!state.isTerminal && outgoing.length === 0) {
      warnings.push(
        `State "${stateName}" is not terminal and has no outgoing transitions, so sessions reaching it cannot advance. ` +
        `Add a transition from it, or mark it terminal.`
      )
    }
  }

  const terminals = stateNames.filter(n => graph.states[n].isTerminal)
  if (terminals.length === 0) {
    warnings.push(
      'No terminal state is defined, so sessions can never complete. Add a transition to "end" (auto-terminal) or mark a state terminal.'
    )
  } else if (graph.states['start']) {
    const reachable = new Set<string>(['start'])
    const queue = ['start']
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const t of graph.transitions) {
        if (t.from === current && !reachable.has(t.to)) {
          reachable.add(t.to)
          queue.push(t.to)
        }
      }
    }
    if (!terminals.some(n => reachable.has(n))) {
      warnings.push(
        `No terminal state is reachable from "start" (terminal states: ${terminals.map(n => `"${n}"`).join(', ')}). ` +
        `Add transitions that lead from "start" to a terminal state.`
      )
    }
  }

  return warnings
}

export function addTransition(graph: WorkflowGraph, transitionStr: string): WorkflowGraph {
  return splitTransitionChain(transitionStr).reduce((g, seg) => addSingleTransition(g, seg), graph)
}

function addSingleTransition(graph: WorkflowGraph, transitionStr: string): WorkflowGraph {
  const transition = parseTransition(transitionStr)
  if (transition.type === 'probabilistic') {
    const existing = graph.transitions
      .filter(t => t.from === transition.from && t.type === 'probabilistic')
      .reduce((acc, t) => acc + (t.weight ?? 0), 0)
    const total = existing + transition.weight!
    if (total > 1.0 + WEIGHT_TOLERANCE) {
      throw new Error(
        `Adding "${transitionStr}" would make the probabilistic weights leaving "${transition.from}" sum to ${formatWeight(total)}, ` +
        `which exceeds 1.0 (existing weights already sum to ${formatWeight(existing)}). ` +
        `Lower this weight to at most ${formatWeight(Math.max(0, 1 - existing))}, or remove/adjust an existing probabilistic transition from "${transition.from}" first.`
      )
    }
  }
  const states: Record<string, State> = { ...graph.states }

  for (const name of [transition.from, transition.to]) {
    if (isReservedStateName(name)) {
      throw new Error(`"${name}" cannot be used as a state name. Pick a different name.`)
    }
    if (!hasState({ states }, name)) {
      states[name] = { name, isTerminal: name === 'end' }
    }
  }

  return { ...graph, states, transitions: [...graph.transitions, transition] }
}

export function markStateTerminal(graph: WorkflowGraph, stateName: string): WorkflowGraph {
  if (!hasState(graph, stateName)) {
    throw new Error(`State "${stateName}" does not exist in workflow "${graph.name}"`)
  }
  return {
    ...graph,
    states: {
      ...graph.states,
      [stateName]: { ...graph.states[stateName], isTerminal: true },
    },
  }
}

// Splits "start -.5-> tails -> end" into ["start -.5-> tails", "tails -> end"]
function splitTransitionChain(chain: string): string[] {
  const results: string[] = []
  let remaining = chain.trim()

  while (remaining) {
    const m = remaining.match(CHAIN_SEGMENT_RE)
    if (!m) throw new Error(`Invalid transition string: "${chain}"`)
    const [, from, arrow, to, rest] = m
    results.push(`${from} ${arrow} ${to}`)
    remaining = rest.trim()
    if (remaining) remaining = `${to} ${remaining}`
  }

  return results
}

export function removeTransition(graph: WorkflowGraph, transitionStr: string): WorkflowGraph {
  const target = parseSingleTransition(transitionStr, false)
  const matches = (t: Transition, want: Transition) =>
    t.from === want.from &&
    t.to === want.to &&
    t.type === want.type &&
    t.action === want.action &&
    t.weight === want.weight
  let transitions = graph.transitions.filter(t => !matches(t, target))

  // Legacy: labels that merely start with a number (e.g. "2fa_done") used to be
  // stored as probabilistic edges with weight parseFloat(label). Let the
  // original string still remove such an edge.
  if (transitions.length === graph.transitions.length && target.type === 'symbolic') {
    const legacyWeight = parseFloat(target.action ?? '')
    if (!isNaN(legacyWeight)) {
      const legacy: Transition = { from: target.from, to: target.to, type: 'probabilistic', weight: legacyWeight }
      transitions = graph.transitions.filter(t => !matches(t, legacy))
    }
  }

  return { ...graph, transitions }
}

export function removeState(graph: WorkflowGraph, name: string): WorkflowGraph {
  if (name === 'start' || name === 'end') {
    throw new Error(`Cannot remove reserved state "${name}"`)
  }
  if (!hasState(graph, name)) {
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

export function getNextTransitions(graph: WorkflowGraph, stateName: string): Transition[] {
  return graph.transitions.filter(t => t.from === stateName)
}

export function sampleNext(transitions: Transition[]): string {
  if (transitions.length === 0) {
    throw new Error('Cannot sample from empty transitions array')
  }
  const rand = Math.random()
  let cumulative = 0
  for (const t of transitions) {
    cumulative += t.weight ?? 0
    if (rand <= cumulative) return t.to
  }
  return transitions[transitions.length - 1].to
}

export function requirements(graph: WorkflowGraph, stateName: string): Requirement[] {
  return graph.transitions
    .filter(t => t.from === stateName && t.type === 'symbolic')
    .map(t => ({ action: t.action!, targetState: t.to }))
}
