import { createStores } from '../src/index'
import { WorkflowGraph } from '@eliph/core'

function makeGraph(name = 'test', description = 'a test workflow'): WorkflowGraph {
  return {
    name,
    description,
    states: { start: { name: 'start', isTerminal: false } },
    transitions: [],
  }
}

describe('SqliteWorkflowStore', () => {
  function store() {
    return createStores(':memory:').workflowStore
  }

  it('saves and retrieves a workflow', async () => {
    const s = store()
    await s.save(makeGraph())
    const result = await s.get('test')
    expect(result).toEqual(makeGraph())
  })

  it('returns null for unknown workflow', async () => {
    expect(await store().get('unknown')).toBeNull()
  })

  it('lists all workflow names', async () => {
    const s = store()
    await s.save(makeGraph('a'))
    await s.save(makeGraph('b'))
    const names = await s.list()
    expect(names).toEqual(expect.arrayContaining(['a', 'b']))
    expect(names).toHaveLength(2)
  })

  it('searches by name', async () => {
    const s = store()
    await s.save(makeGraph('coin_flip'))
    await s.save(makeGraph('onboarding'))
    expect(await s.search('coin')).toEqual(['coin_flip'])
  })

  it('searches by description', async () => {
    const s = store()
    await s.save(makeGraph('flow', 'handles user signup'))
    expect(await s.search('signup')).toEqual(['flow'])
  })

  it('overwrites existing workflow on save', async () => {
    const s = store()
    await s.save(makeGraph())
    await s.save({ ...makeGraph(), description: 'updated' })
    const result = await s.get('test')
    expect(result!.description).toBe('updated')
  })

  it('preserves created_at on overwrite', async () => {
    const s = store()
    await s.save(makeGraph())
    await s.save({ ...makeGraph(), description: 'updated' })
    expect(await s.get('test')).not.toBeNull()
  })

  it('deletes a workflow', async () => {
    const s = store()
    await s.save(makeGraph())
    await s.delete('test')
    expect(await s.get('test')).toBeNull()
  })
})
