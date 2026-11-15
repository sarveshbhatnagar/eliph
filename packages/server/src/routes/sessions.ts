import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import {
  IWorkflowStore, ISessionStore, IUsageStore, IApiKeyStore, Session, WorkflowGraph, getNextTransitions,
  applyDataPatch, requirements, graphWarnings, SessionDataError, SESSION_NOTE_MAX_LENGTH,
} from '@eliph/core'
import { requestOwnerId, canAccessSession, sessionOwnerIdsForListing } from '../middleware/auth'
import {
  ACTOR_MAX_LENGTH, OpFailure, OpResult, RETRY, buildSession, dataFailure, graphFor, initialData, pinnedFlag, recordUsage,
  sessionOps, sessionResponse, stepContext, withWriteRetries,
} from './session-ops'

export { SESSION_WRITE_ATTEMPTS } from './session-ops'

const authed = [{ BearerAuth: [] }]

type AuthedRequest = Pick<FastifyRequest, 'authContext'> & { params: { id: string } }

const idParams = {
  type: 'object',
  properties: { id: { type: 'string' } },
}

const optionalWorkflowQuery = {
  type: 'object',
  properties: { workflow: { type: 'string', description: 'Optional. Defaults to the session\'s workflow; must match it if supplied.' } },
}

export const dataBody = {
  type: 'object',
  additionalProperties: true,
  description: 'Optional. Shallow-merged into the session data; a key set to null removes it. The merged data may be at most 64 KB serialized.',
}

export const noteBody = {
  type: 'string',
  maxLength: SESSION_NOTE_MAX_LENGTH,
  description: `Optional note recorded in the session's event log (max ${SESSION_NOTE_MAX_LENGTH} characters).`,
}

const LIST_DEFAULT_LIMIT = 50
const LIST_MAX_LIMIT = 200

/** Declared 409 response of the session write routes (see withWriteRetries). */
const conflictResponse = {
  type: 'object',
  description: 'CONFLICT: concurrent writes to the session kept winning; nothing was changed by this request, so it can be retried.',
  properties: { error: { type: 'string' }, code: { type: 'string', enum: ['CONFLICT'] } },
  required: ['error', 'code'],
}

/**
 * Declared 409 response of advance and reset, which can also refuse an
 * expected_state. `currentState` is let through as an additional property so
 * the declared properties stay those of conflictResponse.
 */
const stepConflictResponse = {
  type: 'object',
  description: 'CONFLICT: concurrent writes to the session kept winning; retry the request. '
    + 'STATE_MISMATCH: `expected_state` was given and the session is in another state, named in the extra field `currentState`; do not retry blindly. '
    + 'Either way nothing was changed by this request.',
  properties: { error: { type: 'string' }, code: { type: 'string', enum: ['CONFLICT', 'STATE_MISMATCH'] } },
  required: ['error', 'code'],
  additionalProperties: true,
}

/** One sentence for the description of every route that can answer conflictResponse. */
const CONFLICT_NOTE = ' If the session keeps being changed by concurrent requests the response is 409 CONFLICT and nothing was changed; retry the request.'

/** One sentence for the description of the routes that accept expected_state. */
const EXPECTED_STATE_NOTE = ' With `expected_state` the step only happens while the session is in that state; otherwise the response is 409 '
  + 'STATE_MISMATCH with `currentState` and nothing is changed, so two workers finishing the same step cannot move the session twice.'

export const expectedStateBody = {
  type: 'string',
  description: 'Optional guard: the state the caller believes the session is in. If the session is in another state the step is refused (STATE_MISMATCH) and nothing changes.',
}

export const actorBody = {
  type: 'string',
  maxLength: ACTOR_MAX_LENGTH,
  description: `Optional. Who is doing this (free text such as a worker or agent name, max ${ACTOR_MAX_LENGTH} characters); recorded on the event.`,
}

function sendFailure(reply: FastifyReply, failure: OpFailure) {
  reply.code(failure.status).send(failure.body)
}

