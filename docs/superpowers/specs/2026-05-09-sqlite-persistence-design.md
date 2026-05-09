# SQLite Persistence — Design Spec

**Date:** 2026-05-09
**Status:** Approved

---

## Goal

Replace in-memory stores with SQLite-backed implementations so data survives server restarts. The existing `IWorkflowStore`, `ISessionStore`, and `IApiKeyStore` interfaces from `@eliph/core` remain unchanged — only the implementations swap.

---

## Architecture

A new `packages/sqlite` package contains three store classes, each implementing the existing interfaces from `@eliph/core`. A single `createStores(dbPath)` factory opens the SQLite connection, runs schema setup, and returns all three stores sharing that one connection.

`packages/server/src/index.ts` is updated to call `createStores('./eliph.db')` instead of the in-memory stores. The rest of the server — routes, middleware, app factory — is untouched.

`better-sqlite3` is the SQLite driver (synchronous API, excellent TypeScript support). The async store interfaces are satisfied by wrapping synchronous calls.

---

## Package Structure

```
packages/sqlite/
  src/
    db.ts          — opens connection, runs CREATE TABLE IF NOT EXISTS + indexes
    workflow.ts    — SqliteWorkflowStore implements IWorkflowStore
    session.ts     — SqliteSessionStore implements ISessionStore
    apikey.ts      — SqliteApiKeyStore implements IApiKeyStore
    index.ts       — exports all three classes + createStores(dbPath)
  tests/
    workflow.test.ts
    session.test.ts
    apikey.test.ts
  package.json
  tsconfig.json
```

`createStores(dbPath)` is the only public entry point. It opens the DB, runs migrations, and returns `{ workflowStore, sessionStore, apiKeyStore }` ready to pass into `buildApp`.

---

## Schema

### workflows
| Column | Type | Notes |
|--------|------|-------|
| `name` | TEXT PRIMARY KEY | workflow name |
| `description` | TEXT | duplicated from data for inspection |
| `created_at` | TEXT | ISO 8601 |
| `updated_at` | TEXT | ISO 8601, updated on every save |
| `data` | TEXT | full `WorkflowGraph` as JSON — source of truth |

### sessions
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PRIMARY KEY | UUID |
| `workflow_name` | TEXT | duplicated from data for filtering |
| `current_state` | TEXT | duplicated from data for filtering |
| `created_at` | TEXT | ISO 8601 |
| `updated_at` | TEXT | ISO 8601, updated on every save |
| `data` | TEXT | full `Session` as JSON — source of truth |

**Index:** `sessions(workflow_name, current_state)` — used by `findByState`.

### api_keys
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PRIMARY KEY | UUID |
| `label` | TEXT | human-readable name |
| `created_at` | TEXT | ISO 8601 |
| `key_hash` | TEXT | bcrypt hash of raw key |

No `updated_at` — keys are created and deleted, never updated.

---

## Data Flow

**Reads** (`get`, `find`, `list`, `search`, `findByState`):
- Run `SELECT`, parse `data` JSON blob into domain object, return it

**Writes** (`save`, `create`):
- Serialize full domain object to JSON
- `INSERT OR REPLACE` with both metadata columns and JSON blob
- Set `updated_at` to current ISO timestamp

**Deletes** (`delete`):
- `DELETE WHERE id = ?`

**`findByState`** uses the index: `SELECT data FROM sessions WHERE workflow_name = ? AND current_state = ?` — no in-process filtering needed.

**`find` on api_keys** (bcrypt check): fetch all key hashes, compare in-process — unavoidable since bcrypt can't be done in SQL.

---

## Schema Setup

`db.ts` runs all `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statements on startup. No separate migration tool. Adding columns later means adding `ALTER TABLE` statements in the same file.

---

## Files Changed

| File | Action |
|------|--------|
| `packages/sqlite/package.json` | Create |
| `packages/sqlite/tsconfig.json` | Create |
| `packages/sqlite/src/db.ts` | Create |
| `packages/sqlite/src/workflow.ts` | Create |
| `packages/sqlite/src/session.ts` | Create |
| `packages/sqlite/src/apikey.ts` | Create |
| `packages/sqlite/src/index.ts` | Create |
| `packages/sqlite/tests/workflow.test.ts` | Create |
| `packages/sqlite/tests/session.test.ts` | Create |
| `packages/sqlite/tests/apikey.test.ts` | Create |
| `packages/server/package.json` | Add `@eliph/sqlite: *` dependency |
| `packages/server/src/index.ts` | Switch to `createStores('./eliph.db')` |
| `jest.config.ts` | Add sqlite project |

---

## Testing

All tests use `':memory:'` (in-memory SQLite) — fast, isolated, no files on disk.

**WorkflowStore:** save/retrieve, search by name, search by description, overwrite existing, delete

**SessionStore:** save/retrieve, findByState returns correct sessions, findByState ignores other workflows, update currentState persists correctly

**ApiKeyStore:** create returns rawKey, find with correct key returns record, find with wrong key returns null, list excludes key hash, delete removes record

---

## What Is Not In Scope

- Migration tooling (no schema versioning, no rollbacks)
- Postgres implementation (separate package, separate spec)
- DynamoDB implementation (separate package, separate spec)
- Connection pooling (single connection is sufficient for this use case)
