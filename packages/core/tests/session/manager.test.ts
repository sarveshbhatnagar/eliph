import { computeNextState, applyAdvance, applyReset } from '../../src/session/manager'
import { addTransition } from '../../src/graph/engine'
import { WorkflowGraph } from '../../src/graph/types'
import { Session } from '../../src/session/types'

function makeGraph(): WorkflowGraph {
  return { name: 'test', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }
}

function makeSession(currentState = 'start'): Session {
  return { id: 'sess-1', workflowName: 'test', currentState, history: [currentState], createdAt: new Date() }
}

describe('computeNextState', () => {
  it('advances a deterministic transition', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    expect(computeNextState(graph, makeSession())).toBe('review')
  })

  it('throws when no outgoing transitions exist', () => {
    const graph = makeGraph()
    expect(() => computeNextState(graph, makeSession())).toThrow('No outgoing transitions')
  })

  it('advances a symbolic transition with matching completed_action', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -check_done-> complete')
    expect(computeNextState(graph, makeSession(), 'check_done')).toBe('complete')
  })

  it('throws when completed_action does not match any symbolic transition', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -check_done-> complete')
    expect(() => computeNextState(graph, makeSession(), 'wrong_action')).toThrow('does not match')
  })

  it('throws when symbolic transition requires completed_action but none provided', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -check_done-> complete')
    expect(() => computeNextState(graph, makeSession())).toThrow('requires a completed_action')
  })

  it('samples probabilistic transitions (returns one of valid states)', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -.5-> heads')
    graph = addTransition(graph, 'start -.5-> tails')
    for (let i = 0; i < 50; i++) {
      expect(['heads', 'tails']).toContain(computeNextState(graph, makeSession()))
    }
  })
})

describe('applyAdvance', () => {
  it('updates currentState and appends to history', () => {
    const session = makeSession()
    const updated = applyAdvance(session, 'review')
    expect(updated.currentState).toBe('review')
    expect(updated.history).toEqual(['start', 'review'])
  })

  it('does not mutate the original session', () => {
    const session = makeSession()
    applyAdvance(session, 'review')
    expect(session.currentState).toBe('start')
  })
})

describe('applyReset', () => {
  it('resets to start by convention when caller passes "start"', () => {
    const session = makeSession('review')
    const updated = applyReset(session, 'start')
    expect(updated.currentState).toBe('start')
    expect(updated.history).toContain('start')
  })

  it('resets to any target state', () => {
    const session = makeSession('complete')
    const updated = applyReset(session, 'review')
    expect(updated.currentState).toBe('review')
  })
})
