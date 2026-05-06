import { buildMcpServer } from '../src/index'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore } from '@eliph/core'

function makeStores() {
  return {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore: new InMemoryApiKeyStore(),
  }
}

describe('MCP server', () => {
  it('registers all expected tools', () => {
    const server = buildMcpServer(makeStores())
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

  it('create_procedure creates a workflow', async () => {
    const stores = makeStores()
    const server = buildMcpServer(stores)
    await server.callTool('create_procedure', { workflow_name: 'smoke', description: 'test' })
    const graph = await stores.workflowStore.get('smoke')
    expect(graph).not.toBeNull()
    expect(graph?.states.start).toBeDefined()
  })

  it('full session lifecycle works end to end', async () => {
    const stores = makeStores()
    const server = buildMcpServer(stores)

    await server.callTool('create_procedure', { workflow_name: 'e2e', description: '' })
    await server.callTool('add_transition', { workflow_name: 'e2e', transition: 'start -> done' })

    const createRes = await server.callTool('create_session', { workflow_name: 'e2e' })
    const sessionId = JSON.parse(createRes.content[0].text).id

    const advanceRes = await server.callTool('advance', { workflow_name: 'e2e', session_id: sessionId })
    expect(JSON.parse(advanceRes.content[0].text).currentState).toBe('done')
  })
})
