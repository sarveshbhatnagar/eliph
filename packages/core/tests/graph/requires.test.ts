import {
  validateRequires, setTransitionRequires, missingRequiredData, assertRequiredData, RequiredDataError, REQUIRES_LIMITS,
} from '../../src/graph/requires'
import { addTransition, removeTransition } from '../../src/graph/engine'
import { buildGraph } from '../../src/graph/define'
import { chooseTransition, computeNextState } from '../../src/session/manager'
import { WorkflowGraph, Transition } from '../../src/graph/types'
import { Session } from '../../src/session/types'

function graphOf(...transitions: string[]): WorkflowGraph {
  return transitions.reduce(
    (g, t) => addTransition(g, t),
    { name: 'flow', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] } as WorkflowGraph,
  )
}

function session(currentState = 'start'): Session {
  return { id: 's', workflowName: 'flow', workflowOwnerId: 'o', currentState, history: [currentState], createdAt: new Date() }
}

describe('validateRequires', () => {
  it('accepts valid names and drops duplicates', () => {
    expect(validateRequires(['pr_url', 'ticket.id', 'a-b', 'pr_url'])).toEqual(['pr_url', 'ticket.id', 'a-b'])
    expect(validateRequires([])).toEqual([])
  })

  it.each([
    ['not an array', 'pr_url', /must be an array/],
    ['a non-string entry', [1], /must be strings/],
    ['an empty name', [''], /1 to 100 characters/],
    ['a name that is too long', ['a'.repeat(REQUIRES_LIMITS.maxNameLength + 1)], /1 to 100 characters/],
    ['a name with spaces', ['pr url'], /may only contain/],
    ['__proto__', ['__proto__'], /cannot be used/],
    ['constructor', ['constructor'], /cannot be used/],
    ['prototype', ['prototype'], /cannot be used/],
    ['too many names', Array.from({ length: REQUIRES_LIMITS.maxNames + 1 }, (_, i) => `k${i}`), /at most 20/],
  ])('rejects %s', (_label, value, message) => {
    expect(() => validateRequires(value)).toThrow(message)
  })

  it('accepts exactly the maximum number of names and the maximum length', () => {
    const names = Array.from({ length: REQUIRES_LIMITS.maxNames }, (_, i) => `k${i}`)
    expect(validateRequires(names)).toHaveLength(20)
    expect(validateRequires(['a'.repeat(100)])).toEqual(['a'.repeat(100)])
  })
})

describe('setTransitionRequires', () => {
  it('sets and clears the requirement on the named transition only', () => {
    const g = graphOf('start -go-> mid', 'start -skip-> end', 'mid -> end')
    const set = setTransitionRequires(g, 'start -go-> mid', ['pr_url'])
    expect(set.transitions[0]).toEqual({ from: 'start', to: 'mid', type: 'symbolic', action: 'go', requires: ['pr_url'] })
    expect(set.transitions[1]).not.toHaveProperty('requires')
    expect(g.transitions[0]).not.toHaveProperty('requires') // input not mutated

    const cleared = setTransitionRequires(set, 'start -go-> mid', [])
    expect(cleared.transitions[0]).toEqual({ from: 'start', to: 'mid', type: 'symbolic', action: 'go' })
  })

  it('works for deterministic and probabilistic transitions', () => {
    const g = graphOf('start -.5-> a', 'start -.5-> b', 'a -> end')
    expect(setTransitionRequires(g, 'start -.5-> b', ['x']).transitions[1].requires).toEqual(['x'])
    expect(setTransitionRequires(g, 'a -> end', ['y']).transitions[2].requires).toEqual(['y'])
  })

  it('rejects a transition that does not exist, a chain and invalid names', () => {
    const g = graphOf('start -go-> mid', 'mid -> end')
    expect(() => setTransitionRequires(g, 'start -nope-> mid', ['x'])).toThrow(/No transition "start -nope-> mid"/)
    expect(() => setTransitionRequires(g, 'start -go-> mid -> end', ['x'])).toThrow(/chains are not allowed/)
    expect(() => setTransitionRequires(g, 'start -go-> mid', ['bad key'])).toThrow(/may only contain/)
  })
})

describe('removeTransition ignores requires', () => {
  it('removes a transition that has a requirement', () => {
    const g = setTransitionRequires(graphOf('start -go-> mid', 'mid -> end'), 'start -go-> mid', ['pr_url'])
    expect(removeTransition(g, 'start -go-> mid').transitions).toEqual([{ from: 'mid', to: 'end', type: 'deterministic' }])
  })
})

