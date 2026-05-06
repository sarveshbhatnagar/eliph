import { IWorkflowStore, ISessionStore, IApiKeyStore } from '@eliph/core'
import { makeProcedureTools } from './tools/procedures'
import { makeGraphTools } from './tools/graph'
import { makeSessionTools } from './tools/sessions'
import { makeAdvanceTools } from './tools/advance'

type ToolHandler = (args: Record<string, any>) => Promise<any>

export interface Stores {
  workflowStore: IWorkflowStore
  sessionStore: ISessionStore
  apiKeyStore: IApiKeyStore
}

export function buildMcpServer(stores: Stores) {
  const allTools: Record<string, ToolHandler> = {
    ...makeProcedureTools(stores.workflowStore),
    ...makeGraphTools(stores.workflowStore),
    ...makeSessionTools(stores.workflowStore, stores.sessionStore),
    ...makeAdvanceTools(stores.workflowStore, stores.sessionStore),
  } as unknown as Record<string, ToolHandler>

  return {
    getToolNames(): string[] {
      return Object.keys(allTools)
    },
    async callTool(name: string, args: Record<string, any>) {
      const handler = allTools[name]
      if (!handler) throw new Error(`Unknown tool: "${name}"`)
      const result = await handler(args)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
    async start() {
      const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
      const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js')

      const apiKey = process.env.ELIPH_API_KEY
      if (!apiKey) throw new Error('ELIPH_API_KEY env var is required')

      const server = new Server({ name: 'eliph', version: '0.1.0' }, { capabilities: { tools: {} } })

      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Object.keys(allTools).map(name => ({
          name,
          description: `Eliph tool: ${name}`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        })),
      }))

      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params
        return await this.callTool(name, args ?? {})
      })

      const transport = new StdioServerTransport()
      await server.connect(transport)
    },
  }
}
