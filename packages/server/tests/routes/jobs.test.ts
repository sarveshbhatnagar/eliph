import { buildApp } from '../../src/app'
import { generateSpec } from '../../src/docs-builder'
import { JOB_LIMITS } from '../../src/routes/jobs'
import { createStores } from '@eliph/sqlite'

const NOT_FOUND = { error: 'Not found', code: 'NOT_FOUND' }

/**
 * Two orgs. The first has two API keys and the procedure "wf":
 * start -go-> mid, start -skip-> end, mid -> end (requires pr_url).
 */
async function setup() {
  const stores = createStores(':memory:')
  const app = buildApp(stores)
  const org = await stores.orgKeyStore.create('org', 10)
  const { rawKey } = await stores.apiKeyStore.create('k', org.record.id)
  const { rawKey: colleagueRawKey } = await stores.apiKeyStore.create('colleague', org.record.id)
  const other = await stores.orgKeyStore.create('other', 10)
  const { rawKey: otherRawKey } = await stores.apiKeyStore.create('intruder', other.record.id)
  const headers = { authorization: `Bearer ${rawKey}` }
  const colleagueHeaders = { authorization: `Bearer ${colleagueRawKey}` }
  const orgHeaders = { authorization: `Bearer ${org.rawKey}` }
  const otherHeaders = { authorization: `Bearer ${otherRawKey}` }
  for (const h of [headers, otherHeaders]) {
    await app.inject({ method: 'POST', url: '/procedure', headers: h, payload: { workflow_name: 'wf', description: 'd' } })
    for (const transition of ['start -go-> mid', 'start -skip-> end', 'mid -> end']) {
      await app.inject({ method: 'POST', url: '/procedure/wf/transition', headers: h, payload: { transition } })
    }
  }
  const requires = await app.inject({
    method: 'PUT', url: '/procedure/wf/transition/requires', headers, payload: { transition: 'mid -> end', requires: ['pr_url'] },
  })
  expect(requires.statusCode).toBe(200)
  return { app, stores, headers, colleagueHeaders, orgHeaders, otherHeaders, orgId: org.record.id, otherOrgId: other.record.id }
}

type Ctx = Awaited<ReturnType<typeof setup>>

async function createJob(ctx: Ctx, items: object[], extra: object = {}, headers: Record<string, string> = ctx.headers) {
  const res = await ctx.app.inject({ method: 'POST', url: '/job', headers, payload: { workflow: 'wf', items, ...extra } })
  expect(res.statusCode).toBe(201)
  return res.json()
}

async function sessionCount(ctx: Ctx): Promise<number> {
  return (ctx.stores.sessionStore as any).db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
}

function advanceJob(ctx: Ctx, jobId: string, steps: object[], extra: object = {}, headers: Record<string, string> = ctx.headers) {
  return ctx.app.inject({ method: 'POST', url: `/job/${jobId}/advance`, headers, payload: { steps, ...extra } })
}

