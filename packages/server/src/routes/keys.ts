import { FastifyInstance } from 'fastify'
import { IApiKeyStore } from '@eliph/core'

export function keysRoutes(store: IApiKeyStore) {
  return async (app: FastifyInstance) => {
    app.post<{ Body: { label: string } }>('/keys', {
      schema: {
        tags: ['Keys'],
        summary: 'Create an API key (no auth required)',
        security: [],
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
            },
          },
        },
      },
    }, async (req, reply) => {
      const { label } = req.body
      if (!label) return reply.code(400).send({ error: 'label is required', code: 'BAD_REQUEST' })
      const { rawKey, record } = await store.create(label)
      reply.code(201).send({ rawKey, id: record.id, label: record.label, createdAt: record.createdAt })
    })

    app.get('/keys', {
      schema: {
        tags: ['Keys'],
        summary: 'List API keys',
        security: [{ BearerAuth: [] }],
        response: {
          200: { type: 'array', items: { $ref: 'ApiKey#' } },
        },
      },
    }, async (_req, reply) => {
      reply.send(await store.list())
    })

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
      await store.delete(req.params.id)
      reply.code(204).send()
    })
  }
}
