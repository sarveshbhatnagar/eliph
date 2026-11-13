import { buildApp } from '../../src/app'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore, InMemoryOrgKeyStore, InMemoryUsageStore, WorkflowGraph, DEFINITION_LIMITS } from '@eliph/core'

async function setup() {
  const orgKeyStore = new InMemoryOrgKeyStore()
  const apiKeyStore = new InMemoryApiKeyStore(orgKeyStore)
  const { record: org } = await orgKeyStore.create('org-a', 100)
  const { record: other } = await orgKeyStore.create('org-b', 100)
  const stores = {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore,
    orgKeyStore,
    usageStore: new InMemoryUsageStore(),
  }
  const { rawKey } = await apiKeyStore.create('a', org.id)
  const { rawKey: otherKey } = await apiKeyStore.create('b', other.id)
  const app = buildApp(stores)
  await app.ready()
  return { app, stores, rawKey, otherKey, owner: org.id, otherOwner: other.id }
}

function headers(rawKey: string) {
  return { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' }
}

const definition = {
  description: 'code review',
  transitions: ['start -> reviewing', 'reviewing -approved-> merged', 'reviewing -rejected-> start'],
  states: {
    start: { description: 'open the PR' },
    reviewing: { description: 'read the diff' },
    merged: { description: 'all done', terminal: true },
  },
}

function put(app: any, rawKey: string, name: string, body: object) {
  return app.inject({ method: 'PUT', url: `/procedure/${encodeURIComponent(name)}`, headers: headers(rawKey), body: JSON.stringify(body) })
}

const existingGraph: WorkflowGraph = {
  name: 'flow',
  description: 'original',
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

describe('PUT /procedure/:name', () => {
  it('creates a whole procedure (201) with descriptions, terminal flags and warnings', async () => {
    const { app, stores, rawKey, owner } = await setup()
    const res = await put(app, rawKey, 'review flow', definition)
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.name).toBe('review flow')
    expect(body.description).toBe('code review')
    expect(body.transitions).toHaveLength(3)
    expect(body.states.reviewing).toEqual({ name: 'reviewing', isTerminal: false, description: 'read the diff' })
    expect(body.states.merged).toEqual({ name: 'merged', isTerminal: true, description: 'all done' })
    expect(body.warnings).toEqual([])
    const stored = await stores.workflowStore.get('review flow', owner)
    expect(stored).toEqual({ name: body.name, description: body.description, states: body.states, transitions: body.transitions })
  })

  it('includes warnings for an incomplete graph', async () => {
    const { app, rawKey } = await setup()
    const res = await put(app, rawKey, 'flow', { description: '', transitions: ['start -.5-> heads'] })
    expect(res.statusCode).toBe(201)
    const warnings: string[] = res.json().warnings
    expect(warnings.some(w => w.includes('sum to 1.0'))).toBe(true)
    expect(warnings.some(w => w.includes('No terminal state'))).toBe(true)
  })

  it('returns 409 when the procedure exists and overwrite is not true, keeping it', async () => {
    const { app, stores, rawKey, owner } = await setup()
    await stores.workflowStore.save(existingGraph, owner)
    for (const overwrite of [undefined, false]) {
      const res = await put(app, rawKey, 'flow', { ...definition, overwrite })
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('CONFLICT')
      expect(res.json().error).toContain('already exists')
      expect(res.json().error).toContain('overwrite: true')
    }
    expect(await stores.workflowStore.get('flow', owner)).toEqual(existingGraph)
  })

  it('replaces the procedure with overwrite: true (200)', async () => {
    const { app, stores, rawKey, owner } = await setup()
    await stores.workflowStore.save(existingGraph, owner)
    const res = await put(app, rawKey, 'flow', { ...definition, overwrite: true })
    expect(res.statusCode).toBe(200)
    expect(res.json().warnings).toEqual([])
    const stored = await stores.workflowStore.get('flow', owner)
    expect(stored!.description).toBe('code review')
    expect(stored!.states.review).toBeUndefined()
    expect(stored!.states.merged.isTerminal).toBe(true)
  })

  it('returns 201 with overwrite: true when nothing existed', async () => {
    const { app, rawKey } = await setup()
    const res = await put(app, rawKey, 'fresh', { ...definition, overwrite: true })
    expect(res.statusCode).toBe(201)
  })

  it.each([
    [{ ...definition, transitions: ['start -> a', 'a => b'] }, 'Transition #2 "a => b" is invalid'],
    [{ ...definition, transitions: ['start -.7-> a', 'start -.5-> b'] }, 'exceeds 1.0'],
    [{ ...definition, transitions: ['start -1.5-> end'] }, 'greater than 0 and at most 1'],
    [{ ...definition, states: { ...definition.states, reveiwing: { description: 'typo' } } }, 'State "reveiwing" in "states" does not appear in any transition'],
    [{ ...definition, states: { merged: { terminl: true } } }, 'unknown field(s) "terminl"'],
    [{ ...definition, states: { constructor: { description: 'x' } } }, 'State "constructor" in "states" does not appear in any transition'],
    [{ ...definition, states: { toString: { description: 'x' } } }, 'State "toString" in "states" does not appear in any transition'],
    [{ ...definition, states: { hasOwnProperty: { terminal: true } } }, 'State "hasOwnProperty" in "states" does not appear in any transition'],
    [{ ...definition, states: { valueOf: { description: 'x' } } }, 'State "valueOf" in "states" does not appear in any transition'],
  ])('rejects a bad definition with 400 and saves nothing (%#)', async (body, message) => {
    const { app, stores, rawKey, owner } = await setup()
    await stores.workflowStore.save(existingGraph, owner)
    const created = await put(app, rawKey, 'new', body)
    expect(created.statusCode).toBe(400)
    expect(created.json().code).toBe('BAD_REQUEST')
    expect(created.json().error).toContain(message)
    expect(created.json().error).toContain('Nothing was saved')
    expect(await stores.workflowStore.get('new', owner)).toBeNull()

    const replaced = await put(app, rawKey, 'flow', { ...body, overwrite: true })
    expect(replaced.statusCode).toBe(400)
    expect(await stores.workflowStore.get('flow', owner)).toEqual(existingGraph)
  })

  it('rejects a "__proto__" key in states with 400 and saves nothing', async () => {
    const { app, stores, rawKey, owner } = await setup()
    const body = '{"description":"d","transitions":["start -> a"],"states":{"__proto__":{"description":"x"}}}'
    const res = await app.inject({ method: 'PUT', url: '/procedure/new', headers: headers(rawKey), body })
    expect(res.statusCode).toBe(400)
    expect(await stores.workflowStore.get('new', owner)).toBeNull()
    const list = await app.inject({ method: 'GET', url: '/procedures', headers: headers(rawKey) })
    expect(list.statusCode).toBe(200)
  })

  it('keeps an existing procedure readable after a rejected prototype-named state', async () => {
    const { app, stores, rawKey, owner } = await setup()
    await stores.workflowStore.save(existingGraph, owner)
    const res = await put(app, rawKey, 'flow', { ...definition, states: { constructor: { description: 'x' } }, overwrite: true })
    expect(res.statusCode).toBe(400)
    const got = await app.inject({ method: 'GET', url: '/procedure/flow', headers: headers(rawKey) })
    expect(got.statusCode).toBe(200)
    expect(got.json().description).toBe('original')
  })

  it.each([
    ['too many transitions', { description: 'd', transitions: Array.from({ length: DEFINITION_LIMITS.maxTransitionStrings + 1 }, (_, i) => `s${i} -> s${i + 1}`) }],
    ['an over-long transition string', { description: 'd', transitions: ['start -> ' + 'a'.repeat(DEFINITION_LIMITS.maxTransitionLength)] }],
    ['too many states entries', {
      description: 'd',
      transitions: ['start -> a'],
      states: Object.fromEntries(Array.from({ length: DEFINITION_LIMITS.maxStates + 1 }, (_, i) => [`s${i}`, {}])),
    }],
    ['too many edges from chains', {
      description: 'd',
      transitions: Array.from({ length: 101 }, (_, i) => ['start', ...Array.from({ length: 10 }, (_, j) => `c${i}_${j}`)].join(' -> ')),
    }],
  ])('rejects an oversized definition (%s) with 400 and saves nothing', async (_label, body) => {
    const { app, stores, rawKey, owner } = await setup()
    const res = await put(app, rawKey, 'big', body)
    expect(res.statusCode).toBe(400)
    expect(await stores.workflowStore.get('big', owner)).toBeNull()
  })

  it('treats an existing state named like an Object.prototype member as removed when stranding is checked', async () => {
    const { app, stores, rawKey, owner } = await setup()
    const odd: WorkflowGraph = {
      ...existingGraph,
      states: { ...existingGraph.states, constructor: { name: 'constructor', isTerminal: false } },
      transitions: [...existingGraph.transitions, { from: 'review', to: 'constructor', type: 'deterministic' }],
    }
    await stores.workflowStore.save(odd, owner)
    await stores.sessionStore.save({ id: 's1', workflowName: 'flow', workflowOwnerId: owner, currentState: 'constructor', history: ['start', 'constructor'], createdAt: new Date() })
    const res = await put(app, rawKey, 'flow', { ...definition, overwrite: true })
    expect(res.statusCode).toBe(409)
    expect(res.json().states).toEqual(['constructor'])
    expect(await stores.workflowStore.get('flow', owner)).toEqual(odd)
  })

  it('rejects a body without transitions (400)', async () => {
    const { app, stores, rawKey, owner } = await setup()
    const res = await put(app, rawKey, 'new', { description: 'x' })
    expect(res.statusCode).toBe(400)
    expect(await stores.workflowStore.get('new', owner)).toBeNull()
  })

  it('returns 409 listing states that would strand this owner\'s active sessions, and saves nothing', async () => {
    const { app, stores, rawKey, owner } = await setup()
    await stores.workflowStore.save(existingGraph, owner)
    await stores.sessionStore.save({ id: 's1', workflowName: 'flow', workflowOwnerId: owner, currentState: 'review', history: ['start', 'review'], createdAt: new Date() })
    const res = await put(app, rawKey, 'flow', { ...definition, overwrite: true })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('CONFLICT')
    expect(res.json().error).toContain('"review"')
    expect(res.json().states).toEqual(['review'])
    expect(await stores.workflowStore.get('flow', owner)).toEqual(existingGraph)
  })

  it('allows replacing when this owner\'s sessions are only in states that are kept', async () => {
    const { app, stores, rawKey, owner } = await setup()
    await stores.workflowStore.save(existingGraph, owner)
    await stores.sessionStore.save({ id: 's1', workflowName: 'flow', workflowOwnerId: owner, currentState: 'start', history: ['start'], createdAt: new Date() })
    const res = await put(app, rawKey, 'flow', { ...definition, overwrite: true })
    expect(res.statusCode).toBe(200)
  })

  it('ignores another org\'s sessions in a removed state', async () => {
    const { app, stores, rawKey, owner, otherOwner } = await setup()
    await stores.workflowStore.save(existingGraph, owner)
    await stores.workflowStore.save(existingGraph, otherOwner)
    await stores.sessionStore.save({ id: 'foreign', workflowName: 'flow', workflowOwnerId: otherOwner, currentState: 'review', history: ['start', 'review'], createdAt: new Date() })
    const res = await put(app, rawKey, 'flow', { ...definition, overwrite: true })
    expect(res.statusCode).toBe(200)
    expect((await stores.workflowStore.get('flow', owner))!.states.review).toBeUndefined()
    expect(await stores.workflowStore.get('flow', otherOwner)).toEqual(existingGraph)
  })

  it('is isolated per org: same name in another org neither conflicts nor changes', async () => {
    const { app, stores, rawKey, otherKey, owner, otherOwner } = await setup()
    await stores.workflowStore.save(existingGraph, otherOwner)
    const res = await put(app, rawKey, 'flow', definition)
    expect(res.statusCode).toBe(201)
    expect(await stores.workflowStore.get('flow', otherOwner)).toEqual(existingGraph)
    expect((await stores.workflowStore.get('flow', owner))!.description).toBe('code review')

    const theirs = await app.inject({ method: 'GET', url: '/procedure/flow', headers: headers(otherKey) })
    expect(theirs.json().description).toBe('original')
  })

  it('requires authentication', async () => {
    const { app } = await setup()
    const res = await app.inject({ method: 'PUT', url: '/procedure/flow', headers: { 'content-type': 'application/json' }, body: JSON.stringify(definition) })
    expect(res.statusCode).toBe(401)
  })

  it('leaves the procedure usable by sessions', async () => {
    const { app, rawKey } = await setup()
    await put(app, rawKey, 'flow', definition)
    const created = await app.inject({ method: 'POST', url: '/session', headers: headers(rawKey), body: JSON.stringify({ workflow: 'flow' }) })
    expect(created.statusCode).toBe(201)
    expect(created.json().stateDescription).toBe('open the PR')
  })
})