describe('POST /job', () => {
  it('creates one run per item, all at start, sharing a new jobId', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a', data: { n: 1 } }, { label: 'b' }, { label: 'c' }])
    expect(job.jobId).toEqual(expect.any(String))
    expect(job).toMatchObject({ workflow: 'wf', total: 3, done: false, counts: { start: 3 } })
    expect(job.warnings).toEqual(expect.any(Array))
    expect(job.runs.map((r: any) => r.label)).toEqual(['a', 'b', 'c'])
    // The order of the items is kept when the job is read back
    const readBack = (await ctx.app.inject({ url: `/job/${job.jobId}`, headers: ctx.headers })).json()
    expect(readBack.runs.map((r: any) => r.label)).toEqual(['a', 'b', 'c'])
    for (const run of job.runs) {
      expect(run).toMatchObject({ id: expect.any(String), currentState: 'start', isTerminal: false, updatedAt: expect.any(String) })
      expect(run).not.toHaveProperty('error')
    }
    expect(new Set(job.runs.map((r: any) => r.id)).size).toBe(3)

    // Every run is an ordinary session of the caller's org
    const stored = await ctx.stores.sessionStore.get(job.runs[0].id)
    expect(stored).toMatchObject({ jobId: job.jobId, label: 'a', workflowOwnerId: ctx.orgId, data: { n: 1 }, currentState: 'start' })
    expect(stored!.pinnedGraph).toBeUndefined()
    const single = await ctx.app.inject({ method: 'POST', url: `/session/${job.runs[0].id}/advance`, headers: ctx.headers, payload: { completed_action: 'go' } })
    expect(single.statusCode).toBe(200)
    expect(single.json()).toMatchObject({ jobId: job.jobId, label: 'a', currentState: 'mid', data: { n: 1 } })
  })

  it('two jobs get different ids and may reuse labels', async () => {
    const ctx = await setup()
    const one = await createJob(ctx, [{ label: 'a' }])
    const two = await createJob(ctx, [{ label: 'a' }])
    expect(one.jobId).not.toBe(two.jobId)
    expect(one.runs[0].id).not.toBe(two.runs[0].id)
  })

  it('reports a whole finished run in one call through steps', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [
      { label: 'long', data: { ticket: 7 }, steps: [{ completed_action: 'go', note: 'did it' }, { data: { pr_url: 'https://example.test/1' } }] },
      { label: 'short', steps: [{ completed_action: 'skip' }] },
    ], { actor: 'script' })
    expect(job).toMatchObject({ total: 2, done: true, counts: { end: 2 } })
    expect(job.runs.every((r: any) => r.isTerminal && !r.error)).toBe(true)

    const state = (await ctx.app.inject({ url: `/session/${job.runs[0].id}/state`, headers: ctx.headers })).json()
    expect(state.history).toEqual(['start', 'mid', 'end'])
    expect(state.data).toEqual({ ticket: 7, pr_url: 'https://example.test/1' })
    expect(state.events.map((e: any) => [e.type, e.from, e.to, e.action, e.note, e.actor])).toEqual([
      ['created', undefined, 'start', undefined, undefined, 'script'],
      ['advance', 'start', 'mid', 'go', 'did it', 'script'],
      ['advance', 'mid', 'end', undefined, undefined, 'script'],
    ])
    const status = (await ctx.app.inject({ url: `/job/${job.jobId}`, headers: ctx.headers })).json()
    expect(status).toMatchObject({ done: true, counts: { end: 2 } })
  })

  it('a refused step stops that run only and is reported per run', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [
      { label: 'illegal', steps: [{ completed_action: 'nope' }, { completed_action: 'go' }] },
      { label: 'missing', steps: [{ completed_action: 'go' }, {}, { completed_action: 'go' }] },
      { label: 'past-end', steps: [{ completed_action: 'skip' }, {}] },
      { label: 'bad-data', steps: [{ completed_action: 'go', data: { big: 'x'.repeat(70 * 1024) } }] },
      { label: 'fine', steps: [{ completed_action: 'go' }, { data: { pr_url: 'u' } }] },
    ])
    const byLabel = Object.fromEntries(job.runs.map((r: any) => [r.label, r]))
    expect(byLabel.illegal).toMatchObject({ currentState: 'start', error: { code: 'BAD_REQUEST', atStep: 0 } })
    expect(byLabel.missing).toMatchObject({ currentState: 'mid', error: { code: 'MISSING_REQUIRED_DATA', missing: ['pr_url'], atStep: 1 } })
    expect(byLabel['past-end']).toMatchObject({ currentState: 'end', isTerminal: true, error: { code: 'BAD_REQUEST', atStep: 1 } })
    expect(byLabel['past-end'].error.message).toMatch(/terminal/)
    expect(byLabel['bad-data']).toMatchObject({ currentState: 'start', error: { code: 'PAYLOAD_TOO_LARGE', atStep: 0 } })
    expect(byLabel.fine).toMatchObject({ currentState: 'end', isTerminal: true })
    expect(byLabel.fine).not.toHaveProperty('error')
    expect(job).toMatchObject({ total: 5, done: false, counts: { start: 2, mid: 1, end: 2 } })

    // The refused step left no trace: the run holds exactly the steps before it
    const missing = await ctx.stores.sessionStore.get(byLabel.missing.id)
    expect(missing!.history).toEqual(['start', 'mid'])
    expect(missing!.events!.map(e => e.type)).toEqual(['created', 'advance'])
  })

  it('pin: true pins every run to the procedure as it is now', async () => {
    const ctx = await setup()
    const pinned = await createJob(ctx, [{ label: 'a' }, { label: 'b' }], { pin: true })
    const live = await createJob(ctx, [{ label: 'a' }])
    for (const run of pinned.runs) expect((await ctx.stores.sessionStore.get(run.id))!.pinnedGraph).toBeDefined()

    const removed = await ctx.app.inject({ method: 'DELETE', url: '/procedure/wf/transition', headers: ctx.headers, payload: { transition: 'start -go-> mid' } })
    expect(removed.statusCode).toBe(200)

    const res = await advanceJob(ctx, pinned.jobId, [{ label: 'a', completed_action: 'go' }, { label: 'b', completed_action: 'skip' }])
    expect(res.json().results).toEqual([
      { label: 'a', id: pinned.runs[0].id, ok: true, currentState: 'mid' },
      { label: 'b', id: pinned.runs[1].id, ok: true, currentState: 'end' },
    ])
    expect(res.json().runs.map((r: any) => r.isTerminal)).toEqual([false, true])
    const liveRes = await advanceJob(ctx, live.jobId, [{ label: 'a', completed_action: 'go' }])
    expect(liveRes.json().results[0]).toMatchObject({ ok: false, currentState: 'start', error: { code: 'BAD_REQUEST' } })

    // Deleting the procedure does not touch the pinned job; the live one can no longer finish
    await ctx.app.inject({ method: 'DELETE', url: '/procedure/wf', headers: ctx.headers })
    const pinnedStatus = (await ctx.app.inject({ url: `/job/${pinned.jobId}`, headers: ctx.headers })).json()
    expect(pinnedStatus.runs.map((r: any) => r.isTerminal)).toEqual([false, true])
    const liveStatus = (await ctx.app.inject({ url: `/job/${live.jobId}`, headers: ctx.headers })).json()
    expect(liveStatus).toMatchObject({ done: false, runs: [{ isTerminal: false }] })
    expect(pinnedStatus.runs[0]).not.toHaveProperty('pinnedGraph')
  })

  it('records usage like the single-session routes: one session_created per run, one advance per accepted step', async () => {
    const ctx = await setup()
    await createJob(ctx, [{ label: 'a', steps: [{ completed_action: 'go' }, {}] }, { label: 'b' }])
    await new Promise(resolve => setImmediate(resolve))
    const usage = await ctx.stores.usageStore.query(ctx.orgId)
    expect(usage).toEqual([expect.objectContaining({ apiKeyLabel: 'k', sessionsCreated: 2, advances: 1 })])
  })

  describe('validation: 400/404 and nothing is created', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `item-${i}` }))
    const cases: [string, object, number, RegExp][] = [
      ['workflow missing', { items: [{ label: 'a' }] }, 400, /workflow/],
      ['items missing', { workflow: 'wf' }, 400, /items/],
      ['workflow not found', { workflow: 'nope', items: [{ label: 'a' }] }, 404, /Workflow not found/],
      ['items empty', { workflow: 'wf', items: [] }, 400, /at least one item/],
      [`more than ${JOB_LIMITS.maxItems} items`, { workflow: 'wf', items: many(JOB_LIMITS.maxItems + 1) }, 400, /at most 200 items; got 201/],
      ['label missing', { workflow: 'wf', items: [{ label: 'a' }, { data: {} }] }, 400, /label/],
      ['label blank', { workflow: 'wf', items: [{ label: 'a' }, { label: '   ' }] }, 400, /Item 2 has no label/],
      ['label too long', { workflow: 'wf', items: [{ label: 'x'.repeat(201) }] }, 400, /label of item 1 is longer than 200/],
      ['labels not unique', { workflow: 'wf', items: [{ label: 'a' }, { label: 'b' }, { label: 'a' }] }, 400, /unique.*"a"/],
      ['too many steps in total', {
        workflow: 'wf',
        items: [{ label: 'a', steps: Array(1500).fill({}) }, { label: 'b', steps: Array(501).fill({}) }],
      }, 400, /at most 2000 steps in total; got 2001/],
      ['data not an object', { workflow: 'wf', items: [{ label: 'a', data: [1] }] }, 400, /./],
      ['data too large', { workflow: 'wf', items: [{ label: 'a' }, { label: 'b', data: { big: 'x'.repeat(70 * 1024) } }] }, 413, /Item "b": .*64 KB/],
      ['actor too long', { workflow: 'wf', items: [{ label: 'a' }], actor: 'x'.repeat(201) }, 400, /actor/],
      ['step note too long', { workflow: 'wf', items: [{ label: 'a', steps: [{ note: 'x'.repeat(2001) }] }] }, 400, /note/],
    ]
    it.each(cases)('%s', async (_name, payload, status, message) => {
      const ctx = await setup()
      const res = await ctx.app.inject({ method: 'POST', url: '/job', headers: ctx.headers, payload })
      expect(res.statusCode).toBe(status)
      expect(res.json().error).toMatch(message)
      expect(typeof res.json().code).toBe('string')
      expect(await sessionCount(ctx)).toBe(0)
    })

    it('data with a forbidden key', async () => {
      const ctx = await setup()
      const res = await ctx.app.inject({
        method: 'POST', url: '/job', headers: { ...ctx.headers, 'content-type': 'application/json' },
        payload: '{"workflow":"wf","items":[{"label":"a"},{"label":"b","data":{"x":{"constructor":1}}}]}',
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('BAD_REQUEST')
      expect(await sessionCount(ctx)).toBe(0)
    })

    it('accepts exactly the limits', async () => {
      const ctx = await setup()
      const items = many(JOB_LIMITS.maxItems).map((item, i) => ({ ...item, label: i === 0 ? 'x'.repeat(200) : item.label, steps: Array(10).fill({}) }))
      const res = await ctx.app.inject({ method: 'POST', url: '/job', headers: ctx.headers, payload: { workflow: 'wf', items, actor: 'a'.repeat(200) } })
      expect(res.statusCode).toBe(201)
      expect(res.json().total).toBe(200)
      // Every run was stopped by its first step (start needs an action), and all exist
      expect(res.json().runs.every((r: any) => r.error.atStep === 0 && r.currentState === 'start')).toBe(true)
      expect(await sessionCount(ctx)).toBe(200)
    })

    it('requires authentication', async () => {
      const ctx = await setup()
      const res = await ctx.app.inject({ method: 'POST', url: '/job', payload: { workflow: 'wf', items: [{ label: 'a' }] } })
      expect(res.statusCode).toBe(401)
    })
  })
})

