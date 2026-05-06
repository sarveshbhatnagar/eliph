import { parseTransition, validateGraph } from '../../src/graph/engine'
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
