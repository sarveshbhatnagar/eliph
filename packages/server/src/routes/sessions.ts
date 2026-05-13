import { FastifyInstance, FastifyRequest } from 'fastify'
import { IWorkflowStore, ISessionStore, IUsageStore, Session, getNextTransitions, computeNextState, applyAdvance, applyReset, requirements } from '@eliph/core'
import { randomUUID } from 'crypto'
import { ADMIN_OWNER_ID } from '../middleware/auth'

const authed = [{ BearerAuth: [] }]

function ownerId(req: FastifyRequest): string {
  const ctx = req.authContext
  if (ctx?.type === 'api') return ctx.apiKeyId
  return ADMIN_OWNER_ID
}

function recordUsage(req: FastifyRequest, usageStore: IUsageStore, eventType: 'advance' | 'session_created') {
  const ctx = req.authContext
  if (ctx?.type !== 'api' || !ctx.orgKeyId) return
  usageStore.record({ orgKeyId: ctx.orgKeyId, apiKeyId: ctx.apiKeyId, apiKeyLabel: ctx.apiKeyLabel, eventType }).catch(() => {})
}

export function sessionsRoutes(workflowStore: IWorkflowStore, sessionStore: ISessionStore, usageStore: IUsageStore) {
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
          201: { $ref: 'Session#' },
        },
      } as any,
    }, async (req, reply) => {
      const owner = ownerId(req)
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
      reply.code(201).send(session)
    })

    app.delete<{ Params: { id: string } }>('/session/:id', {
      schema: {
        tags: ['Sessions'],
        summary: 'Delete a session',
        security: authed,
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
        response: { 204: { type: 'null' } },
      } as any,
    }, async (req, reply) => {
      await sessionStore.delete(req.params.id)
      reply.code(204).send()
    })

    app.get<{ Params: { id: string }; Querystring: { workflow: string } }>(
      '/session/:id/state', {
        schema: {
          tags: ['Sessions'],
          summary: 'Get current state and available next transitions',
          security: authed,
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
          querystring: {
            type: 'object',
            required: ['workflow'],
            properties: { workflow: { type: 'string' } },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                currentState: { type: 'string' },
                nextTransitions: { type: 'array', items: { $ref: 'Transition#' } },
              },
            },
          },
        } as any,
      }, async (req, reply) => {
        const session = await sessionStore.get(req.params.id)
        if (!session) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        const graph = await workflowStore.get(req.query.workflow, session.workflowOwnerId)
        if (!graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        const state = graph.states[session.currentState]
        reply.send({
          currentState: session.currentState,
          stateDescription: state?.description ?? null,
          isTerminal: state?.isTerminal ?? false,
          nextTransitions: getNextTransitions(graph, session.currentState),
        })
      }
    )

    app.get<{ Params: { id: string }; Querystring: { workflow: string } }>(
      '/session/:id/next', {
        schema: {
          tags: ['Sessions'],
          summary: 'Get next transitions from the current state',
          security: authed,
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
          querystring: {
            type: 'object',
            required: ['workflow'],
            properties: { workflow: { type: 'string' } },
          },
          response: {
            200: { type: 'array', items: { $ref: 'Transition#' } },
          },
        } as any,
      }, async (req, reply) => {
        const session = await sessionStore.get(req.params.id)
        if (!session) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        const graph = await workflowStore.get(req.query.workflow, session.workflowOwnerId)
        if (!graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        reply.send(getNextTransitions(graph, session.currentState))
      }
    )

    app.post<{ Params: { id: string }; Body: { workflow: string; completed_action?: string } }>(
      '/session/:id/advance', {
        schema: {
          tags: ['Sessions'],
          summary: 'Advance session to the next state',
          security: authed,
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
          body: {
            type: 'object',
            required: ['workflow'],
            properties: {
              workflow: { type: 'string' },
              completed_action: { type: 'string' },
            },
          },
          response: {
            200: { $ref: 'Session#' },
          },
        } as any,
      }, async (req, reply) => {
        const session = await sessionStore.get(req.params.id)
        if (!session) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        const graph = await workflowStore.get(req.body.workflow, session.workflowOwnerId)
        if (!graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
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

    app.post<{ Params: { id: string }; Body: { workflow: string; target_state?: string } }>(
      '/session/:id/reset', {
        schema: {
          tags: ['Sessions'],
          summary: 'Reset session to a target state (default: start)',
          security: authed,
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
          body: {
            type: 'object',
            required: ['workflow'],
            properties: {
              workflow: { type: 'string' },
              target_state: { type: 'string' },
            },
          },
          response: {
            200: { $ref: 'Session#' },
          },
        } as any,
      }, async (req, reply) => {
        const session = await sessionStore.get(req.params.id)
        if (!session) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        const graph = await workflowStore.get(req.body.workflow, session.workflowOwnerId)
        if (!graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        const target = req.body.target_state ?? 'start'
        if (!graph.states[target]) {
          return reply.code(400).send({ error: `State "${target}" does not exist`, code: 'BAD_REQUEST' })
        }
        const updated = applyReset(session, target)
        await sessionStore.save(updated)
        reply.send(updated)
      }
    )

    app.get<{ Params: { id: string }; Querystring: { workflow: string } }>(
      '/session/:id/requirements', {
        schema: {
          tags: ['Sessions'],
          summary: 'Get action requirements for the current state',
          security: authed,
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
          querystring: {
            type: 'object',
            required: ['workflow'],
            properties: { workflow: { type: 'string' } },
          },
          response: {
            200: { type: 'array', items: { type: 'string' } },
          },
        } as any,
      }, async (req, reply) => {
        const session = await sessionStore.get(req.params.id)
        if (!session) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        const graph = await workflowStore.get(req.query.workflow, session.workflowOwnerId)
        if (!graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        reply.send(requirements(graph, session.currentState).map(r => r.action))
      }
    )
  }
}
