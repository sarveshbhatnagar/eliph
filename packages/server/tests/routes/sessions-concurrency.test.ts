import { buildApp } from '../../src/app'
import { SESSION_WRITE_ATTEMPTS } from '../../src/routes/sessions'
import { createStores } from '@eliph/sqlite'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore, InMemoryOrgKeyStore, InMemoryUsageStore, Session } from '@eliph/core'

/**
 * SQLite stores whose session reads take a moment to come back after reading,
 * as a slower disk or a busy process would, so concurrent requests really
 * interleave between reading a session and saving it.
 */
function interleavingStores() {
  const stores = createStores(':memory:')
  const get = stores.sessionStore.get.bind(stores.sessionStore)
  stores.sessionStore.get = async (id: string) => {
    const session = await get(id)
    await new Promise(resolve => setTimeout(resolve, Math.random() * 3))
    return session
  }
  return stores
}

async function setup(transitions: string[]) {
  const stores = interleavingStores()
  const app = buildApp(stores)
  const org = await stores.orgKeyStore.create('org', 10)
  const { rawKey } = await stores.apiKeyStore.create('k', org.record.id)
  const headers = { authorization: `Bearer ${rawKey}` }
  await app.inject({ method: 'POST', url: '/procedure', headers, payload: { workflow_name: 'wf', description: 'd' } })
  for (const transition of transitions) {
    await app.inject({ method: 'POST', url: '/procedure/wf/transition', headers, payload: { transition } })
  }
  const session = (await app.inject({ method: 'POST', url: '/session', headers, payload: { workflow: 'wf' } })).json()
  return { app, stores, headers, orgId: org.record.id, sessionId: session.id as string }
}

describe('concurrent session writes (SQLite store)', () => {
  it('20 concurrent PATCH data calls with distinct keys all survive', async () => {
    const { app, stores, headers, sessionId } = await setup(['start -> end'])
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      app.inject({ method: 'PATCH', url: `/session/${sessionId}/data`, headers, payload: { data: { [`k${i}`]: i } } })))
    for (const res of responses) expect(res.statusCode).toBe(200)

    const expected = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))
    const state = (await app.inject({ url: `/session/${sessionId}/state`, headers })).json()
    expect(state.data).toEqual(expected)
    expect(state.events.filter((e: any) => e.type === 'data')).toHaveLength(20)
    const stored = await stores.sessionStore.get(sessionId)
    expect(stored!.revision).toBe(20)
  })

  it('two concurrent advances end where two sequential advances would', async () => {
    const { app, headers, sessionId } = await setup(['start -> mid', 'mid -> end'])
    const responses = await Promise.all([1, 2].map(() =>
      app.inject({ method: 'POST', url: `/session/${sessionId}/advance`, headers, payload: {} })))
    expect(responses.map(r => r.statusCode)).toEqual([200, 200])
    expect(responses.map(r => r.json().currentState).sort()).toEqual(['end', 'mid'])

    const state = (await app.inject({ url: `/session/${sessionId}/state`, headers })).json()
    expect(state.currentState).toBe('end')
    expect(state.history).toEqual(['start', 'mid', 'end'])
    expect(state.events.filter((e: any) => e.type === 'advance').map((e: any) => [e.from, e.to]))
      .toEqual([['start', 'mid'], ['mid', 'end']])
  })

  it('the second of two concurrent advances gets the normal error once the state is terminal', async () => {
    const { app, headers, sessionId } = await setup(['start -> end'])
    const responses = await Promise.all([1, 2].map(() =>
      app.inject({ method: 'POST', url: `/session/${sessionId}/advance`, headers, payload: {} })))
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 400])
    const failed = responses.find(r => r.statusCode === 400)!.json()
    expect(failed.code).toBe('BAD_REQUEST')
    expect(failed.error).toMatch(/terminal state "end"/)

    const state = (await app.inject({ url: `/session/${sessionId}/state`, headers })).json()
    expect(state.history).toEqual(['start', 'end'])
    expect(state.events.filter((e: any) => e.type === 'advance')).toHaveLength(1)
  })

  it('concurrent resets and data patches do not lose each other', async () => {
    const { app, headers, sessionId } = await setup(['start -> mid', 'mid -> end'])
    await app.inject({ method: 'POST', url: `/session/${sessionId}/advance`, headers, payload: {} })
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: `/session/${sessionId}/reset`, headers, payload: { data: { r: 1 } } }),
      app.inject({ method: 'PATCH', url: `/session/${sessionId}/data`, headers, payload: { data: { p: 1 } } }),
    ])
    expect(responses.map(r => r.statusCode)).toEqual([200, 200])
    const state = (await app.inject({ url: `/session/${sessionId}/state`, headers })).json()
    expect(state.currentState).toBe('start')
    expect(state.data).toEqual({ r: 1, p: 1 })
  })

  it('updates a session row stored before revisions existed', async () => {
    const { app, stores, headers, orgId } = await setup(['start -> mid', 'mid -> end'])
    const db = (stores.sessionStore as any).db
    const legacy = { id: 'legacy', workflowName: 'wf', workflowOwnerId: orgId, currentState: 'start', history: ['start'], createdAt: '2026-01-01T00:00:00.000Z' }
    db.prepare('INSERT INTO sessions (id, workflow_name, current_state, created_at, updated_at, data, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('legacy', 'wf', 'start', legacy.createdAt, legacy.createdAt, JSON.stringify(legacy), orgId)

    const patch = await app.inject({ method: 'PATCH', url: '/session/legacy/data', headers, payload: { data: { a: 1 } } })
    expect(patch.statusCode).toBe(200)
    const advance = await app.inject({ method: 'POST', url: '/session/legacy/advance', headers, payload: {} })
    expect(advance.statusCode).toBe(200)
    const reset = await app.inject({ method: 'POST', url: '/session/legacy/reset', headers, payload: {} })
    expect(reset.statusCode).toBe(200)

    const stored = await stores.sessionStore.get('legacy')
    expect(stored!.revision).toBe(3)
    expect(stored!.data).toEqual({ a: 1 })
    expect(stored!.history).toEqual(['start', 'mid', 'start'])
  })
})

