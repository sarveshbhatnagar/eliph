import { buildApp } from '../../src/app'
import { STATS_MAX_SESSIONS } from '../../src/routes/procedures'
import { createStores } from '@eliph/sqlite'
import { Session, SessionEvent } from '@eliph/core'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()

async function setup() {
  const stores = createStores(':memory:')
  const app = buildApp(stores)
  const org = await stores.orgKeyStore.create('org', 10)
  const { rawKey, record: key } = await stores.apiKeyStore.create('k', org.record.id)
  const other = await stores.orgKeyStore.create('other', 10)
  const { rawKey: otherRawKey } = await stores.apiKeyStore.create('intruder', other.record.id)
  const headers = { authorization: `Bearer ${rawKey}` }
  const otherHeaders = { authorization: `Bearer ${otherRawKey}` }
  const def = { description: 'd', transitions: ['start -> review', 'review -approved-> end', 'review -rejected-> start'] }
  expect((await app.inject({ method: 'PUT', url: '/procedure/wf', headers, payload: def })).statusCode).toBe(201)
  return { app, stores, headers, otherHeaders, owner: org.record.id, otherOwner: other.record.id, apiKeyId: key.id }
}

let seq = 0
function session(owner: string, currentState: string, events: SessionEvent[] | undefined, history?: string[], workflowName = 'wf'): Session {
  seq++
  return {
    id: `s-${seq}`,
    workflowName,
    workflowOwnerId: owner,
    currentState,
    history: history ?? [currentState],
    createdAt: new Date(T0 + seq),
    ...(events ? { events } : {}),
  }
}

describe('GET /procedure/:name/stats', () => {
  it('aggregates a scripted set of sessions, including legacy and api-key-owned ones', async () => {
    const { app, stores, headers, owner, apiKeyId } = await setup()
    await stores.sessionStore.save(session(owner, 'end', [
      { type: 'created', to: 'start', at: at(0) },
      { type: 'advance', from: 'start', to: 'review', at: at(1000) },
      { type: 'advance', from: 'review', to: 'end', action: 'approved', at: at(4000) },
    ]))
    await stores.sessionStore.save(session(owner, 'start', [
      { type: 'created', to: 'start', at: at(0) },
      { type: 'advance', from: 'start', to: 'review', at: at(3000) },
      { type: 'reset', from: 'review', to: 'start', at: at(4000) },
    ]))
    // Legacy: owned by an API key id and saved before the event log existed
    await stores.sessionStore.save(session(apiKeyId, 'review', undefined, ['start', 'review']))
    // A different workflow of the same owner is not counted
    await stores.sessionStore.save(session(owner, 'start', [{ type: 'created', to: 'start', at: at(0) }], undefined, 'other'))

    const res = await app.inject({ url: '/procedure/wf/stats', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toEqual({
      workflow: 'wf',
      sessionsAnalyzed: 3,
      truncated: false,
      totals: { sessions: 3, completed: 1, active: 2 },
      states: [
        { state: 'start', entered: 4, currentlyHere: 1, exits: [{ to: 'review', action: null, count: 2 }], resetsAway: 0, avgDwellMs: 2000 },
        { state: 'review', entered: 3, currentlyHere: 1, exits: [{ to: 'end', action: 'approved', count: 1 }], resetsAway: 1, avgDwellMs: 2000 },
        { state: 'end', entered: 1, currentlyHere: 1, exits: [], resetsAway: 0, avgDwellMs: null },
      ],
    })
  })

  it('counts sessions driven through the API', async () => {
    const { app, headers } = await setup()
    const s = (await app.inject({ method: 'POST', url: '/session', headers, payload: { workflow: 'wf' } })).json()
    await app.inject({ method: 'POST', url: `/session/${s.id}/advance`, headers, payload: {} })
    await app.inject({ method: 'POST', url: `/session/${s.id}/advance`, headers, payload: { completed_action: 'rejected' } })
    const body = (await app.inject({ url: '/procedure/wf/stats', headers })).json()
    expect(body.totals).toEqual({ sessions: 1, completed: 0, active: 1 })
    const review = body.states.find((x: any) => x.state === 'review')
    expect(review.exits).toEqual([{ to: 'start', action: 'rejected', count: 1 }])
    expect(review.avgDwellMs).toEqual(expect.any(Number))
  })

  it('is scoped to the caller\'s org', async () => {
    const { app, stores, headers, otherHeaders, owner, otherOwner } = await setup()
    await stores.sessionStore.save(session(owner, 'start', [{ type: 'created', to: 'start', at: at(0) }]))
    // The other org has no procedure "wf": 404 even though sessions of "wf" exist
    expect((await app.inject({ url: '/procedure/wf/stats', headers: otherHeaders })).statusCode).toBe(404)

    // Once it has its own "wf", it sees only its own sessions, and vice versa
    await app.inject({ method: 'PUT', url: '/procedure/wf', headers: otherHeaders, payload: { description: 'd', transitions: ['start -> end'] } })
    await stores.sessionStore.save(session(otherOwner, 'end', [{ type: 'created', to: 'start', at: at(0) }]))
    await stores.sessionStore.save(session(otherOwner, 'end', [{ type: 'created', to: 'start', at: at(0) }]))
    const theirs = (await app.inject({ url: '/procedure/wf/stats', headers: otherHeaders })).json()
    expect(theirs.totals).toEqual({ sessions: 2, completed: 2, active: 0 })
    const mine = (await app.inject({ url: '/procedure/wf/stats', headers })).json()
    expect(mine.totals).toEqual({ sessions: 1, completed: 0, active: 1 })
  })

  it('answers 404 for an unknown procedure and 401 without auth', async () => {
    const { app, headers } = await setup()
    expect((await app.inject({ url: '/procedure/nope/stats', headers })).statusCode).toBe(404)
    expect((await app.inject({ url: '/procedure/wf/stats' })).statusCode).toBe(401)
  })

  it(`analyses at most the newest ${STATS_MAX_SESSIONS} sessions and reports truncated`, async () => {
    const { app, stores, headers, owner } = await setup()
    for (let i = 0; i < STATS_MAX_SESSIONS + 1; i++) {
      await stores.sessionStore.save(session(owner, 'start', [{ type: 'created', to: 'start', at: at(0) }]))
    }
    const body = (await app.inject({ url: '/procedure/wf/stats', headers })).json()
    expect(body.sessionsAnalyzed).toBe(STATS_MAX_SESSIONS)
    expect(body.truncated).toBe(true)
    expect(body.totals.sessions).toBe(STATS_MAX_SESSIONS)
  })
})
