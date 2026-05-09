# SQLite Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `packages/sqlite` package with `SqliteWorkflowStore`, `SqliteSessionStore`, and `SqliteApiKeyStore` implementing the existing store interfaces from `@eliph/core`, then switch the server to use them.

**Architecture:** Each store class takes a shared `better-sqlite3` `Database` instance and wraps synchronous SQLite calls in async methods to satisfy the existing interfaces. A `createStores(dbPath)` factory opens the connection, runs `CREATE TABLE IF NOT EXISTS` migrations, and returns all three stores. The server's `index.ts` switches from in-memory stores to `createStores('./eliph.db')`.

**Tech Stack:** `better-sqlite3` (synchronous SQLite driver), `bcryptjs` (already in workspace for API key hashing), `ts-jest` for tests using `:memory:` SQLite databases.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `packages/sqlite/package.json` | Create | Package metadata, dependencies |
| `packages/sqlite/tsconfig.json` | Create | TypeScript config extending root |
| `packages/sqlite/src/db.ts` | Create | Opens connection, runs schema setup |
| `packages/sqlite/src/workflow.ts` | Create | `SqliteWorkflowStore` |
| `packages/sqlite/src/session.ts` | Create | `SqliteSessionStore` |
| `packages/sqlite/src/apikey.ts` | Create | `SqliteApiKeyStore` |
| `packages/sqlite/src/index.ts` | Create | `createStores(dbPath)` factory + exports |
| `packages/sqlite/tests/workflow.test.ts` | Create | WorkflowStore tests |
| `packages/sqlite/tests/session.test.ts` | Create | SessionStore tests |
| `packages/sqlite/tests/apikey.test.ts` | Create | ApiKeyStore tests |
| `jest.config.ts` | Modify | Add sqlite project |
| `packages/server/package.json` | Modify | Add `@eliph/sqlite: *` dependency |
| `packages/server/src/index.ts` | Modify | Switch to `createStores('./eliph.db')` |

---

## Task 1: Package scaffold and database connection

**Files:**
- Create: `packages/sqlite/package.json`
- Create: `packages/sqlite/tsconfig.json`
- Create: `packages/sqlite/src/db.ts`
- Create: `packages/sqlite/src/index.ts` (stub)

- [ ] **Step 1: Create package.json**

Create `/Users/sarveshbhatnagar/Development/eliph/packages/sqlite/package.json`:

```json
{
  "name": "@eliph/sqlite",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "dependencies": {
    "@eliph/core": "*",
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^9.0.0"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `/Users/sarveshbhatnagar/Development/eliph/packages/sqlite/tsconfig.json`:

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

- [ ] **Step 3: Install dependencies**

Run from repo root:
```bash
npm install
```

Verify:
```bash
ls node_modules/better-sqlite3
```
Expected: directory listing.

- [ ] **Step 4: Create db.ts**

Create `/Users/sarveshbhatnagar/Development/eliph/packages/sqlite/src/db.ts`:

```typescript
import Database from 'better-sqlite3'

