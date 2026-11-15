import { FastifyRequest } from 'fastify'
import {
  IWorkflowStore, ISessionStore, IUsageStore, IApiKeyStore, Session, WorkflowGraph, getNextTransitions,
  applyAdvance, applyReset, mergeSessionData, hasState, SessionDataError,
  sessionRevision, chooseTransition, assertRequiredData, RequiredDataError,
} from '@eliph/core'
import { randomUUID } from 'crypto'
import { canAccessSession } from '../middleware/auth'

/**
 * Session operations shared by the single-session routes (sessions.ts) and the
 * job routes (jobs.ts). They never touch a reply: each returns an OpResult the
 * route turns into a response, so a job can run many of them in one request.
 */

export type Caller = Pick<FastifyRequest, 'authContext'>

export const NOT_FOUND = { error: 'Not found', code: 'NOT_FOUND' }

/** Internal code of an advance refused because the run no longer has the number of steps the caller compared against. */
export const POSITION_MISMATCH = 'POSITION_MISMATCH'

/** Longest `actor` accepted on a step. */
export const ACTOR_MAX_LENGTH = 200

export interface ErrorBody {
  error: string
  code: string
  missing?: string[]
  currentState?: string
}

/** A step that did not happen: the HTTP status and body the single-session route answers with. */
export interface OpFailure {
  ok: false
  status: number
  body: ErrorBody
  /** The session as loaded, when the failure happened after it was found and authorised. */
  session?: Session
}

export interface OpSuccess<G = WorkflowGraph> {
  ok: true
  session: Session
  graph: G
}

export type OpResult<G = WorkflowGraph> = OpSuccess<G> | OpFailure

/** What an advance or reset request may carry (the route bodies, minus the path). */
export interface StepInput {
  workflow?: string
  completed_action?: string
  target_state?: string
  expected_state?: string
  data?: unknown
  note?: string
  actor?: string
}

/** Description, terminal flag and outgoing transitions of a session's current state. */
export function stepContext(graph: WorkflowGraph | null, stateName: string) {
  const state = graph?.states[stateName]
  return {
    stateDescription: state?.description ?? null,
    isTerminal: state?.isTerminal ?? false,
    nextTransitions: graph ? getNextTransitions(graph, stateName) : [],
  }
}

/** `{ pinned: true }` for a pinned session, nothing otherwise (unpinned responses are unchanged). */
export function pinnedFlag(session: Session): { pinned?: true } {
  return session.pinnedGraph ? { pinned: true } : {}
}

/** A session response: the session, its full data, and the step context of its current state. */
export function sessionResponse(session: Session, graph: WorkflowGraph | null) {
  // The graph snapshot and the concurrency counter are internal
  const { pinnedGraph: _pinnedGraph, revision: _revision, ...rest } = session
  return { ...rest, data: session.data ?? {}, ...pinnedFlag(session), ...stepContext(graph, session.currentState) }
}

/** The graph a session runs against: its pinned snapshot, or else the live procedure. */
export function graphFor(workflowStore: IWorkflowStore, session: Session): Promise<WorkflowGraph | null> {
  if (session.pinnedGraph) return Promise.resolve(session.pinnedGraph)
  return workflowStore.get(session.workflowName, session.workflowOwnerId)
}

/** How many times a read-modify-write is attempted before answering 409. */
export const SESSION_WRITE_ATTEMPTS = 10

const WRITE_CONFLICT = {
  error: 'The session was changed by other requests at the same time and this change could not be applied. Nothing was changed by this request; retry it.',
  code: 'CONFLICT',
}

/** Returned by a write attempt whose conditional save lost a race. */
export const RETRY = Symbol('retry')

/** Short random pause before retrying, so concurrent writers stop colliding. */
function backoff(attempt: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.random() * 5 * attempt))
}

/**
 * Run a session read-modify-write with optimistic concurrency. `attempt` loads
 * the session afresh, decides and tries a conditional save; it returns its
 * result (success or failure), or RETRY when the save lost a race. The whole
 * attempt is then retried; after SESSION_WRITE_ATTEMPTS losses: 409.
 */
export async function withWriteRetries<T>(attempt: () => Promise<T | typeof RETRY>): Promise<T | OpFailure> {
  for (let i = 0; i < SESSION_WRITE_ATTEMPTS; i++) {
    if (i > 0) await backoff(i)
    const result = await attempt()
    if (result !== RETRY) return result as T
  }
  return { ok: false, status: 409, body: WRITE_CONFLICT }
}

