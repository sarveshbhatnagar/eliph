# Automated Docs Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a Swagger UI docs site from Fastify route schemas via `npm run docs`, producing a deployable static `docs-site/` folder.

**Architecture:** `@fastify/swagger` is registered only in the doc-builder (never in production `buildApp`). Shared JSON schemas are registered in `buildApp` via `addSchema` (safe validator metadata, no route exposure). `docs-builder.ts` creates its own Fastify instance, registers swagger before routes, calls `app.ready()`, then writes `docs-site/openapi.json` and `docs-site/index.html`.

**Tech Stack:** `@fastify/swagger@8` (Fastify v4 compatible), ts-node (transpile-only), vanilla Swagger UI via CDN.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `packages/server/package.json` | Modify | Add `@fastify/swagger@8` dependency |
| `packages/server/src/app.ts` | Modify | Export `registerSharedSchemas(app)`, call it in `buildApp` |
| `packages/server/src/routes/keys.ts` | Modify | Add schema blocks to all 3 routes |
| `packages/server/src/routes/procedures.ts` | Modify | Add schema blocks to all 6 routes |
| `packages/server/src/routes/sessions.ts` | Modify | Add schema blocks to all 6 routes |
| `packages/server/src/docs-builder.ts` | Create | `generateSpec()` + `main()` (writes docs-site/) |
| `packages/server/tests/docs.test.ts` | Create | Tests that generateSpec returns expected paths/schemas |
| `package.json` (root) | Modify | Add `"docs"` script |
| `.gitignore` | Create | Add `docs-site/` and `node_modules/` |

---

## Task 1: Install @fastify/swagger

**Files:**
- Modify: `packages/server/package.json`

- [ ] **Step 1: Add the dependency**

Replace the `dependencies` block in `packages/server/package.json`:

```json
{
  "name": "@eliph/server",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "dependencies": {
    "@eliph/core": "*",
    "@fastify/swagger": "^8.0.0",
    "fastify": "^4.26.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@types/uuid": "^9.0.0"
  }
}
```

- [ ] **Step 2: Install**

Run from repo root:
```bash
npm install
```

- [ ] **Step 3: Verify**

```bash
ls node_modules/@fastify/swagger
```
Expected: directory listing (not "No such file").

- [ ] **Step 4: Commit**

```bash
git add packages/server/package.json package-lock.json
git commit -m "feat(docs): install @fastify/swagger"
```

---

## Task 2: Register shared named schemas in buildApp

**Files:**
- Modify: `packages/server/src/app.ts`

These `addSchema` calls register named JSON Schema objects on the Fastify instance. They are used by route schemas via `$ref` and are safe in production (no routes exposed). Swagger reads them from the instance to produce named models in the UI.

- [ ] **Step 1: Update app.ts**

Replace the entire contents of `packages/server/src/app.ts` with:

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

export function registerSharedSchemas(app: FastifyInstance): void {
  app.addSchema({
    $id: 'State',
    type: 'object',
    properties: {
      name: { type: 'string' },
      isTerminal: { type: 'boolean' },
    },
    required: ['name', 'isTerminal'],
  })

  app.addSchema({
    $id: 'Transition',
    type: 'object',
    properties: {
      from: { type: 'string' },
      to: { type: 'string' },
      type: { type: 'string', enum: ['deterministic', 'probabilistic', 'symbolic'] },
      weight: { type: 'number' },
      action: { type: 'string' },
    },
    required: ['from', 'to', 'type'],
  })

  app.addSchema({
    $id: 'WorkflowGraph',
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      states: {
        type: 'object',
        additionalProperties: { $ref: 'State#' },
      },
      transitions: {
        type: 'array',
        items: { $ref: 'Transition#' },
      },
    },
    required: ['name', 'description', 'states', 'transitions'],
  })

  app.addSchema({
    $id: 'Session',
    type: 'object',
    properties: {
      id: { type: 'string' },
      workflowName: { type: 'string' },
      currentState: { type: 'string' },
      history: { type: 'array', items: { type: 'string' } },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'workflowName', 'currentState', 'history', 'createdAt'],
  })

  app.addSchema({
    $id: 'ApiKey',
    type: 'object',
    properties: {
      id: { type: 'string' },
      label: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'label', 'createdAt'],
  })
}

