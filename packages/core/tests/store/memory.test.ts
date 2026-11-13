import { InMemoryWorkflowStore } from '../../src/store/memory/workflow'
import { InMemorySessionStore } from '../../src/store/memory/session'
import { InMemoryApiKeyStore } from '../../src/store/memory/apikey'
import { InMemoryOrgKeyStore } from '../../src/store/memory/orgkey'
import bcrypt from 'bcryptjs'
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

function makeGraphWith(
  name: string,
  description: string,
  states: WorkflowGraph['states'] = { start: { name: 'start', isTerminal: false } },
): WorkflowGraph {
  return { name, description, states, transitions: [] }
}

const OWN = 'owner-1'

function makeSession(id = 'sess-1'): Session {
  return {
    id,
    workflowName: 'test',
    workflowOwnerId: OWN,
    currentState: 'start',
    history: ['start'],
    createdAt: new Date(),
  }
}

describe('InMemoryWorkflowStore', () => {
  it('saves and retrieves a workflow', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraph(), OWN)
    const result = await store.get('test', OWN)
    expect(result?.name).toBe('test')
  })

  it('returns null for unknown workflow', async () => {
    const store = new InMemoryWorkflowStore()
    expect(await store.get('nonexistent', OWN)).toBeNull()
  })

  it('lists all workflow names', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraph('a'), OWN)
    await store.save(makeGraph('b'), OWN)
    expect(await store.list(OWN)).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('searches by name token (prefix)', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraph('onboarding'), OWN)
    await store.save(makeGraph('checkout'), OWN)
    const results = await store.search('onboard', OWN)
    expect(results.map((r: any) => r.name)).toContain('onboarding')
    expect(results.map((r: any) => r.name)).not.toContain('checkout')
  })

  it('matches on state-text (state names + descriptions)', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(
      makeGraphWith('refunds', 'handle money back', {
        review: { name: 'review', isTerminal: false, description: 'escalate to manager' },
      }),
      OWN,
    )
    await store.save(makeGraphWith('checkout', 'pay for items'), OWN)
    const results = await store.search('escalate', OWN)
    expect(results.map((r: any) => r.name)).toEqual(['refunds'])
  })

  it('ranks name matches above description-only matches', async () => {
    const store = new InMemoryWorkflowStore()
    // name match
    await store.save(makeGraphWith('payment', 'collect funds'), OWN)
    // description-only match for the same token
    await store.save(makeGraphWith('orders', 'process a payment'), OWN)
    const results = await store.search('payment', OWN)
    expect(results.map((r: any) => r.name)).toEqual(['payment', 'orders'])
  })

  it('matches any of multiple tokens (OR semantics) and ranks by hit count', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraphWith('alpha', 'red green'), OWN)
    await store.save(makeGraphWith('beta', 'green only'), OWN)
    await store.save(makeGraphWith('gamma', 'unrelated text'), OWN)
    const results = await store.search('red green', OWN)
    expect(results.map((r: any) => r.name)).toEqual(['alpha', 'beta'])
    expect(results.map((r: any) => r.name)).not.toContain('gamma')
  })

  it('empty query returns all workflows for the owner', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraph('b'), OWN)
    await store.save(makeGraph('a'), OWN)
    await store.save(makeGraph('a'), 'other-owner')
    const results = await store.search('   ', OWN)
    expect(results.map((r: any) => r.name)).toEqual(['a', 'b'])
  })

  it('deletes a workflow', async () => {
    const store = new InMemoryWorkflowStore()
    await store.save(makeGraph(), OWN)
    await store.delete('test', OWN)
    expect(await store.get('test', OWN)).toBeNull()
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

describe('InMemorySessionStore.saveIfRevision', () => {
  it('saves when the stored revision matches and refuses a stale one', async () => {
    const store = new InMemorySessionStore()
    await store.save(makeSession())
    expect(await store.saveIfRevision({ ...makeSession(), currentState: 'review', revision: 1 }, 0)).toBe(true)
    expect(await store.saveIfRevision({ ...makeSession(), currentState: 'lost', revision: 1 }, 0)).toBe(false)
    expect(await store.get('sess-1')).toMatchObject({ currentState: 'review', revision: 1 })
    expect(await store.saveIfRevision({ ...makeSession(), currentState: 'end', revision: 2 }, 1)).toBe(true)
    expect(await store.get('sess-1')).toMatchObject({ currentState: 'end', revision: 2 })
  })

  it('treats a session without a revision as revision 0', async () => {
    const store = new InMemorySessionStore()
    await store.save(makeSession())
    expect(await store.saveIfRevision({ ...makeSession(), revision: 1 }, 3)).toBe(false)
    expect(await store.saveIfRevision({ ...makeSession(), revision: 1 }, 0)).toBe(true)
  })

  it('does not create a missing session', async () => {
    const store = new InMemorySessionStore()
    expect(await store.saveIfRevision({ ...makeSession(), revision: 1 }, 0)).toBe(false)
    expect(await store.get('sess-1')).toBeNull()
  })
})

describe('InMemorySessionStore.list', () => {
  function at(id: string, owner: string, iso: string, workflowName = 'test'): Session {
    return { ...makeSession(id), workflowOwnerId: owner, workflowName, createdAt: new Date(iso) }
  }

  async function seeded() {
    const store = new InMemorySessionStore()
    await store.save(at('old', 'org', '2026-01-01T00:00:00.000Z'))
    await store.save(at('new', 'org', '2026-01-03T00:00:00.000Z'))
    await store.save(at('legacy', 'key-1', '2026-01-02T00:00:00.000Z', 'other'))
    await store.save(at('foreign', 'other-org', '2026-01-04T00:00:00.000Z'))
    return store
  }

  it('returns only the given owners, newest first', async () => {
    const store = await seeded()
    expect((await store.list(['org', 'key-1'])).map(s => s.id)).toEqual(['new', 'legacy', 'old'])
  })

  it('returns nothing for no owners', async () => {
    expect(await (await seeded()).list([])).toEqual([])
  })

  it('filters by workflow name and pages with limit/offset', async () => {
    const store = await seeded()
    expect((await store.list(['org', 'key-1'], { workflowName: 'other' })).map(s => s.id)).toEqual(['legacy'])
    expect((await store.list(['org', 'key-1'], { limit: 2 })).map(s => s.id)).toEqual(['new', 'legacy'])
    expect((await store.list(['org', 'key-1'], { limit: 2, offset: 2 })).map(s => s.id)).toEqual(['old'])
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

describe('InMemoryApiKeyStore fast lookup', () => {
  it('finds a key without any bcrypt.compare call', async () => {
    const spy = jest.spyOn(bcrypt, 'compare')
    try {
      const store = new InMemoryApiKeyStore()
      const { rawKey, record } = await store.create('k', 'org')
      expect((await store.find(rawKey))?.id).toBe(record.id)
      expect(await store.find('wrong')).toBeNull()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('deleting one key leaves others findable', async () => {
    const store = new InMemoryApiKeyStore()
    const a = await store.create('a', 'org')
    const b = await store.create('b', 'org')
    await store.delete(a.record.id)
    expect(await store.find(a.rawKey)).toBeNull()
    expect((await store.find(b.rawKey))?.id).toBe(b.record.id)
  })
})

describe('InMemoryOrgKeyStore fast lookup', () => {
  it('finds by raw key and returns null for a wrong key', async () => {
    const store = new InMemoryOrgKeyStore()
    const { rawKey, record } = await store.create('acme', 5)
    expect(await store.find(rawKey)).toEqual(record)
    expect(await store.find('wrong')).toBeNull()
  })

  it('regenerate invalidates the old key', async () => {
    const store = new InMemoryOrgKeyStore()
    const { rawKey: oldRaw, record } = await store.create('acme', 5)
    const { rawKey: newRaw } = await store.regenerate(record.id)
    expect(await store.find(oldRaw)).toBeNull()
    expect((await store.find(newRaw))?.id).toBe(record.id)
  })

  it('delete stops the key working', async () => {
    const store = new InMemoryOrgKeyStore()
    const { rawKey, record } = await store.create('acme', 5)
    await store.delete(record.id)
    expect(await store.find(rawKey)).toBeNull()
  })
})
