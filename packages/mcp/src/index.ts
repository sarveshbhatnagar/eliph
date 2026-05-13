import { createClient } from './client'
import { makeProcedureTools } from './tools/procedures'
import { makeGraphTools } from './tools/graph'
import { makeSessionTools } from './tools/sessions'
import { makeAdvanceTools } from './tools/advance'

type ToolHandler = (args: Record<string, any>) => Promise<any>

export const toolMeta: Record<string, { description: string; inputSchema: object }> = {
  procedures: {
    description: 'Search eliph for available workflow procedures. Returns { name, description }[] so you can understand what each workflow does without extra calls. Call with no query to list everything, or pass a term to filter by name or description. Use the description to decide which procedure fits the current task, then call procedure(name) to get the full state/transition graph.',
    inputSchema: { type: 'object', properties: { search_query: { type: 'string', description: 'Optional search term — filters by name or description substring' } } },
  },
  procedure: {
    description: 'Get the full definition of a single eliph workflow procedure — its states, transitions, and description. Use this to understand what a workflow does and what paths are available before creating a session.',
    inputSchema: { type: 'object', required: ['workflow_name'], properties: { workflow_name: { type: 'string' } } },
  },
  update_description: {
    description: 'Update the description of an existing workflow procedure. Use this to clarify intent, fix typos, or improve discoverability — the description is what agents use to decide which workflow fits a task.',
    inputSchema: { type: 'object', required: ['workflow_name', 'description'], properties: { workflow_name: { type: 'string' }, description: { type: 'string' } } },
  },
  delete_procedure: {
    description: 'Permanently delete a workflow procedure and all its states and transitions. Sessions that were running against this procedure will still exist but cannot advance. Use with care.',
    inputSchema: { type: 'object', required: ['workflow_name'], properties: { workflow_name: { type: 'string' } } },
  },
  create_procedure: {
    description: 'Create a new eliph workflow procedure (state machine). A procedure defines a reusable multi-step process. After creating, use add_transition() to define the paths between states. Typical flow: create_procedure → add_transition → create_session.',
    inputSchema: { type: 'object', required: ['workflow_name', 'description'], properties: { workflow_name: { type: 'string', description: 'Unique name for this workflow' }, description: { type: 'string', description: 'What this workflow does' } } },
  },
  add_transition: {
    description: 'Add a transition between two states in a workflow procedure. Three formats supported:\n• "A -> B" — deterministic: advance() with no completed_action moves automatically to B\n• "A -action_name-> B" — symbolic: advance() requires completed_action: "action_name"\n• "A -.7-> B" — probabilistic: advance() samples randomly by weight (0–1). All probabilistic transitions from the same state MUST sum to exactly 1.0 or the workflow is invalid. Example: "start -.7-> success" and "start -.3-> failure" — then advance() picks randomly with 70/30 odds. You cannot influence the outcome.\nChaining: "A -> B -> C" creates multiple transitions at once.\nNOTE: the state named "end" is automatically marked terminal. For other terminal states, use mark_terminal() after creating them.',
    inputSchema: { type: 'object', required: ['workflow_name', 'transition'], properties: { workflow_name: { type: 'string' }, transition: { type: 'string', description: 'e.g. "start -> review", "review -approved-> done", "start -.7-> pass -> end"' } } },
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
  mark_terminal: {
    description: 'Mark a state as terminal — sessions in this state cannot advance further and the workflow is considered complete. The state named "end" is auto-marked terminal. Use this for other logical end states (e.g. "approved", "rejected", "good_to_buy"). Call this after creating the state via add_transition.',
    inputSchema: { type: 'object', required: ['workflow_name', 'state_name'], properties: { workflow_name: { type: 'string' }, state_name: { type: 'string' } } },
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
    description: 'List the transitions available from the current state. Each result includes an "advance_with" field telling you exactly what to pass to advance(). For symbolic transitions this is { completed_action: "action_name" }; for deterministic it says to call advance() with no argument.',
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
    description: 'Returns the symbolic action names required to leave the current state — i.e. the completed_action values you can pass to advance(). Returns [] if all outgoing transitions are deterministic (no action needed). This is a shorthand for next_transitions filtered to symbolic-only; prefer next_transitions for full context.',
    inputSchema: { type: 'object', required: ['session_id', 'workflow_name'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string' } } },
  },
}

export function buildMcpServer(apiUrl: string, apiKey: string) {
  const client = createClient(apiUrl, apiKey)

  const allTools: Record<string, ToolHandler> = {
    ...makeProcedureTools(client),
    ...makeGraphTools(client),    // includes mark_terminal
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
