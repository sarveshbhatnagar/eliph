import { buildApp } from '../../src/app'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore, InMemoryOrgKeyStore, InMemoryUsageStore, WorkflowGraph } from '@eliph/core'

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
  const apiKeyId = record.id
  await stores.workflowStore.save(baseGraph, apiKeyId)
  const app = buildApp(stores)
  await app.ready()
  return { app, stores, rawKey, apiKeyId }
}

function authed(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` }
}

function makeSession(overrides: any) {
  return { workflowOwnerId: 'test-owner', ...overrides, createdAt: new Date() }
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
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    await stores.sessionStore.save(makeSession({ id: 's1', workflowName: 'flow', workflowOwnerId: apiKeyId, currentState: 'start', history: ['start'] }))
    const res = await app.inject({ method: 'DELETE', url: '/session/s1', headers: authed(rawKey) })
    expect(res.statusCode).toBe(204)
  })
})

describe('GET /session/:id/state', () => {
  it('returns current state and next transitions', async () => {
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    await stores.sessionStore.save(makeSession({ id: 's1', workflowName: 'flow', workflowOwnerId: apiKeyId, currentState: 'start', history: ['start'] }))
    const res = await app.inject({ method: 'GET', url: '/session/s1/state?workflow=flow', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.currentState).toBe('start')
    expect(body.nextTransitions).toHaveLength(1)
  })
})

describe('GET /session/:id/next', () => {
  it('returns next valid transitions', async () => {
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    await stores.sessionStore.save(makeSession({ id: 's1', workflowName: 'flow', workflowOwnerId: apiKeyId, currentState: 'start', history: ['start'] }))
    const res = await app.inject({ method: 'GET', url: '/session/s1/next?workflow=flow', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body[0].to).toBe('review')
    expect(body[0].type).toBe('deterministic')
  })
})

describe('POST /session/:id/advance', () => {
  it('advances a deterministic session', async () => {
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    await stores.sessionStore.save(makeSession({ id: 's1', workflowName: 'flow', workflowOwnerId: apiKeyId, currentState: 'start', history: ['start'] }))
    const res = await app.inject({
      method: 'POST', url: '/session/s1/advance',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'flow' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('review')
  })

  it('advances a symbolic session with completed_action', async () => {
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    const symbolicGraph: WorkflowGraph = {
      name: 'sym', description: '', states: { start: { name: 'start', isTerminal: false }, done: { name: 'done', isTerminal: false } },
      transitions: [{ from: 'start', to: 'done', type: 'symbolic', action: 'check_done' }],
    }
    await stores.workflowStore.save(symbolicGraph, apiKeyId)
    await stores.sessionStore.save(makeSession({ id: 's2', workflowName: 'sym', workflowOwnerId: apiKeyId, currentState: 'start', history: ['start'] }))
    const res = await app.inject({
      method: 'POST', url: '/session/s2/advance',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'sym', completed_action: 'check_done' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('done')
  })

  it('returns 400 when symbolic transition requires completed_action', async () => {
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    const symbolicGraph: WorkflowGraph = {
      name: 'sym2', description: '', states: { start: { name: 'start', isTerminal: false }, done: { name: 'done', isTerminal: false } },
      transitions: [{ from: 'start', to: 'done', type: 'symbolic', action: 'check_done' }],
    }
    await stores.workflowStore.save(symbolicGraph, apiKeyId)
    await stores.sessionStore.save(makeSession({ id: 's3', workflowName: 'sym2', workflowOwnerId: apiKeyId, currentState: 'start', history: ['start'] }))
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
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    await stores.sessionStore.save(makeSession({ id: 's1', workflowName: 'flow', workflowOwnerId: apiKeyId, currentState: 'review', history: ['start', 'review'] }))
    const res = await app.inject({
      method: 'POST', url: '/session/s1/reset',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'flow' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('start')
  })

  it('resets session to a target state', async () => {
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    await stores.sessionStore.save(makeSession({ id: 's1', workflowName: 'flow', workflowOwnerId: apiKeyId, currentState: 'end', history: ['start', 'review', 'end'] }))
    const res = await app.inject({
      method: 'POST', url: '/session/s1/reset',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'flow', target_state: 'review' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('review')
  })
})