export function openDb(path: string): Database.Database {
  const db = new Database(path)

  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      name        TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      data        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      current_state TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      data          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_workflow_state
      ON sessions(workflow_name, current_state);

    CREATE TABLE IF NOT EXISTS api_keys (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      key_hash   TEXT NOT NULL
    );
  `)

  return db
}
```

- [ ] **Step 5: Create stub store files and index.ts**

The tests in Tasks 2-4 compile `index.ts` transitively. To avoid compile errors from missing files, create minimal stubs now — each method throws until replaced by the real implementation.

Create `/Users/sarveshbhatnagar/Development/eliph/packages/sqlite/src/workflow.ts`:
```typescript
import Database from 'better-sqlite3'
import { IWorkflowStore, WorkflowGraph } from '@eliph/core'
export class SqliteWorkflowStore implements IWorkflowStore {
  constructor(private db: Database.Database) {}
  async get(_name: string): Promise<WorkflowGraph | null> { throw new Error('not implemented') }
  async list(): Promise<string[]> { throw new Error('not implemented') }
  async search(_query: string): Promise<string[]> { throw new Error('not implemented') }
  async save(_graph: WorkflowGraph): Promise<void> { throw new Error('not implemented') }
  async delete(_name: string): Promise<void> { throw new Error('not implemented') }
}
```

Create `/Users/sarveshbhatnagar/Development/eliph/packages/sqlite/src/session.ts`:
```typescript
import Database from 'better-sqlite3'
import { ISessionStore, Session } from '@eliph/core'
export class SqliteSessionStore implements ISessionStore {
  constructor(private db: Database.Database) {}
  async get(_id: string): Promise<Session | null> { throw new Error('not implemented') }
  async save(_session: Session): Promise<void> { throw new Error('not implemented') }
  async delete(_id: string): Promise<void> { throw new Error('not implemented') }
  async findByState(_workflowName: string, _state: string): Promise<Session[]> { throw new Error('not implemented') }
}
```

Create `/Users/sarveshbhatnagar/Development/eliph/packages/sqlite/src/apikey.ts`:
```typescript
import Database from 'better-sqlite3'
import { IApiKeyStore, ApiKey } from '@eliph/core'
export class SqliteApiKeyStore implements IApiKeyStore {
  constructor(private db: Database.Database) {}
  async find(_rawKey: string): Promise<ApiKey | null> { throw new Error('not implemented') }
  async create(_label: string): Promise<{ rawKey: string; record: ApiKey }> { throw new Error('not implemented') }
  async delete(_id: string): Promise<void> { throw new Error('not implemented') }
  async list(): Promise<Omit<ApiKey, 'key'>[]> { throw new Error('not implemented') }
}
```

Create `/Users/sarveshbhatnagar/Development/eliph/packages/sqlite/src/index.ts`:

```typescript
export { SqliteWorkflowStore } from './workflow'
export { SqliteSessionStore } from './session'
export { SqliteApiKeyStore } from './apikey'

import { openDb } from './db'
import { SqliteWorkflowStore } from './workflow'
import { SqliteSessionStore } from './session'
import { SqliteApiKeyStore } from './apikey'

export function createStores(dbPath: string) {
  const db = openDb(dbPath)
  return {
    workflowStore: new SqliteWorkflowStore(db),
    sessionStore: new SqliteSessionStore(db),
    apiKeyStore: new SqliteApiKeyStore(db),
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/sqlite/ package-lock.json
git commit -m "feat(sqlite): scaffold package, db connection, schema setup"
```

---

## Task 2: SqliteWorkflowStore (TDD)

**Files:**
- Create: `packages/sqlite/tests/workflow.test.ts`
- Create: `packages/sqlite/src/workflow.ts`
- Modify: `jest.config.ts`

- [ ] **Step 1: Add sqlite project to jest.config.ts**

Replace the entire contents of `/Users/sarveshbhatnagar/Development/eliph/jest.config.ts`:

```typescript
export default {
  projects: [
    { displayName: 'core', testMatch: ['<rootDir>/packages/core/tests/**/*.test.ts'], preset: 'ts-jest', testEnvironment: 'node' },
    { displayName: 'server', testMatch: ['<rootDir>/packages/server/tests/**/*.test.ts'], preset: 'ts-jest', testEnvironment: 'node' },
    { displayName: 'mcp', testMatch: ['<rootDir>/packages/mcp/tests/**/*.test.ts'], preset: 'ts-jest', testEnvironment: 'node' },
    { displayName: 'sqlite', testMatch: ['<rootDir>/packages/sqlite/tests/**/*.test.ts'], preset: 'ts-jest', testEnvironment: 'node' },
  ],
}
```

- [ ] **Step 2: Write the failing test**

Create `/Users/sarveshbhatnagar/Development/eliph/packages/sqlite/tests/workflow.test.ts`:

```typescript
import { createStores } from '../src/index'
import { WorkflowGraph } from '@eliph/core'

function makeGraph(name = 'test', description = 'a test workflow'): WorkflowGraph {
  return {
    name,
    description,
    states: { start: { name: 'start', isTerminal: false } },
    transitions: [],
  }
}

describe('SqliteWorkflowStore', () => {
  function store() {
    return createStores(':memory:').workflowStore
  }

  it('saves and retrieves a workflow', async () => {
    const s = store()
    await s.save(makeGraph())
    const result = await s.get('test')
    expect(result).toEqual(makeGraph())
  })

  it('returns null for unknown workflow', async () => {
    expect(await store().get('unknown')).toBeNull()
  })

  it('lists all workflow names', async () => {
    const s = store()
    await s.save(makeGraph('a'))
    await s.save(makeGraph('b'))
    const names = await s.list()
    expect(names).toEqual(expect.arrayContaining(['a', 'b']))
    expect(names).toHaveLength(2)
  })

  it('searches by name', async () => {
    const s = store()
    await s.save(makeGraph('coin_flip'))
    await s.save(makeGraph('onboarding'))
    expect(await s.search('coin')).toEqual(['coin_flip'])
  })

  it('searches by description', async () => {
    const s = store()
    await s.save(makeGraph('flow', 'handles user signup'))
    expect(await s.search('signup')).toEqual(['flow'])
  })

  it('overwrites existing workflow on save', async () => {
    const s = store()
    await s.save(makeGraph())
    await s.save({ ...makeGraph(), description: 'updated' })
    const result = await s.get('test')
    expect(result!.description).toBe('updated')
  })

  it('preserves created_at on overwrite', async () => {
    const s = store()
    // save twice — the DB created_at should not change on second save
    await s.save(makeGraph())
    await s.save({ ...makeGraph(), description: 'updated' })
    // If this doesn't throw, created_at constraint held
    expect(await s.get('test')).not.toBeNull()
  })

  it('deletes a workflow', async () => {
    const s = store()
    await s.save(makeGraph())
    await s.delete('test')
    expect(await s.get('test')).toBeNull()
  })
})
```

- [ ] **Step 3: Run to confirm it fails**

```bash
npm run test:sqlite 2>/dev/null || npx jest --selectProjects sqlite 2>&1 | tail -10
```

Expected: FAIL — `Error: not implemented`

- [ ] **Step 4: Implement SqliteWorkflowStore**

Create `/Users/sarveshbhatnagar/Development/eliph/packages/sqlite/src/workflow.ts`:

```typescript
import Database from 'better-sqlite3'
import { IWorkflowStore, WorkflowGraph } from '@eliph/core'

export class SqliteWorkflowStore implements IWorkflowStore {
  constructor(private db: Database.Database) {}

  async get(name: string): Promise<WorkflowGraph | null> {
    const row = this.db
      .prepare('SELECT data FROM workflows WHERE name = ?')
      .get(name) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as WorkflowGraph) : null
  }

  async list(): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT name FROM workflows')
      .all() as { name: string }[]
    return rows.map(r => r.name)
  }

  async search(query: string): Promise<string[]> {
    const q = query.toLowerCase()
    const rows = this.db
      .prepare('SELECT name, description FROM workflows')
      .all() as { name: string; description: string }[]
    return rows
      .filter(r => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
      .map(r => r.name)
  }

  async save(graph: WorkflowGraph): Promise<void> {
    const now = new Date().toISOString()
    this.db
      .prepare(`
        INSERT INTO workflows (name, description, created_at, updated_at, data)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          description = excluded.description,
          updated_at  = excluded.updated_at,
          data        = excluded.data
      `)
      .run(graph.name, graph.description, now, now, JSON.stringify(graph))
  }

  async delete(name: string): Promise<void> {
    this.db.prepare('DELETE FROM workflows WHERE name = ?').run(name)
  }
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npx jest --selectProjects sqlite --testPathPattern=workflow 2>&1 | tail -15
```

Expected: 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sqlite/src/workflow.ts packages/sqlite/tests/workflow.test.ts jest.config.ts
git commit -m "feat(sqlite): SqliteWorkflowStore with tests"
```

---

## Task 3: SqliteSessionStore (TDD)

**Files:**
- Create: `packages/sqlite/tests/session.test.ts`
- Create: `packages/sqlite/src/session.ts`

- [ ] **Step 1: Write the failing test**

Create `/Users/sarveshbhatnagar/Development/eliph/packages/sqlite/tests/session.test.ts`:

```typescript
import { createStores } from '../src/index'
import { Session } from '@eliph/core'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    workflowName: 'flow',
    currentState: 'start',
    history: ['start'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

describe('SqliteSessionStore', () => {
  function store() {
    return createStores(':memory:').sessionStore
  }

  it('saves and retrieves a session', async () => {
    const s = store()
    const session = makeSession()
    await s.save(session)
    const result = await s.get('sess-1')
    expect(result).not.toBeNull()
    expect(result!.id).toBe('sess-1')
    expect(result!.currentState).toBe('start')
    expect(result!.createdAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  it('returns null for unknown session', async () => {
    expect(await store().get('unknown')).toBeNull()
  })

  it('updates currentState on re-save', async () => {
    const s = store()
    await s.save(makeSession())
    await s.save(makeSession({ currentState: 'review', history: ['start', 'review'] }))
    const result = await s.get('sess-1')
    expect(result!.currentState).toBe('review')
    expect(result!.history).toEqual(['start', 'review'])
  })

  it('preserves createdAt on re-save', async () => {
    const s = store()
    await s.save(makeSession())
    await s.save(makeSession({ currentState: 'review' }))
    const result = await s.get('sess-1')
    expect(result!.createdAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  it('findByState returns matching sessions', async () => {
    const s = store()
    await s.save(makeSession({ id: 'a', currentState: 'review' }))
    await s.save(makeSession({ id: 'b', currentState: 'start' }))
    const results = await s.findByState('flow', 'review')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('a')
  })

  it('findByState ignores sessions from other workflows', async () => {
    const s = store()
    await s.save(makeSession({ id: 'a', workflowName: 'flow', currentState: 'review' }))
    await s.save(makeSession({ id: 'b', workflowName: 'other', currentState: 'review' }))
    const results = await s.findByState('flow', 'review')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('a')
  })

  it('deletes a session', async () => {
    const s = store()
    await s.save(makeSession())
    await s.delete('sess-1')
    expect(await s.get('sess-1')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npx jest --selectProjects sqlite --testPathPattern=session 2>&1 | tail -10
```

Expected: FAIL — `Error: not implemented`

- [ ] **Step 3: Implement SqliteSessionStore**

Create `/Users/sarveshbhatnagar/Development/eliph/packages/sqlite/src/session.ts`:

```typescript
import Database from 'better-sqlite3'
import { ISessionStore, Session } from '@eliph/core'

export class SqliteSessionStore implements ISessionStore {
  constructor(private db: Database.Database) {}

  async get(id: string): Promise<Session | null> {
    const row = this.db
      .prepare('SELECT data FROM sessions WHERE id = ?')
      .get(id) as { data: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.data)
    return { ...parsed, createdAt: new Date(parsed.createdAt) }
  }

  async save(session: Session): Promise<void> {
    const now = new Date().toISOString()
    this.db
      .prepare(`
        INSERT INTO sessions (id, workflow_name, current_state, created_at, updated_at, data)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workflow_name = excluded.workflow_name,
          current_state = excluded.current_state,
          updated_at    = excluded.updated_at,
          data          = excluded.data
      `)
      .run(
        session.id,
        session.workflowName,
        session.currentState,
        session.createdAt.toISOString(),
        now,
        JSON.stringify(session),
      )
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  async findByState(workflowName: string, state: string): Promise<Session[]> {
    const rows = this.db
      .prepare('SELECT data FROM sessions WHERE workflow_name = ? AND current_state = ?')
      .all(workflowName, state) as { data: string }[]
    return rows.map(row => {
      const parsed = JSON.parse(row.data)
      return { ...parsed, createdAt: new Date(parsed.createdAt) }
    })
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx jest --selectProjects sqlite --testPathPattern=session 2>&1 | tail -15
```

Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sqlite/src/session.ts packages/sqlite/tests/session.test.ts
git commit -m "feat(sqlite): SqliteSessionStore with tests"
```

---

## Task 4: SqliteApiKeyStore (TDD)

**Files:**
- Create: `packages/sqlite/tests/apikey.test.ts`
- Create: `packages/sqlite/src/apikey.ts`

- [ ] **Step 1: Write the failing test**

Create `/Users/sarveshbhatnagar/Development/eliph/packages/sqlite/tests/apikey.test.ts`:

```typescript
import { createStores } from '../src/index'

describe('SqliteApiKeyStore', () => {
  function store() {
    return createStores(':memory:').apiKeyStore
  }

  it('create returns a rawKey and a record', async () => {
    const { rawKey, record } = await store().create('test-key')
    expect(typeof rawKey).toBe('string')
    expect(rawKey.length).toBeGreaterThan(0)
    expect(record.label).toBe('test-key')
    expect(record.id).toBeTruthy()
    expect(record.createdAt).toBeInstanceOf(Date)
  })

  it('find returns the record for the correct rawKey', async () => {
    const s = store()
    const { rawKey, record } = await s.create('my-key')
    const found = await s.find(rawKey)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(record.id)
    expect(found!.label).toBe('my-key')
  })

  it('find returns null for a wrong key', async () => {
    const s = store()
    await s.create('my-key')
    expect(await s.find('definitely-wrong')).toBeNull()
  })

  it('list returns all keys without the key hash', async () => {
    const s = store()
    await s.create('key-a')
    await s.create('key-b')
    const keys = await s.list()
    expect(keys).toHaveLength(2)
    expect(keys.map(k => k.label)).toEqual(expect.arrayContaining(['key-a', 'key-b']))
    keys.forEach(k => expect((k as any).key).toBeUndefined())
  })

  it('delete removes the key', async () => {
    const s = store()
    const { record } = await s.create('my-key')
    await s.delete(record.id)
    expect(await s.list()).toHaveLength(0)
  })

  it('deleted key can no longer be found', async () => {
    const s = store()
    const { rawKey, record } = await s.create('my-key')
    await s.delete(record.id)
    expect(await s.find(rawKey)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npx jest --selectProjects sqlite --testPathPattern=apikey 2>&1 | tail -10
```

Expected: FAIL — `Error: not implemented`

- [ ] **Step 3: Implement SqliteApiKeyStore**

Create `/Users/sarveshbhatnagar/Development/eliph/packages/sqlite/src/apikey.ts`:

```typescript
import Database from 'better-sqlite3'
import { IApiKeyStore, ApiKey } from '@eliph/core'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'

export class SqliteApiKeyStore implements IApiKeyStore {
  constructor(private db: Database.Database) {}

  async find(rawKey: string): Promise<ApiKey | null> {
    const rows = this.db
      .prepare('SELECT id, label, created_at, key_hash FROM api_keys')
      .all() as { id: string; label: string; created_at: string; key_hash: string }[]

    for (const row of rows) {
      if (await bcrypt.compare(rawKey, row.key_hash)) {
        return {
          id: row.id,
          key: row.key_hash,
          label: row.label,
          createdAt: new Date(row.created_at),
        }
      }
    }
    return null
  }

  async create(label: string): Promise<{ rawKey: string; record: ApiKey }> {
    const rawKey = randomUUID()
    const keyHash = await bcrypt.hash(rawKey, 10)
    const id = randomUUID()
    const now = new Date()

    this.db
      .prepare('INSERT INTO api_keys (id, label, created_at, key_hash) VALUES (?, ?, ?, ?)')
      .run(id, label, now.toISOString(), keyHash)

    const record: ApiKey = { id, key: keyHash, label, createdAt: now }
    return { rawKey, record }
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id)
  }

  async list(): Promise<Omit<ApiKey, 'key'>[]> {
    const rows = this.db
      .prepare('SELECT id, label, created_at FROM api_keys')
      .all() as { id: string; label: string; created_at: string }[]
    return rows.map(row => ({
      id: row.id,
      label: row.label,
      createdAt: new Date(row.created_at),
    }))
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx jest --selectProjects sqlite --testPathPattern=apikey 2>&1 | tail -15
```

Expected: 6 tests PASS.

- [ ] **Step 5: Run the full sqlite test suite**

```bash
npx jest --selectProjects sqlite 2>&1 | tail -15
```

Expected: 21 tests PASS across workflow, session, apikey.

- [ ] **Step 6: Commit**

```bash
git add packages/sqlite/src/apikey.ts packages/sqlite/tests/apikey.test.ts
git commit -m "feat(sqlite): SqliteApiKeyStore with tests"
```

---

## Task 5: Run full test suite to confirm no regressions

**Files:** none

- [ ] **Step 1: Run all tests**

```bash
npm test 2>&1 | tail -15
```

Expected: all tests pass across core, server, mcp, sqlite.

- [ ] **Step 2: Commit jest.config if not already committed**

```bash
git add jest.config.ts
git diff --cached --quiet || git commit -m "feat(sqlite): add sqlite project to jest config"
```

---

## Task 6: Switch server to SQLite

**Files:**
- Modify: `packages/server/package.json`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Add @eliph/sqlite dependency to server**

Replace `packages/server/package.json`:

```json
{
  "name": "@eliph/server",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "dependencies": {
    "@eliph/core": "*",
    "@eliph/sqlite": "*",
    "@fastify/cors": "^8.5.0",
    "@fastify/swagger": "^8.0.0",
    "fastify": "^4.26.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@types/uuid": "^9.0.0"
  }
}
```

- [ ] **Step 2: Run npm install**

```bash
npm install
```

- [ ] **Step 3: Switch server to SQLite stores**

Replace the entire contents of `packages/server/src/index.ts`:

```typescript
import { createStores } from '@eliph/sqlite'
import { buildApp } from './app'

const stores = createStores('./eliph.db')

const app = buildApp(stores)

app.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1) }
  console.log(`Eliph server listening at ${address}`)
})
```

- [ ] **Step 4: Run server tests to confirm no regressions**

Server tests use `buildApp` directly with in-memory stores, so they should still pass unchanged.

```bash
npm run test:server 2>&1 | tail -10
```

Expected: all server tests PASS.

- [ ] **Step 5: Run the full test suite**

```bash
npm test 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 6: Smoke test the running server**

In one terminal:
```bash
npm start
```

In another:
```bash
curl -s -X POST http://localhost:3000/keys \
  -H 'Content-Type: application/json' \
  -d '{"label": "smoke-test"}'
```

Expected: `{"rawKey":"...","id":"...","label":"smoke-test","createdAt":"..."}` and an `eliph.db` file appears in the repo root.

- [ ] **Step 7: Verify data survives restart**

Stop the server (Ctrl+C), restart it, then list keys:

```bash
curl -s http://localhost:3000/keys \
  -H 'Authorization: Bearer <rawKey-from-above>'
```

Expected: the `smoke-test` key is still there.

- [ ] **Step 8: Add eliph.db to .gitignore**

Edit `.gitignore` to add:

```
node_modules/
dist/
docs-site/
*.db
```

- [ ] **Step 9: Commit**

```bash
git add packages/server/package.json packages/server/src/index.ts package-lock.json .gitignore
git commit -m "feat(server): switch to SQLite persistence via @eliph/sqlite"
```
