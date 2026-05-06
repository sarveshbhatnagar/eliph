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
