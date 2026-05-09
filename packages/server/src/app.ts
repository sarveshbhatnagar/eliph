import Fastify, { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { IWorkflowStore, ISessionStore, IApiKeyStore } from '@eliph/core'
import { authMiddleware } from './middleware/auth'
import { keysRoutes } from './routes/keys'
import { proceduresRoutes } from './routes/procedures'
import { sessionsRoutes } from './routes/sessions'

export interface Stores {
  workflowStore: IWorkflowStore
  sessionStore: ISessionStore
  apiKeyStore: IApiKeyStore
}

export function registerSharedSchemas(app: FastifyInstance): void {
  app.addSchema({
    $id: 'State',
    type: 'object',
    properties: {
      name: { type: 'string' },
      isTerminal: { type: 'boolean' },
    },
    required: ['name', 'isTerminal'],
  })

  app.addSchema({
    $id: 'Transition',
    type: 'object',
    properties: {
      from: { type: 'string' },
      to: { type: 'string' },
      type: { type: 'string', enum: ['deterministic', 'probabilistic', 'symbolic'] },
      weight: { type: 'number' },
      action: { type: 'string' },
    },
    required: ['from', 'to', 'type'],
  })

  app.addSchema({
    $id: 'WorkflowGraph',
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      states: {
        type: 'object',
        additionalProperties: { $ref: 'State#' },
      },
      transitions: {
        type: 'array',
        items: { $ref: 'Transition#' },
      },
    },
    required: ['name', 'description', 'states', 'transitions'],
  })

  app.addSchema({
    $id: 'Session',
    type: 'object',
    properties: {
      id: { type: 'string' },
      workflowName: { type: 'string' },
      currentState: { type: 'string' },
      history: { type: 'array', items: { type: 'string' } },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'workflowName', 'currentState', 'history', 'createdAt'],
  })

  app.addSchema({
    $id: 'ApiKey',
    type: 'object',
    properties: {
      id: { type: 'string' },
      label: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'label', 'createdAt'],
  })
}

export function buildApp(stores: Stores): FastifyInstance {
  const app = Fastify()

  app.register(cors, { origin: true })

  registerSharedSchemas(app)

  app.addHook('preHandler', authMiddleware(stores.apiKeyStore))

  app.register(keysRoutes(stores.apiKeyStore))
  app.register(proceduresRoutes(stores.workflowStore, stores.sessionStore))
  app.register(sessionsRoutes(stores.workflowStore, stores.sessionStore))

  app.setErrorHandler((error, _req, reply) => {
    const status = (error as any).statusCode ?? 500
    const code = (error as any).code ?? 'INTERNAL_ERROR'
    reply.code(status).send({ error: error.message, code })
  })

  return app
}
