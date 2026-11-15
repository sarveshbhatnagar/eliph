import { buildApp } from '../../src/app'
import { generateSpec } from '../../src/docs-builder'
import { createStores } from '@eliph/sqlite'

/** Procedure "wf": start -> mid -> end, with mid -back-> start so a run can pass "start" twice. */
async function setup(interleave = false) {
  const stores = createStores(':memory:')
  if (interleave) {
    // Reads come back a moment later, so concurrent requests really interleave between reading and saving
    const get = stores.sessionStore.get.bind(stores.sessionStore)
    stores.sessionStore.get = async (id: string) => {
      const session = await get(id)
      await new Promise(resolve => setTimeout(resolve, Math.random() * 3))
      return session
    }
  }
  const app = buildApp(stores)
  const org = await stores.orgKeyStore.create('org', 10)
  const { rawKey } = await stores.apiKeyStore.create('k', org.record.id)
  const other = await stores.orgKeyStore.create('other', 10)
  const { rawKey: otherRawKey } = await stores.apiKeyStore.create('intruder', other.record.id)
  const headers = { authorization: `Bearer ${rawKey}` }
  const otherHeaders = { authorization: `Bearer ${otherRawKey}` }
  await app.inject({ method: 'POST', url: '/procedure', headers, payload: { workflow_name: 'wf', description: 'd' } })
  for (const transition of ['start -> mid', 'mid -done-> end', 'mid -back-> start']) {
    await app.inject({ method: 'POST', url: '/procedure/wf/transition', headers, payload: { transition } })
  }
  const session = (await app.inject({ method: 'POST', url: '/session', headers, payload: { workflow: 'wf' } })).json()
  const post = (path: string, payload: object, h: Record<string, string> = headers) =>
    app.inject({ method: 'POST', url: `/session/${session.id}/${path}`, headers: h, payload })
  const state = async () => (await app.inject({ url: `/session/${session.id}/state`, headers })).json()
  return { app, stores, headers, otherHeaders, id: session.id as string, post, state }
}

