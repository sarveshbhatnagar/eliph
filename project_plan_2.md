# Eliph — Automata-Driven Agent Guidance

## Idea

Use finite automata (state machines) to make AI agents smarter and more procedural. Agents follow deterministic, probabilistic, or action-gated workflows defined as state transition graphs, reducing hallucination and making multi-step tasks reliable and auditable.

Any AI can call Eliph as a tool during execution. It answers questions like:

- "What state am I in?"
- "What are my valid next steps?"
- "What action/tool call do I need to make to advance?"
- "What conditions must be met to transition?"
- "What is the full workflow from here to completion?"

---

## Goals

- Give agents a structured, inspectable execution path instead of free-form reasoning
- Support deterministic transitions (always go to state B from A), probabilistic ones (50% heads, 50% tails), and symbolic ones (must call `check_todo` to advance)
- Allow symbolic transitions to map directly to tool calls, so agents know exactly what to invoke at each step
- Allow workflows to be created, queried, and updated at runtime
- Be provider-agnostic — any LLM or agent framework can call the API

---

## Core Concepts

**Workflow** — a named directed graph of states and transitions (e.g. `coin_flip`, `onboarding_flow`, `code_review`)

**State** — a named node in the graph (e.g. `start`, `reviewing`, `complete`). Reserved names are `start` and `end` telling the `start` state and `end` state.

**Transition** — an edge between states with one of three modes:

- **Deterministic** — always taken (implicit weight 1.0)
- **Probabilistic** — weighted, sampled at runtime (e.g. 0.5 heads / 0.5 tails)
- **Symbolic** — guarded by a named action/tool call (e.g. `check_todo_done`, `check_todo_not_done`). The agent invokes the real tool, inspects the result itself, then declares which symbolic action to advance with. Eliph only validates that the symbol matches a valid transition — it never inspects the raw tool output. Result-based branching is expressed by using distinct symbols per outcome (e.g. `check_todo_done` vs `check_todo_not_done`) rather than by passing results into Eliph.

Transition string format:

```
<from_state> -<weight|action>-> <to_state>
```

Examples:

- Deterministic: `start -> review`
- Probabilistic: `start -.5-> heads`, `start -.5-> tails`
- Symbolic (single outcome): `start -check_todo-> reviewing`
- Symbolic (branching by outcome): `deciding -check_todo_done-> complete`, `deciding -check_todo_not_done-> reviewing`

**Session** — a stateful instance of a workflow being executed by an agent. Tracks current state and history.

**Action** — a named symbol required to traverse a symbolic transition. Eliph returns the valid action symbols from the current state; the agent calls the real tool, interprets the result, then declares the matching symbol to `advance`. Result-based branching is modelled as distinct symbols per outcome (e.g. `check_todo_done` / `check_todo_not_done`) — Eliph never inspects raw tool output.

---

## Function Spec

```
procedures(search_query) -> list[workflow_name]
```

Returns workflow names closest to the search query. Used for discovery.

```
procedure(workflow_name) -> WorkflowGraph
```

Returns the full state/transition graph for a workflow, including transition types and symbolic action names.

Example — a `code_review` workflow where `reviewing` branches based on outcome:

```
start -check_todo-> reviewing
reviewing -.7-> approved
reviewing -.3-> changes_requested
approved -> end
changes_requested -fix_code-> reviewing
```

Here `reviewing` is a branching state: probabilistically it goes to `approved` or `changes_requested`, and `changes_requested` loops back via a symbolic `fix_code` action.

```
create_procedure(workflow_name, description) -> WorkflowGraph
```

Initializes a new workflow with a single `start` state.

```
add_transition(workflow_name, transition_string) -> WorkflowGraph
```

Parses `transition_string` and adds states/edges to the graph. Auto-detects transition type:

- Numeric weight → probabilistic
- Identifier (non-numeric) → symbolic action
- No label → deterministic

Example: `add_transition("review_flow", "start -check_todo-> reviewing")`

```
remove_transition(workflow_name, transition_string) -> WorkflowGraph
```

Removes a specific transition edge from the graph. Uses the same string format as `add_transition`. If either state becomes orphaned (no inbound or outbound transitions) after removal, it is not automatically deleted — use `remove_state` explicitly.

```
remove_state(workflow_name, state_name) -> WorkflowGraph
```

Removes a state and all its inbound and outbound transitions. Rejected if `state_name` is `start` or `end`, or if active sessions are currently in that state.

```
create_session(workflow_name) -> Session
```

Creates a new session for a workflow, initialized at `start`. Returns a `session_id` the agent uses for all subsequent calls.

