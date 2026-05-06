import { FastifyInstance } from 'fastify'
import { IApiKeyStore } from '@eliph/core'

export function keysRoutes(store: IApiKeyStore) {
  return async (app: FastifyInstance) => {
    app.post<{ Body: { label: string } }>('/keys', async (req, reply) => {
      const { label } = req.body
      if (!label) return reply.code(400).send({ error: 'label is required', code: 'BAD_REQUEST' })
      const { rawKey, record } = await store.create(label)
      reply.code(201).send({ rawKey, id: record.id, label: record.label, createdAt: record.createdAt })
    })

    app.get('/keys', async (_req, reply) => {
      reply.send(await store.list())
    })

    app.delete<{ Params: { id: string } }>('/keys/:id', async (req, reply) => {
      await store.delete(req.params.id)
      reply.code(204).send()
    })
  }
}
