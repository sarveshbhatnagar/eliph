# Automated Docs Site — Design Spec

**Date:** 2026-05-09
**Status:** Approved

---

## Goal

Generate a Swagger UI documentation site automatically from the existing Fastify route definitions in `packages/server`. The output is a self-contained static folder (`docs-site/`) that can be deployed to GitHub Pages, Netlify, S3, or any static host — separate from the running API server for security reasons.

---

## Architecture

Three pieces:

### 1. Server Augmentation (`packages/server`)

Shared response shapes are registered as named schemas on the Fastify instance via `app.addSchema()` calls inside `buildApp`. This is purely validator metadata — it exposes no routes and is safe in production.

- `WorkflowGraph` — `{ name, description, states, transitions }`
- `Transition` — `{ from, to, type, weight?, action? }`
- `State` — `{ name, isTerminal }`
- `Session` — `{ id, workflowName, currentState, history, createdAt }`
- `ApiKey` — `{ id, label, createdAt }`

These are `$ref`'d from route schemas so Swagger UI renders them as named models, not anonymous inline objects.

A `securitySchemes` definition (`BearerAuth: http bearer`) is added in the swagger plugin config. All routes except `POST /keys` declare `security: [{ BearerAuth: [] }]`, matching the actual auth middleware behaviour.

### 2. Route Schema Annotations (`packages/server/src/routes/`)

Each route in `keys.ts`, `procedures.ts`, and `sessions.ts` gets a `schema` block covering:

- `tags` — groups routes in Swagger UI (`Keys`, `Procedures`, `Sessions`)
- `summary` — one-line description
- `params` — path parameters (where applicable)
- `querystring` — query parameters (where applicable)
- `body` — request body shape (where applicable)
- `response` — success response shape keyed by status code

### 3. Build Script (`scripts/build-docs.ts`)

Runs via `npm run docs`. Does not start a server or open a port. `@fastify/swagger` is registered here only — never in `buildApp` — so the production server never exposes `/documentation` routes.

Steps:
1. Import `buildApp` from `packages/server` with in-memory stores
2. Register `@fastify/swagger` on the returned app instance
3. Call `app.ready()` to initialise all plugins
4. Call `app.swagger()` to get the OpenAPI object in-process
5. Write `docs-site/openapi.json`
6. Write `docs-site/index.html` — minimal Swagger UI HTML loading `openapi.json` from the same directory

---

## File Changes

| File | Change |
|------|--------|
| `packages/server/package.json` | Add `@fastify/swagger` dependency |
| `packages/server/src/app.ts` | Register shared named schemas via `addSchema` (no swagger plugin) |
| `packages/server/src/routes/keys.ts` | Add schema blocks to all 3 routes |
| `packages/server/src/routes/procedures.ts` | Add schema blocks to all 6 routes |
| `packages/server/src/routes/sessions.ts` | Add schema blocks to all 6 routes |
| `scripts/build-docs.ts` | New — build script |
| `package.json` | Add `"docs": "ts-node scripts/build-docs.ts"` script |
| `.gitignore` | Add `docs-site/` (or commit it, depending on deploy strategy) |

---

## Output

```
docs-site/
  index.html    ← Swagger UI
  openapi.json  ← Generated OpenAPI 3.0 spec
```

Running `npm run docs` regenerates both files from scratch. The output is fully static — no server required to view it.

---

## Deployment

Drop `docs-site/` anywhere that serves static files. For GitHub Pages: either commit the folder or add a CI step that runs `npm run docs` and pushes the output to the `gh-pages` branch.

---

## What Is Not In Scope

- Prose guides or conceptual documentation (separate effort)
- Auto-deploy CI pipeline (out of scope for this spec)
- Serving docs from the live API server (intentionally excluded for security)
