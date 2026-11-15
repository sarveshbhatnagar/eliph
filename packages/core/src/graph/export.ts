import { State, Transition, WorkflowGraph } from './types'
import { describeTransition, getNextTransitions, hasState } from './engine'

/** Bounds for the per-item step limit of an exported script. */
export const WORKFLOW_EXPORT_STEPS = { default: 25, min: 1, max: 200 }

/** How many items / characters per label a job accepts; the script refuses more so its result can always be reported. */
const MAX_ITEMS = 200
const MAX_LABEL_LENGTH = 200
/** Same limit as an advance note (SESSION_NOTE_MAX_LENGTH), so a reported step is never rejected for its note. */
const MAX_NOTE_LENGTH = 2000
/** Most steps one POST /job accepts; a larger result is returned with the batches to report it in. */
const MAX_JOB_STEPS = 2000
/** Session data limits (SESSION_DATA_MAX_BYTES, SESSION_DATA_MAX_DEPTH): the script stops an item rather than report data Eliph would refuse. */
const MAX_DATA_BYTES = 64 * 1024
const MAX_DATA_DEPTH = 32
/**
 * Most agent calls one workflow run may make in its lifetime (a limit of the
 * workflow runtime). The script counts its own calls and stops items cleanly
 * at the limit instead of finding out what the runtime does beyond it.
 */
const MAX_AGENT_CALLS = 1000

export interface WorkflowExportOptions {
  /** Most steps one item may take before it is stopped (default 25, clamped to 1..200). Bounds loops. */
  maxSteps?: number
}

export interface WorkflowExport {
  /** Plain-JavaScript workflow script, starting with `export const meta = {...}`. */
  script: string
  /** An example of the `args` the script expects. */
  argsExample: unknown
  /** Human-readable caveats about this export. */
  notes: string[]
}

/** Thrown for a procedure that cannot be turned into a workflow script. */
export class WorkflowExportError extends Error {
  readonly code = 'NOT_EXPORTABLE'
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowExportError'
  }
}

/**
 * Serializes a value as a JavaScript literal. This is the ONLY way user text
 * (names, descriptions, actions) enters the script: JSON keeps it inside
 * string literals, and the extra escapes stop it from closing a surrounding
 * <script> element or (U+2028/2029) from being read as a line break.
 */
function literal(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function isBlank(text: string | undefined): boolean {
  return typeof text !== 'string' || text.trim() === ''
}

/**
 * True when the script passes through this state without calling an agent:
 * nothing to do (no description), nothing to decide (one deterministic exit,
 * no symbolic ones) and nothing to collect (the exit requires no data).
 * Must stay in step with the same test in the script runtime below.
 */
function runsWithoutAgent(state: State | undefined, exits: Transition[]): boolean {
  if (!isBlank(state?.description)) return false
  if (exits.length !== 1 || exits[0].type !== 'deterministic') return false
  return (exits[0].requires ?? []).length === 0
}

/** States reachable from "start", breadth-first, following transitions in stored order. */
function reachableStates(graph: WorkflowGraph): string[] {
  const seen = new Set<string>(['start'])
  const order = ['start']
  for (let i = 0; i < order.length; i++) {
    for (const t of getNextTransitions(graph, order[i])) {
      if (!seen.has(t.to)) {
        seen.add(t.to)
        order.push(t.to)
      }
    }
  }
  return order
}

/** True when some path from "start" can visit a state twice. */
function hasCycle(graph: WorkflowGraph): boolean {
  const done = new Set<string>()
  const onPath = new Set<string>()
  const visit = (name: string): boolean => {
    if (onPath.has(name)) return true
    if (done.has(name)) return false
    onPath.add(name)
    const found = getNextTransitions(graph, name).some(t => visit(t.to))
    onPath.delete(name)
    done.add(name)
    return found
  }
  return visit('start')
}

/**
 * Fewest agent calls one item needs to get from "start" to a terminal state
 * (the cheapest path, counting the states that call an agent). When no terminal
 * state is reachable every item runs until it is stopped, so the count is that
 * of a single step. Lets the script refuse a batch that cannot fit in one run.
 */
function minAgentCalls(graph: WorkflowGraph, reachable: string[], agentStates: string[]): number {
  const cost = (name: string) => (agentStates.includes(name) ? 1 : 0)
  const best = new Map<string, number>([['start', 0]])
  // Relax until stable: graphs are small and all weights are 0 or 1
  for (let changed = true; changed;) {
    changed = false
    for (const from of reachable) {
      const sofar = best.get(from)
      if (sofar === undefined) continue
      for (const t of getNextTransitions(graph, from)) {
        const next = sofar + cost(from)
        if (next < (best.get(t.to) ?? Infinity)) {
          best.set(t.to, next)
          changed = true
        }
      }
    }
  }
  const ends = reachable.filter(name => hasState(graph, name) && graph.states[name].isTerminal && best.has(name))
  if (ends.length === 0) return agentStates.length > 0 ? 1 : 0
  return Math.min(...ends.map(name => best.get(name) as number))
}

function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '')
  return s || 'procedure'
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

