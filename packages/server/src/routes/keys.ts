import { FastifyInstance } from 'fastify'
import { IApiKeyStore, IOrgKeyStore } from '@eliph/core'

export function keysRoutes(orgKeyStore: IOrgKeyStore, apiKeyStore: IApiKeyStore) {
  return async (app: FastifyInstance) => {

    // POST /keys — org key required; enforces per-org key limit
    app.post<{ Body: { label: string } }>('/keys', {
      schema: {
        tags: ['Keys'],
        summary: 'Create an API key (org key required)',
        security: [{ BearerAuth: [] }],
        body: {
          type: 'object',
          required: ['label'],
          properties: { label: { type: 'string' } },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              rawKey: { type: 'string' },
              id: { type: 'string' },
              label: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
              orgKeyId: { type: 'string' },
            },
          },
        },
      },
    }, async (req, reply) => {
      const ctx = req.authContext
      if (ctx?.type !== 'org') {
        return reply.code(403).send({ error: 'Org key required', code: 'FORBIDDEN' })
      }
      const count = await orgKeyStore.countKeys(ctx.orgKeyId)
      if (count >= ctx.keyLimit) {
        return reply.code(403).send({ error: 'Key limit reached', code: 'KEY_LIMIT_REACHED' })
      }
      const { label } = req.body
      if (!label) return reply.code(400).send({ error: 'label is required', code: 'BAD_REQUEST' })
      const { rawKey, record } = await apiKeyStore.create(label, ctx.orgKeyId)
      reply.code(201).send({ rawKey, id: record.id, label: record.label, createdAt: record.createdAt, orgKeyId: record.orgKeyId })
    })

    // GET /keys — org key sees own keys, admin sees all
    app.get('/keys', {
      schema: {
        tags: ['Keys'],
        summary: 'List API keys (scoped by org key, or all for admin)',
        security: [{ BearerAuth: [] }],
        response: {
          200: { type: 'array', items: { $ref: 'ApiKey#' } },
        },
      },
    }, async (req, reply) => {
      const ctx = req.authContext
      if (ctx?.type === 'org') return reply.send(await apiKeyStore.list(ctx.orgKeyId))
      if (ctx?.type === 'admin') return reply.send(await apiKeyStore.list())
      return reply.code(403).send({ error: 'Org key or admin required', code: 'FORBIDDEN' })
    })

    // DELETE /keys/:id — org key can delete own keys, admin can delete any
    app.delete<{ Params: { id: string } }>('/keys/:id', {
      schema: {
        tags: ['Keys'],
        summary: 'Delete an API key',
        security: [{ BearerAuth: [] }],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
        response: { 204: { type: 'null' } },
      },
    }, async (req, reply) => {
      const ctx = req.authContext
      if (ctx?.type === 'org') {
        const keys = await apiKeyStore.list(ctx.orgKeyId)
        if (!keys.find(k => k.id === req.params.id)) {
          return reply.code(403).send({ error: 'Key not owned by this org', code: 'FORBIDDEN' })
        }
      } else if (ctx?.type !== 'admin') {
        return reply.code(403).send({ error: 'Org key or admin required', code: 'FORBIDDEN' })
      }
      await apiKeyStore.delete(req.params.id)
      reply.code(204).send()
    })
  }
}
