import { createClient } from './client'
import { makeProcedureTools } from './tools/procedures'
import { makeGraphTools } from './tools/graph'
import { makeSessionTools } from './tools/sessions'
import { makeAdvanceTools } from './tools/advance'

type ToolHandler = (args: Record<string, any>) => Promise<any>

export const toolMeta: Record<string, { description: string; inputSchema: object }> = {
  procedures: {
    description: 'Search eliph for available workflow procedures (state machines). Eliph is a workflow engine — procedures define multi-step processes with states and transitions. Call this first to discover what workflows exist before creating sessions. Returns a list of procedure names matching the query.',
    inputSchema: { type: 'object', properties: { search_query: { type: 'string', description: 'Optional search term to filter procedures by name' } } },
  },
  procedure: {
    description: 'Get the full definition of a single eliph workflow procedure — its states, transitions, and description. Use this to understand what a workflow does and what paths are available before creating a session.',
    inputSchema: { type: 'object', required: ['workflow_name'], properties: { workflow_name: { type: 'string' } } },
  },
  create_procedure: {
    description: 'Create a new eliph workflow procedure (state machine). A procedure defines a reusable multi-step process. After creating, use add_transition() to define the paths between states. Typical flow: create_procedure → add_transition → create_session.',
    inputSchema: { type: 'object', required: ['workflow_name', 'description'], properties: { workflow_name: { type: 'string', description: 'Unique name for this workflow' }, description: { type: 'string', description: 'What this workflow does' } } },
  },
  add_transition: {
    description: 'Add a transition between two states in a workflow procedure. Transitions define the valid paths through the workflow. Format: "from_state -> to_state" or "from_state -> to_state [action_required]". Example: "start -> review" or "review -> approved [manager_approval]".',
    inputSchema: { type: 'object', required: ['workflow_name', 'transition'], properties: { workflow_name: { type: 'string' }, transition: { type: 'string', description: 'Transition in format "from -> to" or "from -> to [action]"' } } },
  },
  remove_transition: {
    description: 'Remove an existing transition from a workflow procedure. Use the same format as add_transition: "from_state -> to_state".',
    inputSchema: { type: 'object', required: ['workflow_name', 'transition'], properties: { workflow_name: { type: 'string' }, transition: { type: 'string' } } },
  },
  remove_state: {
    description: 'Remove a state and all its transitions from a workflow procedure. Will fail if any active sessions are currently in that state.',
    inputSchema: { type: 'object', required: ['workflow_name', 'state_name'], properties: { workflow_name: { type: 'string' }, state_name: { type: 'string' } } },
  },
  list_states: {
    description: 'List all states defined in a workflow procedure, including which states are terminal (end states). Use this to understand the full shape of a workflow.',
    inputSchema: { type: 'object', required: ['workflow_name'], properties: { workflow_name: { type: 'string' } } },
  },
  create_session: {
    description: 'Start a new eliph session — a single live instance of a workflow procedure running through its states. Every session starts at the "start" state. Returns a session_id you must keep to call advance(), next_transitions(), etc. Use this when beginning a new instance of a process (e.g. a new approval request, a new onboarding run).',
    inputSchema: { type: 'object', required: ['workflow_name'], properties: { workflow_name: { type: 'string' } } },
  },
  delete_session: {
    description: 'Delete a completed or abandoned eliph session. Use this to clean up after a workflow finishes or is cancelled.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' } } },
  },
  current_state: {
    description: 'Get the current state and full history of an eliph session. Use this to check where a workflow instance is right now and what path it has taken. Call before advance() to confirm the current position.',
    inputSchema: { type: 'object', required: ['session_id', 'workflow_name'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string' } } },
  },
  next_transitions: {
    description: 'List the transitions available from the current state of an eliph session — i.e. what states can be moved to next and what actions are required. Always call this before advance() to understand what options exist.',
    inputSchema: { type: 'object', required: ['session_id', 'workflow_name'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string' } } },
  },
  advance: {
    description: 'Advance an eliph session to the next state. Call next_transitions() first to see what is available. If a transition requires a completed_action, pass it here. This is the core operation for driving a workflow forward step by step.',
    inputSchema: { type: 'object', required: ['session_id', 'workflow_name'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string' }, completed_action: { type: 'string', description: 'The action that was completed to enable this transition (if required)' } } },
  },
  reset_state: {
    description: 'Reset an eliph session back to a previous state (defaults to "start"). Use this to restart a workflow from the beginning or roll back to a specific state after an error or rejection.',
    inputSchema: { type: 'object', required: ['session_id', 'workflow_name'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string' }, target_state: { type: 'string', description: 'State to reset to (default: start)' } } },
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