function clampMaxSteps(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return WORKFLOW_EXPORT_STEPS.default
  return Math.min(WORKFLOW_EXPORT_STEPS.max, Math.max(WORKFLOW_EXPORT_STEPS.min, Math.floor(value)))
}

const quote = (names: string[]) => names.map(n => `"${n}"`).join(', ')

/**
 * Turns a procedure into a workflow script that walks every item through the
 * state machine with one agent per state, and returns the path each item took
 * in the shape POST /job accepts (label, data, steps). The script cannot talk
 * to Eliph itself, so the caller reports the result afterwards.
 *
 * Throws WorkflowExportError for graphs a script cannot follow faithfully:
 * probabilistic transitions (scripts may not use randomness), no "start"
 * state, or a reachable non-terminal state with no way out.
 */
export function exportWorkflowScript(graph: WorkflowGraph, opts: WorkflowExportOptions = {}): WorkflowExport {
  if (!hasState(graph, 'start')) {
    throw new WorkflowExportError(`Procedure "${graph.name}" has no "start" state, so there is nowhere for a run to begin.`)
  }
  const probabilistic = graph.transitions.filter(t => t.type === 'probabilistic')
  if (probabilistic.length > 0) {
    throw new WorkflowExportError(
      `Procedure "${graph.name}" has probabilistic transitions (${probabilistic.map(describeTransition).join(', ')}). ` +
      'A workflow script cannot pick an exit at random; replace them with symbolic transitions ("from -action-> to") to export it.'
    )
  }
  const reachable = reachableStates(graph)
  const deadEnds = reachable.filter(
    name => !(hasState(graph, name) && graph.states[name].isTerminal) && getNextTransitions(graph, name).length === 0
  )
  if (deadEnds.length > 0) {
    throw new WorkflowExportError(
      `Procedure "${graph.name}" has non-terminal state(s) with no outgoing transitions: ${quote(deadEnds)}. ` +
      'A run reaching one could never finish. Add a transition from each, or mark it terminal.'
    )
  }

  const maxSteps = clampMaxSteps(opts.maxSteps)
  const stateOf = (name: string): State | undefined => (hasState(graph, name) ? graph.states[name] : undefined)
  const working = reachable.filter(name => !stateOf(name)?.isTerminal)
  const silent = working.filter(name => runsWithoutAgent(stateOf(name), getNextTransitions(graph, name)))
  const agentStates = working.filter(name => !silent.includes(name))
  const minCalls = minAgentCalls(graph, reachable, agentStates)

  const meta = {
    name: `eliph-${slug(graph.name)}`,
    description: oneLine(graph.description ?? '', 150) || oneLine(`Runs the "${graph.name}" procedure once per item`, 150),
    phases: agentStates.map(title => ({ title })),
  }

  // Arrays, not objects keyed by user text: an object literal with a
  // "__proto__" key would set a prototype instead of an entry.
  const procedure = {
    name: graph.name,
    description: graph.description ?? '',
    states: Object.keys(graph.states).map(key => {
      const s = graph.states[key]
      const out: { name: string; isTerminal: boolean; description?: string } = { name: key, isTerminal: !!s.isTerminal }
      if (!isBlank(s.description)) out.description = s.description
      return out
    }),
    transitions: graph.transitions.map(t => {
      const out: Transition = { from: t.from, to: t.to, type: t.type }
      if (t.type === 'symbolic' && t.action !== undefined) out.action = t.action
      if (t.requires && t.requires.length > 0) out.requires = [...t.requires]
      return out
    }),
  }

  const replacements: Record<string, string> = {
    __META__: literal(meta),
    __PROCEDURE__: literal(procedure),
    __MAX_STEPS__: String(maxSteps),
    __MAX_ITEMS__: String(MAX_ITEMS),
    __MAX_LABEL__: String(MAX_LABEL_LENGTH),
    __MAX_NOTE__: String(MAX_NOTE_LENGTH),
    __MAX_JOB_STEPS__: String(MAX_JOB_STEPS),
    __MAX_DATA_BYTES__: String(MAX_DATA_BYTES),
    __MAX_DATA_DEPTH__: String(MAX_DATA_DEPTH),
    __MAX_AGENT_CALLS__: String(MAX_AGENT_CALLS),
    __MIN_AGENT_CALLS__: String(minCalls),
  }
  // One pass with a replacer function: inserted text is never rescanned, and
  // "$" sequences in user text are not treated as replacement patterns.
  const script = RUNTIME.replace(/__[A-Z_]+__/g, token => replacements[token] ?? token)

  return {
    script,
    argsExample: { items: [{ label: 'item-1', data: {} }, { label: 'item-2', data: {} }] },
    notes: exportNotes(graph, { maxSteps, reachable, silent, agentStates, minCalls }),
  }
}

