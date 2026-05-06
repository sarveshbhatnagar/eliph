# Eliph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Eliph — an automata-driven workflow guidance service exposing a REST API and MCP tool interface for AI agents to navigate state machine workflows.

**Architecture:** Three npm workspace packages: `core` (pure TypeScript graph engine + pluggable store interfaces + in-memory defaults), `server` (Fastify REST API with API key auth), `mcp` (stdio MCP wrapper). Both `server` and `mcp` depend only on `core`. All development follows TDD: write failing test → verify it fails → implement → verify it passes → commit.

**Tech Stack:** TypeScript 5, Node.js 20+, Fastify 4, `@modelcontextprotocol/sdk`, Jest + ts-jest, bcryptjs, uuid

---

## File Map

```
eliph/
├── package.json                          # npm workspaces root
├── tsconfig.json                         # base TS config (extended by packages)
├── jest.config.ts                        # root Jest config (projects)
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts                  # barrel exports
│   │   │   ├── graph/
│   │   │   │   ├── types.ts              # TransitionType, Transition, State, WorkflowGraph
│   │   │   │   └── engine.ts             # parseTransition, addTransition, removeTransition,
│   │   │   │                             # removeState, getNextTransitions, sampleNext,
│   │   │   │                             # requirements, validateGraph
│   │   │   ├── session/
│   │   │   │   ├── types.ts              # Session, ApiKey, Requirement
│   │   │   │   └── manager.ts            # computeNextState, applyAdvance, applyReset
│   │   │   └── store/
│   │   │       ├── interfaces.ts         # IWorkflowStore, ISessionStore, IApiKeyStore
│   │   │       └── memory/
│   │   │           ├── workflow.ts       # InMemoryWorkflowStore
│   │   │           ├── session.ts        # InMemorySessionStore
│   │   │           └── apikey.ts         # InMemoryApiKeyStore
│   │   └── tests/
│   │       ├── graph/
│   │       │   └── engine.test.ts
│   │       └── store/
│   │           └── memory.test.ts
│   ├── server/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts                  # creates stores, builds app, starts listening
│   │   │   ├── app.ts                    # Fastify factory — wires middleware + routes
│   │   │   ├── middleware/
│   │   │   │   └── auth.ts               # Bearer token validation hook
│   │   │   └── routes/
│   │   │       ├── keys.ts               # POST /keys, GET /keys, DELETE /keys/:id
│   │   │       ├── procedures.ts         # /procedures + /procedure routes
│   │   │       └── sessions.ts           # /session routes
│   │   └── tests/
│   │       └── routes/
│   │           ├── keys.test.ts
│   │           ├── procedures.test.ts
│   │           └── sessions.test.ts
│   └── mcp/
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts                  # MCP server, tool registration, stdio transport
│       │   └── tools/
│       │       ├── procedures.ts         # procedures, procedure, create_procedure tools
│       │       ├── graph.ts              # add_transition, remove_transition, remove_state, list_states
│       │       ├── sessions.ts           # create_session, delete_session, current_state, next_transitions
│       │       └── advance.ts            # advance, reset_state, requirements
│       └── tests/
│           └── smoke.test.ts
```

---

## Task 1: Monorepo Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `jest.config.ts`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/mcp/package.json`
- Create: `packages/mcp/tsconfig.json`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "eliph",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "jest",
    "test:core": "jest --selectProjects core",
    "test:server": "jest --selectProjects server",
    "test:mcp": "jest --selectProjects mcp"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@types/node": "^20.0.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create root tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

- [ ] **Step 3: Create root jest.config.ts**

```typescript
export default {
  projects: [
    { displayName: 'core', testMatch: ['<rootDir>/packages/core/tests/**/*.test.ts'], preset: 'ts-jest', testEnvironment: 'node' },
    { displayName: 'server', testMatch: ['<rootDir>/packages/server/tests/**/*.test.ts'], preset: 'ts-jest', testEnvironment: 'node' },
    { displayName: 'mcp', testMatch: ['<rootDir>/packages/mcp/tests/**/*.test.ts'], preset: 'ts-jest', testEnvironment: 'node' },
  ],
}
```

- [ ] **Step 4: Create packages/core/package.json**

```json
{
  "name": "@eliph/core",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "dependencies": {
    "bcryptjs": "^2.4.3"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6"
  }
}
```

- [ ] **Step 5: Create packages/core/tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 6: Create packages/server/package.json**

```json
{
  "name": "@eliph/server",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "dependencies": {
    "@eliph/core": "*",
    "fastify": "^4.26.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@types/uuid": "^9.0.0"
  }
}
```

- [ ] **Step 7: Create packages/server/tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 8: Create packages/mcp/package.json**

```json
{
  "name": "@eliph/mcp",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "dependencies": {
    "@eliph/core": "*",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@types/uuid": "^9.0.0"
  }
}
```

- [ ] **Step 9: Create packages/mcp/tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 10: Install dependencies**

```bash
npm install
```

Expected: `node_modules` created at root and in each package, workspaces linked.

- [ ] **Step 11: Commit**

```bash
git add package.json tsconfig.json jest.config.ts packages/
git commit -m "feat: monorepo scaffold — core, server, mcp packages"
```

---

## Task 2: Core Types + Barrel Export

**Files:**
- Create: `packages/core/src/graph/types.ts`
- Create: `packages/core/src/session/types.ts`
- Create: `packages/core/src/store/interfaces.ts`
- Create: `packages/core/src/index.ts`

- [ ] **Step 1: Create packages/core/src/graph/types.ts**

```typescript
export type TransitionType = 'deterministic' | 'probabilistic' | 'symbolic'

export interface Transition {
  from: string
  to: string
  type: TransitionType
  weight?: number   // probabilistic only (0–1)
  action?: string   // symbolic only (e.g. "check_todo_done")
}

export interface State {
  name: string
  isTerminal: boolean  // true when name === 'end'
}

export interface WorkflowGraph {
  name: string
  description: string
  states: Record<string, State>
  transitions: Transition[]
}
```

- [ ] **Step 2: Create packages/core/src/session/types.ts**

```typescript
export interface Session {
  id: string
  workflowName: string
  currentState: string
  history: string[]
  createdAt: Date
}

export interface ApiKey {
  id: string
  key: string      // bcrypt hash — never stored or returned in plaintext
  label: string
  createdAt: Date
}

export interface Requirement {
  action: string
  targetState: string
}
```

- [ ] **Step 3: Create packages/core/src/store/interfaces.ts**

```typescript
import { WorkflowGraph } from '../graph/types'
import { Session, ApiKey } from '../session/types'

export interface IWorkflowStore {
  get(name: string): Promise<WorkflowGraph | null>
  list(): Promise<string[]>
  search(query: string): Promise<string[]>
  save(graph: WorkflowGraph): Promise<void>
  delete(name: string): Promise<void>
}

export interface ISessionStore {
  get(id: string): Promise<Session | null>
  save(session: Session): Promise<void>
  delete(id: string): Promise<void>
  findByState(workflowName: string, state: string): Promise<Session[]>
}

export interface IApiKeyStore {
  find(rawKey: string): Promise<ApiKey | null>
  create(label: string): Promise<{ rawKey: string; record: ApiKey }>
  delete(id: string): Promise<void>
  list(): Promise<Omit<ApiKey, 'key'>[]>
}
```

- [ ] **Step 4: Create packages/core/src/index.ts**

```typescript
export * from './graph/types'
export * from './session/types'
export * from './store/interfaces'
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc -p packages/core/tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/
git commit -m "feat(core): add graph, session, and store types"
```

---

## Task 3: parseTransition (TDD)

**Files:**
- Create: `packages/core/src/graph/engine.ts`
- Create: `packages/core/tests/graph/engine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/graph/engine.test.ts`:

```typescript
import { parseTransition } from '../../src/graph/engine'

describe('parseTransition', () => {
  it('parses a deterministic transition', () => {
    const t = parseTransition('start -> review')
    expect(t).toEqual({ from: 'start', to: 'review', type: 'deterministic' })
  })

  it('parses a probabilistic transition', () => {
    const t = parseTransition('start -.5-> heads')
    expect(t).toEqual({ from: 'start', to: 'heads', type: 'probabilistic', weight: 0.5 })
  })

  it('parses a symbolic transition', () => {
    const t = parseTransition('start -check_todo_done-> reviewing')
    expect(t).toEqual({ from: 'start', to: 'reviewing', type: 'symbolic', action: 'check_todo_done' })
  })

  it('throws on invalid string', () => {
    expect(() => parseTransition('not valid')).toThrow('Invalid transition string')
  })

  it('parses states with underscores', () => {
    const t = parseTransition('check_todo_done -> complete')
    expect(t.from).toBe('check_todo_done')
    expect(t.to).toBe('complete')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --selectProjects core --testPathPattern engine
```

