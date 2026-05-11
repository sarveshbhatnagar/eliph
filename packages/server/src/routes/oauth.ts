import { FastifyInstance } from 'fastify'
import { IApiKeyStore } from '@eliph/core'
import jwt from 'jsonwebtoken'
import { createHash, randomBytes } from 'crypto'

const TOKEN_TTL = 60 * 60 * 24 * 30 // 30 days
const CODE_TTL_MS = 5 * 60 * 1000   // 5 minutes

const ISSUER = process.env.API_URL ?? 'https://eliph-api.revalent.ai'

// In-memory authorization code store (small TTL, no need for DB)
interface PendingCode {
  apiKeyId: string
  redirectUri: string
  codeChallenge?: string
  codeChallengeMethod?: string
  expiresAt: number
}
const pendingCodes = new Map<string, PendingCode>()

function generateCode(): string {
  return randomBytes(32).toString('hex')
}

function verifyPkce(codeVerifier: string, codeChallenge: string, method: string): boolean {
  if (method === 'S256') {
    const hash = createHash('sha256').update(codeVerifier).digest()
    const computed = hash.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    return computed === codeChallenge
  }
  if (method === 'plain') return codeVerifier === codeChallenge
  return false
}

const authorizeHtml = (params: URLSearchParams, error?: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect to Eliph</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 20px; color: #111; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    p { color: #555; font-size: 14px; margin-top: 4px; }
    label { display: block; font-size: 13px; font-weight: 600; margin: 20px 0 6px; }
    input { width: 100%; padding: 10px 12px; font-size: 14px; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box; font-family: monospace; }
    button { margin-top: 16px; width: 100%; padding: 11px; background: #000; color: #fff; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:hover { background: #222; }
    .error { background: #fff0f0; color: #c00; border: 1px solid #fcc; border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-bottom: 16px; }
    .hint { font-size: 12px; color: #888; margin-top: 6px; }
  </style>
</head>
<body>
  <h1>Connect to Eliph</h1>
  <p>Enter your Eliph API key to authorise Claude to access your workflows.</p>
  ${error ? `<div class="error">${error}</div>` : ''}
  <form method="POST" action="/authorize">
    <input type="hidden" name="response_type" value="${params.get('response_type') ?? ''}"/>
    <input type="hidden" name="client_id" value="${params.get('client_id') ?? ''}"/>
    <input type="hidden" name="redirect_uri" value="${params.get('redirect_uri') ?? ''}"/>
    <input type="hidden" name="code_challenge" value="${params.get('code_challenge') ?? ''}"/>
    <input type="hidden" name="code_challenge_method" value="${params.get('code_challenge_method') ?? ''}"/>
    <input type="hidden" name="state" value="${params.get('state') ?? ''}"/>
    <label for="api_key">API Key</label>
    <input id="api_key" name="api_key" type="password" placeholder="Paste your API key" autocomplete="off" required/>
    <p class="hint">Your API key was shown once when created via POST /keys.</p>
    <button type="submit">Authorise</button>
  </form>
</body>
</html>`

export function oauthRoutes(apiKeyStore: IApiKeyStore) {
  return async (app: FastifyInstance) => {

    // RFC 8414 discovery
    app.get('/.well-known/oauth-authorization-server', {
      config: { skipAuth: true },
      schema: { tags: ['OAuth'], summary: 'OAuth 2.0 authorization server metadata (RFC 8414)' } as any,
    }, async (_req, reply) => {
      reply.send({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        grant_types_supported: ['authorization_code', 'client_credentials'],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256', 'plain'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      })
    })

    // Authorization page — show API key form
    app.get('/authorize', {
      config: { skipAuth: true },
      schema: { tags: ['OAuth'], summary: 'OAuth 2.0 authorization endpoint' } as any,
    }, async (req, reply) => {
      const params = new URLSearchParams(req.url.split('?')[1] ?? '')
      reply.type('text/html').send(authorizeHtml(params))
    })

    // Authorization form submission — validate key, issue code, redirect
    app.post('/authorize', {
      config: { skipAuth: true },
      schema: { tags: ['OAuth'], summary: 'OAuth 2.0 authorization form submit' } as any,
    }, async (req, reply) => {
      const body = req.body as Record<string, string>
      const { api_key, redirect_uri, state, code_challenge, code_challenge_method } = body

      const params = new URLSearchParams(body)

      if (!redirect_uri) {
        return reply.code(400).send({ error: 'invalid_request', error_description: 'redirect_uri required' })
      }

      const apiKey = await apiKeyStore.find(api_key)
      if (!apiKey) {
        return reply.type('text/html').send(authorizeHtml(params, 'Invalid API key. Please check and try again.'))
      }

      const code = generateCode()
      pendingCodes.set(code, {
        apiKeyId: apiKey.id,
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
        expiresAt: Date.now() + CODE_TTL_MS,
      })

      const callbackUrl = new URL(redirect_uri)
      callbackUrl.searchParams.set('code', code)
      if (state) callbackUrl.searchParams.set('state', state)

      reply.redirect(callbackUrl.toString())
    })

    // Token endpoint — handles both authorization_code and client_credentials
    app.post('/oauth/token', {
      config: { skipAuth: true },
      schema: { tags: ['OAuth'], summary: 'OAuth 2.0 token endpoint' } as any,
    }, async (req, reply) => {
      const secret = process.env.JWT_SECRET
      if (!secret) {
        return reply.code(500).send({ error: 'server_error', error_description: 'JWT_SECRET not configured' })
      }

      const body = req.body as Record<string, string>
      const grantType = body?.grant_type

      // Authorization code exchange
      if (grantType === 'authorization_code') {
        const { code, redirect_uri, code_verifier } = body

        const pending = pendingCodes.get(code)
        if (!pending || Date.now() > pending.expiresAt) {
          pendingCodes.delete(code)
          return reply.code(400).send({ error: 'invalid_grant', error_description: 'Authorization code expired or invalid' })
        }

        if (pending.redirectUri !== redirect_uri) {
          return reply.code(400).send({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
        }

        if (pending.codeChallenge && code_verifier) {
          const method = pending.codeChallengeMethod ?? 'plain'
          if (!verifyPkce(code_verifier, pending.codeChallenge, method)) {
            return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE verification failed' })
          }
        }

        pendingCodes.delete(code)

        const token = jwt.sign({ apiKeyId: pending.apiKeyId }, secret, { expiresIn: TOKEN_TTL })
        return reply.send({ access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL })
      }

      // Client credentials (kept for Claude Code CLI)
      if (grantType === 'client_credentials') {
        const clientSecret = body?.client_secret
        if (!clientSecret) {
          return reply.code(400).send({ error: 'invalid_client', error_description: 'client_secret is required' })
        }
        const apiKey = await apiKeyStore.find(clientSecret)
        if (!apiKey) {
          return reply.code(401).send({ error: 'invalid_client', error_description: 'Invalid client_secret' })
        }
        const token = jwt.sign({ apiKeyId: apiKey.id }, secret, { expiresIn: TOKEN_TTL })
        return reply.send({ access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL })
      }

      return reply.code(400).send({ error: 'unsupported_grant_type' })
    })
  }
}
