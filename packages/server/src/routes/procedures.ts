import { FastifyInstance } from 'fastify'
import { IWorkflowStore, ISessionStore, WorkflowGraph, addTransition, removeTransition, removeState } from '@eliph/core'

export function proceduresRoutes(workflowStore: IWorkflowStore, sessionStore: ISessionStore) {
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { q?: string } }>('/procedures', async (req, reply) => {
      const q = req.query.q ?? ''
      reply.send(await workflowStore.search(q))
    })

    app.get<{ Params: { name: string } }>('/procedure/:name', async (req, reply) => {
      const graph = await workflowStore.get(req.params.name)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      reply.send(graph)
    })

    app.post<{ Body: { workflow_name: string; description: string } }>('/procedure', async (req, reply) => {
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
      '/procedure/:name/transition', async (req, reply) => {
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
      '/procedure/:name/transition', async (req, reply) => {
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
      '/procedure/:name/state/:state', async (req, reply) => {
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

    app.get<{ Params: { name: string } }>('/procedure/:name/states', async (req, reply) => {
      const graph = await workflowStore.get(req.params.name)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      reply.send(Object.values(graph.states))
    })
  }
}
