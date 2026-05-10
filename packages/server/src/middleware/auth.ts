import { FastifyRequest, FastifyReply } from 'fastify'
import { IOrgKeyStore, IApiKeyStore } from '@eliph/core'

export type AuthContext =
  | { type: 'admin' }
  | { type: 'org'; orgKeyId: string; keyLimit: number }
  | { type: 'api' }

declare module 'fastify' {
  interface FastifyRequest {
    authContext: AuthContext | null
  }
}

export function authMiddleware(orgKeyStore: IOrgKeyStore, apiKeyStore: IApiKeyStore) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/health') return

    const auth = request.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing API key', code: 'UNAUTHORIZED' })
    }
    const token = auth.slice(7)

    // Admin
    const adminSecret = process.env.ADMIN_SECRET
    if (adminSecret && token === adminSecret) {
      request.authContext = { type: 'admin' }
      return
    }

    // Org key
    const orgKey = await orgKeyStore.find(token)
    if (orgKey) {
      request.authContext = { type: 'org', orgKeyId: orgKey.id, keyLimit: orgKey.keyLimit }
      return
    }

    // API key
    const apiKey = await apiKeyStore.find(token)
    if (apiKey) {
      request.authContext = { type: 'api' }
      return
    }

    return reply.code(401).send({ error: 'Invalid API key', code: 'UNAUTHORIZED' })
  }
}
