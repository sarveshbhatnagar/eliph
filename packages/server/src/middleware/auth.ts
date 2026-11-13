import { FastifyRequest, FastifyReply } from 'fastify'
import { IOrgKeyStore, IApiKeyStore, Session } from '@eliph/core'
import jwt from 'jsonwebtoken'
import { timingSafeEqual } from 'crypto'

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export const ADMIN_OWNER_ID = '__admin__'
export const MARKETPLACE_OWNER_ID = '__marketplace__'

export type AuthContext =
  | { type: 'admin' }
  | { type: 'org'; orgKeyId: string; keyLimit: number }
  | { type: 'api'; apiKeyId: string; apiKeyLabel: string; orgKeyId: string }

declare module 'fastify' {
  interface FastifyRequest {
    authContext: AuthContext | null
  }
}

/**
 * Owner namespace for the caller. Procedures and sessions are scoped to the org
 * so all API keys in an org share one namespace and the org key (used by the
 * dashboard) can manage them too. Admin uses its own namespace.
 */
export function requestOwnerId(req: Pick<FastifyRequest, 'authContext'>): string {
  const ctx = req.authContext
  if (ctx?.type === 'api') return ctx.orgKeyId
  if (ctx?.type === 'org') return ctx.orgKeyId
  return ADMIN_OWNER_ID
}

/**
 * Whether the caller may read or modify a session.
 * Allowed for admin, for callers in the org that owns the session, and for
 * legacy sessions whose owner is an API key id (an earlier release stored the
 * API key id as owner) when that key belongs to the caller's org.
 */
export async function canAccessSession(
  req: Pick<FastifyRequest, 'authContext'>,
  session: Pick<Session, 'workflowOwnerId'>,
  apiKeyStore: IApiKeyStore,
): Promise<boolean> {
  const ctx = req.authContext
  if (!ctx) return false
  if (ctx.type === 'admin') return true
  const owner = session.workflowOwnerId
  if (owner === ctx.orgKeyId) return true
  // Legacy: the session was created by this very API key
  if (ctx.type === 'api' && owner === ctx.apiKeyId) return true
  // Legacy: the session is owned by another API key in the caller's org
  if (!ctx.orgKeyId || !owner) return false
  const ownerKey = await apiKeyStore.findById(owner)
  return !!ownerKey && ownerKey.orgKeyId === ctx.orgKeyId
}

/**
 * Owner ids whose sessions the caller may list: the caller's org id, plus the
 * ids of the org's API keys (legacy sessions were owned by the API key id; see
 * canAccessSession). Admin lists the admin namespace only.
 */
export async function sessionOwnerIdsForListing(
  req: Pick<FastifyRequest, 'authContext'>,
  apiKeyStore: IApiKeyStore,
): Promise<string[]> {
  const ctx = req.authContext
  if (!ctx) return []
  if (ctx.type === 'admin') return [ADMIN_OWNER_ID]
  const ids = new Set<string>()
  if (ctx.orgKeyId) {
    ids.add(ctx.orgKeyId)
    for (const key of await apiKeyStore.list(ctx.orgKeyId)) ids.add(key.id)
  }
  if (ctx.type === 'api' && ctx.apiKeyId) ids.add(ctx.apiKeyId)
  return [...ids]
}

export function authMiddleware(orgKeyStore: IOrgKeyStore, apiKeyStore: IApiKeyStore) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === '/health') return
    if (request.method === 'GET' && request.url?.startsWith('/marketplace')) return
    if (request.url === '/oauth/token' && request.method === 'POST') return
    if (request.url?.startsWith('/authorize')) return
    if (request.url === '/.well-known/oauth-authorization-server') return

    const auth = request.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing API key', code: 'UNAUTHORIZED' })
    }
    const token = auth.slice(7)

    // Admin (constant-time comparison to prevent timing attacks)
    const adminSecret = process.env.ADMIN_SECRET
    if (adminSecret && safeEqual(token, adminSecret)) {
      request.authContext = { type: 'admin' }
      return
    }

    // JWT (issued via OAuth /oauth/token). Verified before the org key lookup
    // because verification is cheap and avoids the key store lookups below.
    const jwtSecret = process.env.JWT_SECRET
    if (jwtSecret) {
      let payload: { apiKeyId?: string } | null = null
      try {
        payload = jwt.verify(token, jwtSecret) as { apiKeyId?: string }
      } catch {
        // not a valid JWT — fall through to org key / raw API key checks
      }
      if (payload?.apiKeyId) {
        const keyFromJwt = await apiKeyStore.findById(payload.apiKeyId)
        if (!keyFromJwt) {
          // The API key behind this token was revoked/deleted
          return reply.code(401).send({ error: 'Invalid API key', code: 'UNAUTHORIZED' })
        }
        request.authContext = {
          type: 'api',
          apiKeyId: payload.apiKeyId,
          apiKeyLabel: keyFromJwt.label,
          orgKeyId: keyFromJwt.orgKeyId ?? '',
        }
        return
      }
    }

    // Org key
    const orgKey = await orgKeyStore.find(token)
    if (orgKey) {
      request.authContext = { type: 'org', orgKeyId: orgKey.id, keyLimit: orgKey.keyLimit }
      return
    }

    // Raw API key
    const apiKey = await apiKeyStore.find(token)
    if (apiKey) {
      request.authContext = { type: 'api', apiKeyId: apiKey.id, apiKeyLabel: apiKey.label, orgKeyId: apiKey.orgKeyId }
      return
    }

    return reply.code(401).send({ error: 'Invalid API key', code: 'UNAUTHORIZED' })
  }
}