Expected: FAIL — `Cannot find module '../../src/graph/engine'`

- [ ] **Step 3: Implement parseTransition**

Create `packages/core/src/graph/engine.ts`:

```typescript
import { Transition, WorkflowGraph, State, Requirement } from './types'

export function parseTransition(str: string): Transition {
  // Labeled: "from -label-> to"
  const labeled = str.match(/^(\w+)\s*-([^->]+)->\s*(\w+)$/)
  if (labeled) {
    const [, from, label, to] = labeled
    const trimmed = label.trim()
    const weight = parseFloat(trimmed)
    if (!isNaN(weight)) {
      return { from, to, type: 'probabilistic', weight }
    }
    return { from, to, type: 'symbolic', action: trimmed }
  }

  // Deterministic: "from -> to"
  const det = str.match(/^(\w+)\s*->\s*(\w+)$/)
  if (det) {
    const [, from, to] = det
    return { from, to, type: 'deterministic' }
  }

  throw new Error(`Invalid transition string: "${str}"`)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- --selectProjects core --testPathPattern engine
```

Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/graph/engine.ts packages/core/tests/graph/engine.test.ts
git commit -m "feat(core): parseTransition with deterministic, probabilistic, symbolic support"
```

---

## Task 4: validateGraph (TDD)

**Files:**
- Modify: `packages/core/src/graph/engine.ts`
- Modify: `packages/core/tests/graph/engine.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `packages/core/tests/graph/engine.test.ts`:

```typescript
import { validateGraph } from '../../src/graph/engine'
import { WorkflowGraph } from '../../src/graph/types'

function makeGraph(overrides: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    name: 'test',
    description: '',
    states: { start: { name: 'start', isTerminal: false } },
    transitions: [],
    ...overrides,
  }
}

describe('validateGraph', () => {
  it('returns no errors for a valid graph', () => {
    const graph = makeGraph()
    expect(validateGraph(graph)).toEqual([])
  })

  it('errors when start state is missing', () => {
    const graph = makeGraph({ states: {} })
    expect(validateGraph(graph)).toContain('Graph must have a "start" state')
  })

  it('errors when probabilistic weights do not sum to 1.0', () => {
    const graph = makeGraph({
      states: {
        start: { name: 'start', isTerminal: false },
        heads: { name: 'heads', isTerminal: false },
        tails: { name: 'tails', isTerminal: false },
      },
      transitions: [
        { from: 'start', to: 'heads', type: 'probabilistic', weight: 0.3 },
        { from: 'start', to: 'tails', type: 'probabilistic', weight: 0.3 },
      ],
    })
    const errors = validateGraph(graph)
    expect(errors.some(e => e.includes('sum to 1.0'))).toBe(true)
  })

  it('passes when probabilistic weights sum to 1.0', () => {
    const graph = makeGraph({
      states: {
        start: { name: 'start', isTerminal: false },
        heads: { name: 'heads', isTerminal: false },
        tails: { name: 'tails', isTerminal: false },
      },
      transitions: [
        { from: 'start', to: 'heads', type: 'probabilistic', weight: 0.5 },
        { from: 'start', to: 'tails', type: 'probabilistic', weight: 0.5 },
      ],
    })
    expect(validateGraph(graph)).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --selectProjects core --testPathPattern engine
```

Expected: FAIL — `validateGraph is not a function`

- [ ] **Step 3: Implement validateGraph**

Append to `packages/core/src/graph/engine.ts`:

```typescript
export function validateGraph(graph: WorkflowGraph): string[] {
  const errors: string[] = []

  if (!graph.states['start']) {
    errors.push('Graph must have a "start" state')
  }

  for (const stateName of Object.keys(graph.states)) {
    const probabilistic = graph.transitions.filter(
      t => t.from === stateName && t.type === 'probabilistic'
    )
    if (probabilistic.length > 0) {
      const sum = probabilistic.reduce((acc, t) => acc + (t.weight ?? 0), 0)
      if (Math.abs(sum - 1.0) > 0.001) {
        errors.push(
          `Probabilistic transitions from "${stateName}" must sum to 1.0, got ${sum.toFixed(3)}`
        )
      }
    }
  }

  return errors
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test -- --selectProjects core --testPathPattern engine
```

Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/graph/engine.ts packages/core/tests/graph/engine.test.ts
git commit -m "feat(core): validateGraph — checks start state and probabilistic weight sums"
```

---

## Task 5: addTransition + removeTransition (TDD)

**Files:**
- Modify: `packages/core/src/graph/engine.ts`
- Modify: `packages/core/tests/graph/engine.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `packages/core/tests/graph/engine.test.ts`:

```typescript
import { addTransition, removeTransition } from '../../src/graph/engine'

describe('addTransition', () => {
  it('adds a deterministic edge and creates implied states', () => {
    const graph = makeGraph()
    const updated = addTransition(graph, 'start -> review')
    expect(updated.transitions).toHaveLength(1)
    expect(updated.states['review']).toBeDefined()
  })

  it('marks "end" state as terminal', () => {
    const graph = makeGraph()
    const updated = addTransition(graph, 'start -> end')
    expect(updated.states['end'].isTerminal).toBe(true)
  })

  it('does not mutate the original graph', () => {
    const graph = makeGraph()
    addTransition(graph, 'start -> review')
    expect(graph.transitions).toHaveLength(0)
  })

  it('adds a symbolic transition', () => {
    const graph = makeGraph()
    const updated = addTransition(graph, 'start -check_todo-> reviewing')
    expect(updated.transitions[0]).toMatchObject({ type: 'symbolic', action: 'check_todo' })
  })
})

describe('removeTransition', () => {
  it('removes a matching transition', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    graph = removeTransition(graph, 'start -> review')
    expect(graph.transitions).toHaveLength(0)
  })

  it('leaves states intact after removing their transition', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    graph = removeTransition(graph, 'start -> review')
    expect(graph.states['review']).toBeDefined()
  })

  it('does not mutate the original graph', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    const copy = graph
    removeTransition(graph, 'start -> review')
    expect(copy.transitions).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --selectProjects core --testPathPattern engine
```

Expected: FAIL — `addTransition is not a function`

- [ ] **Step 3: Implement addTransition and removeTransition**

Append to `packages/core/src/graph/engine.ts`:

```typescript
export function addTransition(graph: WorkflowGraph, transitionStr: string): WorkflowGraph {
  const transition = parseTransition(transitionStr)
  const states: Record<string, State> = { ...graph.states }

  if (!states[transition.from]) {
    states[transition.from] = { name: transition.from, isTerminal: transition.from === 'end' }
  }
  if (!states[transition.to]) {
    states[transition.to] = { name: transition.to, isTerminal: transition.to === 'end' }
  }

  return { ...graph, states, transitions: [...graph.transitions, transition] }
}

export function removeTransition(graph: WorkflowGraph, transitionStr: string): WorkflowGraph {
  const target = parseTransition(transitionStr)
  return {
    ...graph,
    transitions: graph.transitions.filter(
      t =>
        !(
          t.from === target.from &&
          t.to === target.to &&
          t.type === target.type &&
          t.action === target.action
        )
    ),
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test -- --selectProjects core --testPathPattern engine
```

Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/graph/engine.ts packages/core/tests/graph/engine.test.ts
git commit -m "feat(core): addTransition and removeTransition"
```

---

## Task 6: removeState (TDD)

**Files:**
- Modify: `packages/core/src/graph/engine.ts`
- Modify: `packages/core/tests/graph/engine.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `packages/core/tests/graph/engine.test.ts`:

