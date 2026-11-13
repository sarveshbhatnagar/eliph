import { buildApp } from '../../src/app'
import { ADMIN_OWNER_ID } from '../../src/middleware/auth'
import {
  InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore, InMemoryOrgKeyStore, InMemoryUsageStore,
  WorkflowGraph, SESSION_DATA_MAX_BYTES,
} from '@eliph/core'

const graph: WorkflowGraph = {
  name: 'flow',
  description: '',
  states: {
    start: { name: 'start', isTerminal: false, description: 'Gather the ticket' },
    review: { name: 'review', isTerminal: false, description: 'Review the change' },
    end: { name: 'end', isTerminal: true },
  },
  transitions: [
    { from: 'start', to: 'review', type: 'symbolic', action: 'gathered' },
    { from: 'review', to: 'end', type: 'deterministic' },
  ],
}

const nested = {
  ticket: { id: 42, links: ['https://example.test/a', 'https://example.test/b'] },
  decisions: [{ what: 'use sqlite', why: null, tags: ['db', { deep: { deeper: [1, 2.5, true, 'x'] } }] }],
  empty: {},
  emptyList: [],
  unicode: 'héllo ✓',
}

async function setup() {
  const orgKeyStore = new InMemoryOrgKeyStore()
  const apiKeyStore = new InMemoryApiKeyStore(orgKeyStore)
  const stores = {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore,
    orgKeyStore,
    usageStore: new InMemoryUsageStore(),
  }
  const { record: org, rawKey: orgRawKey } = await orgKeyStore.create('org', 100)
  const { record: key, rawKey } = await apiKeyStore.create('main', org.id)
  const { record: otherOrg, rawKey: otherOrgRawKey } = await orgKeyStore.create('other', 100)
  const { rawKey: otherRawKey } = await apiKeyStore.create('intruder', otherOrg.id)
  await stores.workflowStore.save(graph, org.id)
  await stores.workflowStore.save(graph, otherOrg.id)
  const app = buildApp(stores)
  await app.ready()
  return { app, stores, org, key, rawKey, orgRawKey, otherOrg, otherRawKey, otherOrgRawKey }
}

