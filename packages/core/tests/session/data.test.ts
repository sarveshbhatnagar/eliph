import {
  mergeSessionData, appendSessionEvent, applyDataPatch, SessionDataError,
  SESSION_DATA_MAX_BYTES, SESSION_EVENTS_MAX,
} from '../../src/session/data'
import { applyAdvance, applyReset } from '../../src/session/manager'
import { Session, SessionEvent } from '../../src/session/types'

// A session as stored by a release before data/events/updatedAt existed
function oldSession(currentState = 'start'): Session {
  return {
    id: 's1',
    workflowName: 'flow',
    workflowOwnerId: 'org',
    currentState,
    history: [currentState],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }
}

function expectDataError(fn: () => unknown, code: string) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(SessionDataError)
    expect((e as SessionDataError).code).toBe(code)
    return
  }
  throw new Error('expected a SessionDataError')
}

describe('mergeSessionData', () => {
  it('shallow-merges a patch into existing data without mutating it', () => {
    const current = { a: 1, nested: { x: 1 } }
    const merged = mergeSessionData(current, { b: 2, nested: { y: 2 } })
    expect(merged).toEqual({ a: 1, b: 2, nested: { y: 2 } })
    expect(current).toEqual({ a: 1, nested: { x: 1 } })
  })

  it('treats missing current data as {}', () => {
    expect(mergeSessionData(undefined, { a: 1 })).toEqual({ a: 1 })
  })

  it('removes a key set to null', () => {
    expect(mergeSessionData({ a: 1, b: 2 }, { a: null })).toEqual({ b: 2 })
  })

  it.each([null, [1, 2], 'str', 3])('rejects a non-object patch %p with BAD_REQUEST', (patch) => {
    expectDataError(() => mergeSessionData({}, patch), 'BAD_REQUEST')
  })

  it.each(['__proto__', 'constructor', 'prototype'])('rejects the key %s at the top level', (key) => {
    const patch = JSON.parse(`{"${key}": {"polluted": true}}`)
    expectDataError(() => mergeSessionData({}, patch), 'BAD_REQUEST')
    expect(({} as any).polluted).toBeUndefined()
  })

  it('rejects forbidden keys nested in objects and arrays', () => {
    expectDataError(() => mergeSessionData({}, JSON.parse('{"a": {"b": {"__proto__": {"x": 1}}}}')), 'BAD_REQUEST')
    expectDataError(() => mergeSessionData({}, JSON.parse('{"a": [{"constructor": 1}]}')), 'BAD_REQUEST')
  })

  it('accepts data exactly at the size limit and rejects one byte more', () => {
    const overhead = JSON.stringify({ k: '' }).length
    const atLimit = { k: 'x'.repeat(SESSION_DATA_MAX_BYTES - overhead) }
    expect(mergeSessionData({}, atLimit)).toEqual(atLimit)
    expectDataError(() => mergeSessionData({}, { k: 'x'.repeat(SESSION_DATA_MAX_BYTES - overhead + 1) }), 'PAYLOAD_TOO_LARGE')
  })

  it('applies the size limit to the merged result, not only the patch', () => {
    const half = 'x'.repeat(SESSION_DATA_MAX_BYTES / 2)
    expectDataError(() => mergeSessionData({ a: half }, { b: half }), 'PAYLOAD_TOO_LARGE')
    // Removing a key in the same patch keeps it under the limit
    expect(Object.keys(mergeSessionData({ a: half }, { a: null, b: half }))).toEqual(['b'])
  })

  it('counts multi-byte characters by their UTF-8 size', () => {
    const overhead = JSON.stringify({ k: '' }).length
    const chars = Math.floor((SESSION_DATA_MAX_BYTES - overhead) / 2) + 1
    expectDataError(() => mergeSessionData({}, { k: 'é'.repeat(chars) }), 'PAYLOAD_TOO_LARGE')
  })
})

