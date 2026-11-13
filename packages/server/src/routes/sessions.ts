import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import {
  IWorkflowStore, ISessionStore, IUsageStore, IApiKeyStore, Session, WorkflowGraph, getNextTransitions, computeNextState,
  applyAdvance, applyReset, applyDataPatch, mergeSessionData, requirements, graphWarnings, hasState, SessionDataError, SESSION_NOTE_MAX_LENGTH,
  sessionRevision,
} from '@eliph/core'
import { randomUUID } from 'crypto'
import { requestOwnerId, canAccessSession, sessionOwnerIdsForListing } from '../middleware/auth'

const authed = [{ BearerAuth: [] }]

type AuthedRequest = Pick<FastifyRequest, 'authContext'> & { params: { id: string } }

const NOT_FOUND = { error: 'Not found', code: 'NOT_FOUND' }

const idParams = {
  type: 'object',
  properties: { id: { type: 'string' } },
}

const optionalWorkflowQuery = {
  type: 'object',
  properties: { workflow: { type: 'string', description: 'Optional. Defaults to the session\'s workflow; must match it if supplied.' } },
}

const dataBody = {
  type: 'object',
  additionalProperties: true,
  description: 'Optional. Shallow-merged into the session data; a key set to null removes it. The merged data may be at most 64 KB serialized.',
}

const noteBody = {
  type: 'string',
  maxLength: SESSION_NOTE_MAX_LENGTH,
  description: `Optional note recorded in the session's event log (max ${SESSION_NOTE_MAX_LENGTH} characters).`,
}

const LIST_DEFAULT_LIMIT = 50
const LIST_MAX_LIMIT = 200

/** Description, terminal flag and outgoing transitions of a session's current state. */
function stepContext(graph: WorkflowGraph | null, stateName: string) {
  const state = graph?.states[stateName]
  return {
    stateDescription: state?.description ?? null,
    isTerminal: state?.isTerminal ?? false,
    nextTransitions: graph ? getNextTransitions(graph, stateName) : [],
  }
}

/** `{ pinned: true }` for a pinned session, nothing otherwise (unpinned responses are unchanged). */
function pinnedFlag(session: Session): { pinned?: true } {
  return session.pinnedGraph ? { pinned: true } : {}
}

/** A session response: the session, its full data, and the step context of its current state. */
function sessionResponse(session: Session, graph: WorkflowGraph | null) {
  // The graph snapshot and the concurrency counter are internal
  const { pinnedGraph: _pinnedGraph, revision: _revision, ...rest } = session
  return { ...rest, data: session.data ?? {}, ...pinnedFlag(session), ...stepContext(graph, session.currentState) }
}

/** The graph a session runs against: its pinned snapshot, or else the live procedure. */
function graphFor(workflowStore: IWorkflowStore, session: Session): Promise<WorkflowGraph | null> {
  if (session.pinnedGraph) return Promise.resolve(session.pinnedGraph)
  return workflowStore.get(session.workflowName, session.workflowOwnerId)
}

/** How many times a read-modify-write is attempted before answering 409. */
export const SESSION_WRITE_ATTEMPTS = 10

const WRITE_CONFLICT = {
  error: 'The session was changed by other requests at the same time and this change could not be applied. Nothing was changed by this request; retry it.',
  code: 'CONFLICT',
}

/** Short random pause before retrying, so concurrent writers stop colliding. */
function backoff(attempt: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.random() * 5 * attempt))
}

/**
 * Run a session read-modify-write with optimistic concurrency. `attempt` loads
 * the session afresh, decides and tries a conditional save; it returns true once
 * it has replied (success or error) and false when the save lost a race. The
 * whole attempt is then retried; after SESSION_WRITE_ATTEMPTS losses: 409.
 */
async function withWriteRetries(reply: FastifyReply, attempt: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < SESSION_WRITE_ATTEMPTS; i++) {
    if (i > 0) await backoff(i)
    if (await attempt()) return
  }
  reply.code(409).send(WRITE_CONFLICT)
}

function sendDataError(reply: FastifyReply, e: SessionDataError) {
  reply.code(e.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400).send({ error: e.message, code: e.code })
}

function recordUsage(req: FastifyRequest, usageStore: IUsageStore, eventType: 'advance' | 'session_created') {
  const ctx = req.authContext
  if (ctx?.type !== 'api' || !ctx.orgKeyId) return
  usageStore.record({ orgKeyId: ctx.orgKeyId, apiKeyId: ctx.apiKeyId, apiKeyLabel: ctx.apiKeyLabel, eventType }).catch(() => {})
}