describe('GET /job/:id', () => {
  it('summarises where every run is', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a' }, { label: 'b' }, { label: 'c' }])
    await advanceJob(ctx, job.jobId, [{ label: 'a', completed_action: 'go' }, { label: 'b', completed_action: 'skip' }])
    const res = await ctx.app.inject({ url: `/job/${job.jobId}`, headers: ctx.headers })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      jobId: job.jobId,
      workflow: 'wf',
      total: 3,
      done: false,
      counts: { mid: 1, end: 1, start: 1 },
      runs: [
        { id: job.runs[0].id, label: 'a', currentState: 'mid', isTerminal: false, updatedAt: expect.any(String) },
        { id: job.runs[1].id, label: 'b', currentState: 'end', isTerminal: true, updatedAt: expect.any(String) },
        { id: job.runs[2].id, label: 'c', currentState: 'start', isTerminal: false, updatedAt: expect.any(String) },
      ],
    })
  })

  it('counts states whose names collide with object members safely', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a' }, { label: 'b' }])
    // Such names cannot be created through the API; a stored session can still carry one
    for (const [i, state] of ['__proto__', 'constructor'].entries()) {
      const run = (await ctx.stores.sessionStore.get(job.runs[i].id))!
      await ctx.stores.sessionStore.save({ ...run, currentState: state })
    }
    const res = await ctx.app.inject({ url: `/job/${job.jobId}`, headers: ctx.headers })
    expect(res.statusCode).toBe(200)
    const counts = JSON.parse(res.payload).counts
    expect(Object.keys(counts).sort()).toEqual(['__proto__', 'constructor'])
    expect(Object.getOwnPropertyDescriptor(counts, '__proto__')!.value).toBe(1)
    expect(counts.constructor).toBe(1)
    expect(({} as any).polluted).toBeUndefined()
  })

  it('404 for an unknown job', async () => {
    const ctx = await setup()
    const res = await ctx.app.inject({ url: '/job/does-not-exist', headers: ctx.headers })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(NOT_FOUND)
  })
})

