import { WorkflowGraph, State } from './types'
import { addTransition } from './engine'

export interface StateDefinition {
  /** What the agent should do / context for this state. */
  description?: string
  /** Mark the state terminal. "end" is always terminal; false never un-marks it. */
  terminal?: boolean
}

/** A whole workflow in one value: what PUT /procedure/:name and define_procedure accept. */
export interface WorkflowDefinition {
  name: string
  description: string
  /** Transition strings (chains allowed), applied in order with addTransition. */
  transitions: string[]
  states?: Record<string, StateDefinition>
}

const STATE_KEYS = new Set(['description', 'terminal'])

/** Limits that keep one definition from tying up the (single-threaded) server. */
export const DEFINITION_LIMITS = {
  /** Entries in "transitions". */
  maxTransitionStrings: 500,
  /** Characters in one transition string. */
  maxTransitionLength: 1000,
  /** Edges in the resulting graph (a chain string adds several). */
  maxEdges: 1000,
  /** Entries in "states". */
  maxStates: 500,
}

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key)

/**
 * Builds a complete workflow graph from a definition, entirely in memory.
 * Every transition goes through addTransition, so the usual rules apply
 * (label grammar, weights in (0, 1], per-state weight total at most 1.0).
 * Throws an Error naming the offending transition string or state; nothing
 * is partially applied because the caller only gets a graph on success.
 */
export function buildGraph(definition: WorkflowDefinition): WorkflowGraph {
  const { name, description, transitions, states } = definition
  if (!Array.isArray(transitions)) {
    throw new Error('"transitions" must be an array of transition strings, e.g. ["start -> review -> end"]')
  }
  if (transitions.length > DEFINITION_LIMITS.maxTransitionStrings) {
    throw new Error(
      `"transitions" has ${transitions.length} entries; at most ${DEFINITION_LIMITS.maxTransitionStrings} are allowed in one definition.`
    )
  }

  let graph: WorkflowGraph = {
    name,
    description,
    states: { start: { name: 'start', isTerminal: false } },
    transitions: [],
  }

  transitions.forEach((str, i) => {
    if (typeof str !== 'string') {
      throw new Error(`Transition #${i + 1} must be a string, got ${JSON.stringify(str)}`)
    }
    if (str.length > DEFINITION_LIMITS.maxTransitionLength) {
      throw new Error(
        `Transition #${i + 1} is ${str.length} characters long; at most ${DEFINITION_LIMITS.maxTransitionLength} are allowed.`
      )
    }
    try {
      graph = addTransition(graph, str)
    } catch (e: any) {
      throw new Error(`Transition #${i + 1} "${str}" is invalid: ${e.message}`)
    }
    if (graph.transitions.length > DEFINITION_LIMITS.maxEdges) {
      throw new Error(
        `Transition #${i + 1} "${str}" brings the procedure to ${graph.transitions.length} transitions; ` +
        `at most ${DEFINITION_LIMITS.maxEdges} are allowed in one definition.`
      )
    }
  })

  if (states !== undefined && states !== null) {
    if (typeof states !== 'object' || Array.isArray(states)) {
      throw new Error('"states" must be an object mapping state names to { description?, terminal? }')
    }
    const entries = Object.entries(states)
    if (entries.length > DEFINITION_LIMITS.maxStates) {
      throw new Error(`"states" has ${entries.length} entries; at most ${DEFINITION_LIMITS.maxStates} are allowed.`)
    }
    const updated: Record<string, State> = { ...graph.states }
    for (const [stateName, def] of entries) {
      // Own-property check: "constructor", "toString", "__proto__" etc. are not states.
      const existing = hasOwn(updated, stateName) ? updated[stateName] : undefined
      if (!existing) {
        throw new Error(
          `State "${stateName}" in "states" does not appear in any transition (check for a typo). ` +
          `Known states: ${Object.keys(updated).map(n => `"${n}"`).join(', ')}.`
        )
      }
      if (def === null || typeof def !== 'object' || Array.isArray(def)) {
        throw new Error(`State "${stateName}" in "states" must be an object like { "description": "...", "terminal": true }`)
      }
      const unknown = Object.keys(def).filter(k => !STATE_KEYS.has(k))
      if (unknown.length > 0) {
        throw new Error(
          `State "${stateName}" in "states" has unknown field(s) ${unknown.map(k => `"${k}"`).join(', ')}; ` +
          `only "description" and "terminal" are allowed.`
        )
      }
      if (def.description !== undefined && typeof def.description !== 'string') {
        throw new Error(`State "${stateName}" in "states": "description" must be a string`)
      }
      if (def.terminal !== undefined && typeof def.terminal !== 'boolean') {
        throw new Error(`State "${stateName}" in "states": "terminal" must be a boolean`)
      }
      updated[stateName] = {
        ...existing,
        isTerminal: existing.isTerminal || def.terminal === true,
        ...(def.description !== undefined ? { description: def.description } : {}),
      }
    }
    graph = { ...graph, states: updated }
  }

  return graph
}
