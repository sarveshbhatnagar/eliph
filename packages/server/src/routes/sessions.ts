import { FastifyInstance } from 'fastify'
import { IWorkflowStore, ISessionStore, Session, getNextTransitions, computeNextState, applyAdvance, applyReset, requirements } from '@eliph/core'
import { randomUUID } from 'crypto'

export function sessionsRoutes(workflowStore: IWorkflowStore, sessionStore: ISessionStore) {
  return async (app: FastifyInstance) => {
    app.post<{ Body: { workflow: string } }>('/session', async (req, reply) => {
      const graph = await workflowStore.get(req.body.workflow)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      const session: Session = {
        id: randomUUID(),
        workflowName: req.body.workflow,
        currentState: 'start',
        history: ['start'],
        createdAt: new Date(),
      }
      await sessionStore.save(session)
      reply.code(201).send(session)
    })

    app.delete<{ Params: { id: string } }>('/session/:id', async (req, reply) => {
      await sessionStore.delete(req.params.id)
      reply.code(204).send()
    })

    app.get<{ Params: { id: string }; Querystring: { workflow: string } }>(
      '/session/:id/state', async (req, reply) => {
        const [session, graph] = await Promise.all([
          sessionStore.get(req.params.id),
          workflowStore.get(req.query.workflow),
        ])
        if (!session || !graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        reply.send({ currentState: session.currentState, nextTransitions: getNextTransitions(graph, session.currentState) })
      }
    )

    app.get<{ Params: { id: string }; Querystring: { workflow: string } }>(
      '/session/:id/next', async (req, reply) => {
        const [session, graph] = await Promise.all([
          sessionStore.get(req.params.id),
          workflowStore.get(req.query.workflow),
        ])
        if (!session || !graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        reply.send(getNextTransitions(graph, session.currentState))
      }
    )

    app.post<{ Params: { id: string }; Body: { workflow: string; completed_action?: string } }>(
      '/session/:id/advance', async (req, reply) => {
        const [session, graph] = await Promise.all([
          sessionStore.get(req.params.id),
          workflowStore.get(req.body.workflow),
        ])
        if (!session || !graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        try {
          const newState = computeNextState(graph, session, req.body.completed_action)
          const updated = applyAdvance(session, newState)
          await sessionStore.save(updated)
          reply.send(updated)
        } catch (e: any) {
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.post<{ Params: { id: string }; Body: { workflow: string; target_state?: string } }>(
      '/session/:id/reset', async (req, reply) => {
        const [session, graph] = await Promise.all([
          sessionStore.get(req.params.id),
          workflowStore.get(req.body.workflow),
        ])
        if (!session || !graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
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
      '/session/:id/requirements', async (req, reply) => {
        const [session, graph] = await Promise.all([
          sessionStore.get(req.params.id),
          workflowStore.get(req.query.workflow),
        ])
        if (!session || !graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        reply.send(requirements(graph, session.currentState))
      }
    )
  }
}