describe('POST /job/:id/advance', () => {
  it('applies steps in order, by label or session id, several per run', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a' }, { label: 'b' }])
    const res = await advanceJob(ctx, job.jobId, [
      { label: 'a', completed_action: 'go', note: 'n1' },
      { session_id: job.runs[1].id, completed_action: 'skip' },
      { label: 'a', session_id: job.runs[0].id, expected_state: 'mid', data: { pr_url: 'u' } },
    ], { actor: 'worker-1' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.results).toEqual([
      { label: 'a', id: job.runs[0].id, ok: true, currentState: 'mid' },
      { label: 'b', id: job.runs[1].id, ok: true, currentState: 'end' },
      { label: 'a', id: job.runs[0].id, ok: true, currentState: 'end' },
    ])
    expect(body).toMatchObject({ jobId: job.jobId, workflow: 'wf', total: 2, done: true, counts: { end: 2 } })
    const stored = await ctx.stores.sessionStore.get(job.runs[0].id)
    expect(stored!.events!.slice(1).map(e => [e.to, e.note, e.actor])).toEqual([['mid', 'n1', 'worker-1'], ['end', undefined, 'worker-1']])
    expect(stored!.data).toEqual({ pr_url: 'u' })
  })

  it('a refused step is reported and does not stop the others', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a' }, { label: 'b' }, { label: 'c', steps: [{ completed_action: 'skip' }] }])
    const res = await advanceJob(ctx, job.jobId, [
      { label: 'a', completed_action: 'nope' },
      { label: 'a', completed_action: 'go' },
      { label: 'a' },
      { label: 'b', expected_state: 'mid', completed_action: 'go' },
      { label: 'c' },
      { label: 'b', data: { big: 'x'.repeat(70 * 1024) }, completed_action: 'go' },
      { label: 'b', expected_state: 'start', completed_action: 'go' },
    ])
    expect(res.statusCode).toBe(200)
    const results = res.json().results
    expect(results).toHaveLength(7)
    expect(results[0]).toMatchObject({ label: 'a', ok: false, currentState: 'start', error: { code: 'BAD_REQUEST', message: expect.stringContaining('nope') } })
    expect(results[1]).toEqual({ label: 'a', id: job.runs[0].id, ok: true, currentState: 'mid' })
    expect(results[2]).toMatchObject({ label: 'a', ok: false, currentState: 'mid', error: { code: 'MISSING_REQUIRED_DATA', missing: ['pr_url'] } })
    expect(results[3]).toMatchObject({ label: 'b', ok: false, currentState: 'start', error: { code: 'STATE_MISMATCH' } })
    expect(results[4]).toMatchObject({ label: 'c', ok: false, currentState: 'end', error: { code: 'BAD_REQUEST', message: expect.stringMatching(/terminal/) } })
    expect(results[5]).toMatchObject({ label: 'b', ok: false, currentState: 'start', error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(results[6]).toEqual({ label: 'b', id: job.runs[1].id, ok: true, currentState: 'mid' })
    expect(res.json().counts).toEqual({ mid: 2, end: 1 })
    // Refused steps changed nothing
    const a = await ctx.stores.sessionStore.get(job.runs[0].id)
    expect(a!.history).toEqual(['start', 'mid'])
    expect(a!.data).toEqual({})
  })

  it('null or empty label, session_id and expected_state on a step mean "not given"', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a' }, { label: 'b' }])
    const res = await advanceJob(ctx, job.jobId, [
      { session_id: job.runs[0].id, label: null, expected_state: null, completed_action: 'go' },
      { label: 'b', session_id: null, expected_state: '', completed_action: 'go' },
      { label: 'a', session_id: '', expected_state: 'start', completed_action: 'go' },
    ])
    expect(res.statusCode).toBe(200)
    expect(res.json().results).toEqual([
      { label: 'a', id: job.runs[0].id, ok: true, currentState: 'mid' },
      { label: 'b', id: job.runs[1].id, ok: true, currentState: 'mid' },
      expect.objectContaining({ label: 'a', ok: false, error: expect.objectContaining({ code: 'STATE_MISMATCH' }) }),
    ])
    // A step that names nothing at all is still a 400
    const unnamed = await advanceJob(ctx, job.jobId, [{ label: '', session_id: null, completed_action: 'go' }])
    expect(unnamed.statusCode).toBe(400)
    expect(unnamed.json().error).toMatch(/Step 1 names no run/)
  })

  it('gives the event loop a turn between steps, so a long request does not hold up every other caller', async () => {
    const ctx = await setup()
    // A loop, so one run can take many steps
    await ctx.app.inject({ method: 'POST', url: '/procedure/wf/transition', headers: ctx.headers, payload: { transition: 'mid -back-> start' } })
    const job = await createJob(ctx, [{ label: 'a' }])
    // Counts turns of the event loop; each save notes the turn it happened in
    let turn = 0
    let running = true
    const tick = () => { turn++; if (running) setImmediate(tick) }
    setImmediate(tick)
    const savedInTurn: number[] = []
    const saveIfRevision = ctx.stores.sessionStore.saveIfRevision.bind(ctx.stores.sessionStore)
    ctx.stores.sessionStore.saveIfRevision = async (session, expected) => {
      savedInTurn.push(turn)
      return saveIfRevision(session, expected)
    }
    try {
      const steps = Array.from({ length: 50 }, (_, i) => ({ label: 'a', completed_action: i % 2 === 0 ? 'go' : 'back' }))
      const res = await advanceJob(ctx, job.jobId, steps)
      expect(res.statusCode).toBe(200)
      expect(res.json().results.every((r: any) => r.ok)).toBe(true)
    } finally {
      running = false
    }
    expect(savedInTurn).toHaveLength(50)
    // No two steps in the same turn: waiting requests were served in between
    expect(new Set(savedInTurn).size).toBe(50)
  })

  it('a label or session id that is not in this job is a per-step NOT_FOUND, never a lookup outside the job', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a' }])
    const otherJob = await createJob(ctx, [{ label: 'z' }])
    const standalone = (await ctx.app.inject({ method: 'POST', url: '/session', headers: ctx.headers, payload: { workflow: 'wf' } })).json()
    const foreign = await createJob(ctx, [{ label: 'a' }], {}, ctx.otherHeaders)

    const res = await advanceJob(ctx, job.jobId, [
      { label: 'z', completed_action: 'go' },
      { session_id: otherJob.runs[0].id, completed_action: 'go' },
      { session_id: standalone.id, completed_action: 'go' },
      { session_id: foreign.runs[0].id, completed_action: 'go' },
      { session_id: 'nope', completed_action: 'go' },
      { session_id: job.runs[0].id, label: 'z', completed_action: 'go' },
      { session_id: otherJob.runs[0].id, label: 'a', completed_action: 'go' },
    ])
    expect(res.statusCode).toBe(200)
    const results = res.json().results
    expect(results).toHaveLength(7)
    for (const result of results) {
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('NOT_FOUND')
      expect(result).not.toHaveProperty('currentState')
      expect(result).not.toHaveProperty('id')
    }
    expect(results[0].label).toBe('z')
    for (const id of [job.runs[0].id, otherJob.runs[0].id, standalone.id, foreign.runs[0].id]) {
      expect((await ctx.stores.sessionStore.get(id))!.currentState).toBe('start')
    }
    expect(res.json()).toMatchObject({ total: 1, counts: { start: 1 } })
  })

  it('a run deleted meanwhile is a per-step NOT_FOUND', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a' }, { label: 'b' }])
    const listByJob = ctx.stores.sessionStore.listByJob.bind(ctx.stores.sessionStore)
    let first = true
    ctx.stores.sessionStore.listByJob = async (jobId: string) => {
      const runs = await listByJob(jobId)
      if (first) {
        first = false
        await ctx.stores.sessionStore.delete(job.runs[0].id)
      }
      return runs
    }
    const res = await advanceJob(ctx, job.jobId, [{ label: 'a', completed_action: 'go' }, { label: 'b', completed_action: 'go' }])
    expect(res.json().results).toEqual([
      { label: 'a', id: job.runs[0].id, ok: false, error: { message: 'Not found', code: 'NOT_FOUND' } },
      { label: 'b', id: job.runs[1].id, ok: true, currentState: 'mid' },
    ])
    expect(res.json().total).toBe(1)
  })

  it('N parallel identical guarded steps move the run exactly once', async () => {
    const ctx = await setup()
    const get = ctx.stores.sessionStore.get.bind(ctx.stores.sessionStore)
    ctx.stores.sessionStore.get = async (id: string) => {
      const session = await get(id)
      await new Promise(resolve => setTimeout(resolve, Math.random() * 3))
      return session
    }
    const job = await createJob(ctx, [{ label: 'a' }])
    await ctx.app.inject({ method: 'POST', url: '/procedure/wf/transition', headers: ctx.headers, payload: { transition: 'mid -go-> start' } })
    const responses = await Promise.all(Array.from({ length: 12 }, () =>
      advanceJob(ctx, job.jobId, [{ label: 'a', expected_state: 'start', completed_action: 'go' }])))
    const results = responses.map(r => r.json().results[0])
    expect(responses.every(r => r.statusCode === 200)).toBe(true)
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(results.filter(r => !r.ok).every(r => r.error.code === 'STATE_MISMATCH' && r.currentState === 'mid')).toBe(true)
    const stored = await get(job.runs[0].id)
    expect(stored!.history).toEqual(['start', 'mid'])
  })

  it.each([
    ['steps missing', {}, /steps/],
    ['steps empty', { steps: [] }, /at least one step/],
    ['too many steps', { steps: Array(JOB_LIMITS.maxSteps + 1).fill({ label: 'a' }) }, /at most 2000 steps; got 2001/],
    ['a step naming no run', { steps: [{ label: 'a' }, { completed_action: 'go' }] }, /Step 2 names no run/],
    ['actor too long', { steps: [{ label: 'a' }], actor: 'x'.repeat(201) }, /actor/],
    ['note too long', { steps: [{ label: 'a', note: 'x'.repeat(2001) }] }, /note/],
  ])('400 when %s, and nothing changes', async (_name, payload, message) => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a', data: { pr_url: 'u' } }])
    const res = await ctx.app.inject({ method: 'POST', url: `/job/${job.jobId}/advance`, headers: ctx.headers, payload })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(message)
    expect((await ctx.stores.sessionStore.get(job.runs[0].id))!.currentState).toBe('start')
  })

  it('404 for an unknown job', async () => {
    const ctx = await setup()
    const res = await advanceJob(ctx, 'does-not-exist', [{ label: 'a' }])
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(NOT_FOUND)
  })
})

