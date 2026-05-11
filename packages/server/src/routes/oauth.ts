import { FastifyInstance } from 'fastify'
import { IApiKeyStore } from '@eliph/core'
import jwt from 'jsonwebtoken'

const TOKEN_TTL = 60 * 60 * 24 * 30 // 30 days

export function oauthRoutes(apiKeyStore: IApiKeyStore) {
  return async (app: FastifyInstance) => {
    app.post('/oauth/token', {
      config: { skipAuth: true },
      schema: {
        tags: ['OAuth'],
        summary: 'OAuth 2.0 client credentials token endpoint',
        consumes: ['application/x-www-form-urlencoded', 'application/json'],
      } as any,
    }, async (req, reply) => {
      const secret = process.env.JWT_SECRET
      if (!secret) {
        return reply.code(500).send({ error: 'server_error', error_description: 'JWT_SECRET not configured' })
      }

      const body = req.body as Record<string, string>
      const grantType = body?.grant_type
      const clientSecret = body?.client_secret

      if (grantType !== 'client_credentials') {
        return reply.code(400).send({ error: 'unsupported_grant_type' })
      }

      if (!clientSecret) {
        return reply.code(400).send({ error: 'invalid_client', error_description: 'client_secret is required' })
      }

      const apiKey = await apiKeyStore.find(clientSecret)
      if (!apiKey) {
        return reply.code(401).send({ error: 'invalid_client', error_description: 'Invalid client_secret' })
      }

      const token = jwt.sign({ apiKeyId: apiKey.id }, secret, { expiresIn: TOKEN_TTL })

      reply.send({
        access_token: token,
        token_type: 'Bearer',
        expires_in: TOKEN_TTL,
      })
    })
  }
}
