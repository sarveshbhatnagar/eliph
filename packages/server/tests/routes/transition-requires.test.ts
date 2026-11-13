import { buildApp } from '../../src/app'
import { createStores } from '@eliph/sqlite'

async function setup() {
  const stores = createStores(':memory:')
  const app = buildApp(stores)
  const org = await stores.orgKeyStore.create('org', 10)
  const { rawKey } = await stores.apiKeyStore.create('k', org.record.id)
  const headers = { authorization: `Bearer ${rawKey}` }
  return { app, stores, headers, owner: org.record.id }
}

const definition = {
  description: 'review flow',
  transitions: [
    'start -> review',
    { transition: 'review -approved-> merged', requires: ['pr_url'] },
    'review -rejected-> start',
    'merged -> end',
  ],
}

async function define(app: any, headers: object, body: object = definition, name = 'wf') {
  const res = await app.inject({ method: 'PUT', url: `/procedure/${name}`, headers, payload: body })
  return res
}

async function newSession(app: any, headers: object, payload: object = { workflow: 'wf' }) {
  const res = await app.inject({ method: 'POST', url: '/session', headers, payload })
  expect(res.statusCode).toBe(201)
  return res.json()
}

function advance(app: any, headers: object, id: string, payload: object) {
  return app.inject({ method: 'POST', url: `/session/${id}/advance`, headers, payload })
}

/** Session at "review" (one deterministic advance from start). */
async function sessionAtReview(app: any, headers: object, payload?: object) {
  const s = await newSession(app, headers, payload)
  const res = await advance(app, headers, s.id, {})
  expect(res.statusCode).toBe(200)
  expect(res.json().currentState).toBe('review')
  return res.json()
}

describe('requires set with PUT /procedure/:name', () => {
  it('accepts the object form and returns requires on the transition', async () => {
    const { app, headers } = await setup()
    const res = await define(app, headers)
    expect(res.statusCode).toBe(201)
    expect(res.json().transitions[1]).toEqual({ from: 'review', to: 'merged', type: 'symbolic', action: 'approved', requires: ['pr_url'] })
    expect(res.json().transitions[0]).not.toHaveProperty('requires')

    const got = await app.inject({ url: '/procedure/wf', headers })
    expect(got.json().transitions[1].requires).toEqual(['pr_url'])
  })

  it('rejects requires on a chain with a clear 400 and saves nothing', async () => {
    const { app, headers } = await setup()
    const res = await define(app, headers, { description: 'd', transitions: [{ transition: 'start -> a -> end', requires: ['x'] }] })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/is a chain; "requires" can only be set on a single transition/)
    expect(res.json().error).toContain('Nothing was saved.')
    expect((await app.inject({ url: '/procedure/wf', headers })).statusCode).toBe(404)
  })

  it.each([
    ['an invalid name', ['bad key']],
    ['a forbidden name', ['__proto__']],
    ['too many names', Array.from({ length: 21 }, (_, i) => `k${i}`)],
    ['an over-long name', ['a'.repeat(101)]],
  ])('rejects %s with 400', async (_label, requires) => {
    const { app, headers } = await setup()
    const res = await define(app, headers, { description: 'd', transitions: [{ transition: 'start -> end', requires }] })
    expect(res.statusCode).toBe(400)
    expect((await app.inject({ url: '/procedure/wf', headers })).statusCode).toBe(404)
  })

  it('string-only definitions keep working unchanged', async () => {
    const { app, headers } = await setup()
    const res = await define(app, headers, { description: 'd', transitions: ['start -> a -> end'] })
    expect(res.statusCode).toBe(201)
    expect(res.json().transitions).toEqual([
      { from: 'start', to: 'a', type: 'deterministic' },
      { from: 'a', to: 'end', type: 'deterministic' },
    ])
  })
})