function exportNotes(
  graph: WorkflowGraph,
  info: { maxSteps: number; reachable: string[]; silent: string[]; agentStates: string[]; minCalls: number },
): string[] {
  const { maxSteps, reachable, silent, agentStates, minCalls } = info
  const notes: string[] = [
    'The script does not talk to Eliph. When it returns, pass the returned "items" (label, data, steps) to POST /job ' +
    `(create_job) with workflow "${graph.name}" to record every run in one call.`,
    `Pass args as { items: [{ label, data? }] } with unique labels (at most ${MAX_ITEMS} items). Items run concurrently and independently; ` +
    'each state of each item is one agent call that starts with a fresh context.',
  ]
  if (hasCycle(graph)) {
    notes.push(
      `The procedure has loops. Each item is stopped after ${maxSteps} steps (max_steps) and reported with an error and the steps it completed; ` +
      'raise max_steps if a legitimate run needs more.'
    )
  } else {
    notes.push(`Each item is stopped after ${maxSteps} steps (max_steps); this procedure has no loops, so the limit only matters if it is set very low.`)
  }
  if (silent.length > 0) {
    notes.push(
      `These states run without an agent because they have no description, a single deterministic exit and no required data: ${quote(silent)}. ` +
      'Give a state a description if work should happen there.'
    )
  }
  if (agentStates.length === 0) {
    notes.push('No state calls an agent: the script only walks each item along the single deterministic path.')
  }
  const undescribed = agentStates.filter(name => isBlank(graph.states[name]?.description))
  if (undescribed.length > 0) {
    notes.push(
      `These states call an agent but have no description, so the agent only gets the state name and the possible exits: ${quote(undescribed)}.`
    )
  }
  const ambiguous = reachable.filter(name => getNextTransitions(graph, name).filter(t => t.type === 'deterministic').length > 1)
  if (ambiguous.length > 0) {
    notes.push(
      `These states have more than one deterministic exit, which neither Eliph nor the script can choose between: ${quote(ambiguous)}. ` +
      'An item there can only leave through a symbolic action, otherwise it stops with an error.'
    )
  }
  if (!reachable.some(name => hasState(graph, name) && graph.states[name].isTerminal)) {
    notes.push(`No terminal state is reachable from "start", so every item will stop at the ${maxSteps}-step limit with an error.`)
  }
  if (graph.transitions.some(t => (t.requires ?? []).length > 0)) {
    notes.push(
      'Transitions with required data: the agent is asked for the missing keys (as strings) and asked once more if it leaves any out; ' +
      'an item whose required data is still missing stops with an error.'
    )
  }
  const unreachable = Object.keys(graph.states).filter(name => !reachable.includes(name))
  if (unreachable.length > 0) {
    notes.push(`These states cannot be reached from "start" and are never run: ${quote(unreachable)}.`)
  }
  if (minCalls > 0) {
    const fit = Math.floor(MAX_AGENT_CALLS / minCalls)
    notes.push(
      `One workflow run can make at most ${MAX_AGENT_CALLS} agent calls in total, and an item of this procedure needs at least ${minCalls}` +
      (fit < MAX_ITEMS ? `, so at most ${fit} items fit in one run (the script refuses more before any agent starts). ` : '. ') +
      'Longer paths, loops and repeated requests for required data use more calls; items still unfinished when the calls run out are ' +
      'reported with an error and the steps they completed. Use fewer items per run if that can happen.'
    )
  }
  if (MAX_ITEMS * maxSteps > MAX_JOB_STEPS) {
    notes.push(
      `POST /job accepts at most ${MAX_JOB_STEPS} steps in total. When a result has more, the script says so and returns "batches" ` +
      '(lists of labels): call POST /job (create_job) once per batch with the items it names. Each call creates its own job.'
    )
  }
  return notes
}

