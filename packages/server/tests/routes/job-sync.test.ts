import { buildApp } from '../../src/app'
import { generateSpec } from '../../src/docs-builder'
import { createStores } from '@eliph/sqlite'

const NOT_FOUND = { error: 'Not found', code: 'NOT_FOUND' }

/** Procedure "wf": start -go-> mid, start -skip-> end, mid -> end (requires pr_url). A second org has its own copy. */
async function setup() {
  const stores = createStores(':memory:')
  const app = buildApp(stores)
  const org = await stores.orgKeyStore.create('org', 10)
  const { rawKey } = await stores.apiKeyStore.create('k', org.record.id)
  const other = await stores.orgKeyStore.create('other', 10)
  const { rawKey: otherRawKey } = await stores.apiKeyStore.create('intruder', other.record.id)
  const headers = { authorization: `Bearer ${rawKey}` }
  const otherHeaders = { authorization: `Bearer ${otherRawKey}` }
  for (const h of [headers, otherHeaders]) {
    const res = await app.inject({
      method: 'PUT', url: '/procedure/wf', headers: h,
      payload: { description: 'd', transitions: ['start -go-> mid', 'start -skip-> end', { transition: 'mid -> end', requires: ['pr_url'] }] },
    })
    expect(res.statusCode).toBe(201)
  }
  return { app, stores, headers, otherHeaders }
}

type Ctx = Awaited<ReturnType<typeof setup>>

const FULL = [{ completed_action: 'go', note: 'went' }, { data: { pr_url: 'https://example.test/1' }, note: 'finished' }]

async function createJob(ctx: Ctx, labels: string[]) {
  const res = await ctx.app.inject({ method: 'POST', url: '/job', headers: ctx.headers, payload: { workflow: 'wf', items: labels.map(label => ({ label })) } })
  expect(res.statusCode).toBe(201)
  return res.json()
}

function sync(ctx: Ctx, jobId: string, items: object[], extra: object = {}, headers: Record<string, string> = ctx.headers) {
  return ctx.app.inject({ method: 'POST', url: `/job/${jobId}/sync`, headers, payload: { items, ...extra } })
}

async function session(ctx: Ctx, id: string) {
  return (await ctx.app.inject({ url: `/session/${id}/state`, headers: ctx.headers })).json()
}

