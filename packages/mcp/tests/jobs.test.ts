import { AddressInfo } from 'net'
import { createStores } from '@eliph/sqlite'
import { buildApp } from '../../server/src/app'
// Types only: the server's route schemas use the `tags` field this package adds to Fastify's schema type
import type {} from '@fastify/swagger'
import { buildMcpServer, toolMeta } from '../src/index'
import { makeJobTools } from '../src/tools/jobs'
import { makeAdvanceTools } from '../src/tools/advance'
import { makeSessionTools } from '../src/tools/sessions'

function fakeClient(result: any = {}) {
  const request = jest.fn(async (..._args: any[]): Promise<any> => result)
  return { client: { request } as any, request }
}

const JOB_TOOLS = ['create_job', 'job_status', 'advance_job', 'delete_job', 'export_workflow']

describe('job tools: registration and descriptions', () => {
  it('registers every job tool with metadata', () => {
    const names = buildMcpServer('https://eliph-api.revalent.ai', 'k').getToolNames()
    for (const name of JOB_TOOLS) {
      expect(names).toContain(name)
      expect(toolMeta[name].description.length).toBeGreaterThan(50)
    }
    expect((toolMeta.create_job.inputSchema as any).required).toEqual(['workflow_name', 'items'])
    expect((toolMeta.job_status.inputSchema as any).required).toEqual(['job_id'])
    expect((toolMeta.advance_job.inputSchema as any).required).toEqual(['job_id', 'steps'])
    expect((toolMeta.delete_job.inputSchema as any).required).toEqual(['job_id'])
    expect((toolMeta.export_workflow.inputSchema as any).required).toEqual(['workflow_name'])
  })

  it('export_workflow says how the script, the Workflow tool and create_job fit together', () => {
    const d = toolMeta.export_workflow.description
    expect(d).toContain('Workflow tool')
    expect(d).toContain('{ items: [{ label, data }] }')
    expect(d).toContain('create_job')
    expect(d).toContain('NOT_EXPORTABLE')
    expect(d).toContain('probabilistic')
  })

  it('create_job, job_status and advance_job say when to use them', () => {
    expect(toolMeta.create_job.description).toContain('one per piece of work')
    expect(toolMeta.create_job.description).toContain('atStep')
    expect(toolMeta.create_job.description).toContain('"steps"')
    expect(toolMeta.job_status.description).toContain('is the whole job done?')
    expect(toolMeta.job_status.description).toContain('counts')
    expect(toolMeta.advance_job.description).toContain('expected_state')
    expect(toolMeta.advance_job.description).toContain('STATE_MISMATCH')
  })

  it.each(['advance', 'reset_state'])('%s declares and explains expected_state and actor', (name) => {
    const schema = toolMeta[name].inputSchema as any
    expect(schema.required).toEqual(['session_id'])
    expect(schema.properties.expected_state).toEqual(expect.objectContaining({ type: 'string' }))
    expect(schema.properties.actor).toEqual(expect.objectContaining({ type: 'string', maxLength: 200 }))
    expect(toolMeta[name].description).toContain('expected_state')
    expect(toolMeta[name].description).toContain('STATE_MISMATCH')
  })

  it('list_sessions declares an optional job_id filter', () => {
    const schema = toolMeta.list_sessions.inputSchema as any
    expect(schema.required).toBeUndefined()
    expect(schema.properties.job_id).toEqual(expect.objectContaining({ type: 'string' }))
  })
})

