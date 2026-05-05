# Eliph — Design Spec

**Date:** 2026-05-05
**Status:** Approved

---

## Overview

Eliph is an automata-driven workflow guidance service for AI agents. It models multi-step processes as directed state graphs — with deterministic, probabilistic, and symbolic (action-gated) transitions — and exposes them over a REST API and MCP tool interface. Agents call Eliph to know where they are, what to do next, and how to advance.

---

## Key Decisions

| Decision | Choice | Reason |
|---|---|---|
| Language | TypeScript | Best MCP ecosystem, strong typing, fast to build |
| Persistence | Pluggable (in-memory default) | Ship fast, swap later without changing callers |
| Primary interface | REST API + MCP wrapper | REST is the canonical layer; MCP is a thin adapter on top |
| Auth | API key (Bearer token), single-tenant | Simple, stored in DB, keys manageable at runtime |
| Action symbols | Inlined per transition | No registry overhead; result-branching via distinct symbols |
| Workflow versioning | None — edits apply immediately | Simpler; risk accepted |
| Development approach | Test-driven (TDD) | Tests written before implementation, red-green-refactor |

---

## Architecture

```
eliph/
├── packages/
│   ├── core/               # Pure TypeScript — zero framework deps
│   │   ├── graph/          # WorkflowGraph engine (pure functions)
│   │   ├── session/        # Session lifecycle
│   │   └── store/          # Store interfaces + in-memory implementations
│   ├── server/             # Fastify REST API
│   │   ├── routes/         # One file per resource group
│   │   └── middleware/     # API key auth
│   └── mcp/                # MCP stdio server
│       └── tools/          # One file per tool group
├── package.json            # npm workspaces root
└── tsconfig.json
```

`core` has no knowledge of HTTP or MCP. `server` and `mcp` both depend only on `core` — they never depend on each other. Store instances are constructed once at startup and injected into both servers.

---

## Data Models

```typescript
type TransitionType = 'deterministic' | 'probabilistic' | 'symbolic'

interface Transition {
  from: string
  to: string
  type: TransitionType
  weight?: number   // probabilistic only, 0–1
  action?: string   // symbolic only (e.g. "check_todo_done")
}

interface State {
  name: string
  isTerminal: boolean  // true when name === 'end'
}

interface WorkflowGraph {
  name: string
  description: string
  states: Map<string, State>
  transitions: Transition[]
}

interface Session {
  id: string           // uuid
  workflowName: string
  currentState: string
  history: string[]    // ordered list of states visited
  createdAt: Date
}

interface ApiKey {
  id: string
  key: string          // stored as bcrypt hash
  label: string
  createdAt: Date
}
```

---

## Core Package

### Graph Engine (`core/graph/engine.ts`)

Pure functions — no class, no side effects, no I/O.

| Function | Description |
|---|---|
| `parseTransition(str)` | Parses transition string, auto-detects type: numeric label → probabilistic, identifier → symbolic, no label → deterministic |
| `addTransition(graph, str)` | Returns updated graph with new edge (and implied states) |
| `removeTransition(graph, str)` | Returns updated graph with edge removed; orphaned states left in place |
| `removeState(graph, name)` | Cascades to all inbound/outbound edges; rejects `start`/`end` |
| `getNextTransitions(graph, state)` | Returns valid outgoing transitions from a state |
| `sampleNext(transitions)` | Samples a probabilistic branch by weight |
| `validateGraph(graph)` | Checks: probabilistic weights sum to 1.0, no unreachable states, `start` exists |

**Transition string format:**
```
<from> -<label>-> <to>
```
- No label → deterministic: `start -> review`
- Numeric label → probabilistic: `start -.5-> heads`
- Identifier label → symbolic: `start -check_todo_done-> reviewing`

### Store Interfaces (`core/store/index.ts`)

All methods are async — callers never change when a real DB is swapped in.

```typescript
interface IWorkflowStore {
  get(name: string): Promise<WorkflowGraph | null>
  list(): Promise<string[]>
  search(query: string): Promise<string[]>  // fuzzy match on name + description
  save(graph: WorkflowGraph): Promise<void>
  delete(name: string): Promise<void>
}

interface ISessionStore {
  get(id: string): Promise<Session | null>
  save(session: Session): Promise<void>
  delete(id: string): Promise<void>
  findByState(workflowName: string, state: string): Promise<Session[]>  // used by removeState guard
}

interface IApiKeyStore {
  find(rawKey: string): Promise<ApiKey | null>  // hashes internally before lookup
  create(label: string): Promise<{ rawKey: string; record: ApiKey }>
  delete(id: string): Promise<void>
  list(): Promise<ApiKey[]>
}
```