describe('POST /job/:id/sync', () => {
  it('applies every reported step to a run that has none, and repeating the call changes nothing', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, ['a', 'b'])
    const first = await sync(ctx, job.jobId, [{ label: 'a', steps: FULL }], { actor: 'worker' })
    expect(first.statusCode).toBe(200)
    expect(first.json().results).toEqual([{ label: 'a', id: job.runs[0].id, ok: true, currentState: 'end', skipped: 0, applied: 2 }])
    expect(first.json()).toMatchObject({ jobId: job.jobId, total: 2, done: false, counts: { end: 1, start: 1 } })

    const before = await session(ctx, job.runs[0].id)
    expect(before.history).toEqual(['start', 'mid', 'end'])
    expect(before.data).toEqual({ pr_url: 'https://example.test/1' })
    expect(before.events.filter((e: any) => e.type === 'advance').map((e: any) => e.actor)).toEqual(['worker', 'worker'])

    const again = await sync(ctx, job.jobId, [{ label: 'a', steps: FULL }])
    expect(again.json().results).toEqual([{ label: 'a', id: job.runs[0].id, ok: true, currentState: 'end', skipped: 2, applied: 0 }])
    const after = await session(ctx, job.runs[0].id)
    expect(after.events).toEqual(before.events)
    expect(after.revision).toBe(before.revision)
  })

  it('skips the steps a run already took and applies only the rest', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, ['a'])
    const id = job.runs[0].id
    await ctx.app.inject({ method: 'POST', url: `/session/${id}/advance`, headers: ctx.headers, payload: { completed_action: 'go' } })
    const res = await sync(ctx, job.jobId, [{ label: 'a', steps: FULL }])
    expect(res.json().results).toEqual([{ label: 'a', id, ok: true, currentState: 'end', skipped: 1, applied: 1 }])
    expect((await session(ctx, id)).history).toEqual(['start', 'mid', 'end'])
  })

  it('grows a run step by step when the reports get longer, as a workflow reports them', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, ['a'])
    const one = await sync(ctx, job.jobId, [{ label: 'a', steps: FULL.slice(0, 1) }])
    expect(one.json().results[0]).toMatchObject({ ok: true, currentState: 'mid', skipped: 0, applied: 1 })
    const two = await sync(ctx, job.jobId, [{ label: 'a', steps: FULL }])
    expect(two.json().results[0]).toMatchObject({ ok: true, currentState: 'end', skipped: 1, applied: 1 })
    expect(two.json().done).toBe(true)
  })

  it('leaves a run that is ahead of the report alone', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, ['a'])
    await sync(ctx, job.jobId, [{ label: 'a', steps: FULL }])
    const res = await sync(ctx, job.jobId, [{ label: 'a', steps: FULL.slice(0, 1) }, { label: 'a2', steps: [] }])
    expect(res.json().results[0]).toEqual({ label: 'a', id: job.runs[0].id, ok: true, currentState: 'end', skipped: 1, applied: 0 })
    const empty = await sync(ctx, job.jobId, [{ label: 'a' }])
    expect(empty.json().results[0]).toMatchObject({ ok: true, skipped: 0, applied: 0, currentState: 'end' })
  })

  it('reports a run that took a different path as DIVERGED and does not touch it', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, ['a'])
    const id = job.runs[0].id
    await ctx.app.inject({ method: 'POST', url: `/session/${id}/advance`, headers: ctx.headers, payload: { completed_action: 'skip' } })
    const before = await session(ctx, id)
    const res = await sync(ctx, job.jobId, [{ label: 'a', steps: FULL }])
    expect(res.statusCode).toBe(200)
    expect(res.json().results[0]).toMatchObject({ label: 'a', ok: false, currentState: 'end', skipped: 0, applied: 0, error: { code: 'DIVERGED', atStep: 0 } })
    expect((await session(ctx, id)).events).toEqual(before.events)

    // A reset makes the run's own path longer than, and different from, the report
    const job2 = await createJob(ctx, ['b'])
    await sync(ctx, job2.jobId, [{ label: 'b', steps: FULL.slice(0, 1) }])
    await ctx.app.inject({ method: 'POST', url: `/session/${job2.runs[0].id}/reset`, headers: ctx.headers, payload: {} })
    const afterReset = await sync(ctx, job2.jobId, [{ label: 'b', steps: FULL }])
    expect(afterReset.json().results[0]).toMatchObject({ ok: false, error: { code: 'DIVERGED', atStep: 1 } })
  })

  it('stops a run at a refused step, says which, and still handles the other items', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, ['a', 'b', 'c'])
    const res = await sync(ctx, job.jobId, [
      { label: 'a', steps: [{ completed_action: 'go' }, { note: 'no pr_url' }] },
      { label: 'nope', steps: FULL },
      { label: 'b', steps: [{ completed_action: 'fly' }] },
      { label: 'c', steps: [{ completed_action: 'skip' }] },
    ])
    expect(res.statusCode).toBe(200)
    const [a, nope, b, c] = res.json().results
    expect(a).toMatchObject({ ok: false, currentState: 'mid', skipped: 0, applied: 1, error: { code: 'MISSING_REQUIRED_DATA', missing: ['pr_url'], atStep: 1 } })
    expect(nope).toEqual({ label: 'nope', ok: false, error: { message: expect.stringContaining('no run'), code: 'NOT_FOUND' } })
    expect(b).toMatchObject({ ok: false, currentState: 'start', applied: 0, error: { code: 'BAD_REQUEST', atStep: 0 } })
    expect(c).toMatchObject({ ok: true, currentState: 'end', applied: 1 })
    // The missing data can be supplied by a later, longer report
    const fixed = await sync(ctx, job.jobId, [{ label: 'a', steps: FULL }])
    expect(fixed.json().results[0]).toMatchObject({ ok: true, currentState: 'end', skipped: 1, applied: 1 })
  })

  it('applies each step once when the same report arrives several times at once', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, ['a'])
    const replies = await Promise.all(Array.from({ length: 8 }, () => sync(ctx, job.jobId, [{ label: 'a', steps: FULL }])))
    for (const r of replies) expect(r.statusCode).toBe(200)
    const s = await session(ctx, job.runs[0].id)
    expect(s.history).toEqual(['start', 'mid', 'end'])
    expect(s.events.filter((e: any) => e.type === 'advance')).toHaveLength(2)
    const applied = replies.reduce((n, r) => n + (r.json().results[0].applied ?? 0), 0)
    expect(applied).toBe(2)
  })

  it('never records a step twice in a loop, however many reports race', async () => {
    const ctx = await setup()
    const defined = await ctx.app.inject({
      method: 'PUT', url: '/procedure/loop', headers: ctx.headers,
      payload: { description: 'd', transitions: ['start -> work', 'work -retry-> work', 'work -done-> end', 'start -go-> mid', 'mid -back-> start'] },
    })
    expect(defined.statusCode).toBe(201)
    const job = (await ctx.app.inject({ method: 'POST', url: '/job', headers: ctx.headers, payload: { workflow: 'loop', items: [{ label: 'a' }, { label: 'b' }, { label: 'filler' }] } })).json()

    // Self-loop: the run is in "work" before and after the reported step, so the state alone cannot tell
    await sync(ctx, job.jobId, [{ label: 'a', steps: [{}] }])
    const selfLoop = [{}, { completed_action: 'retry' }]
    const replies = await Promise.all(Array.from({ length: 8 }, () => sync(ctx, job.jobId, [{ label: 'a', steps: selfLoop }])))
    for (const r of replies) expect(r.json().results[0]).toMatchObject({ ok: true, currentState: 'work' })
    expect(replies.reduce((n, r) => n + r.json().results[0].applied, 0)).toBe(1)
    expect((await session(ctx, job.runs[0].id)).history).toEqual(['start', 'work', 'work'])

    // Cycle: one request is still busy with another item while a second one completes the same report
    const cycle = [{ completed_action: 'go' }, { completed_action: 'back' }, { completed_action: 'go' }]
    const [x, y] = await Promise.all([
      sync(ctx, job.jobId, [{ label: 'b', steps: cycle }]),
      sync(ctx, job.jobId, [{ label: 'filler', steps: [{}, { completed_action: 'retry' }, { completed_action: 'retry' }] }, { label: 'b', steps: cycle }]),
    ])
    expect(x.json().results[0]).toMatchObject({ ok: true, currentState: 'mid' })
    expect(y.json().results[1]).toMatchObject({ ok: true, currentState: 'mid' })
    expect(x.json().results[0].applied + y.json().results[1].applied).toBe(3)
    expect((await session(ctx, job.runs[1].id)).history).toEqual(['start', 'mid', 'start', 'mid'])
  })

  it('carries data reported on an already taken step into the next step, so required data is not lost', async () => {
    const ctx = await setup()
    await ctx.app.inject({
      method: 'PUT', url: '/procedure/two', headers: ctx.headers,
      payload: { description: 'd', transitions: [{ transition: 'start -> mid', requires: ['b'] }, { transition: 'mid -> end', requires: ['a'] }] },
    })
    const job = (await ctx.app.inject({ method: 'POST', url: '/job', headers: ctx.headers, payload: { workflow: 'two', items: [{ label: 'r' }] } })).json()
    // A first attempt is refused, the retry reports only the missing key
    const refused = await sync(ctx, job.jobId, [{ label: 'r', steps: [{ data: { a: '1' } }] }])
    expect(refused.json().results[0]).toMatchObject({ ok: false, error: { code: 'MISSING_REQUIRED_DATA', missing: ['b'] } })
    await sync(ctx, job.jobId, [{ label: 'r', steps: [{ data: { b: '2' } }] }])
    expect((await session(ctx, job.runs[0].id)).data).toEqual({ b: '2' })
    // The full report holds both keys on step 1; step 2 needs "a"
    const full = await sync(ctx, job.jobId, [{ label: 'r', steps: [{ data: { a: '1', b: 'changed' } }, {}] }])
    expect(full.json().results[0]).toEqual({ label: 'r', id: job.runs[0].id, ok: true, currentState: 'end', skipped: 1, applied: 1 })
    // Data the run already holds is not overwritten by a skipped step
    expect((await session(ctx, job.runs[0].id)).data).toEqual({ a: '1', b: '2' })
  })

  it('does not take a step count from the request body of the single-session advance', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, ['a'])
    const res = await ctx.app.inject({
      method: 'POST', url: `/session/${job.runs[0].id}/advance`, headers: ctx.headers,
      payload: { completed_action: 'go', expectedSteps: 7, expected_steps: 7 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().currentState).toBe('mid')
  })

  it('rejects an unusable request without changing anything', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, ['a'])
    for (const items of [[], [{ label: '' }], [{ label: 'a', steps: [] }, { label: 'a', steps: FULL }]]) {
      const res = await sync(ctx, job.jobId, items)
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('BAD_REQUEST')
    }
    const longLabel = await sync(ctx, job.jobId, [{ label: 'x'.repeat(201), steps: [] }])
    expect(longLabel.statusCode).toBe(400)
    const tooMany = await sync(ctx, job.jobId, [{ label: 'a', steps: Array.from({ length: 2001 }, () => ({})) }])
    expect(tooMany.statusCode).toBe(400)
    expect((await session(ctx, job.runs[0].id)).history).toEqual(['start'])
  })

  it('answers 404 for an unknown job and for a job of another org alike, and changes nothing', async () => {
    const ctx = await setup()
    const job = await createJob(ctx, ['a'])
    const unknown = await sync(ctx, 'no-such-job', [{ label: 'a', steps: FULL }])
    const foreign = await sync(ctx, job.jobId, [{ label: 'a', steps: FULL }], {}, ctx.otherHeaders)
    expect(unknown.statusCode).toBe(404)
    expect(foreign.statusCode).toBe(404)
    expect(unknown.json()).toEqual(NOT_FOUND)
    expect(foreign.json()).toEqual(NOT_FOUND)
    expect((await session(ctx, job.runs[0].id)).history).toEqual(['start'])
  })

  it('is in the generated API docs', async () => {
    const spec: any = await generateSpec()
    expect(spec.paths['/job/{id}/sync'].post.tags).toEqual(['Jobs'])
  })
})

describe('POST /job stays responsive', () => {
  it('saves the runs of a large job in separate event-loop turns', async () => {
    const ctx = await setup()
    let turns = 0
    let counting = true
    const tick = () => { turns++; if (counting) setImmediate(tick) }
    setImmediate(tick)
    await ctx.app.inject({ method: 'POST', url: '/job', headers: ctx.headers, payload: { workflow: 'wf', items: Array.from({ length: 30 }, (_, i) => ({ label: `i${i}` })) } })
    counting = false
    expect(turns).toBeGreaterThanOrEqual(29)
  })
})
