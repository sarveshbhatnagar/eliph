import { Transition, WorkflowGraph } from './types'
import { findTransitionIndexes, describeTransition } from './engine'

/** Limits on a transition's required session-data keys. */
export const REQUIRES_LIMITS = {
  /** Names in one transition's "requires". */
  maxNames: 20,
  /** Characters in one name. */
  maxNameLength: 100,
}

/** What a required session-data key may look like. */
export const REQUIRES_NAME_PATTERN = '^[A-Za-z0-9_.-]+$'
const NAME_RE = new RegExp(REQUIRES_NAME_PATTERN)
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Checks a "requires" value and returns it with duplicates dropped (first
 * occurrence kept). Throws an Error saying what is wrong otherwise.
 */
export function validateRequires(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('"requires" must be an array of session-data key names, e.g. ["pr_url"]')
  }
  if (value.length > REQUIRES_LIMITS.maxNames) {
    throw new Error(`"requires" has ${value.length} names; at most ${REQUIRES_LIMITS.maxNames} are allowed.`)
  }
  const names: string[] = []
  for (const name of value) {
    if (typeof name !== 'string') {
      throw new Error(`"requires" entries must be strings, got ${JSON.stringify(name)}`)
    }
    if (name.length < 1 || name.length > REQUIRES_LIMITS.maxNameLength) {
      throw new Error(`"requires" name "${name}" must be 1 to ${REQUIRES_LIMITS.maxNameLength} characters long.`)
    }
    if (!NAME_RE.test(name)) {
      throw new Error(`"requires" name "${name}" may only contain letters, digits, "_", "." and "-".`)
    }
    if (FORBIDDEN_NAMES.has(name)) {
      throw new Error(`"${name}" cannot be used as a required data key.`)
    }
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** The transition with `requires` set, or removed when the list is empty. */
export function withRequires(transition: Transition, requires: string[]): Transition {
  const { requires: _old, ...rest } = transition
  return requires.length > 0 ? { ...rest, requires: [...requires] } : rest
}

/**
 * Sets (or, with an empty list, clears) the data requirement of the existing
 * transition named by a single transition string. Throws when the string names
 * no transition or the list is invalid.
 */
export function setTransitionRequires(graph: WorkflowGraph, transitionStr: string, requires: unknown): WorkflowGraph {
  const names = validateRequires(requires)
  let indexes: number[]
  try {
    indexes = findTransitionIndexes(graph, transitionStr)
  } catch (e: any) {
    throw new Error(`${e.message}. Name exactly one transition, e.g. "review -approved-> merged" (chains are not allowed here).`)
  }
  if (indexes.length === 0) {
    throw new Error(
      `No transition "${transitionStr}" exists in procedure "${graph.name}". ` +
      'Name an existing transition exactly as it was added, e.g. "review -approved-> merged".'
    )
  }
  const set = new Set(indexes)
  return {
    ...graph,
    transitions: graph.transitions.map((t, i) => (set.has(i) ? withRequires(t, names) : t)),
  }
}

/** True when a session-data value counts as supplied (not null/undefined/blank string). */
function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string' && value.trim() === '') return false
  return true
}

/** The required keys of `transition` that `data` does not supply, in declaration order. */
export function missingRequiredData(transition: Pick<Transition, 'requires'>, data: Record<string, unknown> | undefined): string[] {
  const current = data ?? {}
  return (transition.requires ?? []).filter(
    key => !(Object.prototype.hasOwnProperty.call(current, key) && hasValue(current[key]))
  )
}

export class RequiredDataError extends Error {
  readonly code = 'MISSING_REQUIRED_DATA'
  constructor(message: string, public readonly missing: string[]) {
    super(message)
    this.name = 'RequiredDataError'
  }
}

/**
 * Throws RequiredDataError when `data` (the session data with this request's
 * patch already merged) lacks any key the transition requires.
 */
export function assertRequiredData(transition: Transition, data: Record<string, unknown> | undefined): void {
  const missing = missingRequiredData(transition, data)
  if (missing.length === 0) return
  const keys = missing.map(k => `"${k}"`).join(', ')
  const example = missing.map(k => `"${k}": <value>`).join(', ')
  throw new RequiredDataError(
    `Transition "${describeTransition(transition)}" requires session data ${keys} before it can be taken, ` +
    `and ${missing.length === 1 ? 'it is' : 'they are'} missing or empty. ` +
    `Supply ${missing.length === 1 ? 'it' : 'them'} in this advance call, e.g. "data": { ${example} }` +
    `${transition.type === 'symbolic' ? ` together with "completed_action": "${transition.action}"` : ''}. ` +
    'Nothing was changed.',
    missing,
  )
}