describe('expected_state on POST /session/:id/advance', () => {
  it('advances when the session is in the expected state', async () => {
    const { post } = await setup()
    const res = await post('advance', { expected_state: 'start' })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('mid')
  })

  it('answers 409 STATE_MISMATCH with currentState and changes nothing otherwise', async () => {
    const { post, state, stores, id } = await setup()
    const before = await stores.sessionStore.get(id)
    const res = await post('advance', { expected_state: 'mid', completed_action: 'done', data: { a: 1 }, note: 'n' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: expect.stringContaining('"start"'), code: 'STATE_MISMATCH', currentState: 'start' })
    expect(res.json().error).toContain('"mid"')
    expect(await stores.sessionStore.get(id)).toEqual(before)
    const now = await state()
    expect(now.currentState).toBe('start')
    expect(now.data).toEqual({})
    expect(now.events).toHaveLength(1)
  })

  it('is checked before the step itself: a mismatch wins over an illegal action or missing data', async () => {
    const { post } = await setup()
    const res = await post('advance', { expected_state: 'end', completed_action: 'no-such-action' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('STATE_MISMATCH')
  })

  it('a request without expected_state behaves as before', async () => {
    const { post } = await setup()
    expect((await post('advance', {})).json().currentState).toBe('mid')
    const bad = await post('advance', {})
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('BAD_REQUEST')
    expect((await post('advance', { completed_action: 'done' })).json().currentState).toBe('end')
  })

  it('does not tell another org which state a session is in', async () => {
    const { post, otherHeaders } = await setup()
    const res = await post('advance', { expected_state: 'mid' }, otherHeaders)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' })
    const reset = await post('reset', { expected_state: 'mid' }, otherHeaders)
    expect(reset.statusCode).toBe(404)
    expect(reset.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' })
  })

  it('N parallel identical guarded advances move the session exactly once', async () => {
    const { post, state, stores, id } = await setup(true)
    const N = 15
    const responses = await Promise.all(Array.from({ length: N }, () => post('advance', { expected_state: 'start', actor: 'w' })))
    const codes = responses.map(r => r.statusCode).sort()
    expect(codes).toEqual([200, ...Array(N - 1).fill(409)])
    for (const res of responses.filter(r => r.statusCode === 409)) {
      expect(res.json()).toMatchObject({ code: 'STATE_MISMATCH', currentState: 'mid' })
    }
    const now = await state()
    expect(now.currentState).toBe('mid')
    expect(now.history).toEqual(['start', 'mid'])
    expect(now.events.filter((e: any) => e.type === 'advance')).toHaveLength(1)
    expect((await stores.sessionStore.get(id))!.revision).toBe(1)
  })
})

describe('an empty expected_state means "not given"', () => {
  it.each([[null], ['']])('advance and reset with expected_state %j are not refused', async (empty) => {
    const { post, state } = await setup()
    const advanced = await post('advance', { expected_state: empty })
    expect(advanced.statusCode).toBe(200)
    expect(advanced.json().currentState).toBe('mid')
    const reset = await post('reset', { expected_state: empty, actor: empty })
    expect(reset.statusCode).toBe(200)
    expect((await state()).currentState).toBe('start')
    // A real guard still refuses
    expect((await post('advance', { expected_state: 'mid' })).statusCode).toBe(409)
  })
})

describe('expected_state on POST /session/:id/reset', () => {
  it('resets when the session is in the expected state', async () => {
    const { post } = await setup()
    await post('advance', {})
    const res = await post('reset', { expected_state: 'mid' })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('start')
  })

  it('answers 409 STATE_MISMATCH and changes nothing otherwise', async () => {
    const { post, state } = await setup()
    await post('advance', {})
    const res = await post('reset', { expected_state: 'start', target_state: 'end', data: { a: 1 } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'STATE_MISMATCH', currentState: 'mid' })
    // Also ahead of the target check
    const both = await post('reset', { expected_state: 'start', target_state: 'no-such-state' })
    expect(both.statusCode).toBe(409)
    const now = await state()
    expect(now.currentState).toBe('mid')
    expect(now.data).toEqual({})
    expect(now.events.map((e: any) => e.type)).toEqual(['created', 'advance'])
  })

  it('N parallel identical guarded resets reset the session exactly once', async () => {
    const { post, state } = await setup(true)
    await post('advance', {})
    const responses = await Promise.all(Array.from({ length: 10 }, () => post('reset', { expected_state: 'mid' })))
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, ...Array(9).fill(409)])
    const now = await state()
    expect(now.history).toEqual(['start', 'mid', 'start'])
    expect(now.events.filter((e: any) => e.type === 'reset')).toHaveLength(1)
  })
})

describe('actor on advance and reset', () => {
  it('is recorded on the event when given and absent otherwise', async () => {
    const { post, state } = await setup()
    await post('advance', { actor: 'worker-7' })
    await post('advance', { completed_action: 'back' })
    await post('advance', { actor: '' })
    await post('reset', { actor: 'supervisor', note: 'again' })
    await post('reset', {})
    const events = (await state()).events
    expect(events.map((e: any) => [e.type, e.actor])).toEqual([
      ['created', undefined], ['advance', 'worker-7'], ['advance', undefined], ['advance', undefined], ['reset', 'supervisor'], ['reset', undefined],
    ])
    for (const e of events.filter((x: any) => x.actor === undefined)) expect(e).not.toHaveProperty('actor')
  })

  it.each(['advance', 'reset'])('%s refuses an actor longer than 200 characters', async (path) => {
    const { post, state } = await setup()
    expect((await post(path, { actor: 'x'.repeat(200) })).statusCode).toBe(200)
    const res = await post(path, { actor: 'x'.repeat(201) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/actor/)
    expect((await state()).events).toHaveLength(2)
  })
})

describe('expected_state and actor in the generated docs', () => {
  it.each(['advance', 'reset'])('are documented on %s', async (path) => {
    const spec = await generateSpec() as any
    const op = spec.paths[`/session/{id}/${path}`].post
    const body = op.requestBody.content['application/json'].schema
    expect(Object.keys(body.properties)).toEqual(expect.arrayContaining(['expected_state', 'actor']))
    expect(body.properties.actor.maxLength).toBe(200)
    expect(op.description).toContain('STATE_MISMATCH')
    expect(op.responses['409'].content['application/json'].schema.properties.code.enum).toEqual(['CONFLICT', 'STATE_MISMATCH'])
  })
})