export function sessionsRoutes(workflowStore: IWorkflowStore, sessionStore: ISessionStore, usageStore: IUsageStore, apiKeyStore: IApiKeyStore) {
  const ops = sessionOps(workflowStore, sessionStore, usageStore, apiKeyStore)

  /**
   * Load session + authorise + load its graph (see sessionOps.loadRun). Sends
   * the error (404 with the same body for missing and inaccessible) and
   * returns null when that fails.
   */
  async function loadSessionAndGraph(
    req: AuthedRequest,
    reply: FastifyReply,
    workflow: string | undefined,
  ): Promise<{ session: Session; graph: WorkflowGraph } | null> {
    const loaded = await ops.loadRun(req, req.params.id, workflow)
    if (!loaded.ok) {
      sendFailure(reply, loaded)
      return null
    }
    return loaded
  }

  /** Answer an advance or reset: the session on success, the failure's status and body otherwise. */
  function sendStep(reply: FastifyReply, result: OpResult<WorkflowGraph | null>) {
    if (!result.ok) return sendFailure(reply, result)
    reply.send(sessionResponse(result.session, result.graph))
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
      const data = initialData(req.body.data)
      if (!data.ok) return sendFailure(reply, data)
      const session = buildSession(owner, graph, req.body.workflow, { data: data.data, pin: req.body.pin })
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
                jobId: { type: 'string', description: 'Present when the session is a run of a job (see POST /job).' },
                label: { type: 'string', description: 'Present on a run of a job: the name of its piece of work.' },
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
          ...(session.jobId !== undefined ? { jobId: session.jobId } : {}),
          ...(session.label !== undefined ? { label: session.label } : {}),
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

    app.post<{ Params: { id: string }; Body: { workflow?: string; completed_action?: string; expected_state?: string; actor?: string; data?: Record<string, unknown>; note?: string } }>(
      '/session/:id/advance', {
        schema: {
          tags: ['Sessions'],
          summary: 'Advance session to the next state',
          description: 'Returns the session with its data and the step context (stateDescription, isTerminal, nextTransitions) of the new state. '
            + 'A transition with "requires" can only be taken when each of those session-data keys has a value (not null or a blank string) once this '
            + 'request\'s `data` is merged; otherwise the response is 400 MISSING_REQUIRED_DATA with the keys in `missing`, and nothing is changed.'
            + EXPECTED_STATE_NOTE + CONFLICT_NOTE,
          security: authed,
          params: idParams,
          body: {
            type: 'object',
            properties: {
              workflow: optionalWorkflowQuery.properties.workflow,
              completed_action: { type: 'string' },
              expected_state: expectedStateBody,
              data: dataBody,
              note: noteBody,
              actor: actorBody,
            },
          },
          response: {
            200: { $ref: 'Session#' },
            409: stepConflictResponse,
          },
        } as any,
      }, async (req, reply) => sendStep(reply, await ops.advance(req, req.params.id, req.body ?? {}))
    )

    app.post<{ Params: { id: string }; Body: { workflow?: string; target_state?: string; expected_state?: string; actor?: string; data?: Record<string, unknown>; note?: string } }>(
      '/session/:id/reset', {
        schema: {
          tags: ['Sessions'],
          summary: 'Reset session to a target state (default: start)',
          description: 'Returns the session with its data and the step context (stateDescription, isTerminal, nextTransitions) of the target state.'
            + EXPECTED_STATE_NOTE + CONFLICT_NOTE,
          security: authed,
          params: idParams,
          body: {
            type: 'object',
            properties: {
              workflow: optionalWorkflowQuery.properties.workflow,
              target_state: { type: 'string' },
              expected_state: expectedStateBody,
              data: dataBody,
              note: noteBody,
              actor: actorBody,
            },
          },
          response: {
            200: { $ref: 'Session#' },
            409: stepConflictResponse,
          },
        } as any,
      }, async (req, reply) => sendStep(reply, await ops.reset(req, req.params.id, req.body ?? {}))
    )

    app.patch<{ Params: { id: string }; Body: { data: Record<string, unknown> } }>(
      '/session/:id/data', {
        schema: {
          tags: ['Sessions'],
          summary: 'Merge data into a session without changing its state',
          description: 'Shallow-merges `data` into the session data (a key set to null removes it). The merged data may be at most 64 KB serialized (413 PAYLOAD_TOO_LARGE otherwise). Returns the session with its full data and the step context of its current state.'
            + CONFLICT_NOTE,
          security: authed,
          params: idParams,
          body: {
            type: 'object',
            required: ['data'],
            properties: { data: { ...dataBody, description: 'Patch shallow-merged into the session data; a key set to null removes it.' } },
          },
          response: {
            200: { $ref: 'Session#' },
            409: conflictResponse,
          },
        } as any,
      }, async (req, reply) => sendStep(reply, await withWriteRetries<OpResult<WorkflowGraph | null>>(async () => {
        const found = await ops.loadAccessible(req, req.params.id)
        if (!found.ok) return found
        const session = found.session
        let updated: Session
        try {
          updated = applyDataPatch(session, req.body.data)
        } catch (e) {
          if (e instanceof SessionDataError) return dataFailure(e)
          throw e
        }
        if (!(await ops.commit(session, updated))) return RETRY
        // Data can be updated even if the workflow was deleted; step context is then empty
        return { ok: true, session: updated, graph: await graphFor(workflowStore, session) }
      }))
    )

    app.get<{ Querystring: { workflow?: string; job?: string; active?: boolean; limit?: number } }>(
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
              job: { type: 'string', description: 'Optional. Only the sessions (runs) of this job (a jobId returned by POST /job).' },
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
                  jobId: { type: 'string', description: 'Present when the session is a run of a job (see POST /job).' },
                  label: { type: 'string', description: 'Present on a run of a job: the name of its piece of work.' },
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
          const page = await sessionStore.list(ownerIds, { workflowName: req.query.workflow, jobId: req.query.job || undefined, limit: pageSize, offset })
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
              ...(s.jobId !== undefined ? { jobId: s.jobId } : {}),
              ...(s.label !== undefined ? { label: s.label } : {}),
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