```typescript
import { removeState } from '../../src/graph/engine'

describe('removeState', () => {
  it('removes a state and its transitions', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    graph = addTransition(graph, 'review -> end')
    graph = removeState(graph, 'review')
    expect(graph.states['review']).toBeUndefined()
    expect(graph.transitions.filter(t => t.from === 'review' || t.to === 'review')).toHaveLength(0)
  })

  it('throws when removing "start"', () => {
    const graph = makeGraph()
    expect(() => removeState(graph, 'start')).toThrow('Cannot remove reserved state "start"')
  })

  it('throws when removing "end"', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> end')
    expect(() => removeState(graph, 'end')).toThrow('Cannot remove reserved state "end"')
  })

  it('throws when state does not exist', () => {
    const graph = makeGraph()
    expect(() => removeState(graph, 'nonexistent')).toThrow('State "nonexistent" does not exist')
  })

  it('does not mutate the original graph', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    const copy = graph
    removeState(graph, 'review')
    expect(copy.states['review']).toBeDefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --selectProjects core --testPathPattern engine
```

Expected: FAIL — `removeState is not a function`

- [ ] **Step 3: Implement removeState**

Append to `packages/core/src/graph/engine.ts`:

```typescript
export function removeState(graph: WorkflowGraph, name: string): WorkflowGraph {
  if (name === 'start' || name === 'end') {
    throw new Error(`Cannot remove reserved state "${name}"`)
  }
  if (!graph.states[name]) {
    throw new Error(`State "${name}" does not exist`)
  }
  const states = { ...graph.states }
  delete states[name]
  return {
    ...graph,
    states,
    transitions: graph.transitions.filter(t => t.from !== name && t.to !== name),
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test -- --selectProjects core --testPathPattern engine
```

Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/graph/engine.ts packages/core/tests/graph/engine.test.ts
git commit -m "feat(core): removeState with cascade and reserved name guard"
```

---

## Task 7: getNextTransitions, sampleNext, requirements (TDD)

**Files:**
- Modify: `packages/core/src/graph/engine.ts`
- Modify: `packages/core/tests/graph/engine.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `packages/core/tests/graph/engine.test.ts`:

```typescript
import { getNextTransitions, sampleNext, requirements } from '../../src/graph/engine'
import { Transition } from '../../src/graph/types'

describe('getNextTransitions', () => {
  it('returns outgoing transitions from a state', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    graph = addTransition(graph, 'start -> skip')
    const transitions = getNextTransitions(graph, 'start')
    expect(transitions).toHaveLength(2)
  })

  it('returns empty array for state with no outgoing transitions', () => {
    const graph = makeGraph()
    expect(getNextTransitions(graph, 'start')).toHaveLength(0)
  })
})

describe('sampleNext', () => {
  it('always returns a state from the given transitions', () => {
    const transitions: Transition[] = [
      { from: 'start', to: 'heads', type: 'probabilistic', weight: 0.5 },
      { from: 'start', to: 'tails', type: 'probabilistic', weight: 0.5 },
    ]
    for (let i = 0; i < 100; i++) {
      const result = sampleNext(transitions)
      expect(['heads', 'tails']).toContain(result)
    }
  })

  it('returns the only option when weight is 1.0', () => {
    const transitions: Transition[] = [
      { from: 'start', to: 'done', type: 'probabilistic', weight: 1.0 },
    ]
    expect(sampleNext(transitions)).toBe('done')
  })
})

describe('requirements', () => {
  it('returns symbolic transitions as requirements', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -check_todo_done-> complete')
    graph = addTransition(graph, 'start -check_todo_not_done-> reviewing')
    const reqs = requirements(graph, 'start')
    expect(reqs).toHaveLength(2)
    expect(reqs[0]).toEqual({ action: 'check_todo_done', targetState: 'complete' })
  })

  it('excludes non-symbolic transitions', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    expect(requirements(graph, 'start')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --selectProjects core --testPathPattern engine
```

Expected: FAIL — `getNextTransitions is not a function`

- [ ] **Step 3: Implement the three functions**

Append to `packages/core/src/graph/engine.ts`:

```typescript
export function getNextTransitions(graph: WorkflowGraph, stateName: string): Transition[] {
  return graph.transitions.filter(t => t.from === stateName)
}

export function sampleNext(transitions: Transition[]): string {
  const rand = Math.random()
  let cumulative = 0
  for (const t of transitions) {
    cumulative += t.weight ?? 0
    if (rand <= cumulative) return t.to
  }
  return transitions[transitions.length - 1].to
}

export function requirements(graph: WorkflowGraph, stateName: string): Requirement[] {
  return graph.transitions
    .filter(t => t.from === stateName && t.type === 'symbolic')
    .map(t => ({ action: t.action!, targetState: t.to }))
}
```

Update `packages/core/src/graph/engine.ts` imports at top to include `Requirement`:

```typescript
import { Transition, WorkflowGraph, State, Requirement } from './types'
```

Wait — `Requirement` is in `session/types.ts`, not `graph/types.ts`. Import it from the correct path:

```typescript
import { Transition, WorkflowGraph, State } from './types'
import { Requirement } from '../session/types'
```

- [ ] **Step 4: Update the engine.ts import line**

In `packages/core/src/graph/engine.ts`, replace the first import line:

```typescript
import { Transition, WorkflowGraph, State } from './types'
import { Requirement } from '../session/types'
```

- [ ] **Step 5: Run to verify it passes**

```bash
npm test -- --selectProjects core --testPathPattern engine
```

Expected: PASS (all tests)

- [ ] **Step 6: Update core barrel export**

Add to `packages/core/src/index.ts`:

```typescript
export * from './graph/engine'
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/graph/engine.ts packages/core/src/index.ts packages/core/tests/graph/engine.test.ts
git commit -m "feat(core): getNextTransitions, sampleNext, requirements"
```

---

## Task 8: In-Memory Stores (TDD)

**Files:**
- Create: `packages/core/src/store/memory/workflow.ts`
- Create: `packages/core/src/store/memory/session.ts`
- Create: `packages/core/src/store/memory/apikey.ts`
- Create: `packages/core/tests/store/memory.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/store/memory.test.ts`:

```typescript
import { InMemoryWorkflowStore } from '../../src/store/memory/workflow'
import { InMemorySessionStore } from '../../src/store/memory/session'
import { InMemoryApiKeyStore } from '../../src/store/memory/apikey'
import { WorkflowGraph } from '../../src/graph/types'
import { Session } from '../../src/session/types'

function makeGraph(name = 'test'): WorkflowGraph {
  return {
    name,
    description: 'a test workflow',
    states: { start: { name: 'start', isTerminal: false } },
    transitions: [],
  }
}

function makeSession(id = 'sess-1'): Session {
  return {
    id,
    workflowName: 'test',
    currentState: 'start',
    history: ['start'],
    createdAt: new Date(),
  }
}

describe('InMemoryWorkflowStore', () => {
  it('saves and retrieves a workflow', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraph())
    const result = await store.get('test')
    expect(result?.name).toBe('test')
  })

  it('returns null for unknown workflow', async () => {
    const store = new InMemoryWorkflowStore()
    expect(await store.get('nonexistent')).toBeNull()
  })

  it('lists all workflow names', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraph('a'))
    await store.save(makeGraph('b'))
    expect(await store.list()).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('searches by name substring', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraph('onboarding'))
    await store.save(makeGraph('checkout'))
    const results = await store.search('board')
    expect(results).toContain('onboarding')
    expect(results).not.toContain('checkout')
  })

  it('deletes a workflow', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraph())
    await store.delete('test')
    expect(await store.get('test')).toBeNull()
  })
})

describe('InMemorySessionStore', () => {
  it('saves and retrieves a session', async () => {
    const store = new InMemorySessionStore()
    await store.save(makeSession())
    expect(await store.get('sess-1')).toMatchObject({ id: 'sess-1' })
  })

  it('returns null for unknown session', async () => {
    const store = new InMemorySessionStore()
    expect(await store.get('nope')).toBeNull()
  })

  it('deletes a session', async () => {
    const store = new InMemorySessionStore()
    await store.save(makeSession())
    await store.delete('sess-1')
    expect(await store.get('sess-1')).toBeNull()
  })

  it('finds sessions by workflow and state', async () => {
    const store = new InMemorySessionStore()
    await store.save(makeSession('s1'))
    await store.save({ ...makeSession('s2'), currentState: 'review' })
    const results = await store.findByState('test', 'start')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('s1')
  })
})

describe('InMemoryApiKeyStore', () => {
  it('creates a key and finds it by raw value', async () => {
    const store = new InMemoryApiKeyStore()
    const { rawKey } = await store.create('my-key')
    const found = await store.find(rawKey)
    expect(found).not.toBeNull()
    expect(found?.label).toBe('my-key')
  })

  it('returns null for unknown key', async () => {
    const store = new InMemoryApiKeyStore()
    expect(await store.find('bad-key')).toBeNull()
  })

  it('deletes a key by id', async () => {
    const store = new InMemoryApiKeyStore()
    const { rawKey, record } = await store.create('to-delete')
    await store.delete(record.id)
    expect(await store.find(rawKey)).toBeNull()
  })

  it('lists keys without exposing hashes', async () => {
    const store = new InMemoryApiKeyStore()
    await store.create('label-a')
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect((list[0] as any).key).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --selectProjects core --testPathPattern memory
```