describe('PUT /procedure/:name/transition/requires', () => {
  async function setRequires(app: any, headers: object, body: object, name = 'wf') {
    return app.inject({ method: 'PUT', url: `/procedure/${name}/transition/requires`, headers, payload: body })
  }

  it('sets and clears the requirement on one existing transition', async () => {
    const { app, headers } = await setup()
    await define(app, headers, { description: 'd', transitions: ['start -> review', 'review -approved-> end'] })
    const set = await setRequires(app, headers, { transition: 'review -approved-> end', requires: ['pr_url', 'ticket'] })
    expect(set.statusCode).toBe(200)
    expect(set.json().transitions[1].requires).toEqual(['pr_url', 'ticket'])
    expect(set.json().warnings).toEqual(expect.any(Array))
    expect((await app.inject({ url: '/procedure/wf', headers })).json().transitions[1].requires).toEqual(['pr_url', 'ticket'])

    const cleared = await setRequires(app, headers, { transition: 'review -approved-> end', requires: [] })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().transitions[1]).not.toHaveProperty('requires')
    const s = await sessionAtReview(app, headers)
    expect((await advance(app, headers, s.id, { completed_action: 'approved' })).statusCode).toBe(200)
  })

  it('answers 400 for a transition that does not exist or a chain, 404 for an unknown procedure', async () => {
    const { app, headers } = await setup()
    await define(app, headers, { description: 'd', transitions: ['start -> review', 'review -approved-> end'] })
    const missing = await setRequires(app, headers, { transition: 'review -nope-> end', requires: ['x'] })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toContain('No transition "review -nope-> end"')
    const chain = await setRequires(app, headers, { transition: 'start -> review -approved-> end', requires: ['x'] })
    expect(chain.statusCode).toBe(400)
    const bad = await setRequires(app, headers, { transition: 'start -> review', requires: ['constructor'] })
    expect(bad.statusCode).toBe(400)
    const unknown = await setRequires(app, headers, { transition: 'start -> review', requires: ['x'] }, 'nope')
    expect(unknown.statusCode).toBe(404)
  })

  it('removeTransition still removes a transition with requires', async () => {
    const { app, headers } = await setup()
    await define(app, headers)
    const res = await app.inject({ method: 'DELETE', url: '/procedure/wf/transition', headers, payload: { transition: 'review -approved-> merged' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().transitions.some((t: any) => t.action === 'approved')).toBe(false)
  })
})

describe('advance enforces requires', () => {
  it('blocks with MISSING_REQUIRED_DATA and leaves the session unchanged', async () => {
    const { app, headers, stores } = await setup()
    await define(app, headers)
    const s = await sessionAtReview(app, headers, { workflow: 'wf', data: { other: 1 } })
    const before = await stores.sessionStore.get(s.id)

    const res = await advance(app, headers, s.id, { completed_action: 'approved', data: { note_key: 'x' }, note: 'trying' })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.code).toBe('MISSING_REQUIRED_DATA')
    expect(body.missing).toEqual(['pr_url'])
    expect(body.error).toContain('"pr_url"')
    expect(body.error).toContain('in this advance call')

    const after = await stores.sessionStore.get(s.id)
    expect(after).toEqual(before)
    const state = (await app.inject({ url: `/session/${s.id}/state`, headers })).json()
    expect(state.currentState).toBe('review')
    expect(state.data).toEqual({ other: 1 })
    expect(state.events.map((e: any) => e.type)).toEqual(['created', 'advance'])
  })

  it('a whitespace-only value counts as missing', async () => {
    const { app, headers } = await setup()
    await define(app, headers)
    const s = await sessionAtReview(app, headers)
    const res = await advance(app, headers, s.id, { completed_action: 'approved', data: { pr_url: '   ' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().missing).toEqual(['pr_url'])
  })

  it('a null in the same call removes the key and so counts as missing', async () => {
    const { app, headers } = await setup()
    await define(app, headers)
    const s = await sessionAtReview(app, headers, { workflow: 'wf', data: { pr_url: 'https://x/1' } })
    const res = await advance(app, headers, s.id, { completed_action: 'approved', data: { pr_url: null } })
    expect(res.statusCode).toBe(400)
    expect(res.json().missing).toEqual(['pr_url'])
  })

  it('succeeds when the key is supplied in the same advance call', async () => {
    const { app, headers } = await setup()
    await define(app, headers)
    const s = await sessionAtReview(app, headers)
    const res = await advance(app, headers, s.id, { completed_action: 'approved', data: { pr_url: 'https://x/1' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('merged')
    expect(res.json().data).toEqual({ pr_url: 'https://x/1' })
  })

  it('succeeds when the key is already in the session data', async () => {
    const { app, headers } = await setup()
    await define(app, headers)
    const s = await sessionAtReview(app, headers)
    await app.inject({ method: 'PATCH', url: `/session/${s.id}/data`, headers, payload: { data: { pr_url: 'https://x/2' } } })
    const res = await advance(app, headers, s.id, { completed_action: 'approved' })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('merged')
  })

  it('other transitions from the same state are not affected', async () => {
    const { app, headers } = await setup()
    await define(app, headers)
    const s = await sessionAtReview(app, headers)
    const res = await advance(app, headers, s.id, { completed_action: 'rejected' })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('start')
  })

  it('applies to deterministic transitions', async () => {
    const { app, headers } = await setup()
    await define(app, headers, { description: 'd', transitions: [{ transition: 'start -> end', requires: ['summary'] }] })
    const s = await newSession(app, headers)
    expect((await advance(app, headers, s.id, {})).json().code).toBe('MISSING_REQUIRED_DATA')
    const ok = await advance(app, headers, s.id, { data: { summary: 'done' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().currentState).toBe('end')
  })

  it('applies to probabilistic transitions after sampling; a failed check changes nothing', async () => {
    const { app, headers, stores } = await setup()
    await define(app, headers, {
      description: 'd',
      transitions: [{ transition: 'start -.5-> a', requires: ['proof'] }, 'start -.5-> b', 'a -> end', 'b -> end'],
    })
    const s = await newSession(app, headers)
    const spy = jest.spyOn(Math, 'random')
    try {
      spy.mockReturnValue(0.1) // samples "a", which requires proof
      const blocked = await advance(app, headers, s.id, {})
      expect(blocked.statusCode).toBe(400)
      expect(blocked.json().missing).toEqual(['proof'])
      expect((await stores.sessionStore.get(s.id))!.currentState).toBe('start')

      spy.mockReturnValue(0.9) // samples "b", no requirement
      const ok = await advance(app, headers, s.id, {})
      expect(ok.statusCode).toBe(200)
      expect(ok.json().currentState).toBe('b')
    } finally {
      spy.mockRestore()
    }
  })

  it('old graphs without requires are unaffected', async () => {
    const { app, headers, stores, owner } = await setup()
    // A graph exactly as stored before requires existed
    await stores.workflowStore.save({
      name: 'old',
      description: 'd',
      states: { start: { name: 'start', isTerminal: false }, end: { name: 'end', isTerminal: true } },
      transitions: [{ from: 'start', to: 'end', type: 'symbolic', action: 'go' }],
    }, owner)
    const got = (await app.inject({ url: '/procedure/old', headers })).json()
    expect(got.transitions[0]).toEqual({ from: 'start', to: 'end', type: 'symbolic', action: 'go' })
    const s = await newSession(app, headers, { workflow: 'old' })
    expect(s.nextTransitions[0]).not.toHaveProperty('requires')
    const res = await advance(app, headers, s.id, { completed_action: 'go' })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('end')
  })
})

describe('requires is visible to the agent', () => {
  it('appears in nextTransitions of session responses, GET /session/:id/next and /state', async () => {
    const { app, headers } = await setup()
    await define(app, headers)
    const s = await sessionAtReview(app, headers)
    const approved = (list: any[]) => list.find((t: any) => t.action === 'approved')
    expect(approved(s.nextTransitions).requires).toEqual(['pr_url'])
    expect(approved((await app.inject({ url: `/session/${s.id}/next`, headers })).json()).requires).toEqual(['pr_url'])
    expect(approved((await app.inject({ url: `/session/${s.id}/state`, headers })).json().nextTransitions).requires).toEqual(['pr_url'])
    const patched = await app.inject({ method: 'PATCH', url: `/session/${s.id}/data`, headers, payload: { data: { a: 1 } } })
    expect(approved(patched.json().nextTransitions).requires).toEqual(['pr_url'])
  })
})

describe('pinned sessions honour their snapshot\'s requirements', () => {
  it('uses the pinned graph, not the live one', async () => {
    const { app, headers } = await setup()
    await define(app, headers)
    const pinned = await sessionAtReview(app, headers, { workflow: 'wf', pin: true })
    // Live procedure: requirement removed on approved, added on rejected
    await app.inject({ method: 'PUT', url: '/procedure/wf/transition/requires', headers, payload: { transition: 'review -approved-> merged', requires: [] } })
    await app.inject({ method: 'PUT', url: '/procedure/wf/transition/requires', headers, payload: { transition: 'review -rejected-> start', requires: ['reason'] } })

    const next = (await app.inject({ url: `/session/${pinned.id}/next`, headers })).json()
    expect(next.find((t: any) => t.action === 'approved').requires).toEqual(['pr_url'])
    expect(next.find((t: any) => t.action === 'rejected')).not.toHaveProperty('requires')

    const blocked = await advance(app, headers, pinned.id, { completed_action: 'approved' })
    expect(blocked.statusCode).toBe(400)
    expect(blocked.json().missing).toEqual(['pr_url'])

    const live = await sessionAtReview(app, headers)
    expect((await advance(app, headers, live.id, { completed_action: 'rejected' })).json().missing).toEqual(['reason'])
    expect((await advance(app, headers, live.id, { completed_action: 'approved' })).statusCode).toBe(200)
  })
})
