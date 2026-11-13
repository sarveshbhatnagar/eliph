import { makeSessionTools } from '../src/tools/sessions'
import { makeAdvanceTools } from '../src/tools/advance'
import { makeProcedureTools } from '../src/tools/procedures'
import { makeGraphTools } from '../src/tools/graph'
import { toolMeta } from '../src/index'

function fakeClient() {
  const request = jest.fn(async (..._args: any[]): Promise<any> => [])
  return { client: { request } as any, request }
}

describe('session tools: optional workflow_name', () => {
  it.each(['current_state', 'next_transitions', 'advance', 'reset_state', 'requirements'])(
    '%s does not require workflow_name but still accepts it',
    (name) => {
      const schema = toolMeta[name].inputSchema as any
      expect(schema.required).toEqual(['session_id'])
      expect(schema.properties.workflow_name).toBeDefined()
    },
  )

  it('omits workflow from requests when not provided', async () => {
    const { client, request } = fakeClient()
    const s = makeSessionTools(client)
    const a = makeAdvanceTools(client)
    await s.current_state({ session_id: 'abc' })
    await s.next_transitions({ session_id: 'abc' })
    await a.requirements({ session_id: 'abc' })
    await a.advance({ session_id: 'abc', completed_action: 'go' })
    await a.reset_state({ session_id: 'abc' })
    expect(request.mock.calls).toEqual([
      ['GET', '/session/abc/state'],
      ['GET', '/session/abc/next'],
      ['GET', '/session/abc/requirements'],
      ['POST', '/session/abc/advance', { completed_action: 'go' }],
      ['POST', '/session/abc/reset', { target_state: undefined }],
    ])
    for (const call of request.mock.calls) {
      if (call[2]) expect(call[2]).not.toHaveProperty('workflow')
    }
  })

  it('sends workflow when provided', async () => {
    const { client, request } = fakeClient()
    const s = makeSessionTools(client)
    const a = makeAdvanceTools(client)
    await s.current_state({ session_id: 'abc', workflow_name: 'my flow' })
    await s.next_transitions({ session_id: 'abc', workflow_name: 'my flow' })
    await a.requirements({ session_id: 'abc', workflow_name: 'my flow' })
    await a.advance({ session_id: 'abc', workflow_name: 'my flow' })
    await a.reset_state({ session_id: 'abc', workflow_name: 'my flow', target_state: 'x' })
    expect(request.mock.calls).toEqual([
      ['GET', '/session/abc/state?workflow=my%20flow'],
      ['GET', '/session/abc/next?workflow=my%20flow'],
      ['GET', '/session/abc/requirements?workflow=my%20flow'],
      ['POST', '/session/abc/advance', { workflow: 'my flow', completed_action: undefined }],
      ['POST', '/session/abc/reset', { workflow: 'my flow', target_state: 'x' }],
    ])
  })
})

