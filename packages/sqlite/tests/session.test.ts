import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createStores, SqliteSessionStore } from '../src/index'
import { openDb } from '../src/db'
import { Session } from '@eliph/core'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    workflowName: 'flow',
    workflowOwnerId: 'owner-1',
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

describe('SqliteSessionStore data, events and updatedAt', () => {
  it('round-trips data and events', async () => {
    const s = createStores(':memory:').sessionStore
    const session = makeSession({
      data: { pr: 'https://example.test/1', nested: { list: [1, { a: 'b' }] } },
      events: [{ type: 'created', to: 'start', at: '2026-01-01T00:00:00.000Z' }],
    })
    await s.save(session)
    const result = await s.get('sess-1')
    expect(result!.data).toEqual(session.data)
    expect(result!.events).toEqual(session.events)
  })

  it('returns updatedAt from the updated_at column', async () => {
    const s = createStores(':memory:').sessionStore
    const before = Date.now()
    await s.save(makeSession())
    const result = await s.get('sess-1')
    expect(result!.updatedAt).toBeInstanceOf(Date)
    expect(result!.updatedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000)
  })
})

describe('SqliteSessionStore.list', () => {
  async function seeded() {
    const s = createStores(':memory:').sessionStore
    await s.save(makeSession({ id: 'old', workflowOwnerId: 'org', createdAt: new Date('2026-01-01T00:00:00.000Z') }))
    await s.save(makeSession({ id: 'new', workflowOwnerId: 'org', createdAt: new Date('2026-01-03T00:00:00.000Z') }))
    await s.save(makeSession({ id: 'legacy', workflowOwnerId: 'key-1', workflowName: 'other', createdAt: new Date('2026-01-02T00:00:00.000Z') }))
    await s.save(makeSession({ id: 'foreign', workflowOwnerId: 'other-org', createdAt: new Date('2026-01-04T00:00:00.000Z') }))
    return s
  }

  it('returns only the given owners, newest first', async () => {
    const s = await seeded()
    const result = await s.list(['org', 'key-1'])
    expect(result.map(x => x.id)).toEqual(['new', 'legacy', 'old'])
    expect(result[0].createdAt).toEqual(new Date('2026-01-03T00:00:00.000Z'))
  })

  it('returns nothing for no owners', async () => {
    expect(await (await seeded()).list([])).toEqual([])
  })

  it('filters by workflow and pages with limit/offset', async () => {
    const s = await seeded()
    expect((await s.list(['org', 'key-1'], { workflowName: 'other' })).map(x => x.id)).toEqual(['legacy'])
    expect((await s.list(['org', 'key-1'], { limit: 2 })).map(x => x.id)).toEqual(['new', 'legacy'])
    expect((await s.list(['org', 'key-1'], { limit: 2, offset: 2 })).map(x => x.id)).toEqual(['old'])
    expect((await s.list(['org', 'key-1'], { offset: 1 })).map(x => x.id)).toEqual(['legacy', 'old'])
  })

  it('follows an owner change on re-save', async () => {
    const s = await seeded()
    await s.save(makeSession({ id: 'old', workflowOwnerId: 'other-org', createdAt: new Date('2026-01-01T00:00:00.000Z') }))
    expect((await s.list(['org'])).map(x => x.id)).toEqual(['new'])
  })
})

describe('sessions.owner_id migration on an old-schema database', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eliph-sessions-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  // The sessions table exactly as created by the previous release
  function createOldDb(path: string) {
    const db = new Database(path)
    db.exec(`
      CREATE TABLE sessions (
        id            TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        current_state TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        data          TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_workflow_state ON sessions(workflow_name, current_state);
    `)
    const insert = db.prepare('INSERT INTO sessions (id, workflow_name, current_state, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)')
    const oldBlob = (id: string, owner: string, createdAt: string) => JSON.stringify({
      id, workflowName: 'flow', workflowOwnerId: owner, currentState: 'start', history: ['start'], createdAt,
    })
    insert.run('a', 'flow', 'start', '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z', oldBlob('a', 'org', '2026-01-01T00:00:00.000Z'))
    insert.run('b', 'flow', 'start', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', oldBlob('b', 'key-1', '2026-01-02T00:00:00.000Z'))
    insert.run('c', 'flow', 'start', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', oldBlob('c', 'other-org', '2026-01-03T00:00:00.000Z'))
    insert.run('bad', 'flow', 'start', '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z', 'not json')
    db.close()
  }

  it('adds owner_id, backfills it from the JSON blob and keeps old rows readable', async () => {
    const path = join(dir, 'old.db')
    createOldDb(path)
    const db = openDb(path)
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('owner_id')
    const owners = db.prepare('SELECT id, owner_id FROM sessions ORDER BY id').all()
    expect(owners).toEqual([
      { id: 'a', owner_id: 'org' },
      { id: 'b', owner_id: 'key-1' },
      { id: 'bad', owner_id: null },
      { id: 'c', owner_id: 'other-org' },
    ])
    const store = new SqliteSessionStore(db)
    expect((await store.list(['org', 'key-1'])).map(s => s.id)).toEqual(['b', 'a'])
    const old = await store.get('a')
    expect(old!.data).toBeUndefined()
    expect(old!.events).toBeUndefined()
    expect(old!.updatedAt).toEqual(new Date('2026-01-05T00:00:00.000Z'))
    db.close()
  })

  it('is idempotent across reopenings and backfills rows written without owner_id', () => {
    const path = join(dir, 'old.db')
    createOldDb(path)
    openDb(path).close()
    // A row written by an older release (no owner_id) after the migration ran
    const raw = new Database(path)
    raw.prepare('INSERT INTO sessions (id, workflow_name, current_state, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run('late', 'flow', 'start', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z',
        JSON.stringify({ id: 'late', workflowName: 'flow', workflowOwnerId: 'org', currentState: 'start', history: ['start'], createdAt: '2026-02-01T00:00:00.000Z' }))
    raw.close()
    const db = openDb(path)
    expect(db.prepare('SELECT owner_id FROM sessions WHERE id = ?').get('late')).toEqual({ owner_id: 'org' })
    const indexes = (db.prepare('PRAGMA index_list(sessions)').all() as { name: string }[]).map(i => i.name)
    expect(indexes).toContain('idx_sessions_owner_created')
    db.close()
  })
})
