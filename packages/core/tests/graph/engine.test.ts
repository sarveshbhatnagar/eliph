import { parseTransition } from '../../src/graph/engine'

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
