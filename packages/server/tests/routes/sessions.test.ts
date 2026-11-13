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
  const { record: org, rawKey: orgRawKey } = await orgKeyStore.create('test-org', 100)
  const stores = {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore,
    orgKeyStore,
    usageStore: new InMemoryUsageStore(),
  }
  const { rawKey } = await stores.apiKeyStore.create('test', org.id)
  const apiKeyId = org.id // owner namespace is the org id
  await stores.workflowStore.save(baseGraph, apiKeyId)
  const app = buildApp(stores)
  await app.ready()
  return { app, stores, rawKey, apiKeyId, orgRawKey }
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

  it('returns an empty warnings array for a well-formed workflow', async () => {
    const { app, rawKey } = await makeAuthedApp()
    const res = await app.inject({
      method: 'POST', url: '/session',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'flow' }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().warnings).toEqual([])
  })

  it('still creates the session but returns warnings for a problematic workflow', async () => {
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    await stores.workflowStore.save({
      name: 'broken', description: '',
      states: { start: { name: 'start', isTerminal: false }, a: { name: 'a', isTerminal: false } },
      transitions: [{ from: 'start', to: 'a', type: 'deterministic' }],
    }, apiKeyId)
    const res = await app.inject({
      method: 'POST', url: '/session',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'broken' }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.currentState).toBe('start')
    expect(await stores.sessionStore.get(body.id)).not.toBeNull()
    expect(body.warnings.some((w: string) => w.includes('"a"') && w.includes('no outgoing transitions'))).toBe(true)
    expect(body.warnings.some((w: string) => w.includes('No terminal state'))).toBe(true)
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

describe('GET /session/:id/state response fields', () => {
  it('includes stateDescription, isTerminal, history and workflowName', async () => {
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    const described: WorkflowGraph = {
      ...baseGraph,
      name: 'described',
      states: { ...baseGraph.states, review: { name: 'review', isTerminal: false, description: 'Check the work' } },
    }
    await stores.workflowStore.save(described, apiKeyId)
    await stores.sessionStore.save(makeSession({ id: 's1', workflowName: 'described', workflowOwnerId: apiKeyId, currentState: 'review', history: ['start', 'review'] }))
    const res = await app.inject({ method: 'GET', url: '/session/s1/state?workflow=described', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.stateDescription).toBe('Check the work')
    expect(body.isTerminal).toBe(false)
    expect(body.history).toEqual(['start', 'review'])
    expect(body.workflowName).toBe('described')
  })

  it('returns stateDescription null and isTerminal true for an undescribed terminal state', async () => {
    const { app, stores, rawKey, apiKeyId } = await makeAuthedApp()
    await stores.sessionStore.save(makeSession({ id: 's1', workflowName: 'flow', workflowOwnerId: apiKeyId, currentState: 'end', history: ['start', 'review', 'end'] }))
    const res = await app.inject({ method: 'GET', url: '/session/s1/state', headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('stateDescription', null)
    expect(body.isTerminal).toBe(true)
  })
})

describe('session workflow is taken from the session', () => {
  async function setup() {
    const ctx = await makeAuthedApp()
    const other: WorkflowGraph = {
      name: 'other', description: '',
      states: { start: { name: 'start', isTerminal: false }, elsewhere: { name: 'elsewhere', isTerminal: false } },
      transitions: [{ from: 'start', to: 'elsewhere', type: 'deterministic' }],
    }
    await ctx.stores.workflowStore.save(other, ctx.apiKeyId)
    await ctx.stores.sessionStore.save(makeSession({ id: 's1', workflowName: 'flow', workflowOwnerId: ctx.apiKeyId, currentState: 'start', history: ['start'] }))
    return ctx
  }

  it.each([
    ['GET', '/session/s1/state'],
    ['GET', '/session/s1/next'],
    ['GET', '/session/s1/requirements'],
  ])('%s %s works without workflow', async (method, url) => {
    const { app, rawKey } = await setup()
    const res = await app.inject({ method: method as any, url, headers: authed(rawKey) })
    expect(res.statusCode).toBe(200)
  })

  it('advance works without workflow and uses the session graph', async () => {
    const { app, stores, rawKey } = await setup()
    const res = await app.inject({
      method: 'POST', url: '/session/s1/advance',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('review')
    expect((await stores.sessionStore.get('s1'))!.currentState).toBe('review')
  })

  it('reset works without workflow', async () => {
    const { app, rawKey } = await setup()
    const res = await app.inject({
      method: 'POST', url: '/session/s1/reset',
      headers: { ...authed(rawKey), 'content-type': 'application/json' },
      body: JSON.stringify({ target_state: 'review' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('review')
  })

  it.each([
    ['GET', '/session/s1/state?workflow=other', undefined],
    ['GET', '/session/s1/next?workflow=other', undefined],
    ['GET', '/session/s1/requirements?workflow=other', undefined],
    ['POST', '/session/s1/advance', { workflow: 'other' }],
    ['POST', '/session/s1/reset', { workflow: 'other' }],
  ])('%s %s with a mismatched workflow returns 400 naming the real workflow', async (method, url, body) => {
    const { app, stores, rawKey } = await setup()
    const res = await app.inject({
      method: method as any, url,
      headers: body ? { ...authed(rawKey), 'content-type': 'application/json' } : authed(rawKey),
      body: body ? JSON.stringify(body) : undefined,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('"flow"')
    expect((await stores.sessionStore.get('s1'))!.currentState).toBe('start')
  })
})

describe('session access control', () => {
  async function setupTwoOrgs() {
    const ctx = await makeAuthedApp()
    const { record: otherOrg, rawKey: otherOrgRawKey } = await ctx.stores.orgKeyStore.create('other-org', 100)
    const { rawKey: otherRawKey } = await ctx.stores.apiKeyStore.create('intruder', otherOrg.id)
    // Same-named workflow in the other org, so a graph lookup by name alone would succeed
    await ctx.stores.workflowStore.save(baseGraph, otherOrg.id)
    await ctx.stores.sessionStore.save(makeSession({ id: 's1', workflowName: 'flow', workflowOwnerId: ctx.apiKeyId, currentState: 'start', history: ['start'] }))
    return { ...ctx, otherRawKey, otherOrgRawKey, otherOrg }
  }

  it.each([
    ['GET', '/session/s1/state'],
    ['GET', '/session/s1/state?workflow=flow'],
    ['GET', '/session/s1/next'],
    ['GET', '/session/s1/requirements'],
  ])('denies cross-org read %s %s with 404', async (method, url) => {
    const { app, otherRawKey } = await setupTwoOrgs()
    const res = await app.inject({ method: method as any, url, headers: authed(otherRawKey) })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' })
  })

  it('denies cross-org read with the other org key', async () => {
    const { app, otherOrgRawKey } = await setupTwoOrgs()
    const res = await app.inject({ method: 'GET', url: '/session/s1/state', headers: authed(otherOrgRawKey) })
    expect(res.statusCode).toBe(404)
  })

  it.each([
    ['/session/s1/advance', { workflow: 'flow' }],
    ['/session/s1/reset', { workflow: 'flow', target_state: 'review' }],
  ])('denies cross-org write %s and leaves the session untouched', async (url, body) => {
    const { app, stores, otherRawKey } = await setupTwoOrgs()
    const res = await app.inject({
      method: 'POST', url,
      headers: { ...authed(otherRawKey), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.statusCode).toBe(404)
    const s = await stores.sessionStore.get('s1')
    expect(s!.currentState).toBe('start')
    expect(s!.history).toEqual(['start'])
  })

  it('cross-org delete answers 204 like a nonexistent id but keeps the session', async () => {
    const { app, stores, otherRawKey } = await setupTwoOrgs()
    const res = await app.inject({ method: 'DELETE', url: '/session/s1', headers: authed(otherRawKey) })
    const missing = await app.inject({ method: 'DELETE', url: '/session/never-existed', headers: authed(otherRawKey) })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    // Indistinguishable from deleting an id that does not exist
    expect(missing.statusCode).toBe(res.statusCode)
    expect(missing.body).toBe(res.body)
    const s = await stores.sessionStore.get('s1')
    expect(s).not.toBeNull()
    expect(s!.currentState).toBe('start')
  })

  it('deleting a nonexistent session stays 204', async () => {
    const { app, rawKey } = await makeAuthedApp()
    const res = await app.inject({ method: 'DELETE', url: '/session/does-not-exist', headers: authed(rawKey) })
    expect(res.statusCode).toBe(204)
  })

  it('owner delete removes the session', async () => {
    const { app, stores, rawKey } = await setupTwoOrgs()
    const res = await app.inject({ method: 'DELETE', url: '/session/s1', headers: authed(rawKey) })
    expect(res.statusCode).toBe(204)
    expect(await stores.sessionStore.get('s1')).toBeNull()
  })

  it('the owning org key can access the session', async () => {
    const { app, orgRawKey } = await setupTwoOrgs()
    const res = await app.inject({ method: 'GET', url: '/session/s1/state', headers: authed(orgRawKey) })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('start')
  })

  it('admin can access any session', async () => {
    const prev = process.env.ADMIN_SECRET
    process.env.ADMIN_SECRET = 'test-admin-secret'
    try {
      const { app } = await setupTwoOrgs()
      const res = await app.inject({ method: 'GET', url: '/session/s1/state', headers: authed('test-admin-secret') })
      expect(res.statusCode).toBe(200)
      expect(res.json().currentState).toBe('start')
    } finally {
      if (prev === undefined) delete process.env.ADMIN_SECRET
      else process.env.ADMIN_SECRET = prev
    }
  })

  describe('legacy sessions owned by an API key id', () => {
    async function setupLegacy() {
      const ctx = await setupTwoOrgs()
      const org = (await ctx.stores.orgKeyStore.list()).find(o => o.id === ctx.apiKeyId)!
      // An earlier release used the API key id as the owner namespace
      const { record: legacyKey } = await ctx.stores.apiKeyStore.create('legacy', org.id)
      await ctx.stores.workflowStore.save(baseGraph, legacyKey.id)
      await ctx.stores.sessionStore.save(makeSession({ id: 'legacy', workflowName: 'flow', workflowOwnerId: legacyKey.id, currentState: 'start', history: ['start'] }))
      return { ...ctx, legacyKey }
    }

    it('works for another key in the same org (read and advance)', async () => {
      const { app, rawKey } = await setupLegacy()
      const read = await app.inject({ method: 'GET', url: '/session/legacy/state', headers: authed(rawKey) })
      expect(read.statusCode).toBe(200)
      expect(read.json().currentState).toBe('start')
      const adv = await app.inject({
        method: 'POST', url: '/session/legacy/advance',
        headers: { ...authed(rawKey), 'content-type': 'application/json' },
        body: JSON.stringify({ workflow: 'flow' }),
      })
      expect(adv.statusCode).toBe(200)
      expect(adv.json().currentState).toBe('review')
    })

    it('is denied for a key in another org', async () => {
      const { app, stores, otherRawKey } = await setupLegacy()
      const res = await app.inject({ method: 'GET', url: '/session/legacy/state', headers: authed(otherRawKey) })
      expect(res.statusCode).toBe(404)
      const del = await app.inject({ method: 'DELETE', url: '/session/legacy', headers: authed(otherRawKey) })
      expect(del.statusCode).toBe(204)
      expect(await stores.sessionStore.get('legacy')).not.toBeNull()
    })
  })
})