describe('appendSessionEvent', () => {
  const ev = (i: number): SessionEvent => ({ type: 'data', note: String(i), at: new Date(0).toISOString() })

  it('treats missing events as []', () => {
    expect(appendSessionEvent(undefined, ev(1))).toEqual([ev(1)])
  })

  it(`keeps only the most recent ${SESSION_EVENTS_MAX} events`, () => {
    const events = Array.from({ length: SESSION_EVENTS_MAX }, (_, i) => ev(i))
    const next = appendSessionEvent(events, ev(SESSION_EVENTS_MAX))
    expect(next).toHaveLength(SESSION_EVENTS_MAX)
    expect(next[0].note).toBe('1')
    expect(next[next.length - 1].note).toBe(String(SESSION_EVENTS_MAX))
    expect(events).toHaveLength(SESSION_EVENTS_MAX)
  })
})

describe('applyAdvance / applyReset events and data', () => {
  const now = new Date('2026-02-02T00:00:00.000Z')

  it('records an advance event with from, to, action and note on an old session', () => {
    const updated = applyAdvance(oldSession(), 'review', { action: 'go', note: 'why', now })
    expect(updated.events).toEqual([{ type: 'advance', from: 'start', to: 'review', action: 'go', note: 'why', at: now.toISOString() }])
    expect(updated.history).toEqual(['start', 'review'])
    expect(updated.updatedAt).toEqual(now)
    expect(updated.data).toBeUndefined()
  })

  it('omits action and note from the event when not given', () => {
    const updated = applyAdvance(oldSession(), 'review', { now })
    expect(updated.events).toEqual([{ type: 'advance', from: 'start', to: 'review', at: now.toISOString() }])
  })

  it('merges a data patch on advance', () => {
    const s = { ...oldSession(), data: { a: 1, b: 2 } }
    const updated = applyAdvance(s, 'review', { data: { b: null, c: 3 } })
    expect(updated.data).toEqual({ a: 1, c: 3 })
    expect(s.data).toEqual({ a: 1, b: 2 })
  })

  it('throws on an oversized data patch and does not change the session', () => {
    const s = oldSession()
    expect(() => applyAdvance(s, 'review', { data: { k: 'x'.repeat(SESSION_DATA_MAX_BYTES) } })).toThrow(SessionDataError)
    expect(s.currentState).toBe('start')
  })

  it('records a reset event and appends to existing events', () => {
    const s = applyAdvance(oldSession(), 'review', { now })
    const updated = applyReset(s, 'start', { note: 'redo', now })
    expect(updated.events!.map(e => e.type)).toEqual(['advance', 'reset'])
    expect(updated.events![1]).toEqual({ type: 'reset', from: 'review', to: 'start', note: 'redo', at: now.toISOString() })
    expect(updated.history).toEqual(['start', 'review', 'start'])
  })
})

describe('applyDataPatch', () => {
  it('merges data, keeps the state and records a data event', () => {
    const now = new Date('2026-03-03T00:00:00.000Z')
    const updated = applyDataPatch(oldSession('review'), { pr: 'https://example.test/1' }, now)
    expect(updated.currentState).toBe('review')
    expect(updated.history).toEqual(['review'])
    expect(updated.data).toEqual({ pr: 'https://example.test/1' })
    expect(updated.events).toEqual([{ type: 'data', at: now.toISOString() }])
    expect(updated.updatedAt).toEqual(now)
  })
})

describe('mergeSessionData nesting depth', () => {
  const nest = (levels: number) => {
    let v: unknown = 1
    for (let i = 0; i < levels; i++) v = i % 2 ? [v] : { a: v }
    return { root: v }
  }

  it('accepts reasonably nested data', () => {
    expect(() => mergeSessionData({}, nest(20))).not.toThrow()
  })

  it('rejects very deep nesting with a clean error instead of overflowing the stack', () => {
    expect(() => mergeSessionData({}, nest(100000))).toThrow(/nested too deeply/)
  })
})
