import { createClient } from './client'
import { makeProcedureTools } from './tools/procedures'
import { makeGraphTools } from './tools/graph'
import { makeSessionTools } from './tools/sessions'
import { makeAdvanceTools } from './tools/advance'
import { makeJobTools } from './tools/jobs'

/** Shared by advance, reset_state and the steps of advance_job. */
const expectedStateProp = { type: 'string', description: 'Optional. The state you believe the session is in. If it is in any other state the call fails with STATE_MISMATCH and nothing changes. Pass it whenever another agent may be working on the same session.' }
const actorProp = { type: 'string', maxLength: 200, description: 'Optional. Who is doing this (free text, max 200 characters), e.g. an agent or worker name. Recorded in the session event log.' }
const stepDataProp = { type: 'object', additionalProperties: true, description: 'Optional. Patch shallow-merged into the run\'s session data; a key set to null removes it.' }
const stepNoteProp = { type: 'string', maxLength: 2000, description: 'Optional. Short note recorded in the event log (max 2000 characters).' }
const stepActionProp = { type: 'string', description: 'The action that was completed; selects the symbolic transition. Leave out for a deterministic step.' }

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
    description: 'Create a new, empty eliph workflow procedure (state machine) with only a "start" state. To create a whole workflow (transitions, state descriptions, terminal states) in one atomic call, prefer define_procedure instead. After create_procedure, use add_transition() to define the paths between states. Typical flow: create_procedure → add_transition → create_session. If a procedure with this name already exists, this fails with a CONFLICT error and nothing is changed: use the existing procedure (procedure(name)), pick another name, or pass overwrite: true to replace it (this discards its states and transitions).',
    inputSchema: { type: 'object', required: ['workflow_name', 'description'], properties: { workflow_name: { type: 'string', description: 'Unique name for this workflow' }, description: { type: 'string', description: 'What this workflow does' }, overwrite: { type: 'boolean', description: 'Optional. Replace an existing procedure of the same name. Default false (an existing name is a CONFLICT error).' } } },
  },
  define_procedure: {
    description: 'Create or replace a whole eliph workflow procedure in ONE atomic call: description, all transitions, state descriptions and terminal states. This is the preferred way to create a workflow or rewrite one completely; add_transition, remove_transition, update_state_description and mark_terminal remain for small incremental edits.\n' +
      'transitions: transition strings applied in order, same syntax as add_transition ("A -> B" deterministic, "A -action-> B" symbolic, "A -.7-> B" probabilistic; chains like "A -> B -> C" allowed). The state "start" always exists; "end" is automatically terminal.\n' +
      'An entry may instead be an object { "transition": "reviewing -approved-> merged", "requires": ["pr_url"] }: a single transition (not a chain) that can only be taken once those session-data keys have a value (not null or blank). advance() then fails with MISSING_REQUIRED_DATA, changing nothing, until the keys are in the session data or passed in that advance call\'s "data". Use it to make agents record evidence of the work (a link, an id) before moving on.\n' +
      'states (optional): { "<state>": { "description": "what the agent should do here", "terminal": true } }. Every state named there must appear in a transition (or be "start"); an unknown name is rejected as a likely typo.\n' +
      'Example: { "workflow_name": "code_review", "description": "Review and merge a pull request", "transitions": ["start -> reviewing", "reviewing -approved-> merged", "reviewing -changes_requested-> start"], "states": { "start": { "description": "Open the PR and summarise the change" }, "reviewing": { "description": "Read the diff; complete approved or changes_requested" }, "merged": { "description": "Merge and report the link", "terminal": true } } }\n' +
      'The whole definition is validated before anything is saved: if any transition or state is invalid, the error names it and nothing changes. If a procedure with this name already exists this fails with CONFLICT unless overwrite: true; replacing is also refused (CONFLICT, listing the states) while any of your sessions is in a state the new definition removes. The response is the saved graph plus "warnings": advisory problems (probabilistic weights not summing to 1.0, ambiguous exits, dead ends, no reachable terminal state).',
    inputSchema: {
      type: 'object',
      required: ['workflow_name', 'description', 'transitions'],
      properties: {
        workflow_name: { type: 'string', description: 'Unique name for this workflow' },
        description: { type: 'string', description: 'What this workflow does' },
        transitions: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                required: ['transition', 'requires'],
                properties: {
                  transition: { type: 'string', description: 'One transition (not a chain), e.g. "review -approved-> end"' },
                  requires: { type: 'array', items: { type: 'string' }, description: 'Session-data keys that must have a value before this transition can be taken' },
                },
              },
            ],
          },
          description: 'Transitions applied in order: strings, e.g. ["start -> review", "review -approved-> end"], or { "transition", "requires" } objects for a transition that needs session data, e.g. { "transition": "review -approved-> end", "requires": ["pr_url"] }',
        },
        states: {
          type: 'object',
          description: 'Optional. Per-state settings keyed by state name.',
          additionalProperties: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'What the agent should do / context for this state' },
              terminal: { type: 'boolean', description: 'Mark this state terminal (workflow complete)' },
            },
          },
        },
        overwrite: { type: 'boolean', description: 'Optional. Replace an existing procedure of the same name. Default false (an existing name is a CONFLICT error).' },
      },
    },
  },
  add_transition: {
    description: 'Add a transition between two states in a workflow procedure. Three formats supported:\n• "A -> B" — deterministic: advance() with no completed_action moves automatically to B\n• "A -action_name-> B" — symbolic: advance() requires completed_action: "action_name". Action names may contain hyphens ("A -tests-pass-> B") but not "->", and must not be a plain number.\n• "A -.7-> B" — probabilistic: the label is a number, the weight, which must be greater than 0 and at most 1. advance() samples randomly by weight. All probabilistic transitions from the same state should sum to exactly 1.0 (a transition that would push the sum above 1.0 is rejected). Example: "start -.7-> success" and "start -.3-> failure" — then advance() picks randomly with 70/30 odds. You cannot influence the outcome. Do not mix probabilistic exits with other kinds from the same state.\nChaining: "A -> B -> C" creates multiple transitions at once.\nNOTE: the state named "end" is automatically marked terminal. For other terminal states, use mark_terminal() after creating them. The response includes "warnings" for the whole graph: advisory problems with the graph (probabilistic weights not summing to 1.0, a state with several deterministic exits, a state mixing probabilistic and other exits, a non-terminal dead end, no reachable terminal state). They do not block the edit, but fix them before running sessions.',
    inputSchema: { type: 'object', required: ['workflow_name', 'transition'], properties: { workflow_name: { type: 'string' }, transition: { type: 'string', description: 'e.g. "start -> review", "review -approved-> done", "start -.7-> pass -> end"' } } },
  },
  remove_transition: {
    description: 'Remove an existing transition from a workflow procedure. Use the same format as add_transition: "from_state -> to_state". The response includes "warnings": advisory problems with the graph (probabilistic weights not summing to 1.0, a state with several deterministic exits, a state mixing probabilistic and other exits, a non-terminal dead end, no reachable terminal state). They are advisory only.',
    inputSchema: { type: 'object', required: ['workflow_name', 'transition'], properties: { workflow_name: { type: 'string' }, transition: { type: 'string' } } },
  },
  set_transition_requirements: {
    description: 'Require session data before a transition can be taken, so an agent has to record evidence of the work (a PR link, a ticket id, a decision) instead of just declaring completed_action. transition names ONE existing transition exactly as it was added (e.g. "review -approved-> merged"; no chains). requires lists session-data keys (at most 20; letters, digits, "_", "." and "-") that must each have a value that is not null or a blank string; advance() along that transition otherwise fails with MISSING_REQUIRED_DATA (listing the missing keys) and changes nothing. The agent can pass the keys in the same advance call\'s "data". Pass requires: [] to remove the requirement. The requirement is shown as "requires" on the transition in procedure() and in nextTransitions. Pinned sessions keep the requirements of their snapshot. The response is the updated graph plus "warnings".',
    inputSchema: { type: 'object', required: ['workflow_name', 'transition', 'requires'], properties: { workflow_name: { type: 'string' }, transition: { type: 'string', description: 'One existing transition, e.g. "review -approved-> merged"' }, requires: { type: 'array', items: { type: 'string' }, description: 'Session-data keys that must have a value before the transition can be taken; [] clears the requirement.' } } },
  },
  procedure_stats: {
    description: 'Per-state statistics of a workflow procedure, computed from the event logs of your sessions of it (the newest 1000). Use it to find the step where runs stall or backtrack, then improve that state\'s description or transitions. Returns { workflow, sessionsAnalyzed, truncated, totals: { sessions, completed, active }, states: [{ state, entered, currentlyHere, exits: [{ to, action, count }], resetsAway, avgDwellMs }] }: a state with many sessions currentlyHere and a long avgDwellMs is where runs stall; many resetsAway or exits back to earlier states show backtracking. Sessions older than the event log count only in totals, currentlyHere and entered.',
    inputSchema: { type: 'object', required: ['workflow_name'], properties: { workflow_name: { type: 'string' } } },
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
    description: 'Start a new eliph session — a single live instance of a workflow procedure running through its states. Every session starts at the "start" state. Returns a session_id you must keep to call advance(), etc. Use this when beginning a new instance of a process (e.g. a new approval request, a new onboarding run). The response already contains the state description (stateDescription), whether it is terminal (isTerminal) and the next transitions (nextTransitions) of the resulting state, so separate current_state()/next_transitions() calls are unnecessary. Session data is a JSON object (max 64 KB) that persists with the session: store what you gathered (ids, links, decisions) so the work can be resumed in a later conversation. Pass initial data with "data". The response includes "warnings" about the workflow graph (e.g. ambiguous exits, dead ends, weights not summing to 1.0, no reachable terminal state); the session is still created, but such problems can make advance() fail later. To resume earlier work, use list_sessions() instead of creating a new session. Pass pin: true only for long-running or audited runs that must keep the procedure exactly as it is now.',
    inputSchema: { type: 'object', required: ['workflow_name'], properties: { workflow_name: { type: 'string' }, data: { type: 'object', additionalProperties: true, description: 'Optional initial session data (JSON object, max 64 KB), e.g. ids and links for the work this session tracks.' }, pin: { type: 'boolean', description: 'Optional, default false. By default a session follows the live procedure, so fixes to the workflow apply to running sessions immediately; keep that default for normal work. Pass true for long-running or audited runs that must not change underfoot: the session then runs against a snapshot of the procedure taken now, unaffected by later edits or by deleting the procedure (responses then include "pinned": true).' } } },
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
    description: 'List the transitions available from the current state of a session (only session_id is needed). Each result includes an "advance_with" field telling you exactly what to pass to advance(). For symbolic transitions this is { completed_action: "action_name" }; for deterministic it says to call advance() with no argument. A transition with "requires" (a list of session-data keys) can only be taken once each key has a value: pass them in the same advance() call\'s "data" if they are not in the session data yet.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string', description: 'Optional. The session already knows its workflow; if given, it must match the session\'s workflow.' } } },
  },
  advance: {
    description: 'Advance an eliph session to the next state (only session_id is needed; workflow_name is optional). If a transition requires a completed_action, pass it here (the nextTransitions of the previous response tell you which). This is the core operation for driving a workflow forward step by step. The response already contains the state description (stateDescription), whether it is terminal (isTerminal) and the next transitions (nextTransitions) of the resulting state, so separate current_state()/next_transitions() calls are unnecessary. Optionally pass "data" to save what you gathered in this step (shallow-merged into the session data; null removes a key) and a "note" for the event log. If the transition taken lists "requires" (see nextTransitions), each of those session-data keys must have a value (not null or blank) once this call\'s "data" is merged; otherwise advance fails with MISSING_REQUIRED_DATA naming the missing keys and nothing changes, so pass them in "data" in the same call. Session data is a JSON object (max 64 KB) that persists with the session: store what you gathered (ids, links, decisions) so the work can be resumed in a later conversation. Pass expected_state (the state you believe the session is in) when other agents may be working on the same session: if it is in another state the call fails with STATE_MISMATCH and nothing changes, so the same step is never applied twice; call current_state() to see where it is now. Pass "actor" to record who did it in the event log.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string', description: 'Optional. The session already knows its workflow; if given, it must match the session\'s workflow.' }, completed_action: { type: 'string', description: 'The action that was completed to enable this transition (if required)' }, data: { type: 'object', additionalProperties: true, description: 'Optional. Patch shallow-merged into the session data; a key set to null removes it. Store what you gathered (ids, links, decisions) so the work can be resumed later.' }, note: { type: 'string', maxLength: 2000, description: 'Optional. Short note recorded in the session event log (max 2000 characters), e.g. why this step was taken.' }, expected_state: expectedStateProp, actor: actorProp } },
  },
  reset_state: {
    description: 'Reset an eliph session back to a previous state (defaults to "start"). Only session_id is needed. Use this to restart a workflow from the beginning or roll back to a specific state after an error or rejection. The response already contains the state description (stateDescription), whether it is terminal (isTerminal) and the next transitions (nextTransitions) of the resulting state, so separate current_state()/next_transitions() calls are unnecessary. Optionally pass "data" (shallow-merged into the session data; null removes a key) and a "note" explaining the reset for the event log. Session data is a JSON object (max 64 KB) that persists with the session: store what you gathered (ids, links, decisions) so the work can be resumed in a later conversation. Pass expected_state (the state you believe the session is in) when other agents may be working on the same session: if it is in another state the call fails with STATE_MISMATCH and nothing changes, so the same step is never applied twice; call current_state() to see where it is now. Pass "actor" to record who did it in the event log.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string', description: 'Optional. The session already knows its workflow; if given, it must match the session\'s workflow.' }, target_state: { type: 'string', description: 'State to reset to (default: start)' }, data: { type: 'object', additionalProperties: true, description: 'Optional. Patch shallow-merged into the session data; a key set to null removes it. Store what you gathered (ids, links, decisions) so the work can be resumed later.' }, note: { type: 'string', maxLength: 2000, description: 'Optional. Short note recorded in the session event log (max 2000 characters), e.g. why this step was taken.' }, expected_state: expectedStateProp, actor: actorProp } },
  },
  update_session_data: {
    description: 'Merge data into an eliph session without changing its state. Session data is a JSON object (max 64 KB) that persists with the session: store what you gathered (ids, links, decisions) so the work can be resumed in a later conversation. The patch is shallow-merged: top-level keys replace existing ones and a key set to null is removed. Returns the session with its full data and the step context of its current state.',
    inputSchema: { type: 'object', required: ['session_id', 'data'], properties: { session_id: { type: 'string' }, data: { type: 'object', additionalProperties: true, description: 'Patch shallow-merged into the session data; a key set to null removes it.' } } },
  },
  list_sessions: {
    description: 'List your eliph sessions, newest first: { id, workflowName, currentState, createdAt, updatedAt, isTerminal, pinned }[]. Use this to find a session to resume in a new conversation, then call current_state(session_id) to read its data and event log. Filter by workflow_name and by active (true = not finished; unpinned sessions whose workflow was deleted are never active). Sessions that are runs of a job also have jobId and label; pass job_id to list only the runs of that job (job_status gives the same runs with a summary).',
    inputSchema: { type: 'object', properties: { workflow_name: { type: 'string', description: 'Optional. Only sessions of this workflow.' }, active: { type: 'boolean', description: 'Optional. true: only sessions not yet in a terminal state; false: only finished ones.' }, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Optional. Maximum number of sessions (default 50, max 200).' }, job_id: { type: 'string', description: 'Optional. Only the runs of this job (the jobId returned by create_job).' } } },
  },
  requirements: {
    description: 'Returns the symbolic action names required to leave the session\'s current state (only session_id is needed) — i.e. the completed_action values you can pass to advance(). Returns [] if all outgoing transitions are deterministic (no action needed). This is a shorthand for next_transitions filtered to symbolic-only; prefer next_transitions for full context.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' }, workflow_name: { type: 'string', description: 'Optional. The session already knows its workflow; if given, it must match the session\'s workflow.' } } },
  },
  export_workflow: {
    description: 'Turn a procedure into a Claude Code Workflow script that runs it over many items in parallel (one run per item, one agent per state). Use it when the same procedure has to be carried out for several pieces of work at once (several PRs, tickets, files).\n' +
      'How to use it: 1) call export_workflow; 2) pass the returned "script" to the Workflow tool with args { items: [{ label, data }] } ("argsExample" shows the shape; label is a unique name for the piece of work, data is what its agents need to know); 3) when the workflow returns, pass its result\'s "items" unchanged to create_job with the same workflow_name. That one call records every run in eliph and checks each reported path against the procedure. If the result has "batches" (more than 2000 steps in total, see its "warning"), call create_job once per batch instead, each with the items whose labels the batch lists.\n' +
      'Limits: at most 200 items, and one workflow run can make at most 1000 agent calls in total, so a procedure with many states fits fewer items per run ("notes" says how many); the script refuses a batch that cannot fit before any agent starts.\n' +
      'The script does not talk to eliph while it runs, so nothing is recorded until step 3. For LIVE PROGRESS pass live: true instead: 1) create the job first with create_job (items WITHOUT steps); 2) run the script with args { job_id, items }; its agents then record each step with sync_job as they finish it, so job_status shows where every run is while the workflow is still going; 3) when it returns, call sync_job once with its result\'s "job_id" and "items" (not create_job) to add anything an agent failed to record. Live costs one extra tool call per step. Always read "notes": they list caveats of this export (loops and the step limit, states that run without an agent, states with no description).\n' +
      'Returns { workflow, script, argsExample, notes }. Fails with NOT_EXPORTABLE, naming the cause, when the procedure has a probabilistic transition (a script cannot pick an exit at random; make it symbolic), has no "start" state, or has a reachable non-terminal state with no way out (add a transition or mark it terminal).',
    inputSchema: { type: 'object', required: ['workflow_name'], properties: { workflow_name: { type: 'string' }, max_steps: { type: 'integer', minimum: 1, maximum: 200, description: 'Optional. Most steps one item may take before the script stops it (default 25, max 200). Only matters for procedures with loops; raise it if a legitimate run needs more.' }, live: { type: 'boolean', description: 'Optional, default false. true: the script\'s agents record each step in eliph as they finish it (create the job first and pass its job_id in args; finish with sync_job).' } } },
  },
  create_job: {
    description: 'Create a job: a group of eliph sessions ("runs") of the SAME procedure, one per piece of work. Use it instead of create_session when several pieces of work each follow the same procedure (e.g. five PRs to review), especially when different agents handle them in parallel: every piece of work gets its own run, so agents never share or overwrite each other\'s position. Each item needs a "label" (the name of the piece of work, unique inside the job, max 200 characters) and may carry initial "data". At most 200 items.\n' +
      'Each run is an ordinary session: work on it with advance(session_id) and the other session tools, or advance many at once with advance_job. Keep the returned jobId; job_status(jobId) tells you whether the whole job is done.\n' +
      'To record work that ALREADY happened, give an item "steps": the advances it went through, in order ({ completed_action?, data?, note? } each, at most 2000 steps in total). This is how the result of an export_workflow script is recorded: pass its result\'s "items" here unchanged (when that result has "batches", one create_job call per batch). Steps follow the same rules as advance(), so the recorded path is verified against the procedure.\n' +
      'Returns { jobId, workflow, total, done, counts: { <state>: number }, runs: [{ id, label, currentState, isTerminal, updatedAt, error? }], warnings }. A step that is refused (unknown action, MISSING_REQUIRED_DATA, run already terminal) stops THAT run only: the run keeps the steps before it and gets "error" { message, code, missing?, atStep } (atStep counts from 0); the other runs are unaffected. So after create_job, check "done" and look for runs with "error". If the request itself is invalid (unknown workflow, no items, duplicate or empty labels, too many items or steps, bad data) nothing is created.',
    inputSchema: {
      type: 'object',
      required: ['workflow_name', 'items'],
      properties: {
        workflow_name: { type: 'string' },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          description: 'One entry per piece of work, e.g. [{ "label": "PR 41", "data": { "pr_url": "..." } }, { "label": "PR 42" }].',
          items: {
            type: 'object',
            required: ['label'],
            properties: {
              label: { type: 'string', maxLength: 200, description: 'Name of the piece of work, unique inside the job.' },
              data: { type: 'object', additionalProperties: true, description: 'Optional initial session data of this run (JSON object, max 64 KB).' },
              steps: {
                type: 'array',
                description: 'Optional. Advances this piece of work already went through, applied in order right after the run is created.',
                items: { type: 'object', properties: { completed_action: stepActionProp, data: stepDataProp, note: stepNoteProp } },
              },
            },
          },
        },
        pin: { type: 'boolean', description: 'Optional, default false. true pins every run to a snapshot of the procedure as it is now (see create_session).' },
        actor: actorProp,
      },
    },
  },
  job_status: {
    description: 'The one call that answers "is the whole job done?". Returns { jobId, workflow, total, done, counts: { <state>: number }, runs: [{ id, label, currentState, isTerminal, updatedAt }] }: "done" is true when every run is in a terminal state, "counts" says how many runs are in each state, and "runs" shows where each piece of work is. Use it to wait for parallel agents, to find the runs that are stuck, or to resume a job in a later conversation; call current_state(id) on a run for its data and event log.',
    inputSchema: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string', description: 'The jobId returned by create_job.' } } },
  },
  advance_job: {
    description: 'Advance several runs of a job in one call. Each step names its run by "label" (or "session_id") and otherwise works like advance(): completed_action for a symbolic transition, optional data and note. Steps are applied in order, and several steps for the same run are allowed (to move one run several states forward). At most 2000 steps.\n' +
      'Set expected_state on a step (the state you believe that run is in) whenever another agent may be advancing the same run: if the run is somewhere else the step is refused with STATE_MISMATCH and the run is not moved, so a step two workers both report is applied only once.\n' +
      'Returns the job summary (as job_status) plus "results", one per step in order: { label, id, ok, currentState, error?: { message, code, missing? } }. A refused step does not fail the call or the other steps, so check every "ok". Codes are those of advance() (BAD_REQUEST, MISSING_REQUIRED_DATA, PAYLOAD_TOO_LARGE, STATE_MISMATCH, CONFLICT) plus NOT_FOUND when the job has no such run.',
    inputSchema: {
      type: 'object',
      required: ['job_id', 'steps'],
      properties: {
        job_id: { type: 'string', description: 'The jobId returned by create_job.' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 2000,
          description: 'Steps to apply in order, e.g. [{ "label": "PR 41", "completed_action": "approved", "expected_state": "reviewing" }].',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'The label of the run to advance. Give this or session_id.' },
              session_id: { type: 'string', description: 'The session id of the run to advance. Give this or label.' },
              completed_action: stepActionProp,
              expected_state: { type: 'string', description: 'Optional. The state you believe this run is in; the step is refused with STATE_MISMATCH if it is elsewhere.' },
              data: stepDataProp,
              note: stepNoteProp,
            },
          },
        },
        actor: actorProp,
      },
    },
  },
  sync_job: {
    description: 'Bring runs of a job up to date with the steps reported for them. For each item give the run\'s "label" and "steps": the WHOLE path of that run from the start, in order ({ completed_action?, data?, note? } each). Steps the run has already taken are skipped and only the rest are applied, with the same rules as advance(), so calling it again with the same or a longer list is safe and never applies a step twice.\n' +
      'Use it (a) from inside a live workflow script, when your instructions tell you to record your step, and (b) once after a live export_workflow script returns, with its result\'s "job_id" and "items", to add any step that was not recorded while it ran. For a job that was not created beforehand use create_job with steps instead.\n' +
      'Returns the job summary { jobId, workflow, total, done, counts, runs } plus "results": [{ label, id, ok, currentState, skipped, applied, error? }] one per item. ok is true when the run now holds every reported step. A run whose own path differs from the reported steps is left untouched with error code DIVERGED; a label the job does not have gets NOT_FOUND; a refused step stops that run with the same codes as advance() and "atStep" (from 0). Problems with one item do not affect the others. At most 200 items and 2000 steps per call.',
    inputSchema: {
      type: 'object',
      required: ['job_id', 'items'],
      properties: {
        job_id: { type: 'string', description: 'The jobId returned by create_job.' },
        items: {
          type: 'array',
          description: 'One entry per run to bring up to date.',
          items: {
            type: 'object',
            required: ['label', 'steps'],
            properties: {
              label: { type: 'string', description: 'The label of the run.' },
              steps: {
                type: 'array',
                description: 'Every step of the run so far, in order, from the start.',
                items: {
                  type: 'object',
                  properties: {
                    completed_action: { type: 'string', description: 'The action that was completed; omit for a step with no action.' },
                    data: { type: 'object', additionalProperties: true, description: 'Data the step produced.' },
                    note: { type: 'string', description: 'What was done.' },
                  },
                },
              },
            },
          },
        },
        actor: { type: 'string', maxLength: 200, description: 'Optional. Who is recording the steps.' },
      },
    },
  },
  delete_job: {
    description: 'Delete a job: every run (session) of it that you can access, with its data and event log. Use this to clean up after a job is finished or abandoned. This cannot be undone.',
    inputSchema: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string', description: 'The jobId returned by create_job.' } } },
  },
}

export function buildMcpServer(apiUrl: string, apiKey: string) {
  const client = createClient(apiUrl, apiKey)

  const allTools: Record<string, ToolHandler> = {
    ...makeProcedureTools(client),
    ...makeGraphTools(client),    // includes mark_terminal
    ...makeSessionTools(client),
    ...makeAdvanceTools(client),
    ...makeJobTools(client),
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
