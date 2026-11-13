import { makeSessionTools } from '../src/tools/sessions'
import { makeAdvanceTools } from '../src/tools/advance'
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
