import { createStores } from '../src/index'
import { Session } from '@eliph/core'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    workflowName: 'flow',
    currentState: 'start',
    history: ['start'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

describe('SqliteSessionStore', () => {
  function store() {
    return createStores(':memory:').sessionStore
  }

  it('saves and retrieves a session', async () => {
    const s = store()
    const session = makeSession()
    await s.save(session)
    const result = await s.get('sess-1')
    expect(result).not.toBeNull()
    expect(result!.id).toBe('sess-1')
    expect(result!.currentState).toBe('start')
    expect(result!.createdAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  it('returns null for unknown session', async () => {
    expect(await store().get('unknown')).toBeNull()
  })

  it('updates currentState on re-save', async () => {
    const s = store()
    await s.save(makeSession())
    await s.save(makeSession({ currentState: 'review', history: ['start', 'review'] }))
    const result = await s.get('sess-1')
    expect(result!.currentState).toBe('review')
    expect(result!.history).toEqual(['start', 'review'])
  })

  it('preserves createdAt on re-save', async () => {
    const s = store()
    await s.save(makeSession())
    await s.save(makeSession({ currentState: 'review' }))
    const result = await s.get('sess-1')
    expect(result!.createdAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))
  })

  it('findByState returns matching sessions', async () => {
    const s = store()
    await s.save(makeSession({ id: 'a', currentState: 'review' }))
    await s.save(makeSession({ id: 'b', currentState: 'start' }))
    const results = await s.findByState('flow', 'review')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('a')
  })

  it('findByState ignores sessions from other workflows', async () => {
    const s = store()
    await s.save(makeSession({ id: 'a', workflowName: 'flow', currentState: 'review' }))
    await s.save(makeSession({ id: 'b', workflowName: 'other', currentState: 'review' }))
    const results = await s.findByState('flow', 'review')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('a')
  })

  it('deletes a session', async () => {
    const s = store()
    await s.save(makeSession())
    await s.delete('sess-1')
    expect(await s.get('sess-1')).toBeNull()
  })
})
