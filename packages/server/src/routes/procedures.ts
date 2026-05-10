import { FastifyInstance } from 'fastify'
import { IWorkflowStore, ISessionStore, WorkflowGraph, addTransition, removeTransition, removeState, markStateTerminal } from '@eliph/core'

const authed = [{ BearerAuth: [] }]

export function proceduresRoutes(workflowStore: IWorkflowStore, sessionStore: ISessionStore) {
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { q?: string } }>('/procedures', {
      schema: {
        tags: ['Procedures'],
        summary: 'Search procedures by name or description',
        security: authed,
        querystring: {
          type: 'object',
          properties: { q: { type: 'string' } },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      } as any,
    }, async (req, reply) => {
      const q = req.query.q ?? ''
      reply.send(await workflowStore.search(q))
    })

    app.get<{ Params: { name: string } }>('/procedure/:name', {
      schema: {
        tags: ['Procedures'],
        summary: 'Get a procedure by name',
        security: authed,
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { $ref: 'WorkflowGraph#' },
        },
      } as any,
    }, async (req, reply) => {
      const graph = await workflowStore.get(req.params.name)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      reply.send(graph)
    })

    app.post<{ Body: { workflow_name: string; description: string } }>('/procedure', {
      schema: {
        tags: ['Procedures'],
        summary: 'Create a new procedure',
        security: authed,
        body: {
          type: 'object',
          required: ['workflow_name', 'description'],
          properties: {
            workflow_name: { type: 'string' },
            description: { type: 'string' },
          },
        },
        response: {
          201: { $ref: 'WorkflowGraph#' },
        },
      } as any,
    }, async (req, reply) => {
      const { workflow_name, description } = req.body
      const graph: WorkflowGraph = {
        name: workflow_name,
        description,
        states: { start: { name: 'start', isTerminal: false } },
        transitions: [],
      }
      await workflowStore.save(graph)
      reply.code(201).send(graph)
    })

    app.post<{ Params: { name: string }; Body: { transition: string } }>(
      '/procedure/:name/transition', {
        schema: {
          tags: ['Procedures'],
          summary: 'Add a transition to a procedure',
          security: authed,
          params: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
          body: {
            type: 'object',
            required: ['transition'],
            properties: { transition: { type: 'string' } },
          },
          response: {
            200: { $ref: 'WorkflowGraph#' },
          },
        } as any,
      }, async (req, reply) => {
        const graph = await workflowStore.get(req.params.name)
        if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
        try {
          const updated = addTransition(graph, req.body.transition)
          await workflowStore.save(updated)
          reply.send(updated)
        } catch (e: any) {
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.delete<{ Params: { name: string }; Body: { transition: string } }>(
      '/procedure/:name/transition', {
        schema: {
          tags: ['Procedures'],
          summary: 'Remove a transition from a procedure',
          security: authed,
          params: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
          body: {
            type: 'object',
            required: ['transition'],
            properties: { transition: { type: 'string' } },
          },
          response: {
            200: { $ref: 'WorkflowGraph#' },
          },
        } as any,
      }, async (req, reply) => {
        const graph = await workflowStore.get(req.params.name)
        if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
        try {
          const updated = removeTransition(graph, req.body.transition)
          await workflowStore.save(updated)
          reply.send(updated)
        } catch (e: any) {
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.delete<{ Params: { name: string; state: string } }>(
      '/procedure/:name/state/:state', {
        schema: {
          tags: ['Procedures'],
          summary: 'Remove a state from a procedure',
          security: authed,
          params: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              state: { type: 'string' },
            },
          },
          response: {
            200: { $ref: 'WorkflowGraph#' },
          },
        } as any,
      }, async (req, reply) => {
        const graph = await workflowStore.get(req.params.name)
        if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
        const active = await sessionStore.findByState(req.params.name, req.params.state)
        if (active.length > 0) {
          return reply.code(409).send({ error: 'Active sessions exist in this state', code: 'CONFLICT' })
        }
        try {
          const updated = removeState(graph, req.params.state)
          await workflowStore.save(updated)
          reply.send(updated)
        } catch (e: any) {
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.post<{ Params: { name: string; state: string } }>(
      '/procedure/:name/state/:state/terminal', {
        schema: {
          tags: ['Procedures'],
          summary: 'Mark a state as terminal (no further advances allowed)',
          security: authed,
          params: {
            type: 'object',
            properties: { name: { type: 'string' }, state: { type: 'string' } },
          },
          response: { 200: { $ref: 'WorkflowGraph#' } },
        } as any,
      }, async (req, reply) => {
        const graph = await workflowStore.get(req.params.name)
        if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
        try {
          const updated = markStateTerminal(graph, req.params.state)
          await workflowStore.save(updated)
          reply.send(updated)
        } catch (e: any) {
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.get<{ Params: { name: string } }>('/procedure/:name/states', {
      schema: {
        tags: ['Procedures'],
        summary: 'List all states in a procedure',
        security: authed,
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: { $ref: 'State#' } },
        },
      } as any,
    }, async (req, reply) => {
      const graph = await workflowStore.get(req.params.name)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      reply.send(Object.values(graph.states))
    })
  }
}
