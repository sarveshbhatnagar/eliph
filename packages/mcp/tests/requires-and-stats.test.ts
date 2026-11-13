import { makeGraphTools } from '../src/tools/graph'
import { makeProcedureTools } from '../src/tools/procedures'
import { makeSessionTools } from '../src/tools/sessions'
import { buildMcpServer, toolMeta } from '../src/index'

function fakeClient(result: any = {}) {
  const request = jest.fn(async (..._args: any[]): Promise<any> => result)
  return { client: { request } as any, request }
}

describe('set_transition_requirements tool', () => {
  it('is registered with metadata', () => {
    expect(buildMcpServer('https://eliph-api.revalent.ai', 'k').getToolNames()).toContain('set_transition_requirements')
    const schema = toolMeta.set_transition_requirements.inputSchema as any
    expect(schema.required).toEqual(['workflow_name', 'transition', 'requires'])
    expect(toolMeta.set_transition_requirements.description).toContain('MISSING_REQUIRED_DATA')
  })

  it('PUTs the requirement to /procedure/:name/transition/requires', async () => {
    const { client, request } = fakeClient()
    await makeGraphTools(client).set_transition_requirements({ workflow_name: 'code review', transition: 'review -approved-> end', requires: ['pr_url'] })
    expect(request.mock.calls).toEqual([[
      'PUT', '/procedure/code%20review/transition/requires', { transition: 'review -approved-> end', requires: ['pr_url'] },
    ]])
  })
})

describe('procedure_stats tool', () => {
  it('is registered with a description saying what it is for', () => {
    expect(buildMcpServer('https://eliph-api.revalent.ai', 'k').getToolNames()).toContain('procedure_stats')
    expect((toolMeta.procedure_stats.inputSchema as any).required).toEqual(['workflow_name'])
    expect(toolMeta.procedure_stats.description).toMatch(/stall/)
    expect(toolMeta.procedure_stats.description).toMatch(/backtrack/)
  })

  it('GETs /procedure/:name/stats', async () => {
    const { client, request } = fakeClient({ workflow: 'a b' })
    const result = await makeProcedureTools(client).procedure_stats({ workflow_name: 'a b' })
    expect(result).toEqual({ workflow: 'a b' })
    expect(request.mock.calls).toEqual([['GET', '/procedure/a%20b/stats']])
  })
})

describe('requires in existing tools', () => {
  it('define_procedure sends object-form transitions unchanged and documents them', async () => {
    const { client, request } = fakeClient()
    const transitions = ['start -> review', { transition: 'review -approved-> end', requires: ['pr_url'] }]
    await makeProcedureTools(client).define_procedure({ workflow_name: 'f', description: 'd', transitions })
    expect(request.mock.calls).toEqual([['PUT', '/procedure/f', { description: 'd', transitions }]])
    expect(toolMeta.define_procedure.description).toContain('"requires"')
    const items = (toolMeta.define_procedure.inputSchema as any).properties.transitions.items
    expect(items.anyOf.map((x: any) => x.type)).toEqual(['string', 'object'])
  })

  it('advance and next_transitions mention requires and passing data in the same call', () => {
    expect(toolMeta.advance.description).toContain('requires')
    expect(toolMeta.advance.description).toContain('same call')
    expect(toolMeta.next_transitions.description).toContain('requires')
    expect(toolMeta.next_transitions.description).toContain('same advance() call')
  })

  it('next_transitions passes requires through', async () => {
    const { client } = fakeClient([{ from: 'a', to: 'b', type: 'symbolic', action: 'go', requires: ['pr_url'] }])
    const [t] = await makeSessionTools(client).next_transitions({ session_id: 's' })
    expect(t.requires).toEqual(['pr_url'])
    expect(t.advance_with).toEqual({ completed_action: 'go' })
  })
})