export function buildApp(stores: Stores): FastifyInstance {
  const app = Fastify()

  registerSharedSchemas(app)

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

- [ ] **Step 2: Run existing tests to confirm no regression**

```bash
npm run test:server
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/app.ts
git commit -m "feat(docs): export registerSharedSchemas with named JSON schemas"
```

---

## Task 3: Add schema blocks to keys routes

**Files:**
- Modify: `packages/server/src/routes/keys.ts`

Schema blocks add metadata only — they do not change runtime behaviour. The `security: []` on `POST /keys` marks it as exempt in the Swagger UI (matching the actual auth middleware bypass). All other routes carry `security: [{ BearerAuth: [] }]`.

- [ ] **Step 1: Replace keys.ts**

```typescript
import { FastifyInstance } from 'fastify'
import { IApiKeyStore } from '@eliph/core'

export function keysRoutes(store: IApiKeyStore) {
  return async (app: FastifyInstance) => {
    app.post<{ Body: { label: string } }>('/keys', {
      schema: {
        tags: ['Keys'],
        summary: 'Create an API key (no auth required)',
        security: [],
        body: {
          type: 'object',
          required: ['label'],
          properties: { label: { type: 'string' } },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              rawKey: { type: 'string' },
              id: { type: 'string' },
              label: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    }, async (req, reply) => {
      const { label } = req.body
      if (!label) return reply.code(400).send({ error: 'label is required', code: 'BAD_REQUEST' })
      const { rawKey, record } = await store.create(label)
      reply.code(201).send({ rawKey, id: record.id, label: record.label, createdAt: record.createdAt })
    })

    app.get('/keys', {
      schema: {
        tags: ['Keys'],
        summary: 'List API keys',
        security: [{ BearerAuth: [] }],
        response: {
          200: { type: 'array', items: { $ref: 'ApiKey#' } },
        },
      },
    }, async (_req, reply) => {
      reply.send(await store.list())
    })

    app.delete<{ Params: { id: string } }>('/keys/:id', {
      schema: {
        tags: ['Keys'],
        summary: 'Delete an API key',
        security: [{ BearerAuth: [] }],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
        response: { 204: { type: 'null' } },
      },
    }, async (req, reply) => {
      await store.delete(req.params.id)
      reply.code(204).send()
    })
  }
}
```

- [ ] **Step 2: Run server tests**

```bash
npm run test:server
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/routes/keys.ts
git commit -m "feat(docs): add OpenAPI schemas to keys routes"
```

---

## Task 4: Add schema blocks to procedures routes

**Files:**
- Modify: `packages/server/src/routes/procedures.ts`

- [ ] **Step 1: Replace procedures.ts**

```typescript
import { FastifyInstance } from 'fastify'
import { IWorkflowStore, ISessionStore, WorkflowGraph, addTransition, removeTransition, removeState } from '@eliph/core'

const authed = [{ BearerAuth: [] }]

export function proceduresRoutes(workflowStore: IWorkflowStore, sessionStore: ISessionStore) {
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { q?: string } }>('/procedures', {
      schema: {
        tags: ['Procedures'],
        summary: 'Search procedures by name',
        security: authed,
        querystring: {
          type: 'object',
          properties: { q: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: { type: 'string' } },
        },
      },
    }, async (req, reply) => {
      const q = req.query.q ?? ''
      reply.send(await workflowStore.search(q))
    })

    app.get<{ Params: { name: string } }>('/procedure/:name', {
      schema: {
        tags: ['Procedures'],
        summary: 'Get a procedure by name',
        security: authed,
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { $ref: 'WorkflowGraph#' },
        },
      },
    }, async (req, reply) => {
      const graph = await workflowStore.get(req.params.name)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      reply.send(graph)
    })

    app.post<{ Body: { workflow_name: string; description: string } }>('/procedure', {
      schema: {
        tags: ['Procedures'],
        summary: 'Create a new procedure',
        security: authed,
        body: {
          type: 'object',
          required: ['workflow_name', 'description'],
          properties: {
            workflow_name: { type: 'string' },
            description: { type: 'string' },
          },
        },
        response: {
          201: { $ref: 'WorkflowGraph#' },
        },
      },
    }, async (req, reply) => {
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
      '/procedure/:name/transition', {
        schema: {
          tags: ['Procedures'],
          summary: 'Add a transition to a procedure',
          security: authed,
          params: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
          body: {
            type: 'object',
            required: ['transition'],
            properties: { transition: { type: 'string' } },
          },
          response: {
            200: { $ref: 'WorkflowGraph#' },
          },
        },
      }, async (req, reply) => {
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
      '/procedure/:name/transition', {
        schema: {
          tags: ['Procedures'],
          summary: 'Remove a transition from a procedure',
          security: authed,
          params: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
          body: {
            type: 'object',
            required: ['transition'],
            properties: { transition: { type: 'string' } },
          },
          response: {
            200: { $ref: 'WorkflowGraph#' },
          },
        },
      }, async (req, reply) => {
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
      '/procedure/:name/state/:state', {
        schema: {
          tags: ['Procedures'],
          summary: 'Remove a state from a procedure',
          security: authed,
          params: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              state: { type: 'string' },
            },
          },
          response: {
            200: { $ref: 'WorkflowGraph#' },
          },
        },
      }, async (req, reply) => {
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
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.get<{ Params: { name: string } }>('/procedure/:name/states', {
      schema: {
        tags: ['Procedures'],
        summary: 'List all states in a procedure',
        security: authed,
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: { $ref: 'State#' } },
        },
      },
    }, async (req, reply) => {
      const graph = await workflowStore.get(req.params.name)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      reply.send(Object.values(graph.states))
    })
  }
}
```

- [ ] **Step 2: Run server tests**

```bash
npm run test:server
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/routes/procedures.ts
git commit -m "feat(docs): add OpenAPI schemas to procedures routes"
```

---

## Task 5: Add schema blocks to sessions routes

**Files:**
- Modify: `packages/server/src/routes/sessions.ts`

- [ ] **Step 1: Replace sessions.ts**

```typescript
import { FastifyInstance } from 'fastify'
import { IWorkflowStore, ISessionStore, Session, getNextTransitions, computeNextState, applyAdvance, applyReset, requirements } from '@eliph/core'
import { randomUUID } from 'crypto'

const authed = [{ BearerAuth: [] }]

export function sessionsRoutes(workflowStore: IWorkflowStore, sessionStore: ISessionStore) {
  return async (app: FastifyInstance) => {
    app.post<{ Body: { workflow: string } }>('/session', {
      schema: {
        tags: ['Sessions'],
        summary: 'Create a session for a workflow',
        security: authed,
        body: {
          type: 'object',
          required: ['workflow'],
          properties: { workflow: { type: 'string' } },
        },
        response: {
          201: { $ref: 'Session#' },
        },
      },
    }, async (req, reply) => {
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

    app.delete<{ Params: { id: string } }>('/session/:id', {
      schema: {
        tags: ['Sessions'],
        summary: 'Delete a session',
        security: authed,
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
        response: { 204: { type: 'null' } },
      },
    }, async (req, reply) => {
      await sessionStore.delete(req.params.id)
      reply.code(204).send()
    })

    app.get<{ Params: { id: string }; Querystring: { workflow: string } }>(
      '/session/:id/state', {
        schema: {
          tags: ['Sessions'],
          summary: 'Get current state and available next transitions',
          security: authed,
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
          querystring: {
            type: 'object',
            required: ['workflow'],
            properties: { workflow: { type: 'string' } },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                currentState: { type: 'string' },
                nextTransitions: { type: 'array', items: { $ref: 'Transition#' } },
              },
            },
          },
        },
      }, async (req, reply) => {
        const [session, graph] = await Promise.all([
          sessionStore.get(req.params.id),
          workflowStore.get(req.query.workflow),
        ])
        if (!session || !graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        reply.send({ currentState: session.currentState, nextTransitions: getNextTransitions(graph, session.currentState) })
      }
    )

    app.get<{ Params: { id: string }; Querystring: { workflow: string } }>(
      '/session/:id/next', {
        schema: {
          tags: ['Sessions'],
          summary: 'Get next transitions from the current state',
          security: authed,
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
          querystring: {
            type: 'object',
            required: ['workflow'],
            properties: { workflow: { type: 'string' } },
          },
          response: {
            200: { type: 'array', items: { $ref: 'Transition#' } },
          },
        },
      }, async (req, reply) => {
        const [session, graph] = await Promise.all([
          sessionStore.get(req.params.id),
          workflowStore.get(req.query.workflow),
        ])
        if (!session || !graph) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
        reply.send(getNextTransitions(graph, session.currentState))
      }
    )

    app.post<{ Params: { id: string }; Body: { workflow: string; completed_action?: string } }>(
      '/session/:id/advance', {
        schema: {
          tags: ['Sessions'],
          summary: 'Advance session to the next state',
          security: authed,
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
          body: {
            type: 'object',
            required: ['workflow'],
            properties: {
              workflow: { type: 'string' },
              completed_action: { type: 'string' },
            },
          },
          response: {
            200: { $ref: 'Session#' },
          },
        },
      }, async (req, reply) => {
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
      '/session/:id/reset', {
        schema: {
          tags: ['Sessions'],
          summary: 'Reset session to a target state (default: start)',
          security: authed,
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
          body: {
            type: 'object',
            required: ['workflow'],
            properties: {
              workflow: { type: 'string' },
              target_state: { type: 'string' },
            },
          },
          response: {
            200: { $ref: 'Session#' },
          },
        },
      }, async (req, reply) => {
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
      '/session/:id/requirements', {
        schema: {
          tags: ['Sessions'],
          summary: 'Get action requirements for the current state',
          security: authed,
          params: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
          querystring: {
            type: 'object',
            required: ['workflow'],
            properties: { workflow: { type: 'string' } },
          },
          response: {
            200: { type: 'array', items: { type: 'string' } },
          },
        },
      }, async (req, reply) => {
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

- [ ] **Step 2: Run server tests**

```bash
npm run test:server
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/routes/sessions.ts
git commit -m "feat(docs): add OpenAPI schemas to sessions routes"
```

---

## Task 6: Write failing test for generateSpec

**Files:**
- Create: `packages/server/tests/docs.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { generateSpec } from '../../src/docs-builder'

describe('generateSpec', () => {
  it('returns a valid OpenAPI 3.0 spec', async () => {
    const spec = await generateSpec() as any
    expect(spec.openapi).toMatch(/^3\./)
    expect(spec.info.title).toBe('Eliph API')
  })

  it('includes all expected paths', async () => {
    const spec = await generateSpec() as any
    const paths = Object.keys(spec.paths)
    expect(paths).toContain('/keys')
    expect(paths).toContain('/procedures')
    expect(paths).toContain('/procedure/{name}')
    expect(paths).toContain('/procedure/{name}/transition')
    expect(paths).toContain('/procedure/{name}/state/{state}')
    expect(paths).toContain('/procedure/{name}/states')
    expect(paths).toContain('/session')
    expect(paths).toContain('/session/{id}/state')
    expect(paths).toContain('/session/{id}/next')
    expect(paths).toContain('/session/{id}/advance')
    expect(paths).toContain('/session/{id}/reset')
    expect(paths).toContain('/session/{id}/requirements')
  })

  it('includes all shared component schemas', async () => {
    const spec = await generateSpec() as any
    const schemas = Object.keys(spec.components.schemas)
    expect(schemas).toContain('WorkflowGraph')
    expect(schemas).toContain('Session')
    expect(schemas).toContain('Transition')
    expect(schemas).toContain('State')
    expect(schemas).toContain('ApiKey')
  })

  it('includes BearerAuth security scheme', async () => {
    const spec = await generateSpec() as any
    expect(spec.components.securitySchemes).toHaveProperty('BearerAuth')
    expect(spec.components.securitySchemes.BearerAuth.scheme).toBe('bearer')
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm run test:server -- --testPathPattern=docs
```

Expected: FAIL with `Cannot find module '../../src/docs-builder'`

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/server/tests/docs.test.ts
git commit -m "test(docs): failing test for generateSpec"
```

---

## Task 7: Implement docs-builder.ts

**Files:**
- Create: `packages/server/src/docs-builder.ts`

`@fastify/swagger` must be registered BEFORE routes to capture them via its `onRoute` hook. Because `buildApp` registers routes internally, `docs-builder.ts` creates its own Fastify instance and sets up routes in the correct order: swagger first, then routes. `registerSharedSchemas` is called between them — schemas are not routes and order does not matter for schema registration.

The `main()` block runs when the file is executed directly (`ts-node`) but not when imported by tests (`require.main !== module`).

- [ ] **Step 1: Create docs-builder.ts**

```typescript
import Fastify from 'fastify'
import fastifySwagger from '@fastify/swagger'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore } from '@eliph/core'
import { registerSharedSchemas } from './app'
import { keysRoutes } from './routes/keys'
import { proceduresRoutes } from './routes/procedures'
import { sessionsRoutes } from './routes/sessions'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

export async function generateSpec(): Promise<object> {
  const stores = {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore: new InMemoryApiKeyStore(),
  }

  const app = Fastify()

  app.register(fastifySwagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Eliph API',
        description: 'Automata-driven agent workflow engine',
        version: '0.1.0',
      },
      components: {
        securitySchemes: {
          BearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
    },
  })

  registerSharedSchemas(app)
  app.register(keysRoutes(stores.apiKeyStore))
  app.register(proceduresRoutes(stores.workflowStore, stores.sessionStore))
  app.register(sessionsRoutes(stores.workflowStore, stores.sessionStore))

  await app.ready()
  return app.swagger()
}

async function main() {
  const spec = await generateSpec()
  const outDir = resolve(__dirname, '../../../docs-site')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(resolve(outDir, 'openapi.json'), JSON.stringify(spec, null, 2))
  writeFileSync(resolve(outDir, 'index.html'), swaggerUiHtml())
  console.log(`Docs generated in ${outDir}`)
}

function swaggerUiHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Eliph API Docs</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
window.onload = () => {
  SwaggerUIBundle({
    url: './openapi.json',
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
    layout: 'BaseLayout',
    deepLinking: true
  })
}
</script>
</body>
</html>`
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
```

- [ ] **Step 2: Run the test to confirm it passes**

```bash
npm run test:server -- --testPathPattern=docs
```

Expected: all 4 tests PASS.

- [ ] **Step 3: Run the full test suite to confirm no regressions**

```bash
npm test
```

Expected: all tests across core, server, mcp pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/docs-builder.ts
git commit -m "feat(docs): implement generateSpec and docs-builder main"
```

---

## Task 8: Wire up npm run docs and verify output

**Files:**
- Modify: `package.json` (root)
- Create: `.gitignore`

- [ ] **Step 1: Add docs script to root package.json**

Replace the `scripts` block in `package.json`:

```json
{
  "name": "eliph",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "jest",
    "test:core": "jest --selectProjects core",
    "test:server": "jest --selectProjects server",
    "test:mcp": "jest --selectProjects mcp",
    "docs": "ts-node -T packages/server/src/docs-builder.ts"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@types/node": "^20.0.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "ts-node": "^10.9.0",
    "typescript": "^5.4.0"
  }
}
```

(`-T` = transpile-only, skips type checking so ts-node doesn't error on rootDir constraints.)

- [ ] **Step 2: Create .gitignore**

Create `.gitignore` at the repo root:

```
node_modules/
dist/
docs-site/
```

- [ ] **Step 3: Run npm run docs**

```bash
npm run docs
```

Expected output:
```
Docs generated in /path/to/eliph/docs-site
```

- [ ] **Step 4: Verify the output files exist and are valid**

```bash
ls docs-site/
```

Expected: `index.html  openapi.json`

```bash
node -e "const s = require('./docs-site/openapi.json'); console.log(Object.keys(s.paths).join('\n'))"
```

Expected: all 12 paths printed (e.g. `/keys`, `/procedures`, `/procedure/{name}`, etc.)

- [ ] **Step 5: Open the docs in a browser to verify Swagger UI loads**

```bash
open docs-site/index.html
```

Expected: Swagger UI renders with Keys, Procedures, Sessions sections and a working "Authorize" button.

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore
git commit -m "feat(docs): wire up npm run docs and add .gitignore"
```