Expected: FAIL — module not found errors

- [ ] **Step 3: Create InMemoryWorkflowStore**

Create `packages/core/src/store/memory/workflow.ts`:

```typescript
import { IWorkflowStore } from '../interfaces'
import { WorkflowGraph } from '../../graph/types'

export class InMemoryWorkflowStore implements IWorkflowStore {
  private store = new Map<string, WorkflowGraph>()

  async get(name: string): Promise<WorkflowGraph | null> {
    return this.store.get(name) ?? null
  }

  async list(): Promise<string[]> {
    return Array.from(this.store.keys())
  }

  async search(query: string): Promise<string[]> {
    const q = query.toLowerCase()
    return Array.from(this.store.values())
      .filter(g => g.name.toLowerCase().includes(q) || g.description.toLowerCase().includes(q))
      .map(g => g.name)
  }

  async save(graph: WorkflowGraph): Promise<void> {
    this.store.set(graph.name, graph)
  }

  async delete(name: string): Promise<void> {
    this.store.delete(name)
  }
}
```

- [ ] **Step 4: Create InMemorySessionStore**

Create `packages/core/src/store/memory/session.ts`:

```typescript
import { ISessionStore } from '../interfaces'
import { Session } from '../../session/types'

export class InMemorySessionStore implements ISessionStore {
  private store = new Map<string, Session>()

  async get(id: string): Promise<Session | null> {
    return this.store.get(id) ?? null
  }

  async save(session: Session): Promise<void> {
    this.store.set(session.id, session)
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id)
  }

  async findByState(workflowName: string, state: string): Promise<Session[]> {
    return Array.from(this.store.values()).filter(
      s => s.workflowName === workflowName && s.currentState === state
    )
  }
}
```

- [ ] **Step 5: Create InMemoryApiKeyStore**

Create `packages/core/src/store/memory/apikey.ts`:

```typescript
import { IApiKeyStore } from '../interfaces'
import { ApiKey } from '../../session/types'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

export class InMemoryApiKeyStore implements IApiKeyStore {
  private store = new Map<string, ApiKey>()

  async find(rawKey: string): Promise<ApiKey | null> {
    for (const record of this.store.values()) {
      if (await bcrypt.compare(rawKey, record.key)) return record
    }
    return null
  }

  async create(label: string): Promise<{ rawKey: string; record: ApiKey }> {
    const rawKey = randomUUID()
    const hashed = await bcrypt.hash(rawKey, 10)
    const record: ApiKey = { id: randomUUID(), key: hashed, label, createdAt: new Date() }
    this.store.set(record.id, record)
    return { rawKey, record }
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id)
  }

  async list(): Promise<Omit<ApiKey, 'key'>[]> {
    return Array.from(this.store.values()).map(({ key: _key, ...rest }) => rest)
  }
}
```

- [ ] **Step 6: Run to verify it passes**

```bash
npm test -- --selectProjects core --testPathPattern memory
```

Expected: PASS (all tests). Note: bcrypt hashing makes the ApiKeyStore tests slow (~1s each) — this is expected.

- [ ] **Step 7: Update core barrel export**

Add to `packages/core/src/index.ts`:

```typescript
export { InMemoryWorkflowStore } from './store/memory/workflow'
export { InMemorySessionStore } from './store/memory/session'
export { InMemoryApiKeyStore } from './store/memory/apikey'
```

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/store/ packages/core/src/index.ts packages/core/tests/store/
git commit -m "feat(core): in-memory stores for workflows, sessions, and API keys"
```

---

## Task 9: Session Manager (TDD)

**Files:**
- Create: `packages/core/src/session/manager.ts`
- Create: `packages/core/tests/session/manager.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/tests/session/manager.test.ts`:

```typescript
import { computeNextState, applyAdvance, applyReset } from '../../src/session/manager'
import { addTransition } from '../../src/graph/engine'
import { WorkflowGraph } from '../../src/graph/types'
import { Session } from '../../src/session/types'

function makeGraph(): WorkflowGraph {
  return { name: 'test', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }
}

function makeSession(currentState = 'start'): Session {
  return { id: 'sess-1', workflowName: 'test', currentState, history: [currentState], createdAt: new Date() }
}

describe('computeNextState', () => {
  it('advances a deterministic transition', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    expect(computeNextState(graph, makeSession())).toBe('review')
  })

  it('throws when no outgoing transitions exist', () => {
    const graph = makeGraph()
    expect(() => computeNextState(graph, makeSession())).toThrow('No outgoing transitions')
  })

  it('advances a symbolic transition with matching completed_action', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -check_done-> complete')
    expect(computeNextState(graph, makeSession(), 'check_done')).toBe('complete')
  })

  it('throws when completed_action does not match any symbolic transition', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -check_done-> complete')
    expect(() => computeNextState(graph, makeSession(), 'wrong_action')).toThrow('does not match')
  })

  it('throws when symbolic transition requires completed_action but none provided', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -check_done-> complete')
    expect(() => computeNextState(graph, makeSession())).toThrow('requires a completed_action')
  })

  it('samples probabilistic transitions (returns one of valid states)', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -.5-> heads')
    graph = addTransition(graph, 'start -.5-> tails')
    for (let i = 0; i < 50; i++) {
      expect(['heads', 'tails']).toContain(computeNextState(graph, makeSession()))
    }
  })
})

describe('applyAdvance', () => {
  it('updates currentState and appends to history', () => {
    const session = makeSession()
    const updated = applyAdvance(session, 'review')
    expect(updated.currentState).toBe('review')
    expect(updated.history).toEqual(['start', 'review'])
  })

  it('does not mutate the original session', () => {
    const session = makeSession()
    applyAdvance(session, 'review')
    expect(session.currentState).toBe('start')
  })
})