describe('DELETE /job/:id', () => {
  it('deletes every run of the job and nothing else', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a' }, { label: 'b' }])
    const kept = await createJob(ctx, [{ label: 'a' }])
    const standalone = (await ctx.app.inject({ method: 'POST', url: '/session', headers: ctx.headers, payload: { workflow: 'wf' } })).json()
    const res = await ctx.app.inject({ method: 'DELETE', url: `/job/${job.jobId}`, headers: ctx.headers })
    expect(res.statusCode).toBe(204)
    expect(await sessionCount(ctx)).toBe(2)
    expect(await ctx.stores.sessionStore.get(kept.runs[0].id)).not.toBeNull()
    expect(await ctx.stores.sessionStore.get(standalone.id)).not.toBeNull()
    expect((await ctx.app.inject({ url: `/job/${job.jobId}`, headers: ctx.headers })).statusCode).toBe(404)
    // Idempotent, also for a job that never existed
    expect((await ctx.app.inject({ method: 'DELETE', url: `/job/${job.jobId}`, headers: ctx.headers })).statusCode).toBe(204)
    expect((await ctx.app.inject({ method: 'DELETE', url: '/job/does-not-exist', headers: ctx.headers })).statusCode).toBe(204)
  })
})

describe('access control of jobs', () => {
  it('another org cannot see, advance or delete a job; answers match an unknown job', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a', data: { secret: 1 } }, { label: 'b' }])

    const get = await ctx.app.inject({ url: `/job/${job.jobId}`, headers: ctx.otherHeaders })
    const unknown = await ctx.app.inject({ url: '/job/does-not-exist', headers: ctx.otherHeaders })
    expect(get.statusCode).toBe(404)
    expect(get.payload).toBe(unknown.payload)
    expect(get.json()).toEqual(NOT_FOUND)

    const advance = await advanceJob(ctx, job.jobId, [{ label: 'a', completed_action: 'go' }, { session_id: job.runs[1].id, completed_action: 'go' }], {}, ctx.otherHeaders)
    expect(advance.statusCode).toBe(404)
    expect(advance.json()).toEqual(NOT_FOUND)

    const del = await ctx.app.inject({ method: 'DELETE', url: `/job/${job.jobId}`, headers: ctx.otherHeaders })
    expect(del.statusCode).toBe(204)

    const listed = await ctx.app.inject({ url: `/sessions?job=${job.jobId}`, headers: ctx.otherHeaders })
    expect(listed.json()).toEqual([])

    // Nothing happened to the job
    const status = (await ctx.app.inject({ url: `/job/${job.jobId}`, headers: ctx.headers })).json()
    expect(status).toMatchObject({ total: 2, counts: { start: 2 } })
    expect(await sessionCount(ctx)).toBe(2)
  })

  it('unauthenticated requests are refused on every job route', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a' }])
    for (const [method, url, payload] of [
      ['GET', `/job/${job.jobId}`, undefined],
      ['POST', `/job/${job.jobId}/advance`, { steps: [{ label: 'a', completed_action: 'go' }] }],
      ['DELETE', `/job/${job.jobId}`, undefined],
    ] as const) {
      const res = await ctx.app.inject({ method, url, payload, headers: { authorization: 'Bearer wrong' } })
      expect(res.statusCode).toBe(401)
    }
    expect(await sessionCount(ctx)).toBe(1)
  })

  it('other keys of the same org, and its org key, share the job', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a' }])
    const viaColleague = await advanceJob(ctx, job.jobId, [{ label: 'a', completed_action: 'go' }], {}, ctx.colleagueHeaders)
    expect(viaColleague.json().results[0]).toMatchObject({ ok: true, currentState: 'mid' })
    const viaOrgKey = await ctx.app.inject({ url: `/job/${job.jobId}`, headers: ctx.orgHeaders })
    expect(viaOrgKey.json()).toMatchObject({ total: 1, counts: { mid: 1 } })
    expect((await ctx.app.inject({ method: 'DELETE', url: `/job/${job.jobId}`, headers: ctx.orgHeaders })).statusCode).toBe(204)
    expect(await sessionCount(ctx)).toBe(0)
  })

  it('only the accessible sessions of a jobId are shown, advanced or deleted', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a' }])
    // A session of another org that claims the same jobId (cannot be made through the API)
    const mine = (await ctx.stores.sessionStore.get(job.runs[0].id))!
    await ctx.stores.sessionStore.save({ ...mine, id: 'foreign', label: 'theirs', workflowOwnerId: ctx.otherOrgId })

    const status = (await ctx.app.inject({ url: `/job/${job.jobId}`, headers: ctx.headers })).json()
    expect(status.runs.map((r: any) => r.id)).toEqual([job.runs[0].id])
    expect(status.total).toBe(1)
    const theirs = (await ctx.app.inject({ url: `/job/${job.jobId}`, headers: ctx.otherHeaders })).json()
    expect(theirs.runs.map((r: any) => r.id)).toEqual(['foreign'])

    const advance = await advanceJob(ctx, job.jobId, [{ label: 'theirs', completed_action: 'go' }, { session_id: 'foreign', completed_action: 'go' }])
    expect(advance.json().results.map((r: any) => r.error.code)).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect((await ctx.stores.sessionStore.get('foreign'))!.currentState).toBe('start')

    await ctx.app.inject({ method: 'DELETE', url: `/job/${job.jobId}`, headers: ctx.headers })
    expect(await ctx.stores.sessionStore.get('foreign')).not.toBeNull()
    expect(await ctx.stores.sessionStore.get(job.runs[0].id)).toBeNull()
  })

  it('a job is created in the caller\'s own namespace: another org\'s procedure of the same name is not used', async () => {
    const ctx = await setup()
    await ctx.app.inject({ method: 'DELETE', url: '/procedure/wf', headers: ctx.otherHeaders })
    const res = await ctx.app.inject({ method: 'POST', url: '/job', headers: ctx.otherHeaders, payload: { workflow: 'wf', items: [{ label: 'a' }] } })
    expect(res.statusCode).toBe(404)
    expect(await sessionCount(ctx)).toBe(0)
  })
})