In-memory implementations live in `core/store/memory/` and satisfy all three interfaces.

---

## Server Package (REST API)

**Framework:** Fastify

**Auth middleware** (`server/middleware/auth.ts`):
Reads `Authorization: Bearer <key>` on every request. Calls `apiKeyStore.find(key)`. Returns `401` if missing or unrecognised. No route handler runs until auth passes.

**Routes:**

| File | Endpoints |
|---|---|
| `routes/keys.ts` | `POST /keys`, `GET /keys`, `DELETE /keys/:id` |
| `routes/procedures.ts` | `GET /procedures?q=`, `GET /procedure/:name`, `POST /procedure`, `POST /procedure/:name/transition`, `DELETE /procedure/:name/transition`, `DELETE /procedure/:name/state/:state` |
| `routes/sessions.ts` | `POST /session`, `DELETE /session/:id`, `GET /session/:id/state`, `GET /session/:id/next`, `POST /session/:id/advance`, `POST /session/:id/reset` |

**Error contract:**
```typescript
{ error: string, code: string }
```

| Status | Condition |
|---|---|
| `400` | Invalid transition string, bad state name, weights don't sum to 1.0, missing `completed_action` on symbolic transition |
| `401` | Missing or invalid API key |
| `404` | Workflow or session not found |
| `409` | Attempt to remove `start`/`end`, or remove a state with active sessions |

**Advance logic:**
- Deterministic: moves to the single valid next state
- Probabilistic: calls `sampleNext` internally; caller receives the sampled state
- Symbolic: requires `completed_action` string; validates it matches a valid outgoing transition symbol; rejects with `400` otherwise

---

## MCP Package

**Transport:** stdio (agents spawn Eliph MCP as a subprocess)

**Auth:** API key read once from `ELIPH_API_KEY` env var at startup. Server refuses to start if missing.

**Tool groups:**

| File | Tools |
|---|---|
| `tools/procedures.ts` | `procedures`, `procedure`, `create_procedure` |
| `tools/graph.ts` | `add_transition`, `remove_transition`, `remove_state`, `list_states` |
| `tools/sessions.ts` | `create_session`, `delete_session`, `current_state`, `next_transitions` |
| `tools/advance.ts` | `advance`, `reset_state`, `requirements` |

Each tool maps 1:1 to a core function. No business logic in the MCP layer.

---

## Testing Strategy (TDD)

Tests are written before implementation. Each feature follows red → green → refactor.

### `core` — Unit Tests (Jest)

The graph engine is pure functions — every function gets direct unit tests written first.

**Priority test cases:**
- `parseTransition` — all three types, malformed strings, edge cases
- `validateGraph` — weights not summing to 1.0, orphaned states, missing `start`
- `sampleNext` — distribution over many runs matches weights
- `removeState` — cascade behaviour, rejection of `start`/`end`
- In-memory store implementations — full CRUD correctness

### `server` — Integration Tests (Jest + Fastify inject)

Use Fastify's `inject` to fire requests against a real app instance with in-memory stores. No network, no process startup.

**Priority test cases:**
- Auth rejection: missing key, wrong key, valid key
- Full workflow lifecycle: create procedure → add transitions → create session → advance → delete session
- All `400`/`404`/`409` error conditions

### `mcp` — Smoke Tests

Thin layer — a small set of end-to-end smoke tests covering tool registration and one full workflow call is sufficient. Logic coverage lives in `core`.

**Rule:** No mocks of store interfaces. Tests use the real in-memory implementations.

---

## Open Questions (Resolved)

| Question | Decision |
|---|---|
| Action result validation | Eliph never inspects tool output — agent declares symbol, Eliph validates it matches a valid transition |
| Probabilistic sampling | Pure random (not seeded) |
| Workflow versioning | None — edits apply immediately |
| Auth model | Single-tenant API key |
| Action registry | Inlined per transition — no global registry |