export function dataFailure(e: SessionDataError, session?: Session): OpFailure {
  return { ok: false, status: e.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, body: { error: e.message, code: e.code }, session }
}

/** An empty or missing actor means "not given": nothing is recorded. */
function actorOf(input: Pick<StepInput, 'actor'>): string | undefined {
  return input.actor ? input.actor : undefined
}

/**
 * The expected_state guard: a caller that says which state it believes the
 * session is in is refused when the session is somewhere else, so two workers
 * finishing the same step cannot move the run twice. An empty value means
 * "not given", like actor: a JSON null arrives here as "" (body coercion), and
 * no state has an empty name, so a client that fills unused fields is not refused.
 */
function stateMismatch(session: Session, expected: string | undefined): OpFailure | null {
  if (!expected || expected === session.currentState) return null
  return {
    ok: false,
    status: 409,
    body: {
      error: `Session "${session.id}" is in state "${session.currentState}", not "${expected}" (expected_state). Nothing was changed.`,
      code: 'STATE_MISMATCH',
      currentState: session.currentState,
    },
    session,
  }
}

/**
 * Decide one advance of `session` on `graph` without saving anything: the
 * updated session, or why the step is refused. Shared by the advance route,
 * the job advance route and the steps of POST /job.
 */
export function advanceOnce(session: Session, graph: WorkflowGraph, input: StepInput): OpResult {
  const mismatch = stateMismatch(session, input.expected_state)
  if (mismatch) return mismatch
  try {
    const transition = chooseTransition(graph, session, input.completed_action)
    const updated = applyAdvance(session, transition.to, {
      action: input.completed_action, note: input.note, data: input.data, actor: actorOf(input),
    })
    // Checked against the data as it would be after this advance; on failure nothing is saved
    assertRequiredData(transition, updated.data)
    return { ok: true, session: updated, graph }
  } catch (e: any) {
    if (e instanceof SessionDataError) return dataFailure(e, session)
    if (e instanceof RequiredDataError) return { ok: false, status: 400, body: { error: e.message, code: e.code, missing: e.missing }, session }
    return { ok: false, status: 400, body: { error: e.message, code: 'BAD_REQUEST' }, session }
  }
}

/** Decide one reset of `session` on `graph` without saving anything. */
export function resetOnce(session: Session, graph: WorkflowGraph, input: StepInput): OpResult {
  const mismatch = stateMismatch(session, input.expected_state)
  if (mismatch) return mismatch
  const target = input.target_state ?? 'start'
  if (!hasState(graph, target)) {
    return { ok: false, status: 400, body: { error: `State "${target}" does not exist`, code: 'BAD_REQUEST' }, session }
  }
  try {
    return { ok: true, session: applyReset(session, target, { note: input.note, data: input.data, actor: actorOf(input) }), graph }
  } catch (e) {
    if (e instanceof SessionDataError) return dataFailure(e, session)
    throw e
  }
}

/** Initial session data from a request body, validated like any data patch. */
export function initialData(data: unknown): { ok: true; data: Record<string, unknown> } | OpFailure {
  try {
    return { ok: true, data: data === undefined ? {} : mergeSessionData({}, data) }
  } catch (e) {
    if (e instanceof SessionDataError) return dataFailure(e)
    throw e
  }
}

export interface NewSessionOptions {
  data: Record<string, unknown>
  pin?: boolean
  jobId?: string
  label?: string
  actor?: string
  /** Creation time; defaults to now. */
  now?: Date
}

/** A new, unsaved session at "start" of `graph`, owned by `owner`. */
export function buildSession(owner: string, graph: WorkflowGraph, workflowName: string, opts: NewSessionOptions): Session {
  const now = opts.now ?? new Date()
  const session: Session = {
    id: randomUUID(),
    workflowName,
    workflowOwnerId: owner,
    currentState: 'start',
    history: ['start'],
    createdAt: now,
    updatedAt: now,
    data: opts.data,
    events: [{ type: 'created', to: 'start', at: now.toISOString(), ...(opts.actor ? { actor: opts.actor } : {}) }],
  }
  if (opts.pin === true) session.pinnedGraph = structuredClone(graph)
  if (opts.jobId !== undefined) session.jobId = opts.jobId
  if (opts.label !== undefined) session.label = opts.label
  return session
}