describe('GET /sessions and jobs', () => {
  it('rows carry jobId and label, and ?job= keeps one job', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a' }, { label: 'b' }])
    await createJob(ctx, [{ label: 'c' }])
    const standalone = (await ctx.app.inject({ method: 'POST', url: '/session', headers: ctx.headers, payload: { workflow: 'wf' } })).json()
    expect(standalone).not.toHaveProperty('jobId')
    expect(standalone).not.toHaveProperty('label')

    const all = (await ctx.app.inject({ url: '/sessions', headers: ctx.headers })).json()
    expect(all).toHaveLength(4)
    const row = all.find((s: any) => s.id === standalone.id)
    expect(row).not.toHaveProperty('jobId')
    expect(row).not.toHaveProperty('label')

    const filtered = (await ctx.app.inject({ url: `/sessions?job=${job.jobId}`, headers: ctx.headers })).json()
    expect(filtered.map((s: any) => [s.label, s.jobId]).sort()).toEqual([['a', job.jobId], ['b', job.jobId]])
    await advanceJob(ctx, job.jobId, [{ label: 'a', completed_action: 'skip' }])
    const active = (await ctx.app.inject({ url: `/sessions?job=${job.jobId}&active=true`, headers: ctx.headers })).json()
    expect(active.map((s: any) => s.label)).toEqual(['b'])
    expect((await ctx.app.inject({ url: '/sessions?job=does-not-exist', headers: ctx.headers })).json()).toEqual([])
    // An empty value is no filter
    expect((await ctx.app.inject({ url: '/sessions?job=', headers: ctx.headers })).json()).toHaveLength(4)
  })

  it('GET /session/:id/state carries jobId and label for a run, and neither for a standalone session', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, [{ label: 'a' }])
    const run = (await ctx.app.inject({ url: `/session/${job.runs[0].id}/state`, headers: ctx.headers })).json()
    expect(run).toMatchObject({ jobId: job.jobId, label: 'a', currentState: 'start' })
    const standalone = (await ctx.app.inject({ method: 'POST', url: '/session', headers: ctx.headers, payload: { workflow: 'wf' } })).json()
    const state = (await ctx.app.inject({ url: `/session/${standalone.id}/state`, headers: ctx.headers })).json()
    expect(state).not.toHaveProperty('jobId')
    expect(state).not.toHaveProperty('label')
  })
})

describe('job routes in the generated docs', () => {
  it('documents every job route under the Jobs tag with the shared schemas', async () => {
    const spec = await generateSpec() as any
    for (const [path, method] of [['/job', 'post'], ['/job/{id}', 'get'], ['/job/{id}/advance', 'post'], ['/job/{id}', 'delete']]) {
      const op = spec.paths[path][method]
      expect(op).toBeDefined()
      expect(op.tags).toEqual(['Jobs'])
      expect(op.security).toEqual([{ BearerAuth: [] }])
    }
    expect(Object.keys(spec.components.schemas)).toEqual(expect.arrayContaining(['Job', 'JobRun']))
    expect(Object.keys(spec.components.schemas.Session.properties)).toEqual(expect.arrayContaining(['jobId', 'label']))
    expect(spec.components.schemas.SessionEvent.properties).toHaveProperty('actor')
    const listParams = spec.paths['/sessions'].get.parameters.map((p: any) => p.name)
    expect(listParams).toContain('job')
  })
})