describe('job tools: requests', () => {
  it('create_job sends optional fields only when given', async () => {
    const { client, request } = fakeClient()
    const j = makeJobTools(client)
    await j.create_job({ workflow_name: 'w', items: [{ label: 'a' }] })
    await j.create_job({ workflow_name: 'w', items: [{ label: 'a', data: { k: 1 }, steps: [{ completed_action: 'go' }, {}] }], pin: true, actor: 'me' })
    expect(request.mock.calls).toEqual([
      ['POST', '/job', { workflow: 'w', items: [{ label: 'a' }] }],
      ['POST', '/job', { workflow: 'w', items: [{ label: 'a', data: { k: 1 }, steps: [{ completed_action: 'go' }, {}] }], pin: true, actor: 'me' }],
    ])
  })

  it('create_job takes the items of a workflow-script result as they are, dropping what the API does not take', async () => {
    const { client, request } = fakeClient()
    const items = [
      { label: 'a', data: { k: 1 }, steps: [{ completed_action: 'go', note: 'n' }], finalState: 'mid' },
      { label: 'b', data: undefined, steps: [], finalState: 'start', error: 'The agent returned nothing' },
      { label: 'c', data: null, steps: [{ data: { x: 1 } }], finalState: 'end' },
    ]
    await makeJobTools(client).create_job({ workflow_name: 'w', items: items as any })
    expect(request.mock.calls[0][2]).toEqual({
      workflow: 'w',
      items: [
        { label: 'a', data: { k: 1 }, steps: [{ completed_action: 'go', note: 'n' }] },
        { label: 'b', steps: [] },
        { label: 'c', steps: [{ data: { x: 1 } }] },
      ],
    })
  })

  it('job_status, advance_job and delete_job use the encoded job path', async () => {
    const { client, request } = fakeClient()
    const j = makeJobTools(client)
    const id = 'a b/?c'
    const enc = encodeURIComponent(id)
    await j.job_status({ job_id: id })
    await j.advance_job({ job_id: id, steps: [{ label: 'a', completed_action: 'go', expected_state: 'start' }] })
    await j.advance_job({ job_id: id, steps: [{ session_id: 's' }], actor: 'me' })
    expect(await j.delete_job({ job_id: id })).toEqual({ deleted: true })
    expect(request.mock.calls).toEqual([
      ['GET', `/job/${enc}`],
      ['POST', `/job/${enc}/advance`, { steps: [{ label: 'a', completed_action: 'go', expected_state: 'start' }] }],
      ['POST', `/job/${enc}/advance`, { steps: [{ session_id: 's' }], actor: 'me' }],
      ['DELETE', `/job/${enc}`],
    ])
  })

  it('export_workflow GETs the script, with max_steps only when given', async () => {
    const { client, request } = fakeClient({ script: 's' })
    const j = makeJobTools(client)
    expect(await j.export_workflow({ workflow_name: 'my flow' })).toEqual({ script: 's' })
    await j.export_workflow({ workflow_name: 'my flow', max_steps: 40 })
    expect(request.mock.calls).toEqual([
      ['GET', '/procedure/my%20flow/workflow-script'],
      ['GET', '/procedure/my%20flow/workflow-script?max_steps=40'],
    ])
  })

  it('advance and reset_state forward expected_state and actor only when given', async () => {
    const { client, request } = fakeClient()
    const a = makeAdvanceTools(client)
    await a.advance({ session_id: 'abc', completed_action: 'go', expected_state: 'start', actor: 'worker-1' })
    await a.reset_state({ session_id: 'abc', target_state: 'x', expected_state: 'mid', actor: 'worker-2' })
    await a.advance({ session_id: 'abc', completed_action: 'go' })
    expect(request.mock.calls).toEqual([
      ['POST', '/session/abc/advance', { completed_action: 'go', expected_state: 'start', actor: 'worker-1' }],
      ['POST', '/session/abc/reset', { target_state: 'x', expected_state: 'mid', actor: 'worker-2' }],
      ['POST', '/session/abc/advance', { completed_action: 'go' }],
    ])
  })

  it('null or empty expected_state and actor are left out: they mean "none"', async () => {
    const { client, request } = fakeClient()
    const a = makeAdvanceTools(client)
    const j = makeJobTools(client)
    await a.advance({ session_id: 'abc', expected_state: null as any, actor: '' })
    await a.reset_state({ session_id: 'abc', expected_state: '', actor: null as any })
    await j.advance_job({
      job_id: 'j',
      steps: [{ session_id: 's', label: null as any, expected_state: null as any, data: null as any, note: 'n' }, { label: 'a', session_id: null as any }],
      actor: '',
    })
    await j.advance_job({ job_id: 'j', steps: 'oops' as any })
    expect(request.mock.calls).toEqual([
      ['POST', '/session/abc/advance', { completed_action: undefined }],
      ['POST', '/session/abc/reset', { target_state: undefined }],
      ['POST', '/job/j/advance', { steps: [{ session_id: 's', note: 'n' }, { label: 'a' }] }],
      ['POST', '/job/j/advance', { steps: 'oops' }],
    ])
  })

  it('advance_job lists every code a step can be refused with', () => {
    for (const code of ['BAD_REQUEST', 'MISSING_REQUIRED_DATA', 'PAYLOAD_TOO_LARGE', 'STATE_MISMATCH', 'CONFLICT', 'NOT_FOUND']) {
      expect(toolMeta.advance_job.description).toContain(code)
    }
    expect(toolMeta.export_workflow.description).toMatch(/"batches"/)
    expect(toolMeta.export_workflow.description).toMatch(/1000 agent calls/)
  })

  it('list_sessions sends job_id as the job filter', async () => {
    const { client, request } = fakeClient()
    await makeSessionTools(client).list_sessions({ job_id: 'j 1', active: true })
    expect(request.mock.calls).toEqual([['GET', '/sessions?active=true&job=j+1']])
  })
})

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