function auth(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` }
}

function json(rawKey: string) {
  return { ...auth(rawKey), 'content-type': 'application/json' }
}

// A session as stored by a release before data/events existed
function oldSession(id: string, owner: string, extra: object = {}) {
  return { id, workflowName: 'flow', workflowOwnerId: owner, currentState: 'start', history: ['start'], createdAt: new Date(), ...extra }
}

async function create(app: any, rawKey: string, body: object = { workflow: 'flow' }) {
  return app.inject({ method: 'POST', url: '/session', headers: json(rawKey), body: JSON.stringify(body) })
}

describe('step context on session responses', () => {
  it('POST /session returns state description, isTerminal, nextTransitions, data and warnings', async () => {
    const { app, rawKey } = await setup()
    const res = await create(app, rawKey)
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.currentState).toBe('start')
    expect(body.history).toEqual(['start'])
    expect(body.createdAt).toBeDefined()
    expect(body.stateDescription).toBe('Gather the ticket')
    expect(body.isTerminal).toBe(false)
    expect(body.nextTransitions).toEqual([{ from: 'start', to: 'review', type: 'symbolic', action: 'gathered' }])
    expect(body.data).toEqual({})
    expect(body.warnings).toEqual([])
    // events are only on GET /session/:id/state
    expect(body.events).toBeUndefined()
  })

  it('POST /session/:id/advance returns the step context of the new state', async () => {
    const { app, rawKey } = await setup()
    const id = (await create(app, rawKey)).json().id
    const res = await app.inject({ method: 'POST', url: `/session/${id}/advance`, headers: json(rawKey), body: JSON.stringify({ completed_action: 'gathered' }) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ id, currentState: 'review', history: ['start', 'review'], workflowName: 'flow' })
    expect(body.stateDescription).toBe('Review the change')
    expect(body.isTerminal).toBe(false)
    expect(body.nextTransitions).toEqual([{ from: 'review', to: 'end', type: 'deterministic' }])
    expect(body.data).toEqual({})
    expect(body.events).toBeUndefined()

    const done = await app.inject({ method: 'POST', url: `/session/${id}/advance`, headers: json(rawKey), body: '{}' })
    expect(done.json()).toMatchObject({ currentState: 'end', stateDescription: null, isTerminal: true, nextTransitions: [] })
  })

  it('POST /session/:id/reset returns the step context of the target state', async () => {
    const { app, rawKey } = await setup()
    const id = (await create(app, rawKey)).json().id
    const res = await app.inject({ method: 'POST', url: `/session/${id}/reset`, headers: json(rawKey), body: JSON.stringify({ target_state: 'review' }) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      currentState: 'review',
      stateDescription: 'Review the change',
      isTerminal: false,
      nextTransitions: [{ from: 'review', to: 'end', type: 'deterministic' }],
      data: {},
    })
  })

  it('advance and reset still work with an empty body', async () => {
    const { app, stores, rawKey, org } = await setup()
    await stores.sessionStore.save(oldSession('s1', org.id, { currentState: 'review', history: ['start', 'review'] }))
    const adv = await app.inject({ method: 'POST', url: '/session/s1/advance', headers: json(rawKey), body: '{}' })
    expect(adv.statusCode).toBe(200)
    expect(adv.json().currentState).toBe('end')
    const reset = await app.inject({ method: 'POST', url: '/session/s1/reset', headers: json(rawKey), body: '{}' })
    expect(reset.statusCode).toBe(200)
    expect(reset.json().currentState).toBe('start')
  })
})

describe('session data', () => {
  it('accepts initial data on create and nested JSON survives the HTTP round trip', async () => {
    const { app, rawKey } = await setup()
    const res = await create(app, rawKey, { workflow: 'flow', data: nested })
    expect(res.statusCode).toBe(201)
    expect(res.json().data).toEqual(JSON.parse(JSON.stringify(nested)))
    const state = await app.inject({ method: 'GET', url: `/session/${res.json().id}/state`, headers: auth(rawKey) })
    expect(state.json().data).toEqual(JSON.parse(JSON.stringify(nested)))
  })

  it('advance shallow-merges data and null removes a key', async () => {
    const { app, rawKey } = await setup()
    const id = (await create(app, rawKey, { workflow: 'flow', data: { a: 1, b: { x: 1 }, gone: true } })).json().id
    const res = await app.inject({
      method: 'POST', url: `/session/${id}/advance`, headers: json(rawKey),
      body: JSON.stringify({ completed_action: 'gathered', data: { b: { y: [2] }, gone: null, c: 'new' } }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ a: 1, b: { y: [2] }, c: 'new' })
  })

  it('reset merges data too', async () => {
    const { app, rawKey } = await setup()
    const id = (await create(app, rawKey, { workflow: 'flow', data: { a: 1 } })).json().id
    const res = await app.inject({ method: 'POST', url: `/session/${id}/reset`, headers: json(rawKey), body: JSON.stringify({ data: { r: true } }) })
    expect(res.json().data).toEqual({ a: 1, r: true })
  })

  it('PATCH /session/:id/data merges without changing state and returns the full session', async () => {
    const { app, stores, rawKey } = await setup()
    const id = (await create(app, rawKey, { workflow: 'flow', data: { a: 1, b: 2 } })).json().id
    const res = await app.inject({ method: 'PATCH', url: `/session/${id}/data`, headers: json(rawKey), body: JSON.stringify({ data: { b: null, nested } }) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toEqual({ a: 1, nested: JSON.parse(JSON.stringify(nested)) })
    expect(body).toMatchObject({ id, currentState: 'start', history: ['start'], stateDescription: 'Gather the ticket', isTerminal: false })
    expect(body.nextTransitions).toHaveLength(1)
    const stored = await stores.sessionStore.get(id)
    expect(stored!.currentState).toBe('start')
    expect(stored!.events!.map(e => e.type)).toEqual(['created', 'data'])
  })

  it('PATCH data works on an old session without data', async () => {
    const { app, stores, rawKey, org } = await setup()
    await stores.sessionStore.save(oldSession('old', org.id))
    const res = await app.inject({ method: 'PATCH', url: '/session/old/data', headers: json(rawKey), body: JSON.stringify({ data: { k: 'v' } }) })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ k: 'v' })
  })

  it('PATCH data still works when the workflow was deleted (empty step context)', async () => {
    const { app, stores, rawKey, org } = await setup()
    await stores.sessionStore.save(oldSession('s1', org.id, { workflowName: 'gone' }))
    const res = await app.inject({ method: 'PATCH', url: '/session/s1/data', headers: json(rawKey), body: JSON.stringify({ data: { k: 1 } }) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { k: 1 }, stateDescription: null, isTerminal: false, nextTransitions: [] })
  })

  it('PATCH data requires a data object', async () => {
    const { app, rawKey } = await setup()
    const id = (await create(app, rawKey)).json().id
    for (const body of [{}, { data: [1] }, { data: 'x' }, { data: null }]) {
      const res = await app.inject({ method: 'PATCH', url: `/session/${id}/data`, headers: json(rawKey), body: JSON.stringify(body) })
      expect(res.statusCode).toBe(400)
    }
  })

  describe('size cap (64 KB)', () => {
    const big = { blob: 'x'.repeat(SESSION_DATA_MAX_BYTES) }

    it('rejects oversized initial data with 413 and creates nothing', async () => {
      const { app, stores, rawKey, org } = await setup()
      const res = await create(app, rawKey, { workflow: 'flow', data: big })
      expect(res.statusCode).toBe(413)
      expect(res.json().code).toBe('PAYLOAD_TOO_LARGE')
      expect(res.json().error).toContain('64 KB')
      expect(await stores.sessionStore.list([org.id])).toEqual([])
    })

    it('rejects an advance whose merged data is too large and leaves the session untouched', async () => {
      const { app, stores, rawKey } = await setup()
      const half = 'x'.repeat(SESSION_DATA_MAX_BYTES / 2)
      const id = (await create(app, rawKey, { workflow: 'flow', data: { a: half } })).json().id
      const res = await app.inject({
        method: 'POST', url: `/session/${id}/advance`, headers: json(rawKey),
        body: JSON.stringify({ completed_action: 'gathered', data: { b: half } }),
      })
      expect(res.statusCode).toBe(413)
      expect(res.json().code).toBe('PAYLOAD_TOO_LARGE')
      const stored = await stores.sessionStore.get(id)
      expect(stored!.currentState).toBe('start')
      expect(Object.keys(stored!.data!)).toEqual(['a'])
    })

    it('rejects oversized reset and PATCH data with 413', async () => {
      const { app, stores, rawKey } = await setup()
      const id = (await create(app, rawKey)).json().id
      const reset = await app.inject({ method: 'POST', url: `/session/${id}/reset`, headers: json(rawKey), body: JSON.stringify({ target_state: 'review', data: big }) })
      expect(reset.statusCode).toBe(413)
      const patch = await app.inject({ method: 'PATCH', url: `/session/${id}/data`, headers: json(rawKey), body: JSON.stringify({ data: big }) })
      expect(patch.statusCode).toBe(413)
      expect(patch.json().code).toBe('PAYLOAD_TOO_LARGE')
      const stored = await stores.sessionStore.get(id)
      expect(stored!.currentState).toBe('start')
      expect(stored!.data).toEqual({})
    })
  })

  describe('prototype pollution guard', () => {
    it.each([
      '{"workflow":"flow","data":{"__proto__":{"polluted":true}}}',
      '{"workflow":"flow","data":{"constructor":{"prototype":{"polluted":true}}}}',
      '{"workflow":"flow","data":{"a":{"prototype":1}}}',
    ])('rejects %s with 400', async (raw) => {
      const { app, rawKey } = await setup()
      const res = await app.inject({ method: 'POST', url: '/session', headers: json(rawKey), body: raw })
      expect(res.statusCode).toBe(400)
      expect(({} as any).polluted).toBeUndefined()
    })

    it('rejects __proto__ in a PATCH', async () => {
      const { app, rawKey } = await setup()
      const id = (await create(app, rawKey)).json().id
      const res = await app.inject({ method: 'PATCH', url: `/session/${id}/data`, headers: json(rawKey), body: '{"data":{"x":{"__proto__":{"polluted":true}}}}' })
      expect(res.statusCode).toBe(400)
      expect(({} as any).polluted).toBeUndefined()
    })
  })
})

describe('session events', () => {
  it('GET /session/:id/state returns data and the event log', async () => {
    const { app, rawKey } = await setup()
    const id = (await create(app, rawKey)).json().id
    await app.inject({ method: 'POST', url: `/session/${id}/advance`, headers: json(rawKey), body: JSON.stringify({ completed_action: 'gathered', note: 'ticket found' }) })
    await app.inject({ method: 'POST', url: `/session/${id}/reset`, headers: json(rawKey), body: JSON.stringify({ note: 'start over' }) })
    await app.inject({ method: 'PATCH', url: `/session/${id}/data`, headers: json(rawKey), body: JSON.stringify({ data: { k: 1 } }) })
    const res = await app.inject({ method: 'GET', url: `/session/${id}/state`, headers: auth(rawKey) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toEqual({ k: 1 })
    // history is unchanged in shape
    expect(body.history).toEqual(['start', 'review', 'start'])
    const events = body.events.map(({ at, ...rest }: any) => {
      expect(new Date(at).toISOString()).toBe(at)
      return rest
    })
    expect(events).toEqual([
      { type: 'created', to: 'start' },
      { type: 'advance', from: 'start', to: 'review', action: 'gathered', note: 'ticket found' },
      { type: 'reset', from: 'review', to: 'start', note: 'start over' },
      { type: 'data' },
    ])
  })

  it('an old session without data or events reads as {} and []', async () => {
    const { app, stores, rawKey, org } = await setup()
    await stores.sessionStore.save(oldSession('old', org.id))
    const res = await app.inject({ method: 'GET', url: '/session/old/state', headers: auth(rawKey) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ currentState: 'start', data: {}, events: [], stateDescription: 'Gather the ticket' })
    const adv = await app.inject({ method: 'POST', url: '/session/old/advance', headers: json(rawKey), body: JSON.stringify({ completed_action: 'gathered' }) })
    expect(adv.statusCode).toBe(200)
    expect(adv.json().data).toEqual({})
    const after = await app.inject({ method: 'GET', url: '/session/old/state', headers: auth(rawKey) })
    expect(after.json().events.map((e: any) => e.type)).toEqual(['advance'])
  })

  it('rejects a note longer than 2000 characters and leaves the session untouched', async () => {
    const { app, stores, rawKey } = await setup()
    const id = (await create(app, rawKey)).json().id
    const res = await app.inject({
      method: 'POST', url: `/session/${id}/advance`, headers: json(rawKey),
      body: JSON.stringify({ completed_action: 'gathered', note: 'x'.repeat(2001) }),
    })
    expect(res.statusCode).toBe(400)
    expect((await stores.sessionStore.get(id))!.currentState).toBe('start')
    const ok = await app.inject({
      method: 'POST', url: `/session/${id}/reset`, headers: json(rawKey),
      body: JSON.stringify({ note: 'x'.repeat(2000) }),
    })
    expect(ok.statusCode).toBe(200)
  })
})

describe('PATCH /session/:id/data access control', () => {
  it('another org gets 404 and the session is untouched', async () => {
    const { app, stores, rawKey, otherRawKey, otherOrgRawKey } = await setup()
    const id = (await create(app, rawKey, { workflow: 'flow', data: { mine: true } })).json().id
    for (const key of [otherRawKey, otherOrgRawKey]) {
      const res = await app.inject({ method: 'PATCH', url: `/session/${id}/data`, headers: json(key), body: JSON.stringify({ data: { stolen: true } }) })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' })
    }
    expect((await stores.sessionStore.get(id))!.data).toEqual({ mine: true })
  })

  it('an unknown session is 404', async () => {
    const { app, rawKey } = await setup()
    const res = await app.inject({ method: 'PATCH', url: '/session/nope/data', headers: json(rawKey), body: JSON.stringify({ data: {} }) })
    expect(res.statusCode).toBe(404)
  })

  it('the owning org key may patch a legacy session owned by one of its API keys', async () => {
    const { app, stores, org, orgRawKey } = await setup()
    const { record: legacyKey } = await stores.apiKeyStore.create('legacy', org.id)
    await stores.sessionStore.save(oldSession('legacy', legacyKey.id))
    const res = await app.inject({ method: 'PATCH', url: '/session/legacy/data', headers: json(orgRawKey), body: JSON.stringify({ data: { k: 1 } }) })
    expect(res.statusCode).toBe(200)
  })

  it('requires auth', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'PATCH', url: '/session/x/data', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: {} }) })
    expect(res.statusCode).toBe(401)
  })
})

describe('GET /sessions', () => {
  async function seeded() {
    const ctx = await setup()
    const { stores, org, otherOrg } = ctx
    const { record: legacyKey } = await stores.apiKeyStore.create('legacy', org.id)
    await stores.workflowStore.save(graph, legacyKey.id)
    const t = (n: number) => new Date(Date.UTC(2026, 0, n))
    await stores.sessionStore.save(oldSession('s-start', org.id, { createdAt: t(1) }))
    await stores.sessionStore.save(oldSession('s-done', org.id, { createdAt: t(2), currentState: 'end', history: ['start', 'review', 'end'], updatedAt: t(10) }))
    await stores.sessionStore.save(oldSession('s-legacy', legacyKey.id, { createdAt: t(3) }))
    await stores.sessionStore.save(oldSession('s-orphan', org.id, { createdAt: t(4), workflowName: 'deleted-flow' }))
    await stores.sessionStore.save(oldSession('s-foreign', otherOrg.id, { createdAt: t(5) }))
    await stores.sessionStore.save(oldSession('s-admin', ADMIN_OWNER_ID, { createdAt: t(6) }))
    return { ...ctx, legacyKey }
  }

  async function list(app: any, rawKey: string, qs = '') {
    const res = await app.inject({ method: 'GET', url: `/sessions${qs}`, headers: auth(rawKey) })
    expect(res.statusCode).toBe(200)
    return res.json() as any[]
  }

  it('lists the caller org sessions (including legacy api-key-owned ones), newest first', async () => {
    const { app, rawKey, orgRawKey } = await seeded()
    for (const key of [rawKey, orgRawKey]) {
      expect((await list(app, key)).map(s => s.id)).toEqual(['s-orphan', 's-legacy', 's-done', 's-start'])
    }
  })

  it('returns the documented item fields', async () => {
    const { app, rawKey } = await seeded()
    const items = await list(app, rawKey)
    const done = items.find(s => s.id === 's-done')
    expect(done).toEqual({
      id: 's-done',
      workflowName: 'flow',
      currentState: 'end',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-10T00:00:00.000Z',
      isTerminal: true,
    })
    const start = items.find(s => s.id === 's-start')
    expect(start).toEqual({ id: 's-start', workflowName: 'flow', currentState: 'start', createdAt: '2026-01-01T00:00:00.000Z', isTerminal: false })
  })

  it('never lists another org sessions', async () => {
    const { app, otherRawKey, otherOrgRawKey } = await seeded()
    for (const key of [otherRawKey, otherOrgRawKey]) {
      expect((await list(app, key)).map(s => s.id)).toEqual(['s-foreign'])
    }
  })

  it('admin sees only the admin namespace', async () => {
    const prev = process.env.ADMIN_SECRET
    process.env.ADMIN_SECRET = 'test-admin-secret'
    try {
      const { app } = await seeded()
      expect((await list(app, 'test-admin-secret')).map(s => s.id)).toEqual(['s-admin'])
    } finally {
      if (prev === undefined) delete process.env.ADMIN_SECRET
      else process.env.ADMIN_SECRET = prev
    }
  })

  it('filters by workflow', async () => {
    const { app, rawKey } = await seeded()
    expect((await list(app, rawKey, '?workflow=deleted-flow')).map(s => s.id)).toEqual(['s-orphan'])
    expect(await list(app, rawKey, '?workflow=none')).toEqual([])
  })

  it('filters by active: terminal and deleted-workflow sessions are not active', async () => {
    const { app, rawKey } = await seeded()
    expect((await list(app, rawKey, '?active=true')).map(s => s.id)).toEqual(['s-legacy', 's-start'])
    expect((await list(app, rawKey, '?active=false')).map(s => s.id)).toEqual(['s-orphan', 's-done'])
  })

  it('applies limit, default 50 and capped at 200', async () => {
    const { app, stores, rawKey, org } = await setup()
    for (let i = 0; i < 230; i++) {
      await stores.sessionStore.save(oldSession(`s${i}`, org.id, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) }))
    }
    expect(await list(app, rawKey, '?limit=2')).toHaveLength(2)
    expect((await list(app, rawKey, '?limit=2'))[0].id).toBe('s229')
    expect(await list(app, rawKey)).toHaveLength(50)
    expect(await list(app, rawKey, '?limit=1000')).toHaveLength(200)
    const bad = await app.inject({ method: 'GET', url: '/sessions?limit=0', headers: auth(rawKey) })
    expect(bad.statusCode).toBe(400)
  })

  it('with active, the limit counts matching sessions across pages', async () => {
    const { app, stores, rawKey, org } = await setup()
    // 250 newest finished sessions, then 3 active ones
    for (let i = 0; i < 3; i++) {
      await stores.sessionStore.save(oldSession(`a${i}`, org.id, { createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)) }))
    }
    for (let i = 0; i < 250; i++) {
      await stores.sessionStore.save(oldSession(`d${i}`, org.id, { currentState: 'end', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) }))
    }
    expect((await list(app, rawKey, '?active=true&limit=2')).map(s => s.id)).toEqual(['a2', 'a1'])
    expect(await list(app, rawKey, '?active=true')).toHaveLength(3)
  })

  it('lists sessions created through the API', async () => {
    const { app, rawKey, orgRawKey } = await setup()
    const id = (await create(app, rawKey)).json().id
    const items = await list(app, orgRawKey)
    expect(items.map(s => s.id)).toEqual([id])
    expect(items[0].updatedAt).toBeDefined()
  })

  it('requires auth', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'GET', url: '/sessions' })
    expect(res.statusCode).toBe(401)
  })
})