describe('missingRequiredData / assertRequiredData', () => {
  const t: Transition = { from: 'a', to: 'b', type: 'symbolic', action: 'done', requires: ['pr_url', 'count', 'flag', 'note'] }

  it('treats null, undefined, missing and blank strings as missing; 0, false and objects as present', () => {
    expect(missingRequiredData(t, { pr_url: '   ', count: 0, flag: false, note: undefined })).toEqual(['pr_url', 'note'])
    expect(missingRequiredData(t, { pr_url: 'x', count: 0, flag: false, note: {} })).toEqual([])
    expect(missingRequiredData(t, undefined)).toEqual(['pr_url', 'count', 'flag', 'note'])
    expect(missingRequiredData({ requires: ['k'] }, { k: null })).toEqual(['k'])
  })

  it('does not see inherited members as data', () => {
    expect(missingRequiredData({ requires: ['toString'] }, {})).toEqual(['toString'])
  })

  it('a transition without requires needs nothing', () => {
    expect(missingRequiredData({ }, {})).toEqual([])
    expect(() => assertRequiredData({ from: 'a', to: 'b', type: 'deterministic' }, undefined)).not.toThrow()
  })

  it('throws RequiredDataError naming the missing keys and how to supply them', () => {
    let err: unknown
    try {
      assertRequiredData(t, { count: 1, flag: true })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(RequiredDataError)
    const e = err as RequiredDataError
    expect(e.code).toBe('MISSING_REQUIRED_DATA')
    expect(e.missing).toEqual(['pr_url', 'note'])
    expect(e.message).toContain('"pr_url", "note"')
    expect(e.message).toContain('a -done-> b')
    expect(e.message).toContain('in this advance call')
    expect(e.message).toContain('"completed_action": "done"')
  })
})

describe('chooseTransition', () => {
  it('returns the transition (with its requires) that an advance takes', () => {
    const g = setTransitionRequires(graphOf('start -go-> mid', 'mid -> end'), 'start -go-> mid', ['pr_url'])
    expect(chooseTransition(g, session(), 'go')).toEqual(g.transitions[0])
    expect(chooseTransition(g, session('mid'))).toEqual(g.transitions[1])
    expect(computeNextState(g, session(), 'go')).toBe('mid')
  })

  it('samples a probabilistic transition', () => {
    const g = graphOf('start -.3-> a', 'start -.7-> b')
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.9)
    try {
      expect(chooseTransition(g, session())).toEqual({ from: 'start', to: 'b', type: 'probabilistic', weight: 0.7 })
    } finally {
      spy.mockRestore()
    }
  })
})

describe('buildGraph with { transition, requires } entries', () => {
  it('sets requires on that single transition and leaves string entries unchanged', () => {
    const g = buildGraph({
      name: 'f',
      description: '',
      transitions: ['start -> review', { transition: 'review -approved-> end', requires: ['pr_url', 'pr_url'] }, 'review -rejected-> start'],
    })
    expect(g.transitions).toEqual([
      { from: 'start', to: 'review', type: 'deterministic' },
      { from: 'review', to: 'end', type: 'symbolic', action: 'approved', requires: ['pr_url'] },
      { from: 'review', to: 'start', type: 'symbolic', action: 'rejected' },
    ])
  })

  it('an empty requires array adds the transition without a requirement', () => {
    const g = buildGraph({ name: 'f', description: '', transitions: [{ transition: 'start -> end', requires: [] }] })
    expect(g.transitions).toEqual([{ from: 'start', to: 'end', type: 'deterministic' }])
  })

  it('rejects requires on a chain with a clear message', () => {
    expect(() => buildGraph({ name: 'f', description: '', transitions: [{ transition: 'start -> a -> end', requires: ['x'] }] }))
      .toThrow(/Transition #1 "start -> a -> end" is a chain; "requires" can only be set on a single transition/)
  })

  it.each([
    ['unknown fields', { transition: 'start -> end', requires: [], extra: 1 }, /unknown field\(s\) "extra"/],
    ['a missing transition', { requires: ['x'] }, /"transition" must be a transition string/],
    ['a missing requires', { transition: 'start -> end' }, /needs "requires"/],
    ['an invalid name', { transition: 'start -> end', requires: ['__proto__'] }, /Transition #1 "start -> end": "__proto__" cannot be used/],
    ['an array entry', ['start -> end'], /must be a string or an object/],
    ['null', null, /must be a string or an object/],
  ])('rejects an object entry with %s', (_label, entry, message) => {
    expect(() => buildGraph({ name: 'f', description: '', transitions: [entry as any] })).toThrow(message)
  })
})
