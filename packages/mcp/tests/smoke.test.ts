import { buildMcpServer } from '../src/index'

describe('MCP server', () => {
  it('registers all expected tools', () => {
    const server = buildMcpServer('https://eliph-api.revalent.ai', 'test-key')
    const toolNames = server.getToolNames()
    expect(toolNames).toContain('procedures')
    expect(toolNames).toContain('procedure')
    expect(toolNames).toContain('create_procedure')
    expect(toolNames).toContain('add_transition')
    expect(toolNames).toContain('remove_transition')
    expect(toolNames).toContain('remove_state')
    expect(toolNames).toContain('list_states')
    expect(toolNames).toContain('create_session')
    expect(toolNames).toContain('delete_session')
    expect(toolNames).toContain('current_state')
    expect(toolNames).toContain('next_transitions')
    expect(toolNames).toContain('advance')
    expect(toolNames).toContain('reset_state')
    expect(toolNames).toContain('requirements')
  })
})
