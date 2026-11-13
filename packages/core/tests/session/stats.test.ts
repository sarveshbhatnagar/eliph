import { computeProcedureStats } from '../../src/session/stats'
import { WorkflowGraph } from '../../src/graph/types'
import { Session, SessionEvent } from '../../src/session/types'

const graph: WorkflowGraph = {
  name: 'review',
  description: '',
  states: {
    start: { name: 'start', isTerminal: false },
    review: { name: 'review', isTerminal: false },
    end: { name: 'end', isTerminal: true },
  },
  transitions: [
    { from: 'start', to: 'review', type: 'deterministic' },
    { from: 'review', to: 'end', type: 'symbolic', action: 'approved' },
    { from: 'review', to: 'start', type: 'symbolic', action: 'rejected' },
  ],
}

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()

function session(id: string, currentState: string, events: SessionEvent[] | undefined, history?: string[]): Session {
  return {
    id,
    workflowName: 'review',
    workflowOwnerId: 'o',
    currentState,
    history: history ?? [currentState],
    createdAt: new Date(T0),
    ...(events ? { events } : {}),
  }
}

function stateOf(stats: ReturnType<typeof computeProcedureStats>, name: string) {
  const s = stats.states.find(x => x.state === name)
  if (!s) throw new Error(`no stats for ${name}`)
  return s
}

describe('computeProcedureStats', () => {
  const sessions = [
    // start (0) -> review (1000) -> end via approved (4000)
    session('a', 'end', [
      { type: 'created', to: 'start', at: at(0) },
      { type: 'advance', from: 'start', to: 'review', at: at(1000) },
      { type: 'data', at: at(1500) },
      { type: 'advance', from: 'review', to: 'end', action: 'approved', at: at(4000) },
    ]),
    // start (0) -> review (3000) -> start via rejected (4000) -> review (5000), still there
    session('b', 'review', [
      { type: 'created', to: 'start', at: at(0) },
      { type: 'advance', from: 'start', to: 'review', at: at(3000) },
      { type: 'advance', from: 'review', to: 'start', action: 'rejected', at: at(4000) },
      { type: 'advance', from: 'start', to: 'review', at: at(5000) },
    ]),
    // start (0) -> review (2000) -> reset to start (2500), still in start
    session('c', 'start', [
      { type: 'created', to: 'start', at: at(0) },
      { type: 'advance', from: 'start', to: 'review', at: at(2000) },
      { type: 'reset', from: 'review', to: 'start', note: 'redo', at: at(2500) },
    ]),
    // legacy: saved before the event log existed
    session('legacy', 'review', undefined, ['start', 'review']),
  ]

  it('computes totals', () => {
    const stats = computeProcedureStats('review', graph, sessions)
    expect(stats.workflow).toBe('review')
    expect(stats.sessionsAnalyzed).toBe(4)
    expect(stats.truncated).toBe(false)
    expect(stats.totals).toEqual({ sessions: 4, completed: 1, active: 3 })
  })

  it('lists every graph state in graph order', () => {
    const stats = computeProcedureStats('review', graph, sessions)
    expect(stats.states.map(s => s.state)).toEqual(['start', 'review', 'end'])
  })

  it('counts entries (legacy sessions via history), current sessions, exits, resets and dwell', () => {
    const stats = computeProcedureStats('review', graph, sessions)
    expect(stateOf(stats, 'start')).toEqual({
      state: 'start',
      // a: 1, b: 2, c: 2, legacy: 1
      entered: 6,
      currentlyHere: 1,
      exits: [{ to: 'review', action: null, count: 4 }],
      resetsAway: 0,
      // dwell: a 1000, b 3000, b 1000 (4000 -> 5000), c 2000
      avgDwellMs: 1750,
    })
    expect(stateOf(stats, 'review')).toEqual({
      state: 'review',
      // a: 1, b: 2, c: 1, legacy: 1
      entered: 5,
      currentlyHere: 2,
      exits: [
        { to: 'end', action: 'approved', count: 1 },
        { to: 'start', action: 'rejected', count: 1 },
      ],
      resetsAway: 1,
      // dwell: a 3000, b 1000, c (reset) 500
      avgDwellMs: 1500,
    })
    expect(stateOf(stats, 'end')).toEqual({
      state: 'end', entered: 1, currentlyHere: 1, exits: [], resetsAway: 0, avgDwellMs: null,
    })
  })

  it('handles only legacy sessions: totals and currentlyHere, nothing for exits or dwell', () => {
    const stats = computeProcedureStats('review', graph, [session('l1', 'end', undefined, ['start', 'review', 'end']), session('l2', 'start', [])])
    expect(stats.totals).toEqual({ sessions: 2, completed: 1, active: 1 })
    expect(stats.states.map(s => [s.state, s.entered, s.currentlyHere, s.exits.length, s.avgDwellMs])).toEqual([
      ['start', 2, 1, 0, null],
      ['review', 1, 0, 0, null],
      ['end', 1, 1, 0, null],
    ])
  })

  it('reports states no longer in the graph and passes truncated through', () => {
    const s = session('x', 'gone', [
      { type: 'created', to: 'start', at: at(0) },
      { type: 'advance', from: 'start', to: 'gone', at: at(10) },
    ])
    const stats = computeProcedureStats('review', graph, [s], true)
    expect(stats.truncated).toBe(true)
    expect(stats.states.map(x => x.state)).toEqual(['start', 'review', 'end', 'gone'])
    expect(stateOf(stats, 'gone')).toMatchObject({ entered: 1, currentlyHere: 1 })
    expect(stats.totals).toEqual({ sessions: 1, completed: 0, active: 1 })
  })

  it('judges completion of a pinned session against its snapshot', () => {
    const pinnedGraph: WorkflowGraph = { ...graph, states: { ...graph.states, review: { name: 'review', isTerminal: true } } }
    const s = { ...session('p', 'review', []), pinnedGraph }
    expect(computeProcedureStats('review', graph, [s]).totals).toEqual({ sessions: 1, completed: 1, active: 0 })
  })

  it('skips dwell for a leave whose entry was cut off the start of the log', () => {
    const s = session('t', 'end', [
      { type: 'advance', from: 'review', to: 'end', action: 'approved', at: at(100) },
    ])
    const stats = computeProcedureStats('review', graph, [s])
    expect(stateOf(stats, 'review')).toMatchObject({ exits: [{ to: 'end', action: 'approved', count: 1 }], avgDwellMs: null })
  })

  it('handles no sessions', () => {
    const stats = computeProcedureStats('review', graph, [])
    expect(stats.totals).toEqual({ sessions: 0, completed: 0, active: 0 })
    expect(stats.states.every(s => s.entered === 0 && s.avgDwellMs === null)).toBe(true)
  })
})
