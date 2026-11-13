import { buildGraph, DEFINITION_LIMITS } from '../../src/graph/define'
import { graphWarnings } from '../../src/graph/engine'

describe('buildGraph', () => {
  it('builds a valid definition with descriptions and terminal flags', () => {
    const graph = buildGraph({
      name: 'review',
      description: 'code review',
      transitions: ['start -> reviewing', 'reviewing -approved-> merged', 'reviewing -rejected-> start'],
      states: {
        start: { description: 'open the PR' },
        reviewing: { description: 'read the diff' },
        merged: { description: 'done', terminal: true },
      },
    })
    expect(graph.name).toBe('review')
    expect(graph.description).toBe('code review')
    expect(graph.transitions).toEqual([
      { from: 'start', to: 'reviewing', type: 'deterministic' },
      { from: 'reviewing', to: 'merged', type: 'symbolic', action: 'approved' },
      { from: 'reviewing', to: 'start', type: 'symbolic', action: 'rejected' },
    ])
    expect(graph.states).toEqual({
      start: { name: 'start', isTerminal: false, description: 'open the PR' },
      reviewing: { name: 'reviewing', isTerminal: false, description: 'read the diff' },
      merged: { name: 'merged', isTerminal: true, description: 'done' },
    })
    expect(graphWarnings(graph)).toEqual([])
  })

  it('expands chains in order', () => {
    const graph = buildGraph({ name: 'f', description: '', transitions: ['start -.5-> a -> end', 'start -.5-> b -> end'] })
    expect(graph.transitions.map(t => `${t.from}>${t.to}`)).toEqual(['start>a', 'a>end', 'start>b', 'b>end'])
    expect(graph.states.end.isTerminal).toBe(true)
    expect(graphWarnings(graph)).toEqual([])
  })

  it('returns a graph with only start for no transitions', () => {
    const graph = buildGraph({ name: 'f', description: 'd', transitions: [] })
    expect(graph).toEqual({ name: 'f', description: 'd', states: { start: { name: 'start', isTerminal: false } }, transitions: [] })
  })

  it('names the bad transition string and its position', () => {
    expect(() => buildGraph({ name: 'f', description: '', transitions: ['start -> a', 'a => end'] }))
      .toThrow('Transition #2 "a => end" is invalid: Invalid transition string')
  })

  it('names the transition that pushes a state\'s weights over 1.0', () => {
    expect(() => buildGraph({ name: 'f', description: '', transitions: ['start -.7-> a', 'start -.5-> b'] }))
      .toThrow(/Transition #2 "start -\.5-> b" is invalid: .*exceeds 1\.0/)
  })

  it('rejects an out-of-range weight', () => {
    expect(() => buildGraph({ name: 'f', description: '', transitions: ['start -1.5-> end'] }))
      .toThrow(/"start -1\.5-> end".*greater than 0 and at most 1/)
  })

  it('rejects a state in "states" that appears in no transition, naming it', () => {
    expect(() => buildGraph({
      name: 'f', description: '', transitions: ['start -> review -> end'],
      states: { reveiw: { description: 'typo' } },
    })).toThrow(/State "reveiw" in "states" does not appear in any transition/)
  })

  it('allows describing start even without transitions', () => {
    const graph = buildGraph({ name: 'f', description: '', transitions: [], states: { start: { description: 'begin' } } })
    expect(graph.states.start.description).toBe('begin')
  })

  it('keeps end terminal even with terminal: false, and terminal: false leaves others non-terminal', () => {
    const graph = buildGraph({
      name: 'f', description: '', transitions: ['start -> a -> end'],
      states: { end: { terminal: false }, a: { terminal: false } },
    })
    expect(graph.states.end.isTerminal).toBe(true)
    expect(graph.states.a.isTerminal).toBe(false)
  })

  it('rejects unknown fields and wrong types in a state definition', () => {
    const base = { name: 'f', description: '', transitions: ['start -> done'] }
    expect(() => buildGraph({ ...base, states: { done: { terminl: true } as any } })).toThrow(/"done".*unknown field\(s\) "terminl"/)
    expect(() => buildGraph({ ...base, states: { done: { terminal: 'yes' } as any } })).toThrow(/"terminal" must be a boolean/)
    expect(() => buildGraph({ ...base, states: { done: { description: 3 } as any } })).toThrow(/"description" must be a string/)
    expect(() => buildGraph({ ...base, states: { done: 'x' } as any })).toThrow(/must be an object/)
  })

  it('rejects non-string transitions', () => {
    expect(() => buildGraph({ name: 'f', description: '', transitions: [42] as any })).toThrow('Transition #1 must be a string')
  })

  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    'rejects Object.prototype member "%s" in states as an unknown state',
    (stateName) => {
      expect(() => buildGraph({
        name: 'f', description: '', transitions: ['start -> a'],
        states: { [stateName]: { description: 'x' } },
      })).toThrow(`State "${stateName}" in "states" does not appear in any transition`)
    }
  )

  it('rejects a "__proto__" key in states (as parsed from JSON) and leaves the prototype alone', () => {
    const states = JSON.parse('{"__proto__": {"description": "x"}}')
    expect(() => buildGraph({ name: 'f', description: '', transitions: ['start -> a'], states }))
      .toThrow('State "__proto__" in "states" does not appear in any transition')
  })

  it('rejects more transition strings than allowed', () => {
    const transitions = Array.from({ length: DEFINITION_LIMITS.maxTransitionStrings + 1 }, (_, i) => `s${i} -> s${i + 1}`)
    expect(() => buildGraph({ name: 'f', description: '', transitions }))
      .toThrow(`at most ${DEFINITION_LIMITS.maxTransitionStrings} are allowed`)
  })

  it('rejects an over-long transition string', () => {
    const long = 'start -> ' + 'a'.repeat(DEFINITION_LIMITS.maxTransitionLength)
    expect(() => buildGraph({ name: 'f', description: '', transitions: [long] }))
      .toThrow(`Transition #1 is ${long.length} characters long`)
  })

  it('rejects a definition whose chains add up to more edges than allowed', () => {
    // 10 states per chain => 10 edges per string; 101 strings => 1010 edges.
    const transitions = Array.from({ length: 101 }, (_, i) =>
      [`start`, ...Array.from({ length: 10 }, (_, j) => `c${i}_${j}`)].join(' -> ')
    )
    expect(() => buildGraph({ name: 'f', description: '', transitions }))
      .toThrow(`at most ${DEFINITION_LIMITS.maxEdges} are allowed`)
  })

  it('rejects more states entries than allowed', () => {
    const states: Record<string, { description: string }> = {}
    for (let i = 0; i <= DEFINITION_LIMITS.maxStates; i++) states[`s${i}`] = { description: 'x' }
    expect(() => buildGraph({ name: 'f', description: '', transitions: ['start -> s0'], states }))
      .toThrow(`at most ${DEFINITION_LIMITS.maxStates} are allowed`)
  })

  it('accepts a definition at the limits', () => {
    const transitions = Array.from({ length: DEFINITION_LIMITS.maxTransitionStrings }, (_, i) => `s${i} -> s${i + 1}`)
    const graph = buildGraph({ name: 'f', description: '', transitions: ['start -> s0', ...transitions.slice(1)] })
    expect(graph.transitions).toHaveLength(DEFINITION_LIMITS.maxTransitionStrings)
  })
})
