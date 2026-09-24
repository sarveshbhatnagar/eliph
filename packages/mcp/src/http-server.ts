import { createServer, IncomingMessage, ServerResponse } from 'http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildMcpServer, toolMeta } from './index'

const API_URL = process.env.ELIPH_API_URL ?? 'http://localhost:4000'
const PUBLIC_API_URL = process.env.PUBLIC_API_URL ?? 'https://eliph-api.revalent.ai'
const PORT = parseInt(process.env.MCP_PORT ?? '4002')

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => (data += chunk))
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : undefined) }
      catch { resolve(undefined) }
    })
    req.on('error', reject)
  })
}

// MCP clients (Claude Desktop, etc.) do not use browsers and don't need CORS.
// Only allow CORS when the request actually carries an Origin header, and echo
// it back — never the wildcard '*' for an authenticated API.
const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', `http://localhost`)

  const discovery = {
    issuer: PUBLIC_API_URL,
    authorization_endpoint: `${PUBLIC_API_URL}/authorize`,
    token_endpoint: `${PUBLIC_API_URL}/oauth/token`,
    grant_types_supported: ['authorization_code', 'client_credentials'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
  }

  if (url.pathname === '/.well-known/oauth-authorization-server' ||
      url.pathname === '/.well-known/oauth-protected-resource') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(discovery))
    return
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
    return
  }

  const apiKey = req.headers.authorization?.replace(/^Bearer\s+/i, '')

  if (!apiKey) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer realm="eliph", as_uri="${PUBLIC_API_URL}"`,
    })
    res.end(JSON.stringify({ error: 'Authorization: Bearer <api-key> header required' }))
    return
  }

  const mcpInstance = buildMcpServer(API_URL, apiKey)

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — auth is per-request via API key
  })

  const server = new Server(
    { name: 'eliph', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mcpInstance.getToolNames().map(name => ({
      name,
      description: toolMeta[name]?.description ?? name,
      inputSchema: toolMeta[name]?.inputSchema ?? { type: 'object' },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await mcpInstance.callTool(request.params.name, request.params.arguments ?? {})
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      }
    }
  })

  await server.connect(transport)

  const body = await readBody(req)
  await transport.handleRequest(req, res, body)
})

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Eliph MCP HTTP server listening on port ${PORT}`)
})
