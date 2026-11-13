import { buildApp } from '../../src/app'
import { createStores } from '@eliph/sqlite'

async function setup() {
  const stores = createStores(':memory:')
  const app = buildApp(stores)
  const org = await stores.orgKeyStore.create('org', 10)
  const { rawKey } = await stores.apiKeyStore.create('k', org.record.id)
  const other = await stores.orgKeyStore.create('other', 10)
  const { rawKey: otherRawKey } = await stores.apiKeyStore.create('intruder', other.record.id)
  const headers = { authorization: `Bearer ${rawKey}` }
  const otherHeaders = { authorization: `Bearer ${otherRawKey}` }
  await app.inject({ method: 'POST', url: '/procedure', headers, payload: { workflow_name: 'wf', description: 'd' } })
  for (const transition of ['start -go-> mid', 'start -skip-> end', 'mid -> end']) {
    await app.inject({ method: 'POST', url: '/procedure/wf/transition', headers, payload: { transition } })
  }
  await app.inject({ method: 'PATCH', url: '/procedure/wf/state/mid', headers, payload: { description: 'original' } })
  return { app, stores, headers, otherHeaders }
}

async function createSession(app: any, headers: object, pin?: boolean) {
  const payload = pin === undefined ? { workflow: 'wf' } : { workflow: 'wf', pin }
  const res = await app.inject({ method: 'POST', url: '/session', headers, payload })
  expect(res.statusCode).toBe(201)
  return res.json()
}

describe('pinned sessions', () => {
  it('POST /session with pin: true returns pinned: true; without pin the field is absent', async () => {
    const { app, headers } = await setup()
    const pinned = await createSession(app, headers, true)
    expect(pinned.pinned).toBe(true)
    expect(pinned).not.toHaveProperty('pinnedGraph')
    expect(pinned).not.toHaveProperty('revision')
    expect(pinned.warnings).toEqual(expect.any(Array))
    const live = await createSession(app, headers)
    expect(live).not.toHaveProperty('pinned')
    const explicit = await createSession(app, headers, false)
    expect(explicit).not.toHaveProperty('pinned')
  })

  it('every session response of a pinned session includes pinned: true', async () => {
    const { app, headers } = await setup()
    const { id } = await createSession(app, headers, true)
    const state = await app.inject({ url: `/session/${id}/state`, headers })
    expect(state.json().pinned).toBe(true)
    const patch = await app.inject({ method: 'PATCH', url: `/session/${id}/data`, headers, payload: { data: { a: 1 } } })
    expect(patch.json().pinned).toBe(true)
    const advance = await app.inject({ method: 'POST', url: `/session/${id}/advance`, headers, payload: { completed_action: 'go' } })
    expect(advance.json().pinned).toBe(true)
    expect(advance.json()).not.toHaveProperty('pinnedGraph')
    const reset = await app.inject({ method: 'POST', url: `/session/${id}/reset`, headers, payload: {} })
    expect(reset.json().pinned).toBe(true)
  })

  it('keeps using its snapshot after the procedure is edited', async () => {
    const { app, headers } = await setup()
    const pinned = await createSession(app, headers, true)
    const live = await createSession(app, headers)

    const removed = await app.inject({ method: 'DELETE', url: '/procedure/wf/transition', headers, payload: { transition: 'start -go-> mid' } })
    expect(removed.statusCode).toBe(200)
    await app.inject({ method: 'PATCH', url: '/procedure/wf/state/mid', headers, payload: { description: 'edited' } })

    // The pinned session still sees the removed transition
    const next = await app.inject({ url: `/session/${pinned.id}/next`, headers })
    expect(next.json().map((t: any) => t.action)).toEqual(['go', 'skip'])
    const reqs = await app.inject({ url: `/session/${pinned.id}/requirements`, headers })
    expect(reqs.json()).toEqual(['go', 'skip'])
    const advance = await app.inject({ method: 'POST', url: `/session/${pinned.id}/advance`, headers, payload: { completed_action: 'go' } })
    expect(advance.statusCode).toBe(200)
    expect(advance.json().currentState).toBe('mid')
    expect(advance.json().stateDescription).toBe('original')

    // The unpinned session follows the live procedure
    const liveNext = await app.inject({ url: `/session/${live.id}/next`, headers })
    expect(liveNext.json().map((t: any) => t.action)).toEqual(['skip'])
    const liveAdvance = await app.inject({ method: 'POST', url: `/session/${live.id}/advance`, headers, payload: { completed_action: 'go' } })
    expect(liveAdvance.statusCode).toBe(400)
  })

  it('unpinned sessions see live edits immediately', async () => {
    const { app, headers } = await setup()
    const live = await createSession(app, headers)
    await app.inject({ method: 'POST', url: '/procedure/wf/transition', headers, payload: { transition: 'start -extra-> end' } })
    const reqs = await app.inject({ url: `/session/${live.id}/requirements`, headers })
    expect(reqs.json()).toContain('extra')
    const advance = await app.inject({ method: 'POST', url: `/session/${live.id}/advance`, headers, payload: { completed_action: 'extra' } })
    expect(advance.statusCode).toBe(200)
    expect(advance.json().currentState).toBe('end')
  })

  it('keeps working after the procedure is deleted', async () => {
    const { app, headers } = await setup()
    const pinned = await createSession(app, headers, true)
    const live = await createSession(app, headers)
    const del = await app.inject({ method: 'DELETE', url: '/procedure/wf', headers })
    expect(del.statusCode).toBeLessThan(300)

    const state = await app.inject({ url: `/session/${pinned.id}/state`, headers })
    expect(state.statusCode).toBe(200)
    expect(state.json().nextTransitions).toHaveLength(2)
    const advance = await app.inject({ method: 'POST', url: `/session/${pinned.id}/advance`, headers, payload: { completed_action: 'go' } })
    expect(advance.statusCode).toBe(200)
    const reset = await app.inject({ method: 'POST', url: `/session/${pinned.id}/reset`, headers, payload: { target_state: 'mid' } })
    expect(reset.statusCode).toBe(200)
    const done = await app.inject({ method: 'POST', url: `/session/${pinned.id}/advance`, headers, payload: {} })
    expect(done.json().currentState).toBe('end')
    expect(done.json().isTerminal).toBe(true)

    // Unpinned sessions behave as before: their workflow is gone
    const liveState = await app.inject({ url: `/session/${live.id}/state`, headers })
    expect(liveState.statusCode).toBe(404)
  })

  it('GET /sessions items include pinned for pinned sessions and use the snapshot for isTerminal/active', async () => {
    const { app, headers } = await setup()
    const pinned = await createSession(app, headers, true)
    const live = await createSession(app, headers)
    await app.inject({ method: 'DELETE', url: '/procedure/wf', headers })

    const items = (await app.inject({ url: '/sessions', headers })).json()
    const pinnedItem = items.find((s: any) => s.id === pinned.id)
    const liveItem = items.find((s: any) => s.id === live.id)
    expect(pinnedItem.pinned).toBe(true)
    expect(pinnedItem.isTerminal).toBe(false)
    expect(liveItem).not.toHaveProperty('pinned')

    const active = (await app.inject({ url: '/sessions?active=true', headers })).json()
    expect(active.map((s: any) => s.id)).toEqual([pinned.id])
  })

  it('cross-org access to a pinned session is still refused', async () => {
    const { app, headers, otherHeaders } = await setup()
    const { id } = await createSession(app, headers, true)
    for (const req of [
      { method: 'GET', url: `/session/${id}/state` },
      { method: 'GET', url: `/session/${id}/next` },
      { method: 'GET', url: `/session/${id}/requirements` },
      { method: 'POST', url: `/session/${id}/advance`, payload: { completed_action: 'go' } },
      { method: 'POST', url: `/session/${id}/reset`, payload: {} },
      { method: 'PATCH', url: `/session/${id}/data`, payload: { data: { x: 1 } } },
    ]) {
      const res = await app.inject({ ...req, headers: otherHeaders } as any)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' })
    }
    const list = (await app.inject({ url: '/sessions', headers: otherHeaders })).json()
    expect(list).toEqual([])
    const state = await app.inject({ url: `/session/${id}/state`, headers })
    expect(state.json().currentState).toBe('start')
    expect(state.json().data).toEqual({})
  })

  it('stores the snapshot of the procedure taken at creation', async () => {
    const { app, stores, headers } = await setup()
    const { id } = await createSession(app, headers, true)
    const stored = await stores.sessionStore.get(id)
    expect(stored!.pinnedGraph!.transitions).toHaveLength(3)
    expect(Object.keys(stored!.pinnedGraph!.states).sort()).toEqual(['end', 'mid', 'start'])
  })
})

