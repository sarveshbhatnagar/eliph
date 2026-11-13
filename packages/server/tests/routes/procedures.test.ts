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
  const { rawKey } = await stores.apiKeyStore.create('test', org.id)
  const app = buildApp(stores)
  await app.ready()
  return { app, stores, rawKey, apiKeyId: org.id } // owner namespace is the org id
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

describe('DELETE /procedure/:name/state/:state owner scoping', () => {
  it('ignores sessions of another org on a same-named workflow', async () => {
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    const { addTransition } = await import('@eliph/core')
    let graph = { name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] as any[] }
    graph = addTransition(graph as any, 'start -> review') as any
    await stores.workflowStore.save(graph as any, apiKeyId)
    await stores.workflowStore.save(graph as any, 'other-org')
    await stores.sessionStore.save({ id: 'foreign', workflowName: 'flow', workflowOwnerId: 'other-org', currentState: 'review', history: ['start', 'review'], createdAt: new Date() })
    const res = await app.inject({ method: 'DELETE', url: '/procedure/flow/state/review', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    expect(res.json().states.review).toBeUndefined()
  })
})

function jsonHeaders(rawKey: string) {
  return { ...authed(rawKey), 'content-type': 'application/json' }
}

describe('POST /procedure does not silently overwrite', () => {
  async function setupExisting() {
    const ctx = await makeAuthedApp()
    const { addTransition } = await import('@eliph/core')
    let graph: any = { name: 'flow', description: 'original', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }
    graph = addTransition(graph, 'start -> review -> end')
    await ctx.stores.workflowStore.save(graph, ctx.apiKeyId)
    return ctx
  }

  it('returns 409 CONFLICT and keeps the existing workflow', async () => {
    const { app, stores, rawKey, apiKeyId } = await setupExisting()
    const res = await app.inject({
      method: 'POST', url: '/procedure', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ workflow_name: 'flow', description: 'replacement' }),
    })
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.code).toBe('CONFLICT')
    expect(body.error).toContain('already exists')
    expect(body.error).toContain('overwrite: true')
    expect(body.error).toContain('different workflow_name')
    const stored = await stores.workflowStore.get('flow', apiKeyId)
    expect(stored!.description).toBe('original')
    expect(stored!.transitions).toHaveLength(2)
  })

  it('replaces the workflow when overwrite: true', async () => {
    const { app, stores, rawKey, apiKeyId } = await setupExisting()
    const res = await app.inject({
      method: 'POST', url: '/procedure', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ workflow_name: 'flow', description: 'replacement', overwrite: true }),
    })
    expect(res.statusCode).toBe(201)
    const stored = await stores.workflowStore.get('flow', apiKeyId)
    expect(stored!.description).toBe('replacement')
    expect(stored!.transitions).toHaveLength(0)
  })

  it('overwrite: false behaves like omitting it', async () => {
    const { app, rawKey } = await setupExisting()
    const res = await app.inject({
      method: 'POST', url: '/procedure', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ workflow_name: 'flow', description: 'x', overwrite: false }),
    })
    expect(res.statusCode).toBe(409)
  })

  it('does not conflict with a same-named workflow of another owner', async () => {
    const { app, stores, rawKey } = await makeAuthedApp()
    await stores.workflowStore.save({ name: 'flow', description: 'theirs', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }, 'other-org')
    const res = await app.inject({
      method: 'POST', url: '/procedure', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ workflow_name: 'flow', description: 'mine' }),
    })
    expect(res.statusCode).toBe(201)
    expect((await stores.workflowStore.get('flow', 'other-org'))!.description).toBe('theirs')
  })
})

