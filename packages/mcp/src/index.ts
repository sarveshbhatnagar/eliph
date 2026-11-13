import { createClient } from './client'
import { makeProcedureTools } from './tools/procedures'
import { makeGraphTools } from './tools/graph'
import { makeSessionTools } from './tools/sessions'
import { makeAdvanceTools } from './tools/advance'

type ToolHandler = (args: Record<string, any>) => Promise<any>

export const toolMeta: Record<string, { description: string; inputSchema: object }> = {
  browse_marketplace: {
    description: 'Browse the Eliph workflow template marketplace. Returns curated workflow templates you can copy into your namespace. Call this before create_procedure — the template you need may already exist. Returns { name, description }[].',
    inputSchema: { type: 'object', properties: { search_query: { type: 'string', description: 'Optional search term' } } },
  },
  copy_from_marketplace: {
    description: 'Copy a marketplace workflow template into your own namespace. The template is copied with all its states, transitions, and state descriptions intact — ready to use immediately or customise. Optionally rename it with workflow_name. If you already have a procedure with that name, the copy fails with a CONFLICT error and nothing is changed: use your existing procedure, pass a different workflow_name, or pass overwrite: true to replace it (this discards its states and transitions).',
    inputSchema: { type: 'object', required: ['template_name'], properties: { template_name: { type: 'string' }, workflow_name: { type: 'string', description: 'Optional new name (defaults to template name)' }, overwrite: { type: 'boolean', description: 'Optional. Replace an existing procedure of the same name. Default false (an existing name is a CONFLICT error).' } } },
  },
  procedures: {
    description: 'Search eliph for available workflow procedures. Returns { name, description }[] so you can understand what each workflow does without extra calls. Call with no query to list everything, or pass a term to filter by name or description. Use the description to decide which procedure fits the current task, then call procedure(name) to get the full state/transition graph.',
    inputSchema: { type: 'object', properties: { search_query: { type: 'string', description: 'Optional search term — filters by name or description substring' } } },
  },
  procedure: {
    description: 'Get the full definition of a single eliph workflow procedure — its states, transitions, and description. Use this to understand what a workflow does and what paths are available before creating a session. The response includes "warnings": advisory problems with the graph (probabilistic weights not summing to 1.0, a state with several deterministic exits, a state mixing probabilistic and other exits, a non-terminal dead end, no reachable terminal state). Fix them before running sessions.',
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
    description: 'Create a new eliph workflow procedure (state machine). A procedure defines a reusable multi-step process. After creating, use add_transition() to define the paths between states. Typical flow: create_procedure → add_transition → create_session. If a procedure with this name already exists, this fails with a CONFLICT error and nothing is changed: use the existing procedure (procedure(name)), pick another name, or pass overwrite: true to replace it (this discards its states and transitions).',
    inputSchema: { type: 'object', required: ['workflow_name', 'description'], properties: { workflow_name: { type: 'string', description: 'Unique name for this workflow' }, description: { type: 'string', description: 'What this workflow does' }, overwrite: { type: 'boolean', description: 'Optional. Replace an existing procedure of the same name. Default false (an existing name is a CONFLICT error).' } } },
  },
  add_transition: {
    description: 'Add a transition between two states in a workflow procedure. Three formats supported:\n• "A -> B" — deterministic: advance() with no completed_action moves automatically to B\n• "A -action_name-> B" — symbolic: advance() requires completed_action: "action_name". Action names may contain hyphens ("A -tests-pass-> B") but not "->", and must not be a plain number.\n• "A -.7-> B" — probabilistic: the label is a number, the weight, which must be greater than 0 and at most 1. advance() samples randomly by weight. All probabilistic transitions from the same state should sum to exactly 1.0 (a transition that would push the sum above 1.0 is rejected). Example: "start -.7-> success" and "start -.3-> failure" — then advance() picks randomly with 70/30 odds. You cannot influence the outcome. Do not mix probabilistic exits with other kinds from the same state.\nChaining: "A -> B -> C" creates multiple transitions at once.\nNOTE: the state named "end" is automatically marked terminal. For other terminal states, use mark_terminal() after creating them. The response includes "warnings" for the whole graph: advisory problems with the graph (probabilistic weights not summing to 1.0, a state with several deterministic exits, a state mixing probabilistic and other exits, a non-terminal dead end, no reachable terminal state). They do not block the edit, but fix them before running sessions.',
    inputSchema: { type: 'object', required: ['workflow_name', 'transition'], properties: { workflow_name: { type: 'string' }, transition: { type: 'string', description: 'e.g. "start -> review", "review -approved-> done", "start -.7-> pass -> end"' } } },
  },
  remove_transition: {
    description: 'Remove an existing transition from a workflow procedure. Use the same format as add_transition: "from_state -> to_state". The response includes "warnings": advisory problems with the graph (probabilistic weights not summing to 1.0, a state with several deterministic exits, a state mixing probabilistic and other exits, a non-terminal dead end, no reachable terminal state). They are advisory only.',
    inputSchema: { type: 'object', required: ['workflow_name', 'transition'], properties: { workflow_name: { type: 'string' }, transition: { type: 'string' } } },
  },
  remove_state: {
    description: 'Remove a state and all its transitions from a workflow procedure. Will fail if any active sessions are currently in that state. The response includes "warnings": advisory problems with the graph (probabilistic weights not summing to 1.0, a state with several deterministic exits, a state mixing probabilistic and other exits, a non-terminal dead end, no reachable terminal state). They are advisory only.',
    inputSchema: { type: 'object', required: ['workflow_name', 'state_name'], properties: { workflow_name: { type: 'string' }, state_name: { type: 'string' } } },
  },
  list_states: {
    description: 'List all states in a workflow procedure, including name, isTerminal flag, and description. State descriptions contain agent instructions — what to do, what to gather, what decisions to make when a session is in that state.',
    inputSchema: { type: 'object', required: ['workflow_name'], properties: { workflow_name: { type: 'string' } } },
  },
  update_state_description: {
    description: 'Add or update the description of a state in a workflow procedure. Use this to give agents context about what to do when a session is in this state — what actions to take, what information to gather, what decisions to make. This is the primary way to embed agent instructions into a workflow.',
    inputSchema: { type: 'object', required: ['workflow_name', 'state_name', 'description'], properties: { workflow_name: { type: 'string' }, state_name: { type: 'string' }, description: { type: 'string', description: 'What the agent should do / context for this state' } } },
  },
  mark_terminal: {
    description: 'Mark a state as terminal — sessions in this state cannot advance further and the workflow is considered complete. The state named "end" is auto-marked terminal. Use this for other logical end states (e.g. "approved", "rejected", "good_to_buy"). Call this after creating the state via add_transition. The response includes "warnings": advisory problems with the graph (probabilistic weights not summing to 1.0, a state with several deterministic exits, a state mixing probabilistic and other exits, a non-terminal dead end, no reachable terminal state). They are advisory only.',
    inputSchema: { type: 'object', required: ['workflow_name', 'state_name'], properties: { workflow_name: { type: 'string' }, state_name: { type: 'string' } } },
  },
  create_session: {
    description: 'Start a new eliph session — a single live instance of a workflow procedure running through its states. Every session starts at the "start" state. Returns a session_id you must keep to call advance(), etc. Use this when beginning a new instance of a process (e.g. a new approval request, a new onboarding run). The response already contains the state description (stateDescription), whether it is terminal (isTerminal) and the next transitions (nextTransitions) of the resulting state, so separate current_state()/next_transitions() calls are unnecessary. Session data is a JSON object (max 64 KB) that persists with the session: store what you gathered (ids, links, decisions) so the work can be resumed in a later conversation. Pass initial data with "data". The response includes "warnings" about the workflow graph (e.g. ambiguous exits, dead ends, weights not summing to 1.0, no reachable terminal state); the session is still created, but such problems can make advance() fail later. To resume earlier work, use list_sessions() instead of creating a new session.',
    inputSchema: { type: 'object', required: ['workflow_name'], properties: { workflow_name: { type: 'string' }, data: { type: 'object', additionalProperties: true, description: 'Optional initial session data (JSON object, max 64 KB), e.g. ids and links for the work this session tracks.' } } },
  },
  delete_session: {
    description: 'Delete a completed or abandoned eliph session. Use this to clean up after a workflow finishes or is cancelled.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' } } },
  },
  current_state: {
    description: 'Get the current state, workflow name, full history, session data and event log of an eliph session. Only session_id is needed. The response includes the state description — agent instructions for what to do in this state — and the next transitions. Always read the state description to know what actions or decisions are expected here. You do not need this after create_session/advance/reset_state: their responses already contain the state description and next transitions. Use it when resuming a session in a later conversation: "data" holds what was gathered so far (ids, links, decisions) and "events" what happened (most recent 500).',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string', description: 'Optional. The session already knows its workflow; if given, it must match the session\'s workflow.' } } },
  },
  next_transitions: {
    description: 'List the transitions available from the current state of a session (only session_id is needed). Each result includes an "advance_with" field telling you exactly what to pass to advance(). For symbolic transitions this is { completed_action: "action_name" }; for deterministic it says to call advance() with no argument.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string', description: 'Optional. The session already knows its workflow; if given, it must match the session\'s workflow.' } } },
  },
  advance: {
    description: 'Advance an eliph session to the next state (only session_id is needed; workflow_name is optional). If a transition requires a completed_action, pass it here (the nextTransitions of the previous response tell you which). This is the core operation for driving a workflow forward step by step. The response already contains the state description (stateDescription), whether it is terminal (isTerminal) and the next transitions (nextTransitions) of the resulting state, so separate current_state()/next_transitions() calls are unnecessary. Optionally pass "data" to save what you gathered in this step (shallow-merged into the session data; null removes a key) and a "note" for the event log. Session data is a JSON object (max 64 KB) that persists with the session: store what you gathered (ids, links, decisions) so the work can be resumed in a later conversation.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string', description: 'Optional. The session already knows its workflow; if given, it must match the session\'s workflow.' }, completed_action: { type: 'string', description: 'The action that was completed to enable this transition (if required)' }, data: { type: 'object', additionalProperties: true, description: 'Optional. Patch shallow-merged into the session data; a key set to null removes it. Store what you gathered (ids, links, decisions) so the work can be resumed later.' }, note: { type: 'string', maxLength: 2000, description: 'Optional. Short note recorded in the session event log (max 2000 characters), e.g. why this step was taken.' } } },
  },
  reset_state: {
    description: 'Reset an eliph session back to a previous state (defaults to "start"). Only session_id is needed. Use this to restart a workflow from the beginning or roll back to a specific state after an error or rejection. The response already contains the state description (stateDescription), whether it is terminal (isTerminal) and the next transitions (nextTransitions) of the resulting state, so separate current_state()/next_transitions() calls are unnecessary. Optionally pass "data" (shallow-merged into the session data; null removes a key) and a "note" explaining the reset for the event log. Session data is a JSON object (max 64 KB) that persists with the session: store what you gathered (ids, links, decisions) so the work can be resumed in a later conversation.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string', description: 'Optional. The session already knows its workflow; if given, it must match the session\'s workflow.' }, target_state: { type: 'string', description: 'State to reset to (default: start)' }, data: { type: 'object', additionalProperties: true, description: 'Optional. Patch shallow-merged into the session data; a key set to null removes it. Store what you gathered (ids, links, decisions) so the work can be resumed later.' }, note: { type: 'string', maxLength: 2000, description: 'Optional. Short note recorded in the session event log (max 2000 characters), e.g. why this step was taken.' } } },
  },
  update_session_data: {
    description: 'Merge data into an eliph session without changing its state. Session data is a JSON object (max 64 KB) that persists with the session: store what you gathered (ids, links, decisions) so the work can be resumed in a later conversation. The patch is shallow-merged: top-level keys replace existing ones and a key set to null is removed. Returns the session with its full data and the step context of its current state.',
    inputSchema: { type: 'object', required: ['session_id', 'data'], properties: { session_id: { type: 'string' }, data: { type: 'object', additionalProperties: true, description: 'Patch shallow-merged into the session data; a key set to null removes it.' } } },
  },
  list_sessions: {
    description: 'List your eliph sessions, newest first: { id, workflowName, currentState, createdAt, updatedAt, isTerminal }[]. Use this to find a session to resume in a new conversation, then call current_state(session_id) to read its data and event log. Filter by workflow_name and by active (true = not finished; sessions whose workflow was deleted are never active).',
    inputSchema: { type: 'object', properties: { workflow_name: { type: 'string', description: 'Optional. Only sessions of this workflow.' }, active: { type: 'boolean', description: 'Optional. true: only sessions not yet in a terminal state; false: only finished ones.' }, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Optional. Maximum number of sessions (default 50, max 200).' } } },
  },
  requirements: {
    description: 'Returns the symbolic action names required to leave the session\'s current state (only session_id is needed) — i.e. the completed_action values you can pass to advance(). Returns [] if all outgoing transitions are deterministic (no action needed). This is a shorthand for next_transitions filtered to symbolic-only; prefer next_transitions for full context.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string', description: 'Optional. The session already knows its workflow; if given, it must match the session\'s workflow.' } } },
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
