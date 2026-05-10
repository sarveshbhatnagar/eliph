import { InMemoryWorkflowStore } from '../../src/store/memory/workflow'
import { InMemorySessionStore } from '../../src/store/memory/session'
import { InMemoryApiKeyStore } from '../../src/store/memory/apikey'
import { WorkflowGraph } from '../../src/graph/types'
import { Session } from '../../src/session/types'

function makeGraph(name = 'test'): WorkflowGraph {
  return {
    name,
    description: 'a test workflow',
    states: { start: { name: 'start', isTerminal: false } },
    transitions: [],
  }
}

function makeSession(id = 'sess-1'): Session {
  return {
    id,
    workflowName: 'test',
    currentState: 'start',
    history: ['start'],
    createdAt: new Date(),
  }
}

describe('InMemoryWorkflowStore', () => {
  it('saves and retrieves a workflow', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraph())
    const result = await store.get('test')
    expect(result?.name).toBe('test')
  })

  it('returns null for unknown workflow', async () => {
    const store = new InMemoryWorkflowStore()
    expect(await store.get('nonexistent')).toBeNull()
  })

  it('lists all workflow names', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraph('a'))
    await store.save(makeGraph('b'))
    expect(await store.list()).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('searches by name substring', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraph('onboarding'))
    await store.save(makeGraph('checkout'))
    const results = await store.search('board')
    expect(results).toContain('onboarding')
    expect(results).not.toContain('checkout')
  })

  it('deletes a workflow', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraph())
    await store.delete('test')
    expect(await store.get('test')).toBeNull()
  })
})

describe('InMemorySessionStore', () => {
  it('saves and retrieves a session', async () => {
    const store = new InMemorySessionStore()
    await store.save(makeSession())
    expect(await store.get('sess-1')).toMatchObject({ id: 'sess-1' })
  })

  it('returns null for unknown session', async () => {
    const store = new InMemorySessionStore()
    expect(await store.get('nope')).toBeNull()
  })

  it('deletes a session', async () => {
    const store = new InMemorySessionStore()
    await store.save(makeSession())
    await store.delete('sess-1')
    expect(await store.get('sess-1')).toBeNull()
  })

  it('finds sessions by workflow and state', async () => {
    const store = new InMemorySessionStore()
    await store.save(makeSession('s1'))
    await store.save({ ...makeSession('s2'), currentState: 'review' })
    const results = await store.findByState('test', 'start')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('s1')
  })
})

describe('InMemoryApiKeyStore', () => {
  it('creates a key and finds it by raw value', async () => {
    const store = new InMemoryApiKeyStore()
    const { rawKey } = await store.create('my-key', 'test-org-id')
    const found = await store.find(rawKey)
    expect(found).not.toBeNull()
    expect(found?.label).toBe('my-key')
  })

  it('returns null for unknown key', async () => {
    const store = new InMemoryApiKeyStore()
    expect(await store.find('bad-key')).toBeNull()
  })

  it('deletes a key by id', async () => {
    const store = new InMemoryApiKeyStore()
    const { rawKey, record } = await store.create('to-delete', 'test-org-id')
    await store.delete(record.id)
    expect(await store.find(rawKey)).toBeNull()
  })

  it('lists keys without exposing hashes', async () => {
    const store = new InMemoryApiKeyStore()
    await store.create('label-a', 'test-org-id')
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect((list[0] as any).key).toBeUndefined()
  })
})