describe('transition parsing through the API', () => {
  async function setupFlow() {
    const ctx = await makeAuthedApp()
    await ctx.stores.workflowStore.save({ name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }, ctx.apiKeyId)
    return ctx
  }

  it('treats a label with a numeric prefix as a symbolic action', async () => {
    const { app, rawKey } = await setupFlow()
    const res = await app.inject({
      method: 'POST', url: '/procedure/flow/transition', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ transition: 'start -2fa_done-> end' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().transitions[0]).toEqual({ from: 'start', to: 'end', type: 'symbolic', action: '2fa_done' })
  })

  it('accepts hyphenated action labels', async () => {
    const { app, rawKey } = await setupFlow()
    const res = await app.inject({
      method: 'POST', url: '/procedure/flow/transition', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ transition: 'start -tests-pass-> end' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().transitions[0]).toMatchObject({ type: 'symbolic', action: 'tests-pass' })
  })

  it.each(['start -1.5-> end', 'start -0-> end', 'start --0.5-> end'])('rejects out-of-range weight %s with 400', async (transition) => {
    const { app, stores, rawKey, apiKeyId } = await setupFlow()
    const res = await app.inject({
      method: 'POST', url: '/procedure/flow/transition', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ transition }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('greater than 0 and at most 1')
    expect((await stores.workflowStore.get('flow', apiKeyId))!.transitions).toHaveLength(0)
  })

  it('rejects a probabilistic transition that pushes the weights above 1.0 and saves nothing', async () => {
    const { app, stores, rawKey, apiKeyId } = await setupFlow()
    const first = await app.inject({
      method: 'POST', url: '/procedure/flow/transition', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ transition: 'start -.7-> heads' }),
    })
    expect(first.statusCode).toBe(200)
    const res = await app.inject({
      method: 'POST', url: '/procedure/flow/transition', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ transition: 'start -.5-> tails' }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('BAD_REQUEST')
    expect(res.json().error).toContain('exceeds 1.0')
    expect((await stores.workflowStore.get('flow', apiKeyId))!.transitions).toHaveLength(1)
  })

  it('accepts weights summing to 1.0 within tolerance', async () => {
    const { app, rawKey } = await setupFlow()
    for (const transition of ['start -.3333-> a', 'start -.3333-> b', 'start -.3334-> c']) {
      const res = await app.inject({
        method: 'POST', url: '/procedure/flow/transition', headers: jsonHeaders(rawKey),
        body: JSON.stringify({ transition }),
      })
      expect(res.statusCode).toBe(200)
    }
  })
})

describe('graph warnings in procedure responses', () => {
  async function setupFlow() {
    const ctx = await makeAuthedApp()
    await ctx.stores.workflowStore.save({ name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }, ctx.apiKeyId)
    return ctx
  }

  async function add(app: any, rawKey: string, transition: string) {
    return app.inject({
      method: 'POST', url: '/procedure/flow/transition', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ transition }),
    })
  }

  it('POST transition returns warnings but still saves an incomplete graph', async () => {
    const { app, stores, rawKey, apiKeyId } = await setupFlow()
    const res = await add(app, rawKey, 'start -.5-> heads')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.warnings)).toBe(true)
    expect(body.warnings.some((w: string) => w.includes('sum to 1.0'))).toBe(true)
    expect(body.warnings.some((w: string) => w.includes('"heads"') && w.includes('no outgoing transitions'))).toBe(true)
    expect((await stores.workflowStore.get('flow', apiKeyId))!.transitions).toHaveLength(1)
  })

  it('POST transition returns an empty warnings array for a complete graph', async () => {
    const { app, rawKey } = await setupFlow()
    const res = await add(app, rawKey, 'start -> review -> end')
    expect(res.statusCode).toBe(200)
    expect(res.json().warnings).toEqual([])
  })

  it('warns about multiple deterministic exits', async () => {
    const { app, rawKey } = await setupFlow()
    await add(app, rawKey, 'start -> a -> end')
    const res = await add(app, rawKey, 'start -> b -> end')
    expect(res.json().warnings.some((w: string) => w.includes('"start"') && w.includes('deterministic exits'))).toBe(true)
  })

  it('DELETE transition returns warnings', async () => {
    const { app, rawKey } = await setupFlow()
    await add(app, rawKey, 'start -> review -> end')
    const res = await app.inject({
      method: 'DELETE', url: '/procedure/flow/transition', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ transition: 'review -> end' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().warnings.some((w: string) => w.includes('"review"') && w.includes('no outgoing transitions'))).toBe(true)
  })

  it('DELETE state returns warnings', async () => {
    const { app, rawKey } = await setupFlow()
    await add(app, rawKey, 'start -> review -> end')
    const res = await app.inject({ method: 'DELETE', url: '/procedure/flow/state/review', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    expect(res.json().warnings.some((w: string) => w.includes('"start"') && w.includes('no outgoing transitions'))).toBe(true)
  })

  it('POST terminal returns warnings (empty once the graph is complete)', async () => {
    const { app, rawKey } = await setupFlow()
    await add(app, rawKey, 'start -> done')
    const res = await app.inject({ method: 'POST', url: '/procedure/flow/state/done/terminal', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    expect(res.json().states.done.isTerminal).toBe(true)
    expect(res.json().warnings).toEqual([])
  })

  it('GET /procedure/:name returns warnings', async () => {
    const { app, rawKey } = await setupFlow()
    const res = await app.inject({ method: 'GET', url: '/procedure/flow', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    const warnings: string[] = res.json().warnings
    expect(warnings.some(w => w.includes('No terminal state'))).toBe(true)
    expect(warnings.some(w => w.includes('"start"') && w.includes('no outgoing transitions'))).toBe(true)
  })

  it('POST /procedure returns warnings for the new, empty procedure', async () => {
    const { app, rawKey } = await setupFlow()
    const created = await app.inject({
      method: 'POST', url: '/procedure', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ workflow_name: 'other', description: 'x' }),
    })
    expect(created.statusCode).toBe(201)
    const warnings: string[] = created.json().warnings
    expect(warnings.some(w => w.includes('No terminal state'))).toBe(true)
  })

  it('does not add warnings to responses outside the slice', async () => {
    const { app, rawKey } = await setupFlow()
    const patched = await app.inject({
      method: 'PATCH', url: '/procedure/flow', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ description: 'y' }),
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json()).not.toHaveProperty('warnings')
  })
})
