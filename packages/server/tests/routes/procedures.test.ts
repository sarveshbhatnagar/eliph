import { buildApp } from '../../src/app'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore, InMemoryOrgKeyStore, InMemoryUsageStore } from '@eliph/core'

async function makeAuthedApp() {
  const orgKeyStore = new InMemoryOrgKeyStore()
  const apiKeyStore = new InMemoryApiKeyStore(orgKeyStore)
  const { record: org } = await orgKeyStore.create('test-org', 100)
  const stores = {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore,
    orgKeyStore,
    usageStore: new InMemoryUsageStore(),
  }
  const { rawKey, record } = await stores.apiKeyStore.create('test', org.id)
  const app = buildApp(stores)
  await app.ready()
  return { app, stores, rawKey, apiKeyId: record.id }
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
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    await stores.workflowStore.save({
      name: 'flow', description: 'test', states: { start: { name: 'start', isTerminal: false } }, transitions: [],
    }, apiKeyId)
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
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    await stores.workflowStore.save({ name: 'onboarding', description: 'user onboarding', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }, apiKeyId)
    const res = await app.inject({ method: 'GET', url: '/procedures?q=onboard', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    expect(res.json().map((r: any) => r.name)).toContain('onboarding')
  })
})

describe('POST /procedure/:name/transition', () => {
  it('adds a transition to a workflow', async () => {
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    await stores.workflowStore.save({ name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }, apiKeyId)
    const res = await app.inject({
      method: 'POST', url: '/procedure/flow/transition',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ transition: 'start -> review' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().transitions).toHaveLength(1)
  })

  it('returns 400 for invalid transition string', async () => {
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    await stores.workflowStore.save({ name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }, apiKeyId)
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
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    const { addTransition } = await import('@eliph/core')
    let graph = { name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] as any[] }
    graph = addTransition(graph as any, 'start -> review') as any
    await stores.workflowStore.save(graph as any, apiKeyId)
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
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    const { addTransition } = await import('@eliph/core')
    let graph = { name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] as any[] }
    graph = addTransition(graph as any, 'start -> review') as any
    await stores.workflowStore.save(graph as any, apiKeyId)
    const res = await app.inject({
      method: 'DELETE', url: '/procedure/flow/state/review',
      headers: authed(rawKey),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().states.review).toBeUndefined()
  })

  it('returns 409 when active sessions are in the state', async () => {
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    const { addTransition } = await import('@eliph/core')
    let graph = { name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] as any[] }
    graph = addTransition(graph as any, 'start -> review') as any
    await stores.workflowStore.save(graph as any, apiKeyId)
    await stores.sessionStore.save({ id: 's1', workflowName: 'flow', workflowOwnerId: apiKeyId, currentState: 'review', history: ['start', 'review'], createdAt: new Date() })
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
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    await stores.workflowStore.save({ name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false }, review: { name: 'review', isTerminal: false } }, transitions: [] }, apiKeyId)
    const res = await app.inject({ method: 'GET', url: '/procedure/flow/states', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.map((s: any) => s.name)).toContain('start')
    expect(body.map((s: any) => s.name)).toContain('review')
  })
})
