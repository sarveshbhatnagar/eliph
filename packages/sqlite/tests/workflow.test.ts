import { createStores } from '../src/index'
import { WorkflowGraph } from '@eliph/core'

const OWN = 'owner-1'

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
    await s.save(makeGraph(), OWN)
    const result = await s.get('test', OWN)
    expect(result).toEqual(makeGraph())
  })

  it('returns null for unknown workflow', async () => {
    expect(await store().get('unknown', OWN)).toBeNull()
  })

  it('returns null for wrong owner', async () => {
    const s = store()
    await s.save(makeGraph(), OWN)
    expect(await s.get('test', 'other-owner')).toBeNull()
  })

  it('lists all workflow names for owner', async () => {
    const s = store()
    await s.save(makeGraph('a'), OWN)
    await s.save(makeGraph('b'), OWN)
    await s.save(makeGraph('c'), 'other-owner')
    const names = await s.list(OWN)
    expect(names).toEqual(expect.arrayContaining(['a', 'b']))
    expect(names).toHaveLength(2)
  })

  it('searches by name', async () => {
    const s = store()
    await s.save(makeGraph('coin_flip'), OWN)
    await s.save(makeGraph('onboarding'), OWN)
    expect(await s.search('coin', OWN)).toEqual([{ name: 'coin_flip', description: 'a test workflow' }])
  })

  it('searches by description', async () => {
    const s = store()
    await s.save(makeGraph('flow', 'handles user signup'), OWN)
    expect(await s.search('signup', OWN)).toEqual([{ name: 'flow', description: 'handles user signup' }])
  })

  it('overwrites existing workflow on save', async () => {
    const s = store()
    await s.save(makeGraph(), OWN)
    await s.save({ ...makeGraph(), description: 'updated' }, OWN)
    const result = await s.get('test', OWN)
    expect(result!.description).toBe('updated')
  })

  it('two owners can have workflows with the same name', async () => {
    const s = store()
    await s.save(makeGraph('shared'), OWN)
    await s.save({ ...makeGraph('shared'), description: 'other version' }, 'other-owner')
    expect((await s.get('shared', OWN))!.description).toBe('a test workflow')
    expect((await s.get('shared', 'other-owner'))!.description).toBe('other version')
  })

  it('deletes a workflow', async () => {
    const s = store()
    await s.save(makeGraph(), OWN)
    await s.delete('test', OWN)
    expect(await s.get('test', OWN)).toBeNull()
  })
})