/**
 * Runs an exported script the way the workflow runtime does: as the body of an
 * async function with the runtime's globals. `answer` plays every agent.
 */
async function runScript(script: string, args: unknown, answer: (label: string, state: string) => Record<string, unknown> | null) {
  const agent = async (_prompt: string, opts: { label: string; phase: string }) => answer(opts.label.split(': ')[0], opts.phase)
  const parallel = (thunks: Array<() => Promise<unknown>>) =>
    Promise.all(thunks.map(async thunk => {
      try { return await thunk() } catch { return null }
    }))
  const unused = () => { throw new Error('not used by exported scripts') }
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', script.replace(/^export /, ''))
  return fn(agent, parallel, unused, unused, () => {}, args) as Promise<{ workflow: string; items: any[] }>
}

describe('job tools end to end against the real API', () => {
  let app: ReturnType<typeof buildApp>
  let mcp: ReturnType<typeof buildMcpServer>

  /** Calls a tool through the MCP server and parses its text result. */
  async function call(name: string, args: Record<string, any> = {}): Promise<any> {
    const result = await mcp.callTool(name, args)
    return JSON.parse(result.content[0].text)
  }

  beforeAll(async () => {
    const stores = createStores(':memory:')
    app = buildApp(stores)
    const org = await stores.orgKeyStore.create('org', 10)
    const { rawKey } = await stores.apiKeyStore.create('k', org.record.id)
    await app.listen({ port: 0, host: '127.0.0.1' })
    mcp = buildMcpServer(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, rawKey)

    // start -> review (describes work), review -approved-> end (needs pr_url), review -rejected-> start
    await call('define_procedure', {
      workflow_name: 'review',
      description: 'Review one pull request',
      transitions: ['start -> review', { transition: 'review -approved-> end', requires: ['pr_url'] }, 'review -rejected-> start'],
      states: { start: { description: 'Open the pull request' }, review: { description: 'Read the diff and decide' } },
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('create_job makes one run per item and job_status summarises them', async () => {
    const job = await call('create_job', { workflow_name: 'review', items: [{ label: 'pr-1', data: { n: 1 } }, { label: 'pr-2' }], actor: 'lead' })
    expect(job).toEqual(expect.objectContaining({ workflow: 'review', total: 2, done: false, counts: { start: 2 } }))
    expect(job.runs.map((r: any) => r.label)).toEqual(['pr-1', 'pr-2'])

    const status = await call('job_status', { job_id: job.jobId })
    expect(status).toEqual(expect.objectContaining({ jobId: job.jobId, total: 2, done: false, counts: { start: 2 } }))

    // Each run is an ordinary session carrying jobId and label
    const state = await call('current_state', { session_id: job.runs[0].id })
    expect(state).toEqual(expect.objectContaining({ currentState: 'start', data: { n: 1 } }))
    expect(state.events[0]).toEqual(expect.objectContaining({ type: 'created', actor: 'lead' }))
    const listed = await call('list_sessions', { job_id: job.jobId })
    expect(listed.map((s: any) => s.label).sort()).toEqual(['pr-1', 'pr-2'])
    expect(listed.every((s: any) => s.jobId === job.jobId)).toBe(true)
  })

  it('create_job records given steps and reports a refused step on its run only', async () => {
    const job = await call('create_job', {
      workflow_name: 'review',
      items: [
        { label: 'ok', steps: [{}, { completed_action: 'approved', data: { pr_url: 'https://example.test/1' } }] },
        { label: 'no-url', steps: [{}, { completed_action: 'approved' }] },
        { label: 'typo', steps: [{}, { completed_action: 'aproved' }] },
      ],
    })
    expect(job.done).toBe(false)
    expect(job.counts).toEqual({ end: 1, review: 2 })
    const byLabel = Object.fromEntries(job.runs.map((r: any) => [r.label, r]))
    expect(byLabel.ok).toEqual(expect.objectContaining({ currentState: 'end', isTerminal: true }))
    expect(byLabel.ok.error).toBeUndefined()
    expect(byLabel['no-url'].error).toEqual(expect.objectContaining({ code: 'MISSING_REQUIRED_DATA', missing: ['pr_url'], atStep: 1 }))
    expect(byLabel.typo.error).toEqual(expect.objectContaining({ code: 'BAD_REQUEST', atStep: 1 }))
  })

  it('create_job creates nothing when the request is invalid', async () => {
    await expect(call('create_job', { workflow_name: 'nope', items: [{ label: 'a' }] })).rejects.toThrow('Workflow not found')
    await expect(call('create_job', { workflow_name: 'review', items: [] })).rejects.toThrow()
    await expect(call('create_job', { workflow_name: 'review', items: [{ label: 'a' }, { label: 'a' }] })).rejects.toThrow(/"a"/)
  })

  it('advance_job advances runs by label or session id and reports each step', async () => {
    const job = await call('create_job', { workflow_name: 'review', items: [{ label: 'a' }, { label: 'b' }] })
    const res = await call('advance_job', {
      job_id: job.jobId,
      actor: 'worker-1',
      steps: [
        { label: 'a', expected_state: 'start' },
        { label: 'a', completed_action: 'approved', expected_state: 'review', data: { pr_url: 'u' }, note: 'looks good' },
        { session_id: job.runs[1].id },
        { label: 'b', expected_state: 'start' },
        { label: 'missing' },
      ],
    })
    expect(res.results.map((r: any) => r.ok)).toEqual([true, true, true, false, false])
    expect(res.results[1]).toEqual(expect.objectContaining({ label: 'a', currentState: 'end' }))
    expect(res.results[3].error).toEqual(expect.objectContaining({ code: 'STATE_MISMATCH' }))
    expect(res.results[3].currentState).toBe('review')
    expect(res.results[4].error).toEqual(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(res).toEqual(expect.objectContaining({ total: 2, done: false, counts: { end: 1, review: 1 } }))

    // The actor is in the event log of the run
    const state = await call('current_state', { session_id: job.runs[0].id })
    expect(state.events.filter((e: any) => e.actor === 'worker-1').length).toBeGreaterThanOrEqual(2)

    const finished = await call('advance_job', { job_id: job.jobId, steps: [{ label: 'b', completed_action: 'approved', data: { pr_url: 'u2' } }] })
    expect(finished.done).toBe(true)
    expect((await call('job_status', { job_id: job.jobId })).done).toBe(true)
  })

  it('advance and reset_state refuse a wrong expected_state and change nothing', async () => {
    const job = await call('create_job', { workflow_name: 'review', items: [{ label: 'a' }] })
    const id = job.runs[0].id
    const moved = await call('advance', { session_id: id, expected_state: 'start', actor: 'worker-1' })
    expect(moved.currentState).toBe('review')
    // A second worker reporting the same step is refused instead of moving the run again
    await expect(call('advance', { session_id: id, expected_state: 'start', actor: 'worker-2' })).rejects.toThrow(/is in state "review", not "start"/)
    await expect(call('reset_state', { session_id: id, expected_state: 'start' })).rejects.toThrow(/expected_state/)
    expect((await call('current_state', { session_id: id })).currentState).toBe('review')
    const reset = await call('reset_state', { session_id: id, expected_state: 'review', actor: 'worker-2' })
    expect(reset.currentState).toBe('start')
  })

  it('delete_job removes every run of the job', async () => {
    const job = await call('create_job', { workflow_name: 'review', items: [{ label: 'a' }, { label: 'b' }] })
    expect(await call('delete_job', { job_id: job.jobId })).toEqual({ deleted: true })
    await expect(call('job_status', { job_id: job.jobId })).rejects.toThrow('Not found')
    await expect(call('current_state', { session_id: job.runs[0].id })).rejects.toThrow()
    expect(await call('list_sessions', { job_id: job.jobId })).toEqual([])
  })

  it('export_workflow -> run the script -> create_job records every run as done', async () => {
    const exported = await call('export_workflow', { workflow_name: 'review' })
    expect(exported.workflow).toBe('review')
    expect(exported.script.startsWith('export const meta = {')).toBe(true)
    expect(exported.argsExample).toEqual({ items: expect.any(Array) })
    expect(exported.notes.length).toBeGreaterThan(0)

    // pr-2 is rejected once and goes round the loop before it is approved
    const reviews: Record<string, number> = {}
    const result = await runScript(exported.script, { items: [{ label: 'pr-1', data: { repo: 'x' } }, { label: 'pr-2' }, { label: 'pr-3' }] }, (label, state) => {
      if (state === 'start') return { note: `opened ${label}` }
      reviews[label] = (reviews[label] ?? 0) + 1
      if (label === 'pr-2' && reviews[label] === 1) return { action: 'rejected', note: 'needs tests' }
      return { action: 'approved', data: { pr_url: `https://example.test/${label}` }, note: 'approved' }
    })
    expect(result.workflow).toBe('review')
    expect(result.items.map(i => i.finalState)).toEqual(['end', 'end', 'end'])

    const job = await call('create_job', { workflow_name: result.workflow, items: result.items })
    expect(job.total).toBe(3)
    expect(job.runs.every((r: any) => r.error === undefined)).toBe(true)
    const status = await call('job_status', { job_id: job.jobId })
    expect(status).toEqual(expect.objectContaining({ done: true, total: 3, counts: { end: 3 } }))

    // The recorded run holds the path and the data the script collected
    const run = status.runs.find((r: any) => r.label === 'pr-2')
    const state = await call('current_state', { session_id: run.id })
    expect(state.history).toEqual(['start', 'review', 'start', 'review', 'end'])
    expect(state.data).toEqual({ pr_url: 'https://example.test/pr-2' })
  })

  it('create_job keeps a script item that failed part-way where it stopped', async () => {
    const exported = await call('export_workflow', { workflow_name: 'review', max_steps: 5 })
    const result = await runScript(exported.script, { items: [{ label: 'good' }, { label: 'stuck' }] }, (label, state) => {
      if (state === 'start') return {}
      return label === 'stuck' ? null : { action: 'approved', data: { pr_url: 'u' } }
    })
    expect(result.items[1]).toEqual(expect.objectContaining({ finalState: 'review', error: expect.any(String) }))
    const job = await call('create_job', { workflow_name: 'review', items: result.items })
    expect(job).toEqual(expect.objectContaining({ done: false, counts: { end: 1, review: 1 } }))
  })

  it('export_workflow refuses a procedure that cannot be exported', async () => {
    await call('define_procedure', { workflow_name: 'dice', description: 'd', transitions: ['start -.5-> end', 'start -.5-> other -> end'] })
    await expect(call('export_workflow', { workflow_name: 'dice' })).rejects.toThrow(/probabilistic/)
    await expect(call('export_workflow', { workflow_name: 'nope' })).rejects.toThrow('Workflow not found')
  })
})