describe('path segments are URL-encoded', () => {
  it('encodes session ids in every session path', async () => {
    const { client, request } = fakeClient()
    const s = makeSessionTools(client)
    const a = makeAdvanceTools(client)
    const id = '../a b/?c#d'
    const enc = encodeURIComponent(id)
    await s.delete_session({ session_id: id })
    await s.current_state({ session_id: id })
    await s.next_transitions({ session_id: id })
    await a.advance({ session_id: id })
    await a.reset_state({ session_id: id })
    await a.requirements({ session_id: id })
    expect(request.mock.calls.map(c => c[1])).toEqual([
      `/session/${enc}`,
      `/session/${enc}/state`,
      `/session/${enc}/next`,
      `/session/${enc}/advance`,
      `/session/${enc}/reset`,
      `/session/${enc}/requirements`,
    ])
    for (const call of request.mock.calls) expect(call[1]).not.toContain(' ')
  })

  it('encodes workflow and state names in procedure and graph paths', async () => {
    const { client, request } = fakeClient()
    const p = makeProcedureTools(client)
    const g = makeGraphTools(client)
    const wf = 'my/flow?x'
    const st = 'st#1'
    const w = encodeURIComponent(wf)
    const sEnc = encodeURIComponent(st)
    await p.copy_from_marketplace({ template_name: wf })
    await p.procedure({ workflow_name: wf })
    await p.update_description({ workflow_name: wf, description: 'd' })
    await p.delete_procedure({ workflow_name: wf })
    await g.add_transition({ workflow_name: wf, transition: 'a -> b' })
    await g.remove_transition({ workflow_name: wf, transition: 'a -> b' })
    await g.remove_state({ workflow_name: wf, state_name: st })
    await g.list_states({ workflow_name: wf })
    await g.update_state_description({ workflow_name: wf, state_name: st, description: 'd' })
    await g.mark_terminal({ workflow_name: wf, state_name: st })
    expect(request.mock.calls.map(c => c[1])).toEqual([
      `/marketplace/${w}/copy`,
      `/procedure/${w}`,
      `/procedure/${w}`,
      `/procedure/${w}`,
      `/procedure/${w}/transition`,
      `/procedure/${w}/transition`,
      `/procedure/${w}/state/${sEnc}`,
      `/procedure/${w}/states`,
      `/procedure/${w}/state/${sEnc}`,
      `/procedure/${w}/state/${sEnc}/terminal`,
    ])
  })
})

describe('overwrite argument', () => {
  it.each(['create_procedure', 'copy_from_marketplace'])('%s accepts an optional overwrite boolean', (name) => {
    const schema = toolMeta[name].inputSchema as any
    expect(schema.properties.overwrite).toEqual(expect.objectContaining({ type: 'boolean' }))
    expect(schema.required).not.toContain('overwrite')
    expect(toolMeta[name].description).toContain('overwrite: true')
  })

  it('create_procedure keeps its old request body when overwrite is omitted', async () => {
    const { client, request } = fakeClient()
    const p = makeProcedureTools(client)
    await p.create_procedure({ workflow_name: 'w', description: 'd' })
    await p.create_procedure({ workflow_name: 'w', description: 'd', overwrite: true })
    expect(request.mock.calls).toEqual([
      ['POST', '/procedure', { workflow_name: 'w', description: 'd' }],
      ['POST', '/procedure', { workflow_name: 'w', description: 'd', overwrite: true }],
    ])
  })

  it('copy_from_marketplace forwards overwrite and workflow_name only when given', async () => {
    const { client, request } = fakeClient()
    const p = makeProcedureTools(client)
    await p.copy_from_marketplace({ template_name: 't' })
    await p.copy_from_marketplace({ template_name: 't', workflow_name: 'mine' })
    await p.copy_from_marketplace({ template_name: 't', workflow_name: 'mine', overwrite: true })
    expect(request.mock.calls.map(c => c[2])).toEqual([
      {},
      { workflow_name: 'mine' },
      { workflow_name: 'mine', overwrite: true },
    ])
  })
})

describe('tool descriptions mention warnings', () => {
  it.each(['add_transition', 'remove_transition', 'remove_state', 'mark_terminal', 'procedure', 'create_session'])('%s', (name) => {
    expect(toolMeta[name].description).toContain('"warnings"')
  })
})

