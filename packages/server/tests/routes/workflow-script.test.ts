import { buildApp } from '../../src/app'
import { generateSpec } from '../../src/docs-builder'
import { createStores } from '@eliph/sqlite'

async function setup(transitions = ['start -go-> mid', 'start -skip-> end', 'mid -> end']) {
  const stores = createStores(':memory:')
  const app = buildApp(stores)
  const org = await stores.orgKeyStore.create('org', 10)
  const { rawKey } = await stores.apiKeyStore.create('k', org.record.id)
  const other = await stores.orgKeyStore.create('other', 10)
  const { rawKey: otherRawKey } = await stores.apiKeyStore.create('intruder', other.record.id)
  const headers = { authorization: `Bearer ${rawKey}` }
  const otherHeaders = { authorization: `Bearer ${otherRawKey}` }
  await app.inject({ method: 'POST', url: '/procedure', headers, payload: { workflow_name: 'wf', description: 'Ship one change' } })
  for (const transition of transitions) {
    const res = await app.inject({ method: 'POST', url: '/procedure/wf/transition', headers, payload: { transition } })
    expect(res.statusCode).toBe(200)
  }
  return { app, stores, headers, otherHeaders, orgId: org.record.id }
}

describe('GET /procedure/:name/workflow-script', () => {
  it('returns the script, an args example and notes', async () => {
    const { app, headers } = await setup()
    const res = await app.inject({ url: '/procedure/wf/workflow-script', headers })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Object.keys(body).sort()).toEqual(['argsExample', 'notes', 'script', 'workflow'])
    expect(body.workflow).toBe('wf')
    expect(body.script).toMatch(/^export const meta = /)
    expect(body.script).toContain('Ship one change')
    expect(body.argsExample).toEqual({ items: [{ label: expect.any(String), data: {} }, { label: expect.any(String), data: {} }] })
    expect(body.notes.length).toBeGreaterThan(0)
    for (const note of body.notes) expect(typeof note).toBe('string')
  })

  it('does not change the procedure or create sessions', async () => {
    const { app, headers, stores } = await setup()
    const before = (await app.inject({ url: '/procedure/wf', headers })).payload
    await app.inject({ url: '/procedure/wf/workflow-script', headers })
    expect((await app.inject({ url: '/procedure/wf', headers })).payload).toBe(before)
    expect((stores.sessionStore as any).db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0)
  })

  it('max_steps sets the per-item step limit, brought into the allowed range', async () => {
    const { app, headers } = await setup()
    const get = async (query: string) => (await app.inject({ url: `/procedure/wf/workflow-script${query}`, headers })).json()
    const byDefault = await get('')
    const seven = await get('?max_steps=7')
    expect(seven.script).not.toBe(byDefault.script)
    expect(seven.notes.join('\n')).toContain('7 steps')
    expect(byDefault.notes.join('\n')).toContain('25 steps')
    expect((await get('?max_steps=100000')).script).toBe((await get('?max_steps=200')).script)
    expect((await get('?max_steps=0')).script).toBe((await get('?max_steps=1')).script)
  })

  it('400 for a max_steps that is not an integer', async () => {
    const { app, headers } = await setup()
    for (const value of ['abc', '2.5']) {
      const res = await app.inject({ url: `/procedure/wf/workflow-script?max_steps=${value}`, headers })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/max_steps/)
    }
  })

  it('400 NOT_EXPORTABLE for a procedure with a probabilistic transition', async () => {
    const { app, headers } = await setup(['start -.5-> a', 'start -.5-> b', 'a -> end', 'b -> end'])
    const res = await app.inject({ url: '/procedure/wf/workflow-script', headers })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: expect.any(String), code: 'NOT_EXPORTABLE' })
    expect(res.json().error).toMatch(/probabilistic/i)
  })

  it('400 NOT_EXPORTABLE for a reachable state that is neither terminal nor has an exit', async () => {
    const { app, headers, stores, orgId } = await setup()
    await stores.workflowStore.save({
      name: 'stuck',
      description: '',
      states: { start: { name: 'start', isTerminal: false }, limbo: { name: 'limbo', isTerminal: false } },
      transitions: [{ from: 'start', to: 'limbo', type: 'deterministic' }],
    }, orgId)
    const res = await app.inject({ url: '/procedure/stuck/workflow-script', headers })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('NOT_EXPORTABLE')
  })

  it('404 for an unknown procedure', async () => {
    const { app, headers } = await setup()
    const res = await app.inject({ url: '/procedure/nope/workflow-script', headers })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Workflow not found', code: 'NOT_FOUND' })
  })

  it('another org\'s procedure is denied exactly as GET /procedure/:name denies it', async () => {
    const { app, headers, otherHeaders } = await setup()
    const plain = await app.inject({ url: '/procedure/wf', headers: otherHeaders })
    const script = await app.inject({ url: '/procedure/wf/workflow-script', headers: otherHeaders })
    expect(plain.statusCode).toBe(404)
    expect(script.statusCode).toBe(plain.statusCode)
    expect(script.payload).toBe(plain.payload)
    // Their own procedure of the same name is what they get, not ours
    await app.inject({ method: 'POST', url: '/procedure', headers: otherHeaders, payload: { workflow_name: 'wf', description: 'Theirs' } })
    await app.inject({ method: 'POST', url: '/procedure/wf/transition', headers: otherHeaders, payload: { transition: 'start -> end' } })
    const theirs = (await app.inject({ url: '/procedure/wf/workflow-script', headers: otherHeaders })).json()
    expect(theirs.script).toContain('Theirs')
    expect(theirs.script).not.toContain('Ship one change')
    const ours = (await app.inject({ url: '/procedure/wf/workflow-script', headers })).json()
    expect(ours.script).not.toContain('Theirs')
  })

  it('requires authentication', async () => {
    const { app } = await setup()
    expect((await app.inject({ url: '/procedure/wf/workflow-script' })).statusCode).toBe(401)
  })

  it('what the script reports can be passed to POST /job as it is', async () => {
    const { app, headers } = await setup()
    // The shape the script returns for two items: one took "go", one took "skip"
    const reported = {
      workflow: 'wf',
      items: [
        { label: 'one', data: { n: 1 }, steps: [{ completed_action: 'go', note: 'done' }, {}], finalState: 'end' },
        { label: 'two', data: {}, steps: [{ completed_action: 'skip', data: { why: 'not needed' } }], finalState: 'end' },
      ],
    }
    const res = await app.inject({ method: 'POST', url: '/job', headers, payload: reported })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ done: true, counts: { end: 2 } })
  })

  it('is in the generated docs', async () => {
    const spec = await generateSpec() as any
    const op = spec.paths['/procedure/{name}/workflow-script'].get
    expect(op.tags).toEqual(['Procedures'])
    expect(op.parameters.map((p: any) => p.name)).toEqual(expect.arrayContaining(['name', 'max_steps']))
    expect(Object.keys(op.responses['200'].content['application/json'].schema.properties)).toEqual(['workflow', 'script', 'argsExample', 'notes'])
  })
})
