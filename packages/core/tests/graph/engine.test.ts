import { parseTransition, validateGraph, graphWarnings, addTransition, removeTransition, removeState, markStateTerminal, getNextTransitions, sampleNext, requirements } from '../../src/graph/engine'
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

  it('adds a chain of deterministic transitions in one call', () => {
    const graph = makeGraph()
    const updated = addTransition(graph, 'start -> review -> complete')
    expect(updated.transitions).toHaveLength(2)
    expect(updated.transitions[0]).toEqual({ from: 'start', to: 'review', type: 'deterministic' })
    expect(updated.transitions[1]).toEqual({ from: 'review', to: 'complete', type: 'deterministic' })
    expect(updated.states['review']).toBeDefined()
    expect(updated.states['complete']).toBeDefined()
  })

  it('adds a mixed chain (probabilistic + deterministic) in one call', () => {
    const graph = makeGraph()
    const updated = addTransition(graph, 'start -.5-> tails -> end')
    expect(updated.transitions).toHaveLength(2)
    expect(updated.transitions[0]).toEqual({ from: 'start', to: 'tails', type: 'probabilistic', weight: 0.5 })
    expect(updated.transitions[1]).toEqual({ from: 'tails', to: 'end', type: 'deterministic' })
    expect(updated.states['end'].isTerminal).toBe(true)
  })

  it('adds a symbolic chain in one call', () => {
    const graph = makeGraph()
    const updated = addTransition(graph, 'start -approve-> review -publish-> live')
    expect(updated.transitions).toHaveLength(2)
    expect(updated.transitions[0]).toMatchObject({ type: 'symbolic', action: 'approve' })
    expect(updated.transitions[1]).toMatchObject({ type: 'symbolic', action: 'publish' })
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

describe('removeTransition — weight differentiation', () => {
  it('only removes the probabilistic transition with the matching weight', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -.7-> approved')
    graph = addTransition(graph, 'start -.3-> rejected')
    graph = removeTransition(graph, 'start -.7-> approved')
    expect(graph.transitions).toHaveLength(1)
    expect(graph.transitions[0].weight).toBe(0.3)
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

describe('sampleNext — edge cases', () => {
  it('throws on empty transitions array', () => {
    expect(() => sampleNext([])).toThrow('Cannot sample from empty transitions array')
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

describe('parseTransition — strict numeric labels', () => {
  it('treats a label with a numeric prefix as a symbolic action', () => {
    expect(parseTransition('a -2fa_done-> b')).toEqual({ from: 'a', to: 'b', type: 'symbolic', action: '2fa_done' })
  })

  it.each([
    ['a -1st_pass-> b', '1st_pass'],
    ['a -0x10-> b', '0x10'],
    ['a -.5x-> b', '.5x'],
    ['a -Infinity-> b', 'Infinity'],
    ['a -1 2-> b', '1 2'],
  ])('%s is symbolic', (str, action) => {
    expect(parseTransition(str)).toMatchObject({ type: 'symbolic', action })
  })

  it.each([
    ['a -.5-> b', 0.5],
    ['a -0.25-> b', 0.25],
    ['a -1-> b', 1],
    ['a -1.0-> b', 1],
    ['a - .5 -> b', 0.5],
    ['a -1e-3-> b', 0.001],
  ])('%s is probabilistic', (str, weight) => {
    expect(parseTransition(str)).toEqual({ from: 'a', to: 'b', type: 'probabilistic', weight })
  })

  it.each(['a -0-> b', 'a -1.5-> b', 'a -2-> b', 'a --0.5-> b', 'a -1e999-> b'])('rejects out-of-range weight in %s', (str) => {
    expect(() => parseTransition(str)).toThrow('weights must be greater than 0 and at most 1')
  })
})

describe('parseTransition — hyphenated labels', () => {
  it('parses a hyphenated action', () => {
    expect(parseTransition('a -tests-pass-> b')).toEqual({ from: 'a', to: 'b', type: 'symbolic', action: 'tests-pass' })
  })

  it('parses a multi-hyphen action', () => {
    expect(parseTransition('a -x-y-z-> b')).toMatchObject({ type: 'symbolic', action: 'x-y-z' })
  })

  it('does not allow "->" inside a label', () => {
    expect(() => parseTransition('a -x->y-> b')).toThrow('Invalid transition string')
  })

  it.each(['a --> b', 'a -> -> b', 'a -x b', '-> b'])('still rejects %s', (str) => {
    expect(() => parseTransition(str)).toThrow('Invalid transition string')
  })
})

describe('parseTransition — strings that parsed before keep their result', () => {
  it.each([
    ['start -> review', { from: 'start', to: 'review', type: 'deterministic' }],
    ['start->review', { from: 'start', to: 'review', type: 'deterministic' }],
    ['start -.5-> heads', { from: 'start', to: 'heads', type: 'probabilistic', weight: 0.5 }],
    ['start -.5->heads', { from: 'start', to: 'heads', type: 'probabilistic', weight: 0.5 }],
    ['start -check_todo_done-> reviewing', { from: 'start', to: 'reviewing', type: 'symbolic', action: 'check_todo_done' }],
    ['start - spaced action -> b', { from: 'start', to: 'b', type: 'symbolic', action: 'spaced action' }],
    ['start - b -> c', { from: 'start', to: 'c', type: 'symbolic', action: 'b' }],
  ])('%s', (str, expected) => {
    expect(parseTransition(str)).toEqual(expected)
  })
})

describe('addTransition — chains with the new label rules', () => {
  it('splits a chain with a hyphenated label', () => {
    const updated = addTransition(makeGraph(), 'a -x-y-> b -> c')
    expect(updated.transitions).toEqual([
      { from: 'a', to: 'b', type: 'symbolic', action: 'x-y' },
      { from: 'b', to: 'c', type: 'deterministic' },
    ])
  })

  it('splits a chain mixing hyphenated, numeric-prefix and probabilistic labels', () => {
    const updated = addTransition(makeGraph(), 'start -tests-pass-> review -2fa_done-> gate -1-> end')
    expect(updated.transitions).toEqual([
      { from: 'start', to: 'review', type: 'symbolic', action: 'tests-pass' },
      { from: 'review', to: 'gate', type: 'symbolic', action: '2fa_done' },
      { from: 'gate', to: 'end', type: 'probabilistic', weight: 1 },
    ])
  })

  it('rejects a chain containing an invalid weight without partial application', () => {
    const graph = makeGraph()
    expect(() => addTransition(graph, 'start -> a -2-> b')).toThrow('at most 1')
    expect(graph.transitions).toHaveLength(0)
  })
})

describe('addTransition — probabilistic weight budget', () => {
  it('rejects a weight that pushes the outgoing sum above 1.0', () => {
    const graph = addTransition(makeGraph(), 'start -.7-> heads')
    expect(() => addTransition(graph, 'start -.4-> tails')).toThrow('exceeds 1.0')
  })

  it('suggests the remaining budget in the error', () => {
    const graph = addTransition(makeGraph(), 'start -.7-> heads')
    expect(() => addTransition(graph, 'start -.4-> tails')).toThrow('at most 0.3')
  })

  it('allows sums up to 1.0 within the 0.001 tolerance', () => {
    let graph = makeGraph()
    graph = addTransition(graph, 'start -.3333-> a')
    graph = addTransition(graph, 'start -.3333-> b')
    graph = addTransition(graph, 'start -.3344-> c')
    expect(graph.transitions).toHaveLength(3)
  })

  it('counts each source state separately', () => {
    let graph = addTransition(makeGraph(), 'start -.7-> a')
    graph = addTransition(graph, 'a -.7-> b')
    expect(graph.transitions).toHaveLength(2)
  })

  it('checks within a single chain', () => {
    expect(() => addTransition(makeGraph(), 'start -.6-> start -.6-> b')).toThrow('exceeds 1.0')
  })
})

describe('removeTransition — consistent with the parser', () => {
  it('removes a hyphenated symbolic transition', () => {
    let graph = addTransition(makeGraph(), 'start -tests-pass-> end')
    graph = removeTransition(graph, 'start -tests-pass-> end')
    expect(graph.transitions).toHaveLength(0)
  })

  it('removes a numeric-prefix symbolic transition', () => {
    let graph = addTransition(makeGraph(), 'start -2fa_done-> end')
    graph = removeTransition(graph, 'start -2fa_done-> end')
    expect(graph.transitions).toHaveLength(0)
  })

  it('can still remove a legacy out-of-range probabilistic edge by its weight', () => {
    const graph = makeGraph({ transitions: [{ from: 'start', to: 'b', type: 'probabilistic', weight: 2 }] })
    expect(removeTransition(graph, 'start -2-> b').transitions).toHaveLength(0)
  })
})

describe('graphWarnings', () => {
  const ok = (): WorkflowGraph => addTransition(makeGraph(), 'start -> review -> end')

  it('returns no warnings for a complete linear graph', () => {
    expect(graphWarnings(ok())).toEqual([])
  })

  it('includes everything validateGraph reports', () => {
    const graph = makeGraph({ states: {} })
    for (const e of validateGraph(graph)) expect(graphWarnings(graph)).toContain(e)
  })

  it('warns when probabilistic weights do not sum to 1.0', () => {
    let graph = addTransition(makeGraph(), 'start -.5-> heads -> end')
    expect(graphWarnings(graph).some(w => w.includes('"start"') && w.includes('sum to 1.0'))).toBe(true)
    graph = addTransition(graph, 'start -.5-> tails -> end')
    expect(graphWarnings(graph)).toEqual([])
  })

  it('warns about more than one deterministic exit', () => {
    const graph = addTransition(ok(), 'review -> other -> end')
    const warnings = graphWarnings(graph)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"review"')
    expect(warnings[0]).toContain('2 deterministic exits')
  })

  it('does not warn about one deterministic exit alongside symbolic ones', () => {
    const graph = addTransition(ok(), 'review -reject-> start')
    expect(graphWarnings(graph)).toEqual([])
  })

  it('warns when a state mixes probabilistic with deterministic or symbolic exits', () => {
    let graph = addTransition(makeGraph(), 'start -1-> end')
    graph = addTransition(graph, 'start -skip-> end')
    const warnings = graphWarnings(graph)
    expect(warnings.some(w => w.includes('"start"') && w.includes('mixes probabilistic'))).toBe(true)
  })

  it('warns about a non-terminal state with no outgoing transitions', () => {
    const graph = addTransition(ok(), 'start -alt-> limbo')
    const warnings = graphWarnings(graph)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"limbo"')
    expect(warnings[0]).toContain('no outgoing transitions')
  })

  it('does not warn about terminal states without exits', () => {
    const graph = addTransition(makeGraph(), 'start -> done')
    expect(graphWarnings({ ...graph, states: { ...graph.states, done: { name: 'done', isTerminal: true } } })).toEqual([])
  })

  it('warns when no terminal state is defined', () => {
    const graph = addTransition(makeGraph(), 'start -> a -> start')
    expect(graphWarnings(graph).some(w => w.includes('No terminal state is defined'))).toBe(true)
  })

  it('warns when no terminal state is reachable from start', () => {
    let graph = addTransition(makeGraph(), 'start -> a -> start')
    graph = addTransition(graph, 'island -> end')
    const warnings = graphWarnings(graph)
    expect(warnings.some(w => w.includes('No terminal state is reachable from "start"'))).toBe(true)
  })

  it('a fresh procedure (start only) gets warnings, not errors', () => {
    const warnings = graphWarnings(makeGraph())
    expect(warnings.some(w => w.includes('"start"') && w.includes('no outgoing transitions'))).toBe(true)
    expect(warnings.some(w => w.includes('No terminal state'))).toBe(true)
    expect(validateGraph(makeGraph())).toEqual([])
  })
})

describe('removeTransition legacy numeric-prefix edges', () => {
  it('removes an edge stored as probabilistic by the old parser using its original string', () => {
    const graph = {
      name: 'wf',
      description: '',
      states: { a: { name: 'a', isTerminal: false }, b: { name: 'b', isTerminal: false } },
      transitions: [{ from: 'a', to: 'b', type: 'probabilistic' as const, weight: 2 }],
    }
    expect(removeTransition(graph, 'a -2fa_done-> b').transitions).toEqual([])
  })

  it('prefers the symbolic edge when one exists', () => {
    const graph = {
      name: 'wf',
      description: '',
      states: { a: { name: 'a', isTerminal: false }, b: { name: 'b', isTerminal: false } },
      transitions: [
        { from: 'a', to: 'b', type: 'probabilistic' as const, weight: 2 },
        { from: 'a', to: 'b', type: 'symbolic' as const, action: '2fa_done' },
      ],
    }
    expect(removeTransition(graph, 'a -2fa_done-> b').transitions).toEqual([
      { from: 'a', to: 'b', type: 'probabilistic', weight: 2 },
    ])
  })
})

describe('reserved state names', () => {
  const empty = { name: 'wf', description: '', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    'addTransition rejects "%s" as a state name and leaves the graph unchanged',
    name => {
      expect(() => addTransition(empty, `start -> ${name}`)).toThrow(/cannot be used as a state name/)
      expect(() => addTransition(empty, `${name} -> start`)).toThrow(/cannot be used as a state name/)
      expect(empty.transitions).toEqual([])
    },
  )

  it('markStateTerminal and removeState do not treat inherited members as states', () => {
    expect(() => markStateTerminal(empty, 'constructor')).toThrow(/does not exist/)
    expect(() => removeState(empty, 'toString')).toThrow(/does not exist/)
  })
})