```
delete_session(session_id) -> void
```

Terminates and removes a session. Should be called when a workflow reaches `end` or is abandoned.

```
list_states(workflow_name) -> list[State]
```

Returns all states in the workflow graph with their names and types (e.g. `start`, `end`, intermediate). Useful for agents that want a full map before beginning execution.

```
current_state(workflow_name, session_id) -> State
```

Returns the current state for a given agent session.

```
next_transitions(workflow_name, session_id) -> list[Transition]
```

Returns all valid transitions from the current state, including type and any required action name. The agent uses this to decide what to do next.

```
advance(workflow_name, session_id, completed_action?) -> State
```

Attempts to move the session forward. For symbolic transitions, `completed_action` is the symbol the agent declares after executing its tool (e.g. `"check_todo_done"`). Eliph validates that the symbol matches a valid outgoing transition from the current state — it never inspects raw tool output. For deterministic and probabilistic transitions, `completed_action` is omitted.

Examples:
- Deterministic: `advance("onboarding", "sess_1")`
- Probabilistic: `advance("coin_flip", "sess_1")`
- Symbolic: `advance("review_flow", "sess_1", "check_todo_done")`

```
reset_state(workflow_name, session_id, target_state?) -> State
```

Resets a session to `target_state`, or to `start` if omitted. Useful for retrying a failed branch without discarding the entire session. Returns the new current state.

```
requirements(workflow_name, state_name) -> list[Requirement]
```

Returns what actions or conditions must be satisfied to leave a given state.

---

## API Spec

### `GET /procedures?q=<search_query>`

Returns matching workflow names and descriptions.

### `GET /procedure/:workflow_name`

Returns the full workflow graph with all states, transitions, types, and action labels.

### `POST /procedure`

Body: `{ workflow_name, description }`

Creates a new workflow.

### `POST /procedure/:workflow_name/transition`

Body: `{ transition: "<transition_string>" }`

Adds a transition (and any implied new states) to the workflow.

### `DELETE /procedure/:workflow_name/transition`

Body: `{ transition: "<transition_string>" }`

Removes a specific transition edge. Orphaned states are left in place.

### `DELETE /procedure/:workflow_name/state/:state_name`

Removes a state and all its transitions. Rejected for `start`/`end` or if any active session is currently in that state.

### `GET /procedure/:workflow_name/states`

Returns all states in the workflow with their names and types.

### `POST /session`

Body: `{ workflow: "<workflow_name>" }`

Creates a new session initialized at `start`. Returns `{ session_id }`.

### `DELETE /session/:session_id`

Terminates and removes a session.

### `GET /session/:session_id/state?workflow=<workflow_name>`

Returns the current state and available next transitions for a session.

### `GET /session/:session_id/next?workflow=<workflow_name>`

Returns the list of next valid transitions, including type (`deterministic`, `probabilistic`, `symbolic`) and `action` name if symbolic.

### `POST /session/:session_id/advance`

Body: `{ workflow: "<workflow_name>", completed_action?: "<action_symbol>" }`

Advances the session to the next state. For symbolic transitions, validates that `completed_action` matches a valid outgoing transition symbol. Raw tool output is never passed or inspected.

### `POST /session/:session_id/reset`

Body: `{ workflow: "<workflow_name>", target_state?: "<state_name>" }`

Resets the session to `target_state`, or to `start` if omitted.

---

## Implementation Plan

1. **Core graph engine** — state/transition data model supporting deterministic, weighted, and symbolic edges
2. **Transition string parser** — detect type from label: numeric → probabilistic, identifier → symbolic, empty → deterministic
3. **Workflow store** — persist workflows (in-memory first, pluggable DB later)
4. **Session store** — track per-session current state and transition history
5. **REST API** — expose all functions above as HTTP endpoints
6. **Search** — fuzzy/semantic match on workflow names and descriptions
7. **Agent tool wrapper** — package as an MCP tool or OpenAI function-call schema; `next_transitions` response tells the agent exactly which tool to call next
8. **Action validation** — for symbolic transitions, verify that `completed_action` symbol matches a valid outgoing transition from the current state; reject otherwise

---

## Open Questions

- Should Eliph enforce that a `completed_action` symbol was declared before `advance` on symbolic transitions, or trust the agent to call `advance` correctly? Trust the agent to call advance correctly
- How are probabilistic transitions sampled — pure random, or seeded per session for reproducibility? (seeded optionally, pure random by default)
- Should workflows be versioned so live agent sessions aren't broken by edits? No for now.
- Auth model — single-tenant for now, or multi-tenant from day one? Multi Tenant