export function recordUsage(req: Caller, usageStore: IUsageStore, eventType: 'advance' | 'session_created') {
  const ctx = req.authContext
  if (ctx?.type !== 'api' || !ctx.orgKeyId) return
  usageStore.record({ orgKeyId: ctx.orgKeyId, apiKeyId: ctx.apiKeyId, apiKeyLabel: ctx.apiKeyLabel, eventType }).catch(() => {})
}

export function sessionOps(workflowStore: IWorkflowStore, sessionStore: ISessionStore, usageStore: IUsageStore, apiKeyStore: IApiKeyStore) {
  /** Save `updated` only if nobody saved `loaded` since it was read; bumps the revision. */
  function commit(loaded: Session, updated: Session): Promise<boolean> {
    const expected = sessionRevision(loaded)
    return sessionStore.saveIfRevision({ ...updated, revision: expected + 1 }, expected)
  }

  /**
   * Load a session the caller may access. Fails with 404 (same body as not
   * found) when the session is missing or belongs to another org. With `jobId`
   * the session must also belong to that job, so a job route can never reach a
   * session outside its job.
   */
  async function loadAccessible(req: Caller, id: string, jobId?: string): Promise<{ ok: true; session: Session } | OpFailure> {
    const session = await sessionStore.get(id)
    if (!session || !(await canAccessSession(req, session, apiKeyStore)) || (jobId !== undefined && session.jobId !== jobId)) {
      return { ok: false, status: 404, body: NOT_FOUND }
    }
    return { ok: true, session }
  }

  /**
   * Load session + authorise + load its graph. The graph is always chosen by the
   * session's own workflowName (or is its pinned snapshot); a caller-supplied
   * workflow must match it.
   */
  async function loadRun(req: Caller, id: string, workflow?: string, jobId?: string): Promise<OpResult> {
    const found = await loadAccessible(req, id, jobId)
    if (!found.ok) return found
    const session = found.session
    if (workflow !== undefined && workflow !== session.workflowName) {
      return {
        ok: false,
        status: 400,
        body: {
          error: `Session "${session.id}" belongs to workflow "${session.workflowName}", not "${workflow}". Omit workflow or pass "${session.workflowName}".`,
          code: 'BAD_REQUEST',
        },
        session,
      }
    }
    const graph = await graphFor(workflowStore, session)
    if (!graph) return { ok: false, status: 404, body: NOT_FOUND, session }
    return { ok: true, session, graph }
  }

  /** Load, decide with `once`, save; the whole thing again when the save loses a race. */
  function write(
    req: Caller, id: string, input: StepInput, jobId: string | undefined,
    once: (session: Session, graph: WorkflowGraph, input: StepInput) => OpResult,
  ): Promise<OpResult> {
    return withWriteRetries<OpResult>(async () => {
      // Everything, including expected_state, is decided from the session as freshly loaded on every attempt
      const loaded = await loadRun(req, id, input.workflow, jobId)
      if (!loaded.ok) return loaded
      const result = once(loaded.session, loaded.graph, input)
      if (!result.ok) return result
      if (!(await commit(loaded.session, result.session))) return RETRY
      return result
    })
  }

  /** Advance one session the caller may access (within `jobId` when given). */
  /**
   * `expectedSteps` (sync only; never taken from a request body): the advance
   * happens only while the run has taken exactly that many steps. A state can
   * be visited again in a loop, so the state alone does not say whether a
   * reported step was already recorded; the number of steps taken does.
   */
  async function advance(req: Caller, id: string, input: StepInput, jobId?: string, expectedSteps?: number): Promise<OpResult> {
    const once = expectedSteps === undefined ? advanceOnce : (session: Session, graph: WorkflowGraph, step: StepInput): OpResult => {
      if (session.history.length - 1 !== expectedSteps) {
        return { ok: false, status: 409, body: { error: 'The run was changed by another request.', code: POSITION_MISMATCH }, session }
      }
      return advanceOnce(session, graph, step)
    }
    const result = await write(req, id, input, jobId, once)
    if (result.ok) recordUsage(req, usageStore, 'advance')
    return result
  }

  /** Reset one session the caller may access to `input.target_state` (default: start). */
  function reset(req: Caller, id: string, input: StepInput): Promise<OpResult> {
    return write(req, id, input, undefined, resetOnce)
  }

  return { commit, loadAccessible, loadRun, advance, reset }
}

export type SessionOps = ReturnType<typeof sessionOps>