describe('write conflicts that never resolve', () => {
  class AlwaysConflicting extends InMemorySessionStore {
    attempts = 0
    async saveIfRevision(_session: Session, _expected: number): Promise<boolean> {
      this.attempts++
      return false
    }
  }

  async function setupConflicting() {
    const orgKeyStore = new InMemoryOrgKeyStore()
    const apiKeyStore = new InMemoryApiKeyStore(orgKeyStore)
    const sessionStore = new AlwaysConflicting()
    const stores = { workflowStore: new InMemoryWorkflowStore(), sessionStore, apiKeyStore, orgKeyStore, usageStore: new InMemoryUsageStore() }
    const { record: org } = await orgKeyStore.create('org', 10)
    const { rawKey } = await apiKeyStore.create('k', org.id)
    await stores.workflowStore.save({
      name: 'wf', description: '',
      states: { start: { name: 'start', isTerminal: false }, end: { name: 'end', isTerminal: true } },
      transitions: [{ from: 'start', to: 'end', type: 'deterministic' }],
    }, org.id)
    await sessionStore.save({ id: 's', workflowName: 'wf', workflowOwnerId: org.id, currentState: 'start', history: ['start'], createdAt: new Date() })
    const app = buildApp(stores)
    await app.ready()
    return { app, sessionStore, headers: { authorization: `Bearer ${rawKey}` } }
  }

  it.each([
    ['POST', '/session/s/advance', {}],
    ['POST', '/session/s/reset', {}],
    ['PATCH', '/session/s/data', { data: { a: 1 } }],
  ])('%s %s answers 409 CONFLICT after the bounded retries and changes nothing', async (method, url, payload) => {
    const { app, sessionStore, headers } = await setupConflicting()
    const res = await app.inject({ method: method as any, url, headers, payload })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('CONFLICT')
    expect(typeof res.json().error).toBe('string')
    expect(sessionStore.attempts).toBe(SESSION_WRITE_ATTEMPTS)
    const stored = await sessionStore.get('s')
    expect(stored!.currentState).toBe('start')
    expect(stored!.data).toBeUndefined()
  })
})