describe('session data, notes and listing', () => {
  it('create_session keeps its old body and forwards optional data', async () => {
    const { client, request } = fakeClient()
    const s = makeSessionTools(client)
    await s.create_session({ workflow_name: 'w' })
    await s.create_session({ workflow_name: 'w', data: { a: { b: [1] } } })
    expect(request.mock.calls).toEqual([
      ['POST', '/session', { workflow: 'w' }],
      ['POST', '/session', { workflow: 'w', data: { a: { b: [1] } } }],
    ])
  })

  it('create_session forwards pin only when given', async () => {
    const { client, request } = fakeClient()
    const s = makeSessionTools(client)
    await s.create_session({ workflow_name: 'w', pin: true })
    await s.create_session({ workflow_name: 'w', data: { a: 1 }, pin: false })
    await s.create_session({ workflow_name: 'w', data: { a: 1 } })
    expect(request.mock.calls).toEqual([
      ['POST', '/session', { workflow: 'w', pin: true }],
      ['POST', '/session', { workflow: 'w', data: { a: 1 }, pin: false }],
      ['POST', '/session', { workflow: 'w', data: { a: 1 } }],
    ])
  })

  it('create_session declares an optional pin argument explaining when to use it', () => {
    const create = toolMeta.create_session.inputSchema as any
    expect(create.required).toEqual(['workflow_name'])
    expect(create.properties.pin).toEqual(expect.objectContaining({ type: 'boolean' }))
    expect(create.properties.pin.description).toMatch(/long-running or audited/)
    expect(create.properties.pin.description).toMatch(/live procedure/)
  })

  it('advance and reset_state forward data and note only when given', async () => {
    const { client, request } = fakeClient()
    const a = makeAdvanceTools(client)
    await a.advance({ session_id: 'abc', completed_action: 'go', data: { k: 1 }, note: 'why' })
    await a.reset_state({ session_id: 'abc', target_state: 'x', data: { k: null }, note: 'redo' })
    await a.advance({ session_id: 'abc' })
    expect(request.mock.calls).toEqual([
      ['POST', '/session/abc/advance', { completed_action: 'go', data: { k: 1 }, note: 'why' }],
      ['POST', '/session/abc/reset', { target_state: 'x', data: { k: null }, note: 'redo' }],
      ['POST', '/session/abc/advance', { completed_action: undefined }],
    ])
  })

  it('update_session_data PATCHes the encoded session path', async () => {
    const { client, request } = fakeClient()
    const s = makeSessionTools(client)
    await s.update_session_data({ session_id: 'a b/c', data: { k: 1 } })
    expect(request.mock.calls).toEqual([['PATCH', `/session/${encodeURIComponent('a b/c')}/data`, { data: { k: 1 } }]])
  })

  it('list_sessions builds an encoded query string from optional filters', async () => {
    const { client, request } = fakeClient()
    const s = makeSessionTools(client)
    await s.list_sessions({})
    await s.list_sessions({ workflow_name: 'my flow&x', active: true, limit: 10 })
    await s.list_sessions({ active: false })
    expect(request.mock.calls).toEqual([
      ['GET', '/sessions'],
      ['GET', '/sessions?workflow=my+flow%26x&active=true&limit=10'],
      ['GET', '/sessions?active=false'],
    ])
  })

  it('declares the new optional arguments and tools', () => {
    for (const name of ['advance', 'reset_state']) {
      const schema = toolMeta[name].inputSchema as any
      expect(schema.required).toEqual(['session_id'])
      expect(schema.properties.data).toEqual(expect.objectContaining({ type: 'object' }))
      expect(schema.properties.note).toEqual(expect.objectContaining({ type: 'string', maxLength: 2000 }))
    }
    const create = toolMeta.create_session.inputSchema as any
    expect(create.required).toEqual(['workflow_name'])
    expect(create.properties.data).toEqual(expect.objectContaining({ type: 'object' }))
    expect((toolMeta.update_session_data.inputSchema as any).required).toEqual(['session_id', 'data'])
    const list = toolMeta.list_sessions.inputSchema as any
    expect(list.required).toBeUndefined()
    expect(Object.keys(list.properties)).toEqual(['workflow_name', 'active', 'limit'])
  })

  it.each(['create_session', 'advance', 'reset_state', 'current_state'])('%s description says the response has the step context', (name) => {
    const d = toolMeta[name].description
    expect(d).toContain('state description')
    expect(d.toLowerCase()).toContain('next transitions')
  })

  it.each(['create_session', 'advance', 'reset_state', 'update_session_data'])('%s description explains session data', (name) => {
    expect(toolMeta[name].description).toContain('later conversation')
  })
})
