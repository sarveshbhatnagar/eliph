import { createStores } from '../src/index'
import { openDb } from '../src/db'
import { SqliteWorkflowStore } from '../src/workflow'
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

  it('backfills the FTS index for workflows saved before FTS existed', async () => {
    // Share one db so a second store sees the first store's rows (simulating a restart).
    const db = openDb(':memory:')
    const s1 = new SqliteWorkflowStore(db)
    await s1.save(makeGraph('legacy_flow', 'pre-existing workflow'), OWN)
    // Simulate a database created before the FTS table existed: rows present, index empty.
    db.prepare('DELETE FROM workflows_fts').run()
    expect(await s1.search('legacy', OWN)).toEqual([])

    // Constructing a fresh store on the same db should backfill the index.
    const s2 = new SqliteWorkflowStore(db)
    expect(await s2.search('legacy', OWN)).toEqual([
      { name: 'legacy_flow', description: 'pre-existing workflow' },
    ])
  })

  it('deletes a workflow', async () => {
    const s = store()
    await s.save(makeGraph(), OWN)
    await s.delete('test', OWN)
    expect(await s.get('test', OWN)).toBeNull()
  })

  it('matches text found only in a state name or description', async () => {
    const s = store()
    const graph: WorkflowGraph = {
      name: 'deploy',
      description: 'a deployment workflow',
      states: {
        start: { name: 'start', isTerminal: false },
        revert: { name: 'revert', isTerminal: false, description: 'rollback the release' },
      },
      transitions: [],
    }
    await s.save(graph, OWN)
    const results = await s.search('rollback', OWN)
    expect(results.map(r => r.name)).toContain('deploy')
  })

  it('ranks a name match above a description-only match', async () => {
    const s = store()
    await s.save(makeGraph('payment', 'handles money'), OWN)
    await s.save(makeGraph('checkout', 'processes a payment'), OWN)
    const results = await s.search('payment', OWN)
    expect(results.map(r => r.name)).toEqual(['payment', 'checkout'])
  })

  it('matches on multiple tokens', async () => {
    const s = store()
    await s.save(makeGraph('flow', 'handles user signup'), OWN)
    await s.save(makeGraph('other', 'unrelated thing'), OWN)
    const results = await s.search('user signup', OWN)
    expect(results.map(r => r.name)).toContain('flow')
  })

  it('does not throw on queries with FTS operator characters', async () => {
    const s = store()
    await s.save(makeGraph('deploy_prod', 'deploy to production now'), OWN)
    const results = await s.search('deploy (prod)! "now"', OWN)
    expect(results.map(r => r.name)).toContain('deploy_prod')
  })

  it('keeps the FTS index in sync on update', async () => {
    const s = store()
    const v1: WorkflowGraph = {
      name: 'sync',
      description: 'the original tagline',
      states: { start: { name: 'start', isTerminal: false, description: 'oldword' } },
      transitions: [],
    }
    await s.save(v1, OWN)
    expect((await s.search('oldword', OWN)).map(r => r.name)).toContain('sync')

    const v2: WorkflowGraph = {
      name: 'sync',
      description: 'the brandnew tagline',
      states: { start: { name: 'start', isTerminal: false, description: 'newword' } },
      transitions: [],
    }
    await s.save(v2, OWN)
    expect((await s.search('brandnew', OWN)).map(r => r.name)).toContain('sync')
    expect((await s.search('newword', OWN)).map(r => r.name)).toContain('sync')
    expect((await s.search('oldword', OWN)).map(r => r.name)).not.toContain('sync')
    expect((await s.search('original', OWN)).map(r => r.name)).not.toContain('sync')
  })

  it('removes a workflow from the FTS index on delete', async () => {
    const s = store()
    await s.save(makeGraph('gone', 'soon to be deleted'), OWN)
    expect((await s.search('deleted', OWN)).map(r => r.name)).toContain('gone')
    await s.delete('gone', OWN)
    expect((await s.search('deleted', OWN)).map(r => r.name)).not.toContain('gone')
  })

  it('returns all workflows for an empty query (browse mode)', async () => {
    const s = store()
    await s.save(makeGraph('a'), OWN)
    await s.save(makeGraph('b'), OWN)
    const results = await s.search('', OWN)
    expect(results.map(r => r.name)).toEqual(['a', 'b'])
  })
})
