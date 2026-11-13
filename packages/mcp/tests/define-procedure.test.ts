import { makeProcedureTools } from '../src/tools/procedures'
import { buildMcpServer, toolMeta } from '../src/index'

function fakeClient() {
  const request = jest.fn(async (..._args: any[]): Promise<any> => ({}))
  return { client: { request } as any, request }
}

describe('define_procedure tool', () => {
  it('is registered with metadata', () => {
    const server = buildMcpServer('https://eliph-api.revalent.ai', 'test-key')
    expect(server.getToolNames()).toContain('define_procedure')
    const meta = toolMeta.define_procedure
    expect((meta.inputSchema as any).required).toEqual(['workflow_name', 'description', 'transitions'])
    expect(Object.keys((meta.inputSchema as any).properties)).toEqual(['workflow_name', 'description', 'transitions', 'states', 'overwrite'])
    expect(meta.description).toContain('preferred')
    expect(meta.description).toContain('Example')
  })

  it('PUTs the whole definition to /procedure/:name', async () => {
    const { client, request } = fakeClient()
    const tools = makeProcedureTools(client)
    await tools.define_procedure({
      workflow_name: 'code review',
      description: 'review a PR',
      transitions: ['start -> reviewing', 'reviewing -approved-> merged'],
      states: { merged: { description: 'done', terminal: true } },
      overwrite: true,
    })
    expect(request.mock.calls).toEqual([[
      'PUT', '/procedure/code%20review',
      {
        description: 'review a PR',
        transitions: ['start -> reviewing', 'reviewing -approved-> merged'],
        states: { merged: { description: 'done', terminal: true } },
        overwrite: true,
      },
    ]])
  })

  it('omits optional states and overwrite when not given', async () => {
    const { client, request } = fakeClient()
    const tools = makeProcedureTools(client)
    await tools.define_procedure({ workflow_name: 'flow', description: 'd', transitions: ['start -> end'] })
    expect(request.mock.calls).toEqual([['PUT', '/procedure/flow', { description: 'd', transitions: ['start -> end'] }]])
  })

  it('create_procedure points to define_procedure and keeps its request shape', async () => {
    expect(toolMeta.create_procedure.description).toContain('define_procedure')
    const { client, request } = fakeClient()
    await makeProcedureTools(client).create_procedure({ workflow_name: 'flow', description: 'd' })
    expect(request.mock.calls).toEqual([['POST', '/procedure', { workflow_name: 'flow', description: 'd' }]])
  })
})