/**
 * The script. Everything below is fixed text except the __TOKENS__, which are
 * replaced with literals. It must stay plain JavaScript with no template
 * literals, no clock and no randomness (the workflow runtime forbids both so
 * that runs can be resumed), and must not put user text in comments.
 */
const RUNTIME = String.raw`export const meta = __META__

// Generated by Eliph from a procedure. Runs every item through the procedure's
// state machine, one agent per state, and returns the path each item took.
// The result's "items" (label, data, steps) can be passed as-is to Eliph's
// POST /job to record the runs; a result with "batches" has too many steps for
// one call and is reported batch by batch. Regenerate instead of editing by hand.

const PROCEDURE = __PROCEDURE__
const MAX_STEPS = __MAX_STEPS__
const MAX_ITEMS = __MAX_ITEMS__
const MAX_LABEL = __MAX_LABEL__
const MAX_NOTE = __MAX_NOTE__
const MAX_JOB_STEPS = __MAX_JOB_STEPS__
const MAX_DATA_BYTES = __MAX_DATA_BYTES__
const MAX_DATA_DEPTH = __MAX_DATA_DEPTH__
const MAX_AGENT_CALLS = __MAX_AGENT_CALLS__
const MIN_AGENT_CALLS_PER_ITEM = __MIN_AGENT_CALLS__
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype']

const STATES = new Map(PROCEDURE.states.map(s => [s.name, s]))

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function exitsOf(stateName) {
  return PROCEDURE.transitions.filter(t => t.from === stateName)
}

// Same rule as Eliph: null, undefined and blank strings do not count as supplied.
function hasValue(v) {
  if (v === null || v === undefined) return false
  if (typeof v === 'string' && v.trim() === '') return false
  return true
}

function missingFor(exit, data) {
  return (exit.requires || []).filter(
    key => !(Object.prototype.hasOwnProperty.call(data, key) && hasValue(data[key]))
  )
}

// A copy of a data value without the keys Eliph refuses, at any depth. Throws
// for nesting deeper than Eliph stores (the top-level data object is depth 0).
function scrub(value, depth, onForbidden) {
  if (depth > MAX_DATA_DEPTH) throw new Error('data is nested more than ' + MAX_DATA_DEPTH + ' levels deep, which Eliph does not store.')
  if (Array.isArray(value)) return value.map(v => scrub(v, depth + 1, onForbidden))
  if (!isObject(value)) return value
  const out = {}
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      if (onForbidden) onForbidden(key)
      continue
    }
    out[key] = scrub(value[key], depth + 1, onForbidden)
  }
  return out
}

// The usable part of the data an agent returned: own keys with a value,
// without forbidden keys anywhere inside.
function cleanData(raw, onForbidden) {
  const out = {}
  if (!isObject(raw)) return out
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      if (onForbidden) onForbidden(key)
      continue
    }
    if (raw[key] === null || raw[key] === undefined) continue
    out[key] = scrub(raw[key], 1, onForbidden)
  }
  return out
}

// UTF-8 size of a string, as Eliph measures session data.
function byteLength(text) {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}

function dataBytes(data) {
  return byteLength(JSON.stringify(data))
}

// Agent calls are counted here so the run stops cleanly at its lifetime limit.
let agentCalls = 0
function callAgent(prompt, options) {
  if (agentCalls >= MAX_AGENT_CALLS) {
    throw new Error('this workflow run has used all ' + MAX_AGENT_CALLS + ' agent calls it may make. Run the unfinished items again in a new run with fewer items.')
  }
  agentCalls++
  return agent(prompt, options)
}

function describeExit(exit) {
  return exit.type === 'symbolic'
    ? 'action ' + JSON.stringify(exit.action) + ' (moves to ' + JSON.stringify(exit.to) + ')'
    : 'completing the step (moves to ' + JSON.stringify(exit.to) + ')'
}

function readItems(input) {
  let raw = input
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch (e) { throw new Error('args must be { items: [{ label, data? }] }, got a string that is not JSON.') }
  }
  const list = Array.isArray(raw) ? raw : (isObject(raw) ? raw.items : undefined)
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('No items to run. Pass args as { items: [{ label: "name of the piece of work", data: { ... } }] } with at least one item.')
  }
  if (list.length > MAX_ITEMS) {
    throw new Error('Too many items: ' + list.length + '. At most ' + MAX_ITEMS + ' can be reported as one job; split them over several runs.')
  }
  if (list.length * MIN_AGENT_CALLS_PER_ITEM > MAX_AGENT_CALLS) {
    throw new Error('Too many items: ' + list.length + '. Each needs at least ' + MIN_AGENT_CALLS_PER_ITEM + ' agent calls and one run may make '
      + MAX_AGENT_CALLS + ', so pass at most ' + Math.floor(MAX_AGENT_CALLS / MIN_AGENT_CALLS_PER_ITEM) + ' items per run.')
  }
  const seen = new Set()
  return list.map((entry, index) => {
    const item = typeof entry === 'string' ? { label: entry } : entry
    if (!isObject(item) || typeof item.label !== 'string' || item.label.trim() === '') {
      throw new Error('Item ' + (index + 1) + ' has no label. Every item needs a non-empty string "label".')
    }
    if (item.label.length > MAX_LABEL) {
      throw new Error('The label of item ' + (index + 1) + ' is longer than ' + MAX_LABEL + ' characters.')
    }
    if (seen.has(item.label)) {
      throw new Error('Labels must be unique, but ' + JSON.stringify(item.label) + ' is used more than once.')
    }
    seen.add(item.label)
    if (item.data !== undefined && item.data !== null && !isObject(item.data)) {
      throw new Error('The data of item ' + JSON.stringify(item.label) + ' must be an object.')
    }
    // Checked before any agent runs: data Eliph would refuse makes the whole report unusable.
    if (isObject(item.data)) {
      let kept
      try {
        kept = cleanData(item.data, key => { throw new Error('must not contain the key ' + JSON.stringify(key) + ' (at any depth).') })
      } catch (e) {
        throw new Error('The data of item ' + JSON.stringify(item.label) + ': ' + e.message)
      }
      const bytes = dataBytes(kept)
      if (bytes > MAX_DATA_BYTES) {
        throw new Error('The data of item ' + JSON.stringify(item.label) + ' is ' + bytes + ' bytes; Eliph stores at most ' + MAX_DATA_BYTES + ' (64 KB) per run.')
      }
    }
    return { label: item.label, data: isObject(item.data) ? item.data : {} }
  })
}

function buildSchema(exits, symbolic, deterministic) {
  const dataProperties = {}
  for (const exit of exits) {
    for (const key of exit.requires || []) {
      if (!FORBIDDEN_KEYS.includes(key)) dataProperties[key] = { type: 'string' }
    }
  }
  const properties = {}
  const required = []
  if (symbolic.length > 0) {
    properties.action = { type: 'string', enum: Array.from(new Set(symbolic.map(t => t.action))) }
    if (deterministic.length !== 1) required.push('action')
  }
  properties.data = { type: 'object', properties: dataProperties, additionalProperties: true }
  properties.note = { type: 'string' }
  return { type: 'object', properties: properties, required: required }
}

function buildPrompt(item, run, state, exits, symbolic, deterministic, retry) {
  const lines = []
  lines.push('You are carrying out ONE step of a procedure for ONE piece of work. You start with no memory of earlier steps: everything known is below.')
  lines.push('')
  lines.push('Procedure: ' + PROCEDURE.name)
  if (PROCEDURE.description && PROCEDURE.description.trim() !== '') {
    lines.push('About the procedure: ' + PROCEDURE.description)
  }
  lines.push('Piece of work: ' + item.label)
  lines.push('Data collected for this piece of work so far (JSON):')
  lines.push(JSON.stringify(run.data, null, 2))
  lines.push('')
  lines.push('Current step: ' + state.name)
  lines.push('Instructions for this step:')
  lines.push(state.description && state.description.trim() !== ''
    ? state.description
    : '(No written instructions. Work out what this step needs from its name, the procedure and the ways to finish below.)')
  lines.push('')
  lines.push('How to finish this step:')
  const usable = symbolic.concat(deterministic.length === 1 ? deterministic : [])
  for (const exit of usable) {
    const missing = missingFor(exit, run.data)
    const needs = missing.length > 0
      ? ' Before you can finish this way you must supply these data keys: ' + missing.map(k => JSON.stringify(k)).join(', ') + '.'
      : ''
    if (exit.type === 'symbolic') {
      lines.push('- Return action ' + JSON.stringify(exit.action) + ' when that is the outcome; the work then moves to ' + JSON.stringify(exit.to) + '.' + needs)
    } else if (symbolic.length > 0) {
      lines.push('- Leave "action" out when none of the actions apply and the step is simply complete; the work then moves to ' + JSON.stringify(exit.to) + '.' + needs)
    } else {
      lines.push('- There is nothing to choose: when the step is complete the work moves to ' + JSON.stringify(exit.to) + '.' + needs)
    }
  }
  lines.push('')
  lines.push('Do the work of this step now, yourself, and report only when it is done. Do not do later steps.')
  lines.push('Report:')
  if (symbolic.length > 0) lines.push('- action: exactly one of the action names above' + (deterministic.length === 1 ? ', or leave it out as described' : '') + '.')
  lines.push('- data: an object with the values this step produced (the data keys asked for above as strings, plus anything a later step will need, since later steps only see this data).')
  lines.push('- note: one or two sentences on what you did and why you finished this way.')
  if (retry) {
    lines.push('')
    lines.push('IMPORTANT: your previous report finished by ' + describeExit(retry.exit) + ' but left out required data: '
      + retry.missing.map(k => JSON.stringify(k)).join(', ') + '. Finish whatever is needed to know '
      + (retry.missing.length === 1 ? 'it' : 'them') + ' and report again with ' + (retry.missing.length === 1 ? 'that key' : 'those keys')
      + ' filled in under "data". This is the last attempt.')
  }
  return lines.join('\n')
}

async function runItem(item) {
  const run = { state: 'start', data: cleanData(item.data), steps: [] }
  let error
  try {
    while (true) {
      const state = STATES.get(run.state)
      if (!state) { error = 'The procedure has no state ' + JSON.stringify(run.state) + '.'; break }
      if (state.isTerminal) break
      if (run.steps.length >= MAX_STEPS) {
        error = 'Stopped after ' + MAX_STEPS + ' steps without reaching a terminal state (still in ' + JSON.stringify(run.state) + ').'
        break
      }
      const exits = exitsOf(run.state)
      const symbolic = exits.filter(t => t.type === 'symbolic')
      const deterministic = exits.filter(t => t.type === 'deterministic')
      if (exits.length === 0) { error = 'State ' + JSON.stringify(run.state) + ' has no way out.'; break }

      // Nothing to do, decide or collect: pass through without an agent.
      const blank = !state.description || state.description.trim() === ''
      if (blank && exits.length === 1 && deterministic.length === 1 && (deterministic[0].requires || []).length === 0) {
        run.steps.push({})
        run.state = deterministic[0].to
        continue
      }

      const options = {
        label: item.label + ': ' + state.name,
        phase: state.name,
        schema: buildSchema(exits, symbolic, deterministic),
      }
      const pick = answer => {
        const named = typeof answer.action === 'string' ? symbolic.find(t => t.action === answer.action) : undefined
        return named || (deterministic.length === 1 ? deterministic[0] : undefined)
      }

      const first = await callAgent(buildPrompt(item, run, state, exits, symbolic, deterministic, null), options)
      if (!isObject(first)) {
        error = 'The agent for state ' + JSON.stringify(run.state) + ' returned nothing (it was skipped or failed).'
        break
      }
      let exit = pick(first)
      if (!exit) {
        error = 'The agent for state ' + JSON.stringify(run.state) + ' returned '
          + (first.action === undefined ? 'no action' : 'action ' + JSON.stringify(first.action))
          + ', which matches no exit. Valid actions: ' + (symbolic.map(t => JSON.stringify(t.action)).join(', ') || '(none)') + '.'
        break
      }
      const returned = cleanData(first.data)
      Object.assign(run.data, returned)
      let note = first.note

      let missing = missingFor(exit, run.data)
      if (missing.length > 0) {
        const second = await callAgent(buildPrompt(item, run, state, exits, symbolic, deterministic, { exit: exit, missing: missing }), options)
        if (!isObject(second)) {
          error = 'The agent for state ' + JSON.stringify(run.state) + ' returned nothing when asked again for required data ('
            + missing.join(', ') + ').'
          break
        }
        // A changed mind is honoured only when it names an action; a report
        // without one keeps the exit that was being completed.
        const renamed = typeof second.action === 'string' ? symbolic.find(t => t.action === second.action) : undefined
        if (renamed) exit = renamed
        const more = cleanData(second.data)
        Object.assign(returned, more)
        Object.assign(run.data, more)
        if (typeof second.note === 'string' && second.note.trim() !== '') note = second.note
        missing = missingFor(exit, run.data)
        if (missing.length > 0) {
          error = 'State ' + JSON.stringify(run.state) + ': finishing by ' + describeExit(exit) + ' requires data '
            + missing.map(k => JSON.stringify(k)).join(', ') + ', which the agent did not supply after being asked twice.'
          break
        }
      }

      // Eliph would refuse this step on replay, so the item stops here, where
      // the recorded run will be, instead of reporting work that cannot be stored.
      const bytes = dataBytes(run.data)
      if (bytes > MAX_DATA_BYTES) {
        error = 'State ' + JSON.stringify(run.state) + ': the data collected for this item would be ' + bytes + ' bytes; Eliph stores at most '
          + MAX_DATA_BYTES + ' (64 KB) per run. This step was not recorded. Return ids and links instead of full documents.'
        break
      }

      const step = {}
      if (exit.type === 'symbolic') step.completed_action = exit.action
      if (Object.keys(returned).length > 0) step.data = returned
      if (typeof note === 'string' && note.trim() !== '') step.note = note.trim().slice(0, MAX_NOTE)
      run.steps.push(step)
      run.state = exit.to
    }
  } catch (e) {
    // Keep what was completed: a throw must not discard earlier steps.
    error = 'Stopped in state ' + JSON.stringify(run.state) + ': ' + (e && e.message ? e.message : String(e))
  }
  const result = { label: item.label, data: item.data, steps: run.steps, finalState: run.state }
  if (error) result.error = error
  return result
}

const ITEMS = readItems(args)
const settled = await parallel(ITEMS.map(item => () => runItem(item)))
const results = settled.map((result, index) => result || {
  label: ITEMS[index].label,
  data: ITEMS[index].data,
  steps: [],
  finalState: 'start',
  error: 'The run was lost before it reported anything.',
})
const failed = results.filter(r => r.error).length
log(PROCEDURE.name + ': ' + (results.length - failed) + ' finished, ' + failed + ' failed (of ' + results.length + ')')

const output = { workflow: PROCEDURE.name, items: results }
const totalSteps = results.reduce((sum, r) => sum + r.steps.length, 0)
if (totalSteps > MAX_JOB_STEPS) {
  // Too many steps for one POST /job: say how to split, in item order.
  const batches = [[]]
  let inBatch = 0
  for (const r of results) {
    if (inBatch + r.steps.length > MAX_JOB_STEPS && batches[batches.length - 1].length > 0) {
      batches.push([])
      inBatch = 0
    }
    batches[batches.length - 1].push(r.label)
    inBatch += r.steps.length
  }
  output.batches = batches
  output.warning = 'The items hold ' + totalSteps + ' steps and one POST /job (create_job) accepts ' + MAX_JOB_STEPS
    + '. Report them in ' + batches.length + ' calls: one per entry of "batches", each with the items whose labels it lists.'
  log(output.warning)
}

return output
`