export function sessionsRoutes(workflowStore: IWorkflowStore, sessionStore: ISessionStore, usageStore: IUsageStore, apiKeyStore: IApiKeyStore) {
  /** Save `updated` only if nobody saved `loaded` since it was read; bumps the revision. */
  function commit(loaded: Session, updated: Session): Promise<boolean> {
    const expected = sessionRevision(loaded)
    return sessionStore.saveIfRevision({ ...updated, revision: expected + 1 }, expected)
  }

  /**
   * Load a session the caller may access. Sends 404 (same body as not found)
   * when the session is missing or belongs to another org, and returns null.
   */
  async function loadAccessibleSession(req: AuthedRequest, reply: FastifyReply): Promise<Session | null> {
    const session = await sessionStore.get(req.params.id)
    if (!session || !(await canAccessSession(req, session, apiKeyStore))) {
      reply.code(404).send(NOT_FOUND)
      return null
    }
    return session
  }

  /**
   * Load session + authorise + load its graph. The graph is always chosen by the
   * session's own workflowName (or is its pinned snapshot); a caller-supplied
   * workflow must match it.
   */
  async function loadSessionAndGraph(
    req: AuthedRequest,
    reply: FastifyReply,
    workflow: string | undefined,
  ): Promise<{ session: Session; graph: WorkflowGraph } | null> {
    const session = await loadAccessibleSession(req, reply)
    if (!session) return null
    if (workflow !== undefined && workflow !== session.workflowName) {
      reply.code(400).send({
        error: `Session "${session.id}" belongs to workflow "${session.workflowName}", not "${workflow}". Omit workflow or pass "${session.workflowName}".`,
        code: 'BAD_REQUEST',
      })
      return null
    }
    const graph = await graphFor(workflowStore, session)
    if (!graph) {
      reply.code(404).send(NOT_FOUND)
      return null
    }
    return { session, graph }
  }

  return async (app: FastifyInstance) => {
    app.post<{ Body: { workflow: string; data?: Record<string, unknown>; pin?: boolean } }>('/session', {
      schema: {
        tags: ['Sessions'],
        summary: 'Create a session for a workflow',
        description: 'Returns the session with its data and the step context (stateDescription, isTerminal, nextTransitions) of the start state.',
        security: authed,
        body: {
          type: 'object',
          required: ['workflow'],
          properties: {
            workflow: { type: 'string' },
            data: { ...dataBody, description: 'Optional initial session data (JSON object, max 64 KB serialized).' },
            pin: {
              type: 'boolean',
              description: 'Optional, default false. true pins the session to a snapshot of the procedure as it is now: later edits '
                + 'to the procedure (or deleting it) do not affect this session. By default a session follows the live procedure.',
            },
          },
        },
        response: {
          201: { $ref: 'SessionWithWarnings#' },
        },
      } as any,
    }, async (req, reply) => {
      const owner = requestOwnerId(req)
      const graph = await workflowStore.get(req.body.workflow, owner)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      let data: Record<string, unknown> = {}
      try {
        if (req.body.data !== undefined) data = mergeSessionData({}, req.body.data)
      } catch (e) {
        if (e instanceof SessionDataError) return sendDataError(reply, e)
        throw e
      }
      const now = new Date()
      const session: Session = {
        id: randomUUID(),
        workflowName: req.body.workflow,
        workflowOwnerId: owner,
        currentState: 'start',
        history: ['start'],
        createdAt: now,
        updatedAt: now,
        data,
        events: [{ type: 'created', to: 'start', at: now.toISOString() }],
      }
      if (req.body.pin === true) session.pinnedGraph = structuredClone(graph)
      await sessionStore.save(session)
      recordUsage(req, usageStore, 'session_created')
      reply.code(201).send({ ...sessionResponse(session, graph), warnings: graphWarnings(graph) })
    })

    app.delete<{ Params: { id: string } }>('/session/:id', {
      schema: {
        tags: ['Sessions'],
        summary: 'Delete a session',
        security: authed,
        params: idParams,
        response: { 204: { type: 'null' } },
      } as any,
    }, async (req, reply) => {
      const session = await sessionStore.get(req.params.id)
      // Deleting is idempotent: a nonexistent session and one the caller may not
      // access both answer 204, so the response never reveals that an id exists.
      // An inaccessible session is left untouched.
      if (session && await canAccessSession(req, session, apiKeyStore)) {
        await sessionStore.delete(req.params.id)
      }
      reply.code(204).send()
    })

    app.get<{ Params: { id: string }; Querystring: { workflow?: string } }>(
      '/session/:id/state', {
        schema: {
          tags: ['Sessions'],
          summary: 'Get current state and available next transitions',
          security: authed,
          params: idParams,
          querystring: optionalWorkflowQuery,
          response: {
            200: {
              type: 'object',
              properties: {
                currentState: { type: 'string' },
                stateDescription: { type: 'string', nullable: true },
                isTerminal: { type: 'boolean' },
                workflowName: { type: 'string' },
                history: { type: 'array', items: { type: 'string' } },
                nextTransitions: { type: 'array', items: { $ref: 'Transition#' } },
                data: { $ref: 'SessionData#' },
                pinned: { type: 'boolean', description: 'Present and true when the session runs against a snapshot of its procedure (created with pin: true).' },
                events: {
                  type: 'array',
                  items: { $ref: 'SessionEvent#' },
                  description: 'Append-only event log, oldest first. Only the most recent 500 events are kept.',
                },
              },
            },
          },
        } as any,
      }, async (req, reply) => {
        const loaded = await loadSessionAndGraph(req, reply, req.query.workflow)
        if (!loaded) return
        const { session, graph } = loaded
        reply.send({
          currentState: session.currentState,
          workflowName: session.workflowName,
          history: session.history,
          ...stepContext(graph, session.currentState),
          data: session.data ?? {},
          ...pinnedFlag(session),
          events: session.events ?? [],
        })
      }
    )

    app.get<{ Params: { id: string }; Querystring: { workflow?: string } }>(
      '/session/:id/next', {
        schema: {
          tags: ['Sessions'],
          summary: 'Get next transitions from the current state',
          security: authed,
          params: idParams,
          querystring: optionalWorkflowQuery,
          response: {
            200: { type: 'array', items: { $ref: 'Transition#' } },
          },
        } as any,
      }, async (req, reply) => {
        const loaded = await loadSessionAndGraph(req, reply, req.query.workflow)
        if (!loaded) return
        const { session, graph } = loaded
        reply.send(getNextTransitions(graph, session.currentState))
      }
    )

    app.post<{ Params: { id: string }; Body: { workflow?: string; completed_action?: string; data?: Record<string, unknown>; note?: string } }>(
      '/session/:id/advance', {
        schema: {
          tags: ['Sessions'],
          summary: 'Advance session to the next state',
          description: 'Returns the session with its data and the step context (stateDescription, isTerminal, nextTransitions) of the new state.',
          security: authed,
          params: idParams,
          body: {
            type: 'object',
            properties: {
              workflow: optionalWorkflowQuery.properties.workflow,
              completed_action: { type: 'string' },
              data: dataBody,
              note: noteBody,
            },
          },
          response: {
            200: { $ref: 'Session#' },
          },
        } as any,
      }, async (req, reply) => withWriteRetries(reply, async () => {
        // The next state is decided from the session as freshly loaded on every attempt
        const loaded = await loadSessionAndGraph(req, reply, req.body?.workflow)
        if (!loaded) return true
        const { session, graph } = loaded
        const body = req.body ?? {}
        let updated: Session
        try {
          const newState = computeNextState(graph, session, body.completed_action)
          updated = applyAdvance(session, newState, { action: body.completed_action, note: body.note, data: body.data })
        } catch (e: any) {
          if (e instanceof SessionDataError) sendDataError(reply, e)
          else reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
          return true
        }
        if (!(await commit(session, updated))) return false
        recordUsage(req, usageStore, 'advance')
        reply.send(sessionResponse(updated, graph))
        return true
      })
    )

    app.post<{ Params: { id: string }; Body: { workflow?: string; target_state?: string; data?: Record<string, unknown>; note?: string } }>(
      '/session/:id/reset', {
        schema: {
          tags: ['Sessions'],
          summary: 'Reset session to a target state (default: start)',
          description: 'Returns the session with its data and the step context (stateDescription, isTerminal, nextTransitions) of the target state.',
          security: authed,
          params: idParams,
          body: {
            type: 'object',
            properties: {
              workflow: optionalWorkflowQuery.properties.workflow,
              target_state: { type: 'string' },
              data: dataBody,
              note: noteBody,
            },
          },
          response: {
            200: { $ref: 'Session#' },
          },
        } as any,
      }, async (req, reply) => withWriteRetries(reply, async () => {
        const loaded = await loadSessionAndGraph(req, reply, req.body?.workflow)
        if (!loaded) return true
        const { session, graph } = loaded
        const body = req.body ?? {}
        const target = body.target_state ?? 'start'
        if (!hasState(graph, target)) {
          reply.code(400).send({ error: `State "${target}" does not exist`, code: 'BAD_REQUEST' })
          return true
        }
        let updated: Session
        try {
          updated = applyReset(session, target, { note: body.note, data: body.data })
        } catch (e) {
          if (e instanceof SessionDataError) {
            sendDataError(reply, e)
            return true
          }
          throw e
        }
        if (!(await commit(session, updated))) return false
        reply.send(sessionResponse(updated, graph))
        return true
      })
    )

    app.patch<{ Params: { id: string }; Body: { data: Record<string, unknown> } }>(
      '/session/:id/data', {
        schema: {
          tags: ['Sessions'],
          summary: 'Merge data into a session without changing its state',
          description: 'Shallow-merges `data` into the session data (a key set to null removes it). The merged data may be at most 64 KB serialized (413 PAYLOAD_TOO_LARGE otherwise). Returns the session with its full data and the step context of its current state.',
          security: authed,
          params: idParams,
          body: {
            type: 'object',
            required: ['data'],
            properties: { data: { ...dataBody, description: 'Patch shallow-merged into the session data; a key set to null removes it.' } },
          },
          response: {
            200: { $ref: 'Session#' },
          },
        } as any,
      }, async (req, reply) => withWriteRetries(reply, async () => {
        const session = await loadAccessibleSession(req, reply)
        if (!session) return true
        let updated: Session
        try {
          updated = applyDataPatch(session, req.body.data)
        } catch (e) {
          if (e instanceof SessionDataError) {
            sendDataError(reply, e)
            return true
          }
          throw e
        }
        if (!(await commit(session, updated))) return false
        // Data can be updated even if the workflow was deleted; step context is then empty
        const graph = await graphFor(workflowStore, session)
        reply.send(sessionResponse(updated, graph))
        return true
      })
    )

    app.get<{ Querystring: { workflow?: string; active?: boolean; limit?: number } }>(
      '/sessions', {
        schema: {
          tags: ['Sessions'],
          summary: 'List your sessions, newest first',
          description: 'Lists the sessions of the caller\'s org (including legacy sessions owned by one of its API keys). '
            + '`active=true` keeps sessions whose current state is not terminal; a session whose workflow no longer exists is never active (unless it is pinned). '
            + `limit defaults to ${LIST_DEFAULT_LIMIT}; values above ${LIST_MAX_LIMIT} are treated as ${LIST_MAX_LIMIT}.`,
          security: authed,
          querystring: {
            type: 'object',
            properties: {
              workflow: { type: 'string', description: 'Optional. Only sessions of this workflow (exact name).' },
              active: { type: 'boolean', description: 'Optional. true: only sessions not in a terminal state; false: only finished sessions (or whose workflow was deleted).' },
              limit: { type: 'integer', minimum: 1, default: LIST_DEFAULT_LIMIT, description: `Maximum number of sessions (default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT}).` },
            },
          },
          response: {
            200: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  workflowName: { type: 'string' },
                  currentState: { type: 'string' },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                  isTerminal: { type: 'boolean' },
                  pinned: { type: 'boolean', description: 'Present and true when the session runs against a snapshot of its procedure (created with pin: true).' },
                },
                required: ['id', 'workflowName', 'currentState', 'createdAt', 'isTerminal'],
              },
            },
          },
        } as any,
      }, async (req, reply) => {
        const ownerIds = await sessionOwnerIdsForListing(req, apiKeyStore)
        const limit = Math.min(req.query.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT)
        const active = req.query.active
        const graphs = new Map<string, Promise<WorkflowGraph | null>>()
        const liveGraphFor = (s: Session) => {
          if (s.pinnedGraph) return Promise.resolve(s.pinnedGraph)
          const key = JSON.stringify([s.workflowOwnerId, s.workflowName])
          let graph = graphs.get(key)
          if (!graph) {
            graph = workflowStore.get(s.workflowName, s.workflowOwnerId)
            graphs.set(key, graph)
          }
          return graph
        }

        const items: object[] = []
        // Without an active filter one page is enough; with it, page until filled
        const pageSize = active === undefined ? limit : LIST_MAX_LIMIT
        let offset = 0
        while (items.length < limit) {
          const page = await sessionStore.list(ownerIds, { workflowName: req.query.workflow, limit: pageSize, offset })
          for (const s of page) {
            const graph = await liveGraphFor(s)
            const isTerminal = graph?.states[s.currentState]?.isTerminal ?? false
            if (active !== undefined && active !== (!!graph && !isTerminal)) continue
            items.push({
              id: s.id,
              workflowName: s.workflowName,
              currentState: s.currentState,
              createdAt: s.createdAt,
              ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
              isTerminal,
              ...pinnedFlag(s),
            })
            if (items.length >= limit) break
          }
          if (page.length < pageSize) break
          offset += page.length
        }
        reply.send(items)
      }
    )

    app.get<{ Params: { id: string }; Querystring: { workflow?: string } }>(
      '/session/:id/requirements', {
        schema: {
          tags: ['Sessions'],
          summary: 'Get action requirements for the current state',
          security: authed,
          params: idParams,
          querystring: optionalWorkflowQuery,
          response: {
            200: { type: 'array', items: { type: 'string' } },
          },
        } as any,
      }, async (req, reply) => {
        const loaded = await loadSessionAndGraph(req, reply, req.query.workflow)
        if (!loaded) return
        const { session, graph } = loaded
        reply.send(requirements(graph, session.currentState).map(r => r.action))
      }
    )
  }
}
