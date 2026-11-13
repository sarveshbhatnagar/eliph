import Fastify, { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { IWorkflowStore, ISessionStore, IApiKeyStore, IOrgKeyStore, IUsageStore } from '@eliph/core'
import { authMiddleware } from './middleware/auth'
import { keysRoutes } from './routes/keys'
import { orgKeysRoutes } from './routes/orgkeys'
import { oauthRoutes } from './routes/oauth'
import { marketplaceRoutes } from './routes/marketplace'
import { proceduresRoutes } from './routes/procedures'
import { sessionsRoutes } from './routes/sessions'

export interface Stores {
  workflowStore: IWorkflowStore
  sessionStore: ISessionStore
  apiKeyStore: IApiKeyStore
  orgKeyStore: IOrgKeyStore
  usageStore: IUsageStore
}

const warningsSchema = {
  type: 'array',
  items: { type: 'string' },
  description: 'Advisory, human-readable problems with the workflow graph (e.g. weights not summing to 1.0, ambiguous exits, no reachable terminal state). Edits are not rejected because of them.',
}

export function registerSharedSchemas(app: FastifyInstance): void {
  app.addSchema({
    $id: 'State',
    type: 'object',
    properties: {
      name: { type: 'string' },
      isTerminal: { type: 'boolean' },
      description: { type: 'string' },
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

  const workflowGraphProperties = {
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
  }
  const workflowGraphRequired = ['name', 'description', 'states', 'transitions']

  app.addSchema({
    $id: 'WorkflowGraph',
    type: 'object',
    properties: workflowGraphProperties,
    required: workflowGraphRequired,
  })

  // WorkflowGraph plus advisory warnings (see graphWarnings in @eliph/core)
  app.addSchema({
    $id: 'WorkflowGraphWithWarnings',
    type: 'object',
    properties: { ...workflowGraphProperties, warnings: warningsSchema },
    required: workflowGraphRequired,
  })

  app.addSchema({
    $id: 'SessionData',
    type: 'object',
    additionalProperties: true,
    description: 'Free-form JSON object stored on the session (max 64 KB serialized). Use it to carry what was gathered (ids, links, decisions) across conversations.',
  })

  app.addSchema({
    $id: 'SessionEvent',
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['created', 'advance', 'reset', 'data'] },
      from: { type: 'string' },
      to: { type: 'string' },
      action: { type: 'string' },
      note: { type: 'string' },
      at: { type: 'string', format: 'date-time' },
    },
    required: ['type', 'at'],
  })

  const sessionProperties = {
    id: { type: 'string' },
    workflowName: { type: 'string' },
    currentState: { type: 'string' },
    history: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string', format: 'date-time' },
    data: { $ref: 'SessionData#' },
    // Step context for the current state, so no separate current_state/next calls are needed
    stateDescription: { type: 'string', nullable: true, description: 'Description of the current state (agent instructions), or null.' },
    isTerminal: { type: 'boolean', description: 'Whether the current state is terminal (workflow complete).' },
    nextTransitions: { type: 'array', items: { $ref: 'Transition#' }, description: 'Transitions available from the current state.' },
    pinned: { type: 'boolean', description: 'Present and true when the session runs against a snapshot of its procedure taken at creation (pin: true); absent otherwise.' },
  }
  const sessionRequired = ['id', 'workflowName', 'currentState', 'history', 'createdAt']

  app.addSchema({
    $id: 'Session',
    type: 'object',
    properties: sessionProperties,
    required: sessionRequired,
  })

  // Session plus advisory warnings about its workflow graph
  app.addSchema({
    $id: 'SessionWithWarnings',
    type: 'object',
    properties: { ...sessionProperties, warnings: warningsSchema },
    required: sessionRequired,
  })

  app.addSchema({
    $id: 'ApiKey',
    type: 'object',
    properties: {
      id: { type: 'string' },
      label: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      orgKeyId: { type: 'string' },
    },
    required: ['id', 'label', 'createdAt', 'orgKeyId'],
  })
}

export function buildApp(stores: Stores): FastifyInstance {
  const app = Fastify()

  app.decorateRequest('authContext', null)
  app.register(cors, { origin: true })
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    const params = new URLSearchParams(body as string)
    const obj: Record<string, string> = {}
    params.forEach((v, k) => { obj[k] = v })
    done(null, obj)
  })

  registerSharedSchemas(app)

  app.get('/health', async (_req, reply) => {
    reply.send({ status: 'ok', ts: new Date().toISOString() })
  })

  app.addHook('preHandler', authMiddleware(stores.orgKeyStore, stores.apiKeyStore))

  app.register(oauthRoutes(stores.apiKeyStore))
  app.register(keysRoutes(stores.orgKeyStore, stores.apiKeyStore))
  app.register(orgKeysRoutes(stores.orgKeyStore, stores.usageStore))
  app.register(marketplaceRoutes(stores.workflowStore))
  app.register(proceduresRoutes(stores.workflowStore, stores.sessionStore))
  app.register(sessionsRoutes(stores.workflowStore, stores.sessionStore, stores.usageStore, stores.apiKeyStore))

  app.setErrorHandler((error, _req, reply) => {
    const status = (error as any).statusCode ?? 500
    const code = (error as any).code ?? 'INTERNAL_ERROR'
    reply.code(status).send({ error: error.message, code })
  })

  return app
}
