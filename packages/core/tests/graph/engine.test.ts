import { parseTransition, validateGraph, addTransition, removeTransition, removeState, getNextTransitions, sampleNext, requirements } from '../../src/graph/engine'
import { Transition } from '../../src/graph/types'
import { WorkflowGraph } from '../../src/graph/types'

function makeGraph(overrides: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    name: 'test',
    description: '',
    states: { start: { name: 'start', isTerminal: false } },
    transitions: [],
    ...overrides,
  }
}

describe('parseTransition', () => {
  it('parses a deterministic transition', () => {
    const t = parseTransition('start -> review')
    expect(t).toEqual({ from: 'start', to: 'review', type: 'deterministic' })
  })

  it('parses a probabilistic transition', () => {
    const t = parseTransition('start -.5-> heads')
    expect(t).toEqual({ from: 'start', to: 'heads', type: 'probabilistic', weight: 0.5 })
  })

  it('parses a symbolic transition', () => {
    const t = parseTransition('start -check_todo_done-> reviewing')
    expect(t).toEqual({ from: 'start', to: 'reviewing', type: 'symbolic', action: 'check_todo_done' })
  })

  it('throws on invalid string', () => {
    expect(() => parseTransition('not valid')).toThrow('Invalid transition string')
  })

  it('parses states with underscores', () => {
    const t = parseTransition('check_todo_done -> complete')
    expect(t.from).toBe('check_todo_done')
    expect(t.to).toBe('complete')
  })
})

describe('validateGraph', () => {
  it('returns no errors for a valid graph', () => {
    const graph = makeGraph()
    expect(validateGraph(graph)).toEqual([])
  })

  it('errors when start state is missing', () => {
    const graph = makeGraph({ states: {} })
    expect(validateGraph(graph)).toContain('Graph must have a "start" state')
  })

  it('errors when probabilistic weights do not sum to 1.0', () => {
    const graph = makeGraph({
      states: {
        start: { name: 'start', isTerminal: false },
        heads: { name: 'heads', isTerminal: false },
        tails: { name: 'tails', isTerminal: false },
      },
      transitions: [
        { from: 'start', to: 'heads', type: 'probabilistic', weight: 0.3 },
        { from: 'start', to: 'tails', type: 'probabilistic', weight: 0.3 },
      ],
    })
    const errors = validateGraph(graph)
    expect(errors.some(e => e.includes('sum to 1.0'))).toBe(true)
  })

  it('passes when probabilistic weights sum to 1.0', () => {
    const graph = makeGraph({
      states: {
        start: { name: 'start', isTerminal: false },
        heads: { name: 'heads', isTerminal: false },
        tails: { name: 'tails', isTerminal: false },
      },
      transitions: [
        { from: 'start', to: 'heads', type: 'probabilistic', weight: 0.5 },
        { from: 'start', to: 'tails', type: 'probabilistic', weight: 0.5 },
      ],
    })
    expect(validateGraph(graph)).toEqual([])
  })
})

describe('addTransition', () => {
  it('adds a deterministic edge and creates implied states', () => {
    const graph = makeGraph()
    const updated = addTransition(graph, 'start -> review')
    expect(updated.transitions).toHaveLength(1)
    expect(updated.states['review']).toBeDefined()
  })

  it('marks "end" state as terminal', () => {
    const graph = makeGraph()
    const updated = addTransition(graph, 'start -> end')
    expect(updated.states['end'].isTerminal).toBe(true)
  })

  it('does not mutate the original graph', () => {
    const graph = makeGraph()
    addTransition(graph, 'start -> review')
    expect(graph.transitions).toHaveLength(0)
  })

  it('adds a symbolic transition', () => {
    const graph = makeGraph()
    const updated = addTransition(graph, 'start -check_todo-> reviewing')
    expect(updated.transitions[0]).toMatchObject({ type: 'symbolic', action: 'check_todo' })
  })
})

describe('removeTransition', () => {
  it('removes a matching transition', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    graph = removeTransition(graph, 'start -> review')
    expect(graph.transitions).toHaveLength(0)
  })

  it('leaves states intact after removing their transition', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    graph = removeTransition(graph, 'start -> review')
    expect(graph.states['review']).toBeDefined()
  })

  it('does not mutate the original graph', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    const copy = graph
    removeTransition(graph, 'start -> review')
    expect(copy.transitions).toHaveLength(1)
  })
})

describe('removeState', () => {
  it('removes a state and its transitions', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    graph = addTransition(graph, 'review -> end')
    graph = removeState(graph, 'review')
    expect(graph.states['review']).toBeUndefined()
    expect(graph.transitions.filter(t => t.from === 'review' || t.to === 'review')).toHaveLength(0)
  })

  it('throws when removing "start"', () => {
    const graph = makeGraph()
    expect(() => removeState(graph, 'start')).toThrow('Cannot remove reserved state "start"')
  })

  it('throws when removing "end"', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> end')
    expect(() => removeState(graph, 'end')).toThrow('Cannot remove reserved state "end"')
  })

  it('throws when state does not exist', () => {
    const graph = makeGraph()
    expect(() => removeState(graph, 'nonexistent')).toThrow('State "nonexistent" does not exist')
  })

  it('does not mutate the original graph', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    const copy = graph
    removeState(graph, 'review')
    expect(copy.states['review']).toBeDefined()
  })
})

describe('getNextTransitions', () => {
  it('returns outgoing transitions from a state', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    graph = addTransition(graph, 'start -> skip')
    const transitions = getNextTransitions(graph, 'start')
    expect(transitions).toHaveLength(2)
  })

  it('returns empty array for state with no outgoing transitions', () => {
    const graph = makeGraph()
    expect(getNextTransitions(graph, 'start')).toHaveLength(0)
  })
})

describe('sampleNext', () => {
  it('always returns a state from the given transitions', () => {
    const transitions: Transition[] = [
      { from: 'start', to: 'heads', type: 'probabilistic', weight: 0.5 },
      { from: 'start', to: 'tails', type: 'probabilistic', weight: 0.5 },
    ]
    for (let i = 0; i < 100; i++) {
      const result = sampleNext(transitions)
      expect(['heads', 'tails']).toContain(result)
    }
  })

  it('returns the only option when weight is 1.0', () => {
    const transitions: Transition[] = [
      { from: 'start', to: 'done', type: 'probabilistic', weight: 1.0 },
    ]
    expect(sampleNext(transitions)).toBe('done')
  })
})

describe('requirements', () => {
  it('returns symbolic transitions as requirements', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -check_todo_done-> complete')
    graph = addTransition(graph, 'start -check_todo_not_done-> reviewing')
    const reqs = requirements(graph, 'start')
    expect(reqs).toHaveLength(2)
    expect(reqs[0]).toEqual({ action: 'check_todo_done', targetState: 'complete' })
  })

  it('excludes non-symbolic transitions', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -> review')
    expect(requirements(graph, 'start')).toHaveLength(0)
  })
})
