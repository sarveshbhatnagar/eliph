import { FastifyRequest, FastifyReply } from 'fastify'
import { IOrgKeyStore, IApiKeyStore } from '@eliph/core'
import jwt from 'jsonwebtoken'

export const ADMIN_OWNER_ID = '__admin__'

export type AuthContext =
  | { type: 'admin' }
  | { type: 'org'; orgKeyId: string; keyLimit: number }
  | { type: 'api'; apiKeyId: string }

declare module 'fastify' {
  interface FastifyRequest {
    authContext: AuthContext | null
  }
}

export function authMiddleware(orgKeyStore: IOrgKeyStore, apiKeyStore: IApiKeyStore) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/health') return
    if (request.url === '/oauth/token' && request.method === 'POST') return
    if (request.url?.startsWith('/authorize')) return
    if (request.url === '/.well-known/oauth-authorization-server') return

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

    // JWT (issued via OAuth /oauth/token)
    const jwtSecret = process.env.JWT_SECRET
    if (jwtSecret) {
      try {
        const payload = jwt.verify(token, jwtSecret) as { apiKeyId: string }
        if (payload?.apiKeyId) {
          request.authContext = { type: 'api', apiKeyId: payload.apiKeyId }
          return
        }
      } catch {
        // not a valid JWT — fall through to raw API key check
      }
    }

    // Raw API key
    const apiKey = await apiKeyStore.find(token)
    if (apiKey) {
      request.authContext = { type: 'api', apiKeyId: apiKey.id }
      return
    }

    return reply.code(401).send({ error: 'Invalid API key', code: 'UNAUTHORIZED' })
  }
}