describe('procedure edit guards ignore pinned sessions', () => {
  it('a state holding only a pinned session can be removed, and the session keeps working', async () => {
    const { createStores } = await import('@eliph/sqlite')
    const { buildApp } = await import('../../src/app')
    const stores = createStores(':memory:')
    const app = buildApp(stores)
    const org = await stores.orgKeyStore.create('org', 10)
    const { rawKey } = await stores.apiKeyStore.create('k', org.record.id)
    const headers = { authorization: `Bearer ${rawKey}` }
    await app.inject({ method: 'PUT', url: '/procedure/wf', headers, payload: { description: 'd', transitions: ['start -> mid -> end'] } })

    const pinned = (await app.inject({ method: 'POST', url: '/session', headers, payload: { workflow: 'wf', pin: true } })).json()
    await app.inject({ method: 'POST', url: `/session/${pinned.id}/advance`, headers, payload: {} })
    const unpinned = (await app.inject({ method: 'POST', url: '/session', headers, payload: { workflow: 'wf' } })).json()

    // unpinned session in `start` does not block removing `mid`; the pinned one in `mid` does not either
    const removed = await app.inject({ method: 'DELETE', url: '/procedure/wf/state/mid', headers })
    expect(removed.statusCode).toBe(200)

    const next = await app.inject({ method: 'POST', url: `/session/${pinned.id}/advance`, headers, payload: {} })
    expect(next.statusCode).toBe(200)
    expect(next.json().currentState).toBe('end')

    // an unpinned session sitting in a state still blocks its removal
    await app.inject({ method: 'POST', url: '/procedure/wf/transition', headers, payload: { transition: 'start -> other' } })
    await app.inject({ method: 'POST', url: `/session/${unpinned.id}/advance`, headers, payload: {} })
    const blocked = await app.inject({ method: 'DELETE', url: '/procedure/wf/state/other', headers })
    expect(blocked.statusCode).toBe(409)
  })
})
