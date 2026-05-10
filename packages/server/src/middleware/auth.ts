import { FastifyRequest, FastifyReply } from 'fastify'
import { IApiKeyStore } from '@eliph/core'

export function authMiddleware(apiKeyStore: IApiKeyStore) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/health') return
    // POST /keys is exempt — needed to create the first key (bootstrap)
    if (request.method === 'POST' && request.url === '/keys') return

    const auth = request.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing API key', code: 'UNAUTHORIZED' })
    }
    const rawKey = auth.slice(7)
    const key = await apiKeyStore.find(rawKey)
    if (!key) {
      return reply.code(401).send({ error: 'Invalid API key', code: 'UNAUTHORIZED' })
    }
  }
}