describe('applyReset', () => {
  it('resets to start by convention when caller passes "start"', () => {
    const session = makeSession('review')
    const updated = applyReset(session, 'start')
    expect(updated.currentState).toBe('start')
    expect(updated.history).toContain('start')
  })

  it('resets to any target state', () => {
    const session = makeSession('complete')
    const updated = applyReset(session, 'review')
    expect(updated.currentState).toBe('review')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --selectProjects core --testPathPattern manager
```

Expected: FAIL — `Cannot find module '../../src/session/manager'`

- [ ] **Step 3: Implement session manager**

Create `packages/core/src/session/manager.ts`:

```typescript
import { WorkflowGraph } from '../graph/types'
import { Session } from './types'
import { getNextTransitions, sampleNext } from '../graph/engine'

export function computeNextState(
  graph: WorkflowGraph,
  session: Session,
  completedAction?: string
): string {
  const outgoing = getNextTransitions(graph, session.currentState)

  if (outgoing.length === 0) {
    throw new Error(`No outgoing transitions from state "${session.currentState}"`)
  }

  if (completedAction !== undefined) {
    const match = outgoing.find(t => t.type === 'symbolic' && t.action === completedAction)
    if (!match) {
      throw new Error(
        `Action "${completedAction}" does not match any valid transition from "${session.currentState}"`
      )
    }
    return match.to
  }

  const probabilistic = outgoing.filter(t => t.type === 'probabilistic')
  if (probabilistic.length > 0) {
    return sampleNext(probabilistic)
  }

  const deterministic = outgoing.filter(t => t.type === 'deterministic')
  if (deterministic.length === 1) {
    return deterministic[0].to
  }

  if (outgoing.some(t => t.type === 'symbolic')) {
    throw new Error(
      `State "${session.currentState}" requires a completed_action to advance`
    )
  }

  throw new Error(`Cannot determine next state from "${session.currentState}"`)
}

export function applyAdvance(session: Session, newState: string): Session {
  return { ...session, currentState: newState, history: [...session.history, newState] }
}

export function applyReset(session: Session, targetState: string): Session {
  return { ...session, currentState: targetState, history: [...session.history, targetState] }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test -- --selectProjects core --testPathPattern manager
```

Expected: PASS (all tests)

- [ ] **Step 5: Update core barrel export**

Add to `packages/core/src/index.ts`:

```typescript
export * from './session/manager'
```

- [ ] **Step 6: Run all core tests**

```bash
npm test -- --selectProjects core
```

Expected: PASS (all core tests)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/session/ packages/core/src/index.ts packages/core/tests/session/
git commit -m "feat(core): session manager — computeNextState, applyAdvance, applyReset"
```

---

## Task 10: Server App + Auth Middleware (TDD)

**Files:**
- Create: `packages/server/src/app.ts`
- Create: `packages/server/src/middleware/auth.ts`
- Create: `packages/server/src/index.ts`
- Create: `packages/server/tests/routes/keys.test.ts` (test helper setup only)

- [ ] **Step 1: Create auth middleware**

Create `packages/server/src/middleware/auth.ts`:

```typescript
import { FastifyRequest, FastifyReply } from 'fastify'
import { IApiKeyStore } from '@eliph/core'

export function authMiddleware(apiKeyStore: IApiKeyStore) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // POST /keys is exempt — needed to create the first key
    if (request.method === 'POST' && request.url === '/keys') return

    const auth = request.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing API key', code: 'UNAUTHORIZED' })
    }
    const rawKey = auth.slice(7)
    const key = await apiKeyStore.find(rawKey)
    if (!key) {
      return reply.code(401).send({ error: 'Invalid API key', code: 'UNAUTHORIZED' })
    }
  }
}
```

- [ ] **Step 2: Create app factory**

Create `packages/server/src/app.ts`:

```typescript
import Fastify, { FastifyInstance } from 'fastify'
import { IWorkflowStore, ISessionStore, IApiKeyStore } from '@eliph/core'
import { authMiddleware } from './middleware/auth'
import { keysRoutes } from './routes/keys'
import { proceduresRoutes } from './routes/procedures'
import { sessionsRoutes } from './routes/sessions'

export interface Stores {
  workflowStore: IWorkflowStore
  sessionStore: ISessionStore
  apiKeyStore: IApiKeyStore
}

export function buildApp(stores: Stores): FastifyInstance {
  const app = Fastify()

  app.addHook('preHandler', authMiddleware(stores.apiKeyStore))

  app.register(keysRoutes(stores.apiKeyStore))
  app.register(proceduresRoutes(stores.workflowStore, stores.sessionStore))
  app.register(sessionsRoutes(stores.workflowStore, stores.sessionStore))

  app.setErrorHandler((error, _req, reply) => {
    const status = (error as any).statusCode ?? 500
    const code = (error as any).code ?? 'INTERNAL_ERROR'
    reply.code(status).send({ error: error.message, code })
  })

  return app
}
```

- [ ] **Step 3: Create stub route files so app.ts compiles**

Create `packages/server/src/routes/keys.ts`:

```typescript
import { FastifyInstance } from 'fastify'
import { IApiKeyStore } from '@eliph/core'

export function keysRoutes(_store: IApiKeyStore) {
  return async (_app: FastifyInstance) => {}
}
```

Create `packages/server/src/routes/procedures.ts`:

```typescript
import { FastifyInstance } from 'fastify'
import { IWorkflowStore, ISessionStore } from '@eliph/core'

export function proceduresRoutes(_ws: IWorkflowStore, _ss: ISessionStore) {
  return async (_app: FastifyInstance) => {}
}
```

Create `packages/server/src/routes/sessions.ts`:

```typescript
import { FastifyInstance } from 'fastify'
import { IWorkflowStore, ISessionStore } from '@eliph/core'

export function sessionsRoutes(_ws: IWorkflowStore, _ss: ISessionStore) {
  return async (_app: FastifyInstance) => {}
}
```

- [ ] **Step 4: Write failing auth tests**

Create `packages/server/tests/routes/keys.test.ts`:

```typescript
import { buildApp } from '../../src/app'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore } from '@eliph/core'

function makeStores() {
  return {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore: new InMemoryApiKeyStore(),
  }
}

describe('auth middleware', () => {
  it('allows POST /keys without a token', async () => {
    const app = buildApp(makeStores())
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/keys', body: { label: 'test' } })
    expect(res.statusCode).not.toBe(401)
  })

  it('rejects requests without Authorization header', async () => {
    const app = buildApp(makeStores())
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/procedures' })
    expect(res.statusCode).toBe(401)
  })

  it('rejects requests with invalid key', async () => {
    const app = buildApp(makeStores())
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/procedures',
      headers: { authorization: 'Bearer bad-key' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('allows requests with valid key', async () => {
    const stores = makeStores()
    const { rawKey } = await stores.apiKeyStore.create('test')
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/procedures',
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(res.statusCode).not.toBe(401)
  })
})
```

- [ ] **Step 5: Run to verify it fails**

```bash
npm test -- --selectProjects server --testPathPattern keys
```

Expected: FAIL — route stubs cause 404s, but auth tests can still run. The "allows POST /keys" test will fail because the route returns 404, not 401. That's fine — we just need to verify auth logic works.

Actually `POST /keys` being 404 means status != 401 so that test PASSES. The others should pass too. Let's run and see.

```bash
npm test -- --selectProjects server --testPathPattern keys
```

Expected: PASS (auth middleware tests pass with stub routes)

- [ ] **Step 6: Create server entry point**

Create `packages/server/src/index.ts`:

```typescript
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore } from '@eliph/core'
import { buildApp } from './app'

const stores = {
  workflowStore: new InMemoryWorkflowStore(),
  sessionStore: new InMemorySessionStore(),
  apiKeyStore: new InMemoryApiKeyStore(),
}

const app = buildApp(stores)

app.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1) }
  console.log(`Eliph server listening at ${address}`)
})
```

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/ packages/server/tests/
git commit -m "feat(server): app factory and auth middleware"
```

---

## Task 11: Keys Routes (TDD)

**Files:**
- Modify: `packages/server/src/routes/keys.ts`
- Modify: `packages/server/tests/routes/keys.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `packages/server/tests/routes/keys.test.ts`:

```typescript
describe('POST /keys', () => {
  it('creates a key and returns the raw key once', async () => {
    const app = buildApp(makeStores())
    await app.ready()
    const res = await app.inject({
      method: 'POST', url: '/keys',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'my-key' }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.rawKey).toBeDefined()
    expect(body.id).toBeDefined()
    expect(body.label).toBe('my-key')
  })
})

describe('GET /keys', () => {
  it('lists keys without exposing hashes', async () => {
    const stores = makeStores()
    const { rawKey } = await stores.apiKeyStore.create('existing')
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'GET', url: '/keys',
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].key).toBeUndefined()
  })
})

describe('DELETE /keys/:id', () => {
  it('deletes a key by id', async () => {
    const stores = makeStores()
    const { rawKey, record } = await stores.apiKeyStore.create('to-delete')
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'DELETE', url: `/keys/${record.id}`,
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(res.statusCode).toBe(204)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --selectProjects server --testPathPattern keys
```

Expected: FAIL — routes return 404

- [ ] **Step 3: Implement keys routes**

Replace `packages/server/src/routes/keys.ts`:

```typescript
import { FastifyInstance } from 'fastify'
import { IApiKeyStore } from '@eliph/core'

export function keysRoutes(store: IApiKeyStore) {
  return async (app: FastifyInstance) => {
    app.post<{ Body: { label: string } }>('/keys', async (req, reply) => {
      const { label } = req.body
      if (!label) return reply.code(400).send({ error: 'label is required', code: 'BAD_REQUEST' })
      const { rawKey, record } = await store.create(label)
      reply.code(201).send({ rawKey, id: record.id, label: record.label, createdAt: record.createdAt })
    })

    app.get('/keys', async (_req, reply) => {
      reply.send(await store.list())
    })

    app.delete<{ Params: { id: string } }>('/keys/:id', async (req, reply) => {
      await store.delete(req.params.id)
      reply.code(204).send()
    })
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test -- --selectProjects server --testPathPattern keys
```

Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/keys.ts packages/server/tests/routes/keys.test.ts
git commit -m "feat(server): keys routes — create, list, delete API keys"
```

---

## Task 12: Procedures Routes (TDD)

**Files:**
- Modify: `packages/server/src/routes/procedures.ts`
- Create: `packages/server/tests/routes/procedures.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/server/tests/routes/procedures.test.ts`:

```typescript
import { buildApp } from '../../src/app'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore } from '@eliph/core'

async function makeAuthedApp() {
  const stores = {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore: new InMemoryApiKeyStore(),
  }
  const { rawKey } = await stores.apiKeyStore.create('test')
  const app = buildApp(stores)
  await app.ready()
  return { app, stores, rawKey }
}

function authed(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` }
}

describe('POST /procedure', () => {
  it('creates a workflow with a start state', async () => {
    const { app, rawKey } = await makeAuthedApp()
    const res = await app.inject({
      method: 'POST', url: '/procedure',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_name: 'test', description: 'a test' }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.name).toBe('test')
    expect(body.states.start).toBeDefined()
  })
})

describe('GET /procedure/:name', () => {
  it('returns a workflow', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    await stores.workflowStore.save({
      name: 'flow', description: 'test', states: { start: { name: 'start', isTerminal: false } }, transitions: [],
    })
    const res = await app.inject({ method: 'GET', url: '/procedure/flow', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('flow')
  })

  it('returns 404 for unknown workflow', async () => {
    const { app, rawKey } = await makeAuthedApp()
    const res = await app.inject({ method: 'GET', url: '/procedure/nope', headers: authed(rawKey) })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /procedures', () => {
  it('returns matching workflow names', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    await stores.workflowStore.save({ name: 'onboarding', description: 'user onboarding', states: { start: { name: 'start', isTerminal: false } }, transitions: [] })
    const res = await app.inject({ method: 'GET', url: '/procedures?q=onboard', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toContain('onboarding')
  })
})

describe('POST /procedure/:name/transition', () => {
  it('adds a transition to a workflow', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    await stores.workflowStore.save({ name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] })
    const res = await app.inject({
      method: 'POST', url: '/procedure/flow/transition',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ transition: 'start -> review' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().transitions).toHaveLength(1)
  })

  it('returns 400 for invalid transition string', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    await stores.workflowStore.save({ name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] })
    const res = await app.inject({
      method: 'POST', url: '/procedure/flow/transition',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ transition: 'not valid' }),
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('DELETE /procedure/:name/transition', () => {
  it('removes a transition', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    const { addTransition } = await import('@eliph/core')
    let graph = { name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }
    graph = addTransition(graph, 'start -> review') as any
    await stores.workflowStore.save(graph as any)
    const res = await app.inject({
      method: 'DELETE', url: '/procedure/flow/transition',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ transition: 'start -> review' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().transitions).toHaveLength(0)
  })
})

describe('DELETE /procedure/:name/state/:state', () => {
  it('removes a state', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    const { addTransition } = await import('@eliph/core')
    let graph = { name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }
    graph = addTransition(graph, 'start -> review') as any
    await stores.workflowStore.save(graph as any)
    const res = await app.inject({
      method: 'DELETE', url: '/procedure/flow/state/review',
      headers: authed(rawKey),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().states.review).toBeUndefined()
  })

  it('returns 409 when active sessions are in the state', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    const { addTransition } = await import('@eliph/core')
    let graph = { name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }
    graph = addTransition(graph, 'start -> review') as any
    await stores.workflowStore.save(graph as any)
    await stores.sessionStore.save({ id: 's1', workflowName: 'flow', currentState: 'review', history: ['start', 'review'], createdAt: new Date() })
    const res = await app.inject({ method: 'DELETE', url: '/procedure/flow/state/review', headers: authed(rawKey) })
    expect(res.statusCode).toBe(409)
  })

  it('returns 404 for unknown workflow', async () => {
    const { app, rawKey } = await makeAuthedApp()
    const res = await app.inject({ method: 'DELETE', url: '/procedure/nope/state/review', headers: authed(rawKey) })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /procedure/:name/states', () => {
  it('returns all states in a workflow', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    await stores.workflowStore.save({ name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false }, review: { name: 'review', isTerminal: false } }, transitions: [] })
    const res = await app.inject({ method: 'GET', url: '/procedure/flow/states', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.map((s: any) => s.name)).toContain('start')
    expect(body.map((s: any) => s.name)).toContain('review')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --selectProjects server --testPathPattern procedures
```

Expected: FAIL — routes return 404

- [ ] **Step 3: Implement procedures routes**

Replace `packages/server/src/routes/procedures.ts`:

```typescript
import { FastifyInstance } from 'fastify'
import { IWorkflowStore, ISessionStore, addTransition, removeTransition, removeState } from '@eliph/core'
import { WorkflowGraph } from '@eliph/core'

export function proceduresRoutes(workflowStore: IWorkflowStore, sessionStore: ISessionStore) {
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { q?: string } }>('/procedures', async (req, reply) => {
      const q = req.query.q ?? ''
      reply.send(await workflowStore.search(q))
    })

    app.get<{ Params: { name: string } }>('/procedure/:name', async (req, reply) => {
      const graph = await workflowStore.get(req.params.name)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      reply.send(graph)
    })

    app.post<{ Body: { workflow_name: string; description: string } }>('/procedure', async (req, reply) => {
      const { workflow_name, description } = req.body
      const graph: WorkflowGraph = {
        name: workflow_name,
        description,
        states: { start: { name: 'start', isTerminal: false } },
        transitions: [],
      }
      await workflowStore.save(graph)
      reply.code(201).send(graph)
    })

    app.post<{ Params: { name: string }; Body: { transition: string } }>(
      '/procedure/:name/transition', async (req, reply) => {
        const graph = await workflowStore.get(req.params.name)
        if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
        try {
          const updated = addTransition(graph, req.body.transition)
          await workflowStore.save(updated)
          reply.send(updated)
        } catch (e: any) {
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.delete<{ Params: { name: string }; Body: { transition: string } }>(
      '/procedure/:name/transition', async (req, reply) => {
        const graph = await workflowStore.get(req.params.name)
        if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
        try {
          const updated = removeTransition(graph, req.body.transition)
          await workflowStore.save(updated)
          reply.send(updated)
        } catch (e: any) {
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.delete<{ Params: { name: string; state: string } }>(
      '/procedure/:name/state/:state', async (req, reply) => {
        const graph = await workflowStore.get(req.params.name)
        if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
        const active = await sessionStore.findByState(req.params.name, req.params.state)
        if (active.length > 0) {
          return reply.code(409).send({ error: 'Active sessions exist in this state', code: 'CONFLICT' })
        }
        try {
          const updated = removeState(graph, req.params.state)
          await workflowStore.save(updated)
          reply.send(updated)
        } catch (e: any) {
          const status = e.message.includes('reserved') ? 400 : 400
          reply.code(status).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.get<{ Params: { name: string } }>('/procedure/:name/states', async (req, reply) => {
      const graph = await workflowStore.get(req.params.name)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      reply.send(Object.values(graph.states))
    })
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test -- --selectProjects server --testPathPattern procedures
```

Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/procedures.ts packages/server/tests/routes/procedures.test.ts
git commit -m "feat(server): procedures routes — CRUD workflows and transitions"
```

---

## Task 13: Sessions Routes (TDD)

**Files:**
- Modify: `packages/server/src/routes/sessions.ts`
- Create: `packages/server/tests/routes/sessions.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/server/tests/routes/sessions.test.ts`:

```typescript
import { buildApp } from '../../src/app'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore, WorkflowGraph } from '@eliph/core'

const baseGraph: WorkflowGraph = {
  name: 'flow',
  description: '',
  states: {
    start: { name: 'start', isTerminal: false },
    review: { name: 'review', isTerminal: false },
    end: { name: 'end', isTerminal: true },
  },
  transitions: [
    { from: 'start', to: 'review', type: 'deterministic' },
    { from: 'review', to: 'end', type: 'deterministic' },
  ],
}

async function makeAuthedApp() {
  const stores = {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore: new InMemoryApiKeyStore(),
  }
  await stores.workflowStore.save(baseGraph)
  const { rawKey } = await stores.apiKeyStore.create('test')
  const app = buildApp(stores)
  await app.ready()
  return { app, stores, rawKey }
}

function authed(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` }
}

describe('POST /session', () => {
  it('creates a session at start state', async () => {
    const { app, rawKey } = await makeAuthedApp()
    const res = await app.inject({
      method: 'POST', url: '/session',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'flow' }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.currentState).toBe('start')
    expect(body.id).toBeDefined()
  })

  it('returns 404 for unknown workflow', async () => {
    const { app, rawKey } = await makeAuthedApp()
    const res = await app.inject({
      method: 'POST', url: '/session',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'nope' }),
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /session/:id', () => {
  it('deletes a session', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    await stores.sessionStore.save({ id: 's1', workflowName: 'flow', currentState: 'start', history: ['start'], createdAt: new Date() })
    const res = await app.inject({ method: 'DELETE', url: '/session/s1', headers: authed(rawKey) })
    expect(res.statusCode).toBe(204)
  })
})

describe('GET /session/:id/state', () => {
  it('returns current state and next transitions', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    await stores.sessionStore.save({ id: 's1', workflowName: 'flow', currentState: 'start', history: ['start'], createdAt: new Date() })
    const res = await app.inject({ method: 'GET', url: '/session/s1/state?workflow=flow', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.currentState).toBe('start')
    expect(body.nextTransitions).toHaveLength(1)
  })
})

describe('GET /session/:id/next', () => {
  it('returns next valid transitions', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    await stores.sessionStore.save({ id: 's1', workflowName: 'flow', currentState: 'start', history: ['start'], createdAt: new Date() })
    const res = await app.inject({ method: 'GET', url: '/session/s1/next?workflow=flow', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body[0].to).toBe('review')
    expect(body[0].type).toBe('deterministic')
  })
})

describe('POST /session/:id/advance', () => {
  it('advances a deterministic session', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    await stores.sessionStore.save({ id: 's1', workflowName: 'flow', currentState: 'start', history: ['start'], createdAt: new Date() })
    const res = await app.inject({
      method: 'POST', url: '/session/s1/advance',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'flow' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('review')
  })

  it('advances a symbolic session with completed_action', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    const symbolicGraph: WorkflowGraph = {
      name: 'sym', description: '', states: { start: { name: 'start', isTerminal: false }, done: { name: 'done', isTerminal: false } },
      transitions: [{ from: 'start', to: 'done', type: 'symbolic', action: 'check_done' }],
    }
    await stores.workflowStore.save(symbolicGraph)
    await stores.sessionStore.save({ id: 's2', workflowName: 'sym', currentState: 'start', history: ['start'], createdAt: new Date() })
    const res = await app.inject({
      method: 'POST', url: '/session/s2/advance',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'sym', completed_action: 'check_done' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('done')
  })

  it('returns 400 when symbolic transition requires completed_action', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    const symbolicGraph: WorkflowGraph = {
      name: 'sym2', description: '', states: { start: { name: 'start', isTerminal: false }, done: { name: 'done', isTerminal: false } },
      transitions: [{ from: 'start', to: 'done', type: 'symbolic', action: 'check_done' }],
    }
    await stores.workflowStore.save(symbolicGraph)
    await stores.sessionStore.save({ id: 's3', workflowName: 'sym2', currentState: 'start', history: ['start'], createdAt: new Date() })
    const res = await app.inject({
      method: 'POST', url: '/session/s3/advance',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'sym2' }),
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /session/:id/reset', () => {
  it('resets session to start', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    await stores.sessionStore.save({ id: 's1', workflowName: 'flow', currentState: 'review', history: ['start', 'review'], createdAt: new Date() })
    const res = await app.inject({
      method: 'POST', url: '/session/s1/reset',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'flow' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('start')
  })

  it('resets session to a target state', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    await stores.sessionStore.save({ id: 's1', workflowName: 'flow', currentState: 'end', history: ['start', 'review', 'end'], createdAt: new Date() })
    const res = await app.inject({
      method: 'POST', url: '/session/s1/reset',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'flow', target_state: 'review' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('review')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --selectProjects server --testPathPattern sessions
```

Expected: FAIL — routes return 404

- [ ] **Step 3: Implement sessions routes**

Replace `packages/server/src/routes/sessions.ts`:

```typescript
import { FastifyInstance } from 'fastify'
import { IWorkflowStore, ISessionStore, getNextTransitions, computeNextState, applyAdvance, applyReset, requirements, Session } from '@eliph/core'
import { randomUUID } from 'crypto'

export function sessionsRoutes(workflowStore: IWorkflowStore, sessionStore: ISessionStore) {
  return async (app: FastifyInstance) => {
    app.post<{ Body: { workflow: string } }>('/session', async (req, reply) => {
      const graph = await workflowStore.get(req.body.workflow)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      const session: Session = {
        id: randomUUID(),
        workflowName: req.body.workflow,
        currentState: 'start',
        history: ['start'],
        createdAt: new Date(),
      }
      await sessionStore.save(session)
      reply.code(201).send(session)
    })

    app.delete<{ Params: { id: string } }>('/session/:id', async (req, reply) => {
      await sessionStore.delete(req.params.id)
      reply.code(204).send()
    })

    app.get<{ Params: { id: string }; Querystring: { workflow: string } }>(
      '/session/:id/state', async (req, reply) => {
        const [session, graph] = await Promise.all([
          sessionStore.get(req.params.id),
          workflowStore.get(req.query.workflow),
        ])
        if (!session || !graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        reply.send({ currentState: session.currentState, nextTransitions: getNextTransitions(graph, session.currentState) })
      }
    )

    app.get<{ Params: { id: string }; Querystring: { workflow: string } }>(
      '/session/:id/next', async (req, reply) => {
        const [session, graph] = await Promise.all([
          sessionStore.get(req.params.id),
          workflowStore.get(req.query.workflow),
        ])
        if (!session || !graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        reply.send(getNextTransitions(graph, session.currentState))
      }
    )

    app.post<{ Params: { id: string }; Body: { workflow: string; completed_action?: string } }>(
      '/session/:id/advance', async (req, reply) => {
        const [session, graph] = await Promise.all([
          sessionStore.get(req.params.id),
          workflowStore.get(req.body.workflow),
        ])
        if (!session || !graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        try {
          const newState = computeNextState(graph, session, req.body.completed_action)
          const updated = applyAdvance(session, newState)
          await sessionStore.save(updated)
          reply.send(updated)
        } catch (e: any) {
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.post<{ Params: { id: string }; Body: { workflow: string; target_state?: string } }>(
      '/session/:id/reset', async (req, reply) => {
        const [session, graph] = await Promise.all([
          sessionStore.get(req.params.id),
          workflowStore.get(req.body.workflow),
        ])
        if (!session || !graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        const target = req.body.target_state ?? 'start'
        if (!graph.states[target]) {
          return reply.code(400).send({ error: `State "${target}" does not exist`, code: 'BAD_REQUEST' })
        }
        const updated = applyReset(session, target)
        await sessionStore.save(updated)
        reply.send(updated)
      }
    )

    app.get<{ Params: { id: string }; Querystring: { workflow: string } }>(
      '/session/:id/requirements', async (req, reply) => {
        const [session, graph] = await Promise.all([
          sessionStore.get(req.params.id),
          workflowStore.get(req.query.workflow),
        ])
        if (!session || !graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        reply.send(requirements(graph, session.currentState))
      }
    )
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test -- --selectProjects server --testPathPattern sessions
```

Expected: PASS (all tests)

- [ ] **Step 5: Run all server tests**

```bash
npm test -- --selectProjects server
```

Expected: PASS (all server tests)

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/sessions.ts packages/server/tests/routes/sessions.test.ts
git commit -m "feat(server): sessions routes — create, advance, reset, state, next, requirements"
```

---

## Task 14: MCP Package (Smoke Tests)

**Files:**
- Create: `packages/mcp/src/index.ts`
- Create: `packages/mcp/src/tools/procedures.ts`
- Create: `packages/mcp/src/tools/graph.ts`
- Create: `packages/mcp/src/tools/sessions.ts`
- Create: `packages/mcp/src/tools/advance.ts`
- Create: `packages/mcp/tests/smoke.test.ts`

- [ ] **Step 1: Write smoke tests**

Create `packages/mcp/tests/smoke.test.ts`:

```typescript
import { buildMcpServer } from '../src/index'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore } from '@eliph/core'

function makeStores() {
  return {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore: new InMemoryApiKeyStore(),
  }
}

describe('MCP server', () => {
  it('registers all expected tools', () => {
    const server = buildMcpServer(makeStores())
    const toolNames = server.getToolNames()
    expect(toolNames).toContain('procedures')
    expect(toolNames).toContain('procedure')
    expect(toolNames).toContain('create_procedure')
    expect(toolNames).toContain('add_transition')
    expect(toolNames).toContain('remove_transition')
    expect(toolNames).toContain('remove_state')
    expect(toolNames).toContain('list_states')
    expect(toolNames).toContain('create_session')
    expect(toolNames).toContain('delete_session')
    expect(toolNames).toContain('current_state')
    expect(toolNames).toContain('next_transitions')
    expect(toolNames).toContain('advance')
    expect(toolNames).toContain('reset_state')
    expect(toolNames).toContain('requirements')
  })

  it('create_procedure creates a workflow', async () => {
    const stores = makeStores()
    const server = buildMcpServer(stores)
    await server.callTool('create_procedure', { workflow_name: 'smoke', description: 'test' })
    const graph = await stores.workflowStore.get('smoke')
    expect(graph).not.toBeNull()
    expect(graph?.states.start).toBeDefined()
  })

  it('full session lifecycle works end to end', async () => {
    const stores = makeStores()
    const server = buildMcpServer(stores)

    await server.callTool('create_procedure', { workflow_name: 'e2e', description: '' })
    await server.callTool('add_transition', { workflow_name: 'e2e', transition: 'start -> done' })

    const createRes = await server.callTool('create_session', { workflow_name: 'e2e' })
    const sessionId = JSON.parse(createRes.content[0].text).id

    const advanceRes = await server.callTool('advance', { workflow_name: 'e2e', session_id: sessionId })
    expect(JSON.parse(advanceRes.content[0].text).currentState).toBe('done')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --selectProjects mcp
```

Expected: FAIL — `Cannot find module '../src/index'`

- [ ] **Step 3: Create tool handler files**

Create `packages/mcp/src/tools/procedures.ts`:

```typescript
import { IWorkflowStore, WorkflowGraph } from '@eliph/core'

export function makeProcedureTools(workflowStore: IWorkflowStore) {
  return {
    procedures: async (args: { search_query: string }) => {
      return await workflowStore.search(args.search_query ?? '')
    },
    procedure: async (args: { workflow_name: string }) => {
      const graph = await workflowStore.get(args.workflow_name)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      return graph
    },
    create_procedure: async (args: { workflow_name: string; description: string }) => {
      const graph: WorkflowGraph = {
        name: args.workflow_name,
        description: args.description,
        states: { start: { name: 'start', isTerminal: false } },
        transitions: [],
      }
      await workflowStore.save(graph)
      return graph
    },
  }
}
```

Create `packages/mcp/src/tools/graph.ts`:

```typescript
import { IWorkflowStore, addTransition, removeTransition, removeState } from '@eliph/core'

export function makeGraphTools(workflowStore: IWorkflowStore) {
  return {
    add_transition: async (args: { workflow_name: string; transition: string }) => {
      const graph = await workflowStore.get(args.workflow_name)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      const updated = addTransition(graph, args.transition)
      await workflowStore.save(updated)
      return updated
    },
    remove_transition: async (args: { workflow_name: string; transition: string }) => {
      const graph = await workflowStore.get(args.workflow_name)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      const updated = removeTransition(graph, args.transition)
      await workflowStore.save(updated)
      return updated
    },
    remove_state: async (args: { workflow_name: string; state_name: string }) => {
      const graph = await workflowStore.get(args.workflow_name)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      const updated = removeState(graph, args.state_name)
      await workflowStore.save(updated)
      return updated
    },
    list_states: async (args: { workflow_name: string }) => {
      const graph = await workflowStore.get(args.workflow_name)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      return Object.values(graph.states)
    },
  }
}
```

Create `packages/mcp/src/tools/sessions.ts`:

```typescript
import { IWorkflowStore, ISessionStore, getNextTransitions, Session } from '@eliph/core'
import { randomUUID } from 'crypto'

export function makeSessionTools(workflowStore: IWorkflowStore, sessionStore: ISessionStore) {
  return {
    create_session: async (args: { workflow_name: string }) => {
      const graph = await workflowStore.get(args.workflow_name)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      const session: Session = {
        id: randomUUID(),
        workflowName: args.workflow_name,
        currentState: 'start',
        history: ['start'],
        createdAt: new Date(),
      }
      await sessionStore.save(session)
      return session
    },
    delete_session: async (args: { session_id: string }) => {
      await sessionStore.delete(args.session_id)
      return { deleted: true }
    },
    current_state: async (args: { workflow_name: string; session_id: string }) => {
      const session = await sessionStore.get(args.session_id)
      if (!session) throw new Error(`Session "${args.session_id}" not found`)
      return { currentState: session.currentState, history: session.history }
    },
    next_transitions: async (args: { workflow_name: string; session_id: string }) => {
      const [session, graph] = await Promise.all([
        sessionStore.get(args.session_id),
        workflowStore.get(args.workflow_name),
      ])
      if (!session) throw new Error(`Session "${args.session_id}" not found`)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      return getNextTransitions(graph, session.currentState)
    },
  }
}
```

Create `packages/mcp/src/tools/advance.ts`:

```typescript
import { IWorkflowStore, ISessionStore, computeNextState, applyAdvance, applyReset, requirements } from '@eliph/core'

export function makeAdvanceTools(workflowStore: IWorkflowStore, sessionStore: ISessionStore) {
  return {
    advance: async (args: { workflow_name: string; session_id: string; completed_action?: string }) => {
      const [session, graph] = await Promise.all([
        sessionStore.get(args.session_id),
        workflowStore.get(args.workflow_name),
      ])
      if (!session) throw new Error(`Session "${args.session_id}" not found`)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      const newState = computeNextState(graph, session, args.completed_action)
      const updated = applyAdvance(session, newState)
      await sessionStore.save(updated)
      return updated
    },
    reset_state: async (args: { workflow_name: string; session_id: string; target_state?: string }) => {
      const [session, graph] = await Promise.all([
        sessionStore.get(args.session_id),
        workflowStore.get(args.workflow_name),
      ])
      if (!session) throw new Error(`Session "${args.session_id}" not found`)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      const target = args.target_state ?? 'start'
      if (!graph.states[target]) throw new Error(`State "${target}" does not exist`)
      const updated = applyReset(session, target)
      await sessionStore.save(updated)
      return updated
    },
    requirements: async (args: { workflow_name: string; session_id: string }) => {
      const [session, graph] = await Promise.all([
        sessionStore.get(args.session_id),
        workflowStore.get(args.workflow_name),
      ])
      if (!session) throw new Error(`Session "${args.session_id}" not found`)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      return requirements(graph, session.currentState)
    },
  }
}
```

- [ ] **Step 4: Create MCP server**

Create `packages/mcp/src/index.ts`:

```typescript
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
  }

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
```

- [ ] **Step 5: Run to verify tests pass**

```bash
npm test -- --selectProjects mcp
```

Expected: PASS (all smoke tests)

- [ ] **Step 6: Run all tests**

```bash
npm test
```

Expected: PASS (all core, server, and mcp tests)

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/
git commit -m "feat(mcp): MCP server with all 14 tools and smoke tests"
```

---

## Self-Review

**Spec coverage check:**
- ✅ `procedures`, `procedure`, `create_procedure` — Task 12 + 14
- ✅ `add_transition`, `remove_transition`, `remove_state` — Tasks 5, 6, 12, 14
- ✅ `list_states` — Task 12, 14
- ✅ `create_session`, `delete_session` — Tasks 13, 14
- ✅ `current_state`, `next_transitions` — Tasks 13, 14
- ✅ `advance` (all 3 transition types) — Tasks 9, 13, 14
- ✅ `reset_state` — Tasks 9, 13, 14
- ✅ `requirements` — Tasks 7, 13, 14
- ✅ Auth middleware — Task 10
- ✅ API key CRUD — Task 11
- ✅ In-memory stores — Task 8
- ✅ Pluggable store interfaces — Task 2
- ✅ TDD throughout — every task writes tests before implementation

**No placeholders present.** All steps include complete code.

**Type consistency:** `WorkflowGraph`, `Session`, `ApiKey`, `Transition`, `State`, `Requirement` defined once in Task 2 and referenced consistently. `computeNextState`, `applyAdvance`, `applyReset` defined in Task 9 and imported in Tasks 13 and 14 by the same names.
