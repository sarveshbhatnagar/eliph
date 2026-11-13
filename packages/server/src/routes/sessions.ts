import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { IWorkflowStore, ISessionStore, IUsageStore, IApiKeyStore, Session, WorkflowGraph, getNextTransitions, computeNextState, applyAdvance, applyReset, requirements, graphWarnings } from '@eliph/core'
import { randomUUID } from 'crypto'
import { requestOwnerId, canAccessSession } from '../middleware/auth'

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

function recordUsage(req: FastifyRequest, usageStore: IUsageStore, eventType: 'advance' | 'session_created') {
  const ctx = req.authContext
  if (ctx?.type !== 'api' || !ctx.orgKeyId) return
  usageStore.record({ orgKeyId: ctx.orgKeyId, apiKeyId: ctx.apiKeyId, apiKeyLabel: ctx.apiKeyLabel, eventType }).catch(() => {})
}

export function sessionsRoutes(workflowStore: IWorkflowStore, sessionStore: ISessionStore, usageStore: IUsageStore, apiKeyStore: IApiKeyStore) {
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
   * session's own workflowName; a caller-supplied workflow must match it.
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
    const graph = await workflowStore.get(session.workflowName, session.workflowOwnerId)
    if (!graph) {
      reply.code(404).send(NOT_FOUND)
      return null
    }
    return { session, graph }
  }

  return async (app: FastifyInstance) => {
    app.post<{ Body: { workflow: string } }>('/session', {
      schema: {
        tags: ['Sessions'],
        summary: 'Create a session for a workflow',
        security: authed,
        body: {
          type: 'object',
          required: ['workflow'],
          properties: { workflow: { type: 'string' } },
        },
        response: {
          201: { $ref: 'SessionWithWarnings#' },
        },
      } as any,
    }, async (req, reply) => {
      const owner = requestOwnerId(req)
      const graph = await workflowStore.get(req.body.workflow, owner)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      const session: Session = {
        id: randomUUID(),
        workflowName: req.body.workflow,
        workflowOwnerId: owner,
        currentState: 'start',
        history: ['start'],
        createdAt: new Date(),
      }
      await sessionStore.save(session)
      recordUsage(req, usageStore, 'session_created')
      reply.code(201).send({ ...session, warnings: graphWarnings(graph) })
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
              },
            },
          },
        } as any,
      }, async (req, reply) => {
        const loaded = await loadSessionAndGraph(req, reply, req.query.workflow)
        if (!loaded) return
        const { session, graph } = loaded
        const state = graph.states[session.currentState]
        reply.send({
          currentState: session.currentState,
          workflowName: session.workflowName,
          history: session.history,
          stateDescription: state?.description ?? null,
          isTerminal: state?.isTerminal ?? false,
          nextTransitions: getNextTransitions(graph, session.currentState),
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

    app.post<{ Params: { id: string }; Body: { workflow?: string; completed_action?: string } }>(
      '/session/:id/advance', {
        schema: {
          tags: ['Sessions'],
          summary: 'Advance session to the next state',
          security: authed,
          params: idParams,
          body: {
            type: 'object',
            properties: {
              workflow: optionalWorkflowQuery.properties.workflow,
              completed_action: { type: 'string' },
            },
          },
          response: {
            200: { $ref: 'Session#' },
          },
        } as any,
      }, async (req, reply) => {
        const loaded = await loadSessionAndGraph(req, reply, req.body?.workflow)
        if (!loaded) return
        const { session, graph } = loaded
        try {
          const newState = computeNextState(graph, session, req.body.completed_action)
          const updated = applyAdvance(session, newState)
          await sessionStore.save(updated)
          recordUsage(req, usageStore, 'advance')
          reply.send(updated)
        } catch (e: any) {
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.post<{ Params: { id: string }; Body: { workflow?: string; target_state?: string } }>(
      '/session/:id/reset', {
        schema: {
          tags: ['Sessions'],
          summary: 'Reset session to a target state (default: start)',
          security: authed,
          params: idParams,
          body: {
            type: 'object',
            properties: {
              workflow: optionalWorkflowQuery.properties.workflow,
              target_state: { type: 'string' },
            },
          },
          response: {
            200: { $ref: 'Session#' },
          },
        } as any,
      }, async (req, reply) => {
        const loaded = await loadSessionAndGraph(req, reply, req.body?.workflow)
        if (!loaded) return
        const { session, graph } = loaded
        const target = req.body.target_state ?? 'start'
        if (!graph.states[target]) {
          return reply.code(400).send({ error: `State "${target}" does not exist`, code: 'BAD_REQUEST' })
        }
        const updated = applyReset(session, target)
        await sessionStore.save(updated)
        reply.send(updated)
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
