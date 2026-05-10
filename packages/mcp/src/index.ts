import { createClient } from './client'
import { makeProcedureTools } from './tools/procedures'
import { makeGraphTools } from './tools/graph'
import { makeSessionTools } from './tools/sessions'
import { makeAdvanceTools } from './tools/advance'

type ToolHandler = (args: Record<string, any>) => Promise<any>

export const toolMeta: Record<string, { description: string; inputSchema: object }> = {
  procedures: {
    description: 'Search for workflow procedures by name.',
    inputSchema: { type: 'object', properties: { search_query: { type: 'string', description: 'Optional search term' } } },
  },
  procedure: {
    description: 'Get a single workflow procedure by name.',
    inputSchema: { type: 'object', required: ['workflow_name'], properties: { workflow_name: { type: 'string' } } },
  },
  create_procedure: {
    description: 'Create a new workflow procedure.',
    inputSchema: { type: 'object', required: ['workflow_name', 'description'], properties: { workflow_name: { type: 'string' }, description: { type: 'string' } } },
  },
  add_transition: {
    description: 'Add a transition to a workflow procedure.',
    inputSchema: { type: 'object', required: ['workflow_name', 'transition'], properties: { workflow_name: { type: 'string' }, transition: { type: 'string' } } },
  },
  remove_transition: {
    description: 'Remove a transition from a workflow procedure.',
    inputSchema: { type: 'object', required: ['workflow_name', 'transition'], properties: { workflow_name: { type: 'string' }, transition: { type: 'string' } } },
  },
  remove_state: {
    description: 'Remove a state from a workflow procedure.',
    inputSchema: { type: 'object', required: ['workflow_name', 'state_name'], properties: { workflow_name: { type: 'string' }, state_name: { type: 'string' } } },
  },
  list_states: {
    description: 'List all states in a workflow procedure.',
    inputSchema: { type: 'object', required: ['workflow_name'], properties: { workflow_name: { type: 'string' } } },
  },
  create_session: {
    description: 'Start a new session for a workflow procedure.',
    inputSchema: { type: 'object', required: ['workflow_name'], properties: { workflow_name: { type: 'string' } } },
  },
  delete_session: {
    description: 'Delete a session.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' } } },
  },
  current_state: {
    description: 'Get the current state and history of a session.',
    inputSchema: { type: 'object', required: ['session_id', 'workflow_name'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string' } } },
  },
  next_transitions: {
    description: 'List the available next transitions from the current state.',
    inputSchema: { type: 'object', required: ['session_id', 'workflow_name'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string' } } },
  },
  advance: {
    description: 'Advance a session to the next state.',
    inputSchema: { type: 'object', required: ['session_id', 'workflow_name'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string' }, completed_action: { type: 'string', description: 'The action that was just completed' } } },
  },
  reset_state: {
    description: 'Reset a session back to a target state (default: start).',
    inputSchema: { type: 'object', required: ['session_id', 'workflow_name'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string' }, target_state: { type: 'string' } } },
  },
  requirements: {
    description: 'Get the action requirements for the current state of a session.',
    inputSchema: { type: 'object', required: ['session_id', 'workflow_name'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string' } } },
  },
}

export function buildMcpServer(apiUrl: string, apiKey: string) {
  const client = createClient(apiUrl, apiKey)

  const allTools: Record<string, ToolHandler> = {
    ...makeProcedureTools(client),
    ...makeGraphTools(client),
    ...makeSessionTools(client),
    ...makeAdvanceTools(client),
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

      const server = new Server({ name: 'eliph', version: '0.1.0' }, { capabilities: { tools: {} } })

      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Object.keys(allTools).map(name => ({
          name,
          description: toolMeta[name]?.description ?? name,
          inputSchema: toolMeta[name]?.inputSchema ?? { type: 'object' },
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
