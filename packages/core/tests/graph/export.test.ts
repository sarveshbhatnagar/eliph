import { exportWorkflowScript, WorkflowExportError, WORKFLOW_EXPORT_STEPS } from '../../src/graph/export'
import { buildGraph } from '../../src/graph/define'
import { setTransitionRequires, assertRequiredData } from '../../src/graph/requires'
import { chooseTransition, applyAdvance } from '../../src/session/manager'
import { mergeSessionData } from '../../src/session/data'
import { WorkflowGraph } from '../../src/graph/types'
import { Session } from '../../src/session/types'
import * as core from '../../src/index'

interface Step { completed_action?: string; data?: Record<string, unknown>; note?: string }
interface ItemResult { label: string; data: Record<string, unknown>; steps: Step[]; finalState: string; error?: string }
interface RunResult { workflow: string; items: ItemResult[] }
interface AgentCall { prompt: string; opts: { label: string; phase: string; schema: any } }
type Answer = Record<string, unknown> | null | Error
/** What the fake agent says, per state: a queue of answers (the last one repeats) or a function. */
type AnswerTable = Record<string, Answer[] | ((call: AgentCall, nth: number) => Answer)>

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

/**
 * Runs a generated script the way the workflow runtime does: as the body of an
 * async function with the runtime's globals, and with the clock and random
 * source made to throw as they do there.
 */
async function runScript(script: string, args: unknown, table: AnswerTable = {}) {
  const calls: AgentCall[] = []
  const logs: string[] = []
  const counts: Record<string, number> = {}
  const agent = async (prompt: string, opts: AgentCall['opts']) => {
    const call = { prompt, opts }
    calls.push(call)
    const key = `${opts.label}`
    const nth = counts[key] = (counts[key] ?? 0) + 1
    const entry = table[opts.phase]
    if (!entry) throw new Error(`no fake answer for state "${opts.phase}"`)
    const answer = typeof entry === 'function' ? entry(call, nth) : entry[Math.min(nth, entry.length) - 1]
    if (answer instanceof Error) throw answer
    return answer
  }
  const parallel = (thunks: Array<() => Promise<unknown>>) =>
    Promise.all(thunks.map(async thunk => {
      try { return await thunk() } catch { return null }
    }))
  const pipeline = () => { throw new Error('pipeline is not used') }
  const phase = () => { throw new Error('phase() is global state and must not be used from concurrent items') }

  expect(script.startsWith('export const meta = {')).toBe(true)
  const body = script.replace(/^export /, '')
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', body)

  const now = jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Date.now() is not available') })
  const random = jest.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random() is not available') })
  try {
    const result: RunResult = await fn(agent, parallel, pipeline, phase, (m: string) => logs.push(m), args)
    return { result, calls, logs }
  } finally {
    now.mockRestore()
    random.mockRestore()
  }
}

/** The meta literal, parsed back out of the script text as JSON. */
function readMeta(script: string): { name: string; description: string; phases: Array<{ title: string }> } {
  const prefix = 'export const meta = '
  expect(script.startsWith(prefix)).toBe(true)
  const end = script.indexOf('\n}\n')
  expect(end).toBeGreaterThan(0)
  return JSON.parse(script.slice(prefix.length, end + 2))
}

/**
 * Replays an item's reported steps through the real engine, the way an advance
 * does (merge data, choose the transition, check its required data, apply).
 * Throws if Eliph would refuse any step; returns the session it ends with.
 */
function replay(graph: WorkflowGraph, item: ItemResult): Session {
  let session: Session = {
    id: item.label, workflowName: graph.name, workflowOwnerId: 'o', currentState: 'start', history: ['start'],
    createdAt: new Date(0), data: mergeSessionData(undefined, item.data),
  }
  for (const step of item.steps) {
    const merged = step.data === undefined ? session.data : mergeSessionData(session.data, step.data)
    const transition = chooseTransition(graph, session, step.completed_action)
    assertRequiredData(transition, merged)
    session = applyAdvance(session, transition.to, { action: step.completed_action, data: step.data, note: step.note, now: new Date(0) })
  }
  expect(session.currentState).toBe(item.finalState)
  return session
}

const linear = buildGraph({
  name: 'Ship It',
  description: 'Build and release one package.',
  transitions: ['start -> build -> release -> end'],
  states: {
    start: { description: 'Check out the code.' },
    build: { description: 'Run the build.' },
    release: { description: 'Publish it.' },
  },
})

const review = buildGraph({
  name: 'review',
  description: 'Review a change and fix it until approved.',
  transitions: ['start -> reviewing', 'reviewing -approved-> end', 'reviewing -changes_requested-> fixing', 'fixing -> reviewing'],
  states: {
    reviewing: { description: 'Read the diff and decide.' },
    fixing: { description: 'Apply the requested changes.' },
  },
})

const withRequires = setTransitionRequires(
  buildGraph({
    name: 'pr',
    description: 'Open a pull request.',
    transitions: ['start -> coding', 'coding -opened-> end', 'coding -abandoned-> dropped'],
    states: { start: { description: 'Read the ticket.' }, coding: { description: 'Write the change.' }, dropped: { terminal: true } },
  }),
  'coding -opened-> end',
  ['pr_url'],
)

describe('exportWorkflowScript: text', () => {
  it('is exported from the package index', () => {
    expect(core.exportWorkflowScript).toBe(exportWorkflowScript)
    expect(core.WorkflowExportError).toBe(WorkflowExportError)
  })

  it('starts with a meta that is pure JSON', () => {
    const { script } = exportWorkflowScript(linear)
    expect(readMeta(script)).toEqual({
      name: 'eliph-ship-it',
      description: 'Build and release one package.',
      phases: [{ title: 'start' }, { title: 'build' }, { title: 'release' }],
    })
  })

  it('lists phases breadth-first from start, leaving out terminal states and states that run without an agent', () => {
    const meta = readMeta(exportWorkflowScript(review).script)
    expect(meta.phases).toEqual([{ title: 'reviewing' }, { title: 'fixing' }])
  })

  it('slugs the name and cuts the description to one short line', () => {
    const graph = buildGraph({ name: '  Über "Flow" #1 ', description: `line one\nline two ${'x'.repeat(300)}`, transitions: ['start -> end'] })
    const meta = readMeta(exportWorkflowScript(graph).script)
    expect(meta.name).toMatch(/^eliph-[a-z0-9-]+$/)
    expect(meta.name).toBe('eliph-ber-flow-1')
    expect(meta.description).not.toContain('\n')
    expect(meta.description.length).toBeLessThanOrEqual(150)
    expect(meta.description.startsWith('line one line two')).toBe(true)
    expect(readMeta(exportWorkflowScript(buildGraph({ name: '???', description: '', transitions: ['start -> end'] })).script).name).toBe('eliph-procedure')
  })

  it.each([linear, review, withRequires])('uses no clock, randomness or TypeScript-only syntax (%#)', graph => {
    const { script } = exportWorkflowScript(graph)
    expect(script).not.toContain('Date.now')
    expect(script).not.toContain('Math.random')
    expect(script).not.toContain('new Date(')
    expect(script).not.toContain('`')
    // parses as plain JavaScript
    expect(() => new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', script.replace(/^export /, ''))).not.toThrow()
  })

  it('returns an args example and notes computed from the graph', () => {
    const looped = exportWorkflowScript(review, { maxSteps: 7 })
    expect(looped.argsExample).toEqual({ items: [{ label: 'item-1', data: {} }, { label: 'item-2', data: {} }] })
    expect(looped.notes.some(n => /loops/.test(n) && /after 7 steps/.test(n))).toBe(true)
    expect(looped.notes.some(n => /without an agent/.test(n) && n.includes('"start"'))).toBe(true)
    expect(looped.notes.some(n => /POST \/job/.test(n))).toBe(true)

    const straight = exportWorkflowScript(linear)
    expect(straight.notes.some(n => /has loops/.test(n))).toBe(false)
    expect(straight.notes.some(n => /without an agent/.test(n))).toBe(false)
    expect(exportWorkflowScript(withRequires).notes.some(n => /required data/.test(n))).toBe(true)
  })

  it('clamps maxSteps to 1..200 and defaults to 25', () => {
    const limit = (maxSteps?: number) => Number(/const MAX_STEPS = (\d+)/.exec(exportWorkflowScript(linear, { maxSteps }).script)![1])
    expect(limit()).toBe(25)
    expect(WORKFLOW_EXPORT_STEPS.default).toBe(25)
    expect(limit(0)).toBe(1)
    expect(limit(-5)).toBe(1)
    expect(limit(9999)).toBe(200)
    expect(limit(12.9)).toBe(12)
    expect(limit(NaN)).toBe(25)
  })
})

describe('exportWorkflowScript: graphs that cannot be exported', () => {
  const expectNotExportable = (graph: WorkflowGraph, message: RegExp) => {
    let thrown: unknown
    try { exportWorkflowScript(graph) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(WorkflowExportError)
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as WorkflowExportError).code).toBe('NOT_EXPORTABLE')
    expect((thrown as WorkflowExportError).message).toMatch(message)
  }

  it('rejects probabilistic transitions', () => {
    expectNotExportable(buildGraph({ name: 'coin', description: '', transitions: ['start -.5-> heads -> end', 'start -.5-> tails -> end'] }), /probabilistic/)
  })

  it('rejects a graph without a start state', () => {
    expectNotExportable({ name: 'empty', description: '', states: {}, transitions: [] }, /"start"/)
    expectNotExportable(
      { name: 'x', description: '', states: { a: { name: 'a', isTerminal: false }, end: { name: 'end', isTerminal: true } }, transitions: [{ from: 'a', to: 'end', type: 'deterministic' }] },
      /"start"/,
    )
  })

  it('rejects a non-terminal state with no exits', () => {
    expectNotExportable(buildGraph({ name: 'stuck', description: '', transitions: ['start -> limbo'] }), /"limbo"/)
    expectNotExportable(buildGraph({ name: 'only-start', description: '', transitions: [] }), /"start"/)
  })
})

describe('generated script: running it', () => {
  it('walks a linear deterministic procedure, one agent per state, with every item independent', async () => {
    const { script } = exportWorkflowScript(linear)
    const { result, calls, logs } = await runScript(
      script,
      { items: [{ label: 'pkg-a', data: { repo: 'a' } }, { label: 'pkg-b' }] },
      {
        start: [{ note: 'checked out' }],
        build: [{ data: { artifact: 'a.tgz', nothing: null }, note: '  built  ' }],
        release: [{}],
      },
    )
    expect(result.workflow).toBe('Ship It')
    expect(result.items).toEqual([
      { label: 'pkg-a', data: { repo: 'a' }, finalState: 'end', steps: [{ note: 'checked out' }, { data: { artifact: 'a.tgz' }, note: 'built' }, {}] },
      { label: 'pkg-b', data: {}, finalState: 'end', steps: [{ note: 'checked out' }, { data: { artifact: 'a.tgz' }, note: 'built' }, {}] },
    ])
    expect(calls).toHaveLength(6)
    expect(calls.map(c => c.opts.label).sort()).toEqual(['pkg-a: build', 'pkg-a: release', 'pkg-a: start', 'pkg-b: build', 'pkg-b: release', 'pkg-b: start'])
    expect(calls.every(c => c.opts.phase === c.opts.label.split(': ')[1])).toBe(true)
    expect(logs).toEqual(['Ship It: 2 finished, 0 failed (of 2)'])
    for (const item of result.items) expect(replay(linear, item).data).toEqual({ ...item.data, artifact: 'a.tgz' })

    // the prompt carries everything a fresh agent needs
    const release = calls.find(c => c.opts.label === 'pkg-a: release')!
    expect(release.prompt).toContain('Procedure: Ship It')
    expect(release.prompt).toContain('Build and release one package.')
    expect(release.prompt).toContain('Piece of work: pkg-a')
    expect(release.prompt).toContain('"repo": "a"')
    expect(release.prompt).toContain('"artifact": "a.tgz"')
    expect(release.prompt).toContain('Current step: release')
    expect(release.prompt).toContain('Publish it.')
    expect(release.prompt).toContain('moves to "end"')
    // deterministic-only state: no action to pick
    expect(release.opts.schema).toEqual({
      type: 'object',
      properties: { data: { type: 'object', properties: {}, additionalProperties: true }, note: { type: 'string' } },
      required: [],
    })
  })

  it('accepts args given as the items array itself', async () => {
    const { result } = await runScript(exportWorkflowScript(linear).script, [{ label: 'solo' }], { start: [{}], build: [{}], release: [{}] })
    expect(result.items.map(i => [i.label, i.finalState])).toEqual([['solo', 'end']])
  })

  it('fails clearly when there are no items or labels repeat', async () => {
    const { script } = exportWorkflowScript(linear)
    await expect(runScript(script, undefined)).rejects.toThrow(/No items to run/)
    await expect(runScript(script, { items: [] })).rejects.toThrow(/No items to run/)
    await expect(runScript(script, { items: [{ data: {} }] })).rejects.toThrow(/no label/)
    await expect(runScript(script, { items: [{ label: 'a' }, { label: 'b' }, { label: 'a' }] })).rejects.toThrow(/unique.*"a"/)
    await expect(runScript(script, { items: [{ label: 'a', data: [1] }] })).rejects.toThrow(/must be an object/)
  })

  it('follows the symbolic exit the agent names', async () => {
    const { script } = exportWorkflowScript(withRequires)
    const { result, calls } = await runScript(script, { items: [{ label: 'T-1' }, { label: 'T-2' }] }, {
      start: [{}],
      coding: call => (call.opts.label.startsWith('T-1')
        ? { action: 'opened', data: { pr_url: 'https://example.test/pr/1' }, note: 'opened it' }
        : { action: 'abandoned', note: 'not needed' }),
    })
    expect(result.items).toEqual([
      { label: 'T-1', data: {}, finalState: 'end', steps: [{}, { completed_action: 'opened', data: { pr_url: 'https://example.test/pr/1' }, note: 'opened it' }] },
      { label: 'T-2', data: {}, finalState: 'dropped', steps: [{}, { completed_action: 'abandoned', note: 'not needed' }] },
    ])
    result.items.forEach(item => replay(withRequires, item))

    const coding = calls.find(c => c.opts.label === 'T-1: coding')!
    expect(coding.opts.schema).toEqual({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['opened', 'abandoned'] },
        data: { type: 'object', properties: { pr_url: { type: 'string' } }, additionalProperties: true },
        note: { type: 'string' },
      },
      required: ['action'],
    })
    expect(coding.prompt).toContain('Return action "opened"')
    expect(coding.prompt).toContain('Return action "abandoned"')
    expect(coding.prompt).toMatch(/"opened".*must supply these data keys: "pr_url"/)
    expect(calls).toHaveLength(4)
  })

  it('does not ask for required data the item already has', async () => {
    const { result, calls } = await runScript(
      exportWorkflowScript(withRequires).script,
      { items: [{ label: 'T-3', data: { pr_url: 'https://example.test/pr/3' } }] },
      { start: [{}], coding: [{ action: 'opened' }] },
    )
    expect(result.items[0]).toEqual({ label: 'T-3', data: { pr_url: 'https://example.test/pr/3' }, finalState: 'end', steps: [{}, { completed_action: 'opened' }] })
    expect(calls[1].prompt).not.toContain('must supply these data keys')
    replay(withRequires, result.items[0])
  })

  it('takes a review/fix loop twice and then finishes', async () => {
    const { script } = exportWorkflowScript(review)
    const { result, calls } = await runScript(script, { items: [{ label: 'PR-9', data: { diff: 'd' } }] }, {
      reviewing: [
        { action: 'changes_requested', data: { round: 1 }, note: 'needs tests' },
        { action: 'changes_requested', data: { round: 2 }, note: 'still failing' },
        { action: 'approved', note: 'good' },
      ],
      fixing: [{ note: 'fixed' }],
    })
    const [item] = result.items
    expect(item.error).toBeUndefined()
    expect(item.finalState).toBe('end')
    // "start" has no description and one deterministic exit: no agent, an empty step
    expect(item.steps).toEqual([
      {},
      { completed_action: 'changes_requested', data: { round: 1 }, note: 'needs tests' },
      { note: 'fixed' },
      { completed_action: 'changes_requested', data: { round: 2 }, note: 'still failing' },
      { note: 'fixed' },
      { completed_action: 'approved', note: 'good' },
    ])
    expect(calls.map(c => c.opts.phase)).toEqual(['reviewing', 'fixing', 'reviewing', 'fixing', 'reviewing'])
    // later agents see the data earlier ones returned
    expect(calls[4].prompt).toContain('"round": 2')
    const session = replay(review, item)
    expect(session.history).toEqual(['start', 'reviewing', 'fixing', 'reviewing', 'fixing', 'reviewing', 'end'])
    expect(session.data).toEqual({ diff: 'd', round: 2 })
    expect(item.data).toEqual({ diff: 'd' })
  })

  it('lets a state with both kinds of exit complete without an action', async () => {
    const graph = buildGraph({
      name: 'mixed', description: '',
      transitions: ['start -escalate-> help -> end', 'start -> end'],
      states: { start: { description: 'Try it.' }, help: { description: 'Ask.' } },
    })
    const { result, calls } = await runScript(exportWorkflowScript(graph).script, { items: [{ label: 'a' }, { label: 'b' }] }, {
      start: call => (call.opts.label.startsWith('a') ? {} : { action: 'escalate' }),
      help: [{}],
    })
    expect(calls[0].opts.schema.required).toEqual([])
    expect(calls[0].opts.schema.properties.action.enum).toEqual(['escalate'])
    expect(result.items.map(i => i.steps)).toEqual([[{}], [{ completed_action: 'escalate' }, {}]])
    result.items.forEach(item => replay(graph, item))
  })

  describe('required data', () => {
    const script = exportWorkflowScript(withRequires).script

    it('re-asks once, naming the missing keys, and continues when the retry supplies them', async () => {
      const { result, calls } = await runScript(script, { items: [{ label: 'T-1' }] }, {
        start: [{}],
        coding: [
          { action: 'opened', data: { branch: 'feat', pr_url: '   ' }, note: 'first' },
          { action: 'opened', data: { pr_url: 'https://example.test/pr/7' }, note: 'second' },
        ],
      })
      expect(calls).toHaveLength(3)
      expect(calls[1].prompt).not.toContain('previous report')
      expect(calls[2].prompt).toContain('previous report')
      expect(calls[2].prompt).toContain('left out required data: "pr_url"')
      expect(calls[2].opts.label).toBe('T-1: coding')
      expect(result.items[0]).toEqual({
        label: 'T-1', data: {}, finalState: 'end',
        steps: [{}, { completed_action: 'opened', data: { branch: 'feat', pr_url: 'https://example.test/pr/7' }, note: 'second' }],
      })
      replay(withRequires, result.items[0])
    })

    it('stops the item with an error, keeping earlier steps, when the data never arrives', async () => {
      const { result, calls, logs } = await runScript(script, { items: [{ label: 'T-1' }, { label: 'T-2' }] }, {
        start: [{ note: 'read' }],
        coding: call => (call.opts.label.startsWith('T-1')
          ? { action: 'opened', data: { pr_url: null } }
          : { action: 'opened', data: { pr_url: 'https://example.test/pr/2' } }),
      })
      const [bad, good] = result.items
      expect(bad.steps).toEqual([{ note: 'read' }])
      expect(bad.finalState).toBe('coding')
      expect(bad.error).toMatch(/requires data "pr_url".*asked twice/)
      expect(calls.filter(c => c.opts.label === 'T-1: coding')).toHaveLength(2)
      expect(good.error).toBeUndefined()
      expect(good.finalState).toBe('end')
      expect(logs).toEqual(['pr: 1 finished, 1 failed (of 2)'])
      // what was completed is still a path Eliph accepts
      replay(withRequires, bad)
      replay(withRequires, good)
    })

    it('asks an agent for the data a description-less deterministic exit requires', async () => {
      const graph = setTransitionRequires(buildGraph({ name: 'gate', description: '', transitions: ['start -> end'] }), 'start -> end', ['ticket'])
      const exported = exportWorkflowScript(graph)
      expect(readMeta(exported.script).phases).toEqual([{ title: 'start' }])
      const { result, calls } = await runScript(exported.script, { items: [{ label: 'a' }, { label: 'b', data: { ticket: 'X-1' } }] }, {
        start: call => (call.opts.label.startsWith('a') ? { data: { ticket: 'X-2' } } : {}),
      })
      expect(calls).toHaveLength(2)
      expect(result.items.map(i => i.steps)).toEqual([[{ data: { ticket: 'X-2' } }], [{}]])
      result.items.forEach(item => replay(graph, item))
    })
  })

  it('stops an item whose agent returns null, keeping the steps before it', async () => {
    const { result, logs } = await runScript(exportWorkflowScript(linear).script, { items: [{ label: 'a' }, { label: 'b' }] }, {
      start: [{}],
      build: call => (call.opts.label.startsWith('a') ? null : { note: 'ok' }),
      release: [{}],
    })
    expect(result.items[0]).toEqual({
      label: 'a', data: {}, finalState: 'build', steps: [{}],
      error: expect.stringMatching(/"build" returned nothing/),
    })
    expect(result.items[1].finalState).toBe('end')
    expect(result.items[1].error).toBeUndefined()
    expect(logs).toEqual(['Ship It: 1 finished, 1 failed (of 2)'])
    replay(linear, result.items[0])
  })

  it('keeps completed steps when an agent call throws', async () => {
    const { result } = await runScript(exportWorkflowScript(linear).script, { items: [{ label: 'a' }] }, {
      start: [{ note: 'one' }], build: [new Error('budget exhausted')],
    })
    expect(result.items[0]).toEqual({ label: 'a', data: {}, finalState: 'build', steps: [{ note: 'one' }], error: expect.stringContaining('budget exhausted') })
  })

  it('reports an action that matches no exit', async () => {
    const { result } = await runScript(exportWorkflowScript(review).script, { items: [{ label: 'a' }] }, {
      reviewing: [{ action: 'shrug' }],
    })
    expect(result.items[0].steps).toEqual([{}])
    expect(result.items[0].finalState).toBe('reviewing')
    expect(result.items[0].error).toMatch(/"shrug".*matches no exit.*"approved", "changes_requested"/)
  })

  it('cuts a never-ending loop off at maxSteps and keeps the steps taken', async () => {
    const { script } = exportWorkflowScript(review, { maxSteps: 5 })
    const { result, calls } = await runScript(script, { items: [{ label: 'loop' }] }, {
      reviewing: [{ action: 'changes_requested' }],
      fixing: [{}],
    })
    const [item] = result.items
    expect(item.steps).toHaveLength(5)
    expect(item.error).toMatch(/Stopped after 5 steps/)
    expect(item.finalState).toBe('reviewing')
    expect(calls).toHaveLength(4)
    replay(review, item)
  })

  it('ignores forbidden keys and nulls in returned data, so the report is one Eliph accepts', async () => {
    const { result } = await runScript(exportWorkflowScript(linear).script, { items: [{ label: 'a' }] }, {
      start: [{ data: JSON.parse('{"__proto__": {"polluted": true}, "constructor": "x", "gone": null, "kept": 1}') }],
      build: [{ data: 'not an object' }],
      release: [{ note: 42 }],
    })
    expect(result.items[0].steps).toEqual([{ data: { kept: 1 } }, {}, {}])
    expect(({} as any).polluted).toBeUndefined()
    replay(linear, result.items[0])
  })

  it('keeps hostile state text as data: it cannot change the code and reaches the prompt verbatim', async () => {
    const nasty = [
      'Use `backticks` and ${process.exit()} and $& and $\' freely.',
      'Quotes: \' " \\ and a closing tag </script><script>alert(1)</script> <!-- x',
      'Separators:\u2028and\u2029here.',
      '*/ }); throw new Error("escaped"); /*',
      '__PROCEDURE__ __META__ __MAX_STEPS__',
    ].join('\n')
    const action = 'ok`${1}"\'</script>'
    const graph: WorkflowGraph = {
      name: 'evil"`${name}\n</script>',
      description: nasty,
      states: {
        start: { name: 'start', isTerminal: false, description: nasty },
        end: { name: 'end', isTerminal: true },
      },
      transitions: [{ from: 'start', to: 'end', type: 'symbolic', action }],
    }
    const { script } = exportWorkflowScript(graph)
    expect(script.toLowerCase()).not.toContain('</script')
    expect(script).not.toContain('<!--')
    expect(script).not.toMatch(/[\u2028\u2029]/)
    const meta = readMeta(script)
    expect(meta.name).toBe('eliph-evil-name-script')
    expect(meta.phases).toEqual([{ title: 'start' }])

    const exit = jest.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit was called') }) as never)
    try {
      const { result, calls } = await runScript(script, { items: [{ label: 'x`${1}' }] }, { start: [{ action }] })
      expect(exit).not.toHaveBeenCalled()
      expect(calls).toHaveLength(1)
      expect(calls[0].prompt).toContain(nasty)
      expect(calls[0].prompt).toContain(`Procedure: ${graph.name}`)
      expect(calls[0].prompt).toContain(`Return action ${JSON.stringify(action)}`)
      expect(calls[0].opts.schema.properties.action.enum).toEqual([action])
      expect(calls[0].opts.label).toBe('x`${1}: start')
      expect(result).toEqual({ workflow: graph.name, items: [{ label: 'x`${1}', data: {}, finalState: 'end', steps: [{ completed_action: action }] }] })
      replay(graph, result.items[0])
    } finally {
      exit.mockRestore()
    }
  })
})

describe('generated script: limits of the job API and of a workflow run', () => {
  /** Linear procedure with `n` agent states before "end". */
  const chain = (n: number) => {
    const names = ['start', ...Array.from({ length: n - 1 }, (_, i) => `s${i + 1}`)]
    return buildGraph({
      name: `chain-${n}`,
      description: 'd',
      transitions: [[...names, 'end'].join(' -> ')],
      states: Object.fromEntries(names.map(name => [name, { description: `Do ${name}.` }])),
    })
  }
  const answers = (graph: WorkflowGraph, answer: Answer = {}): AnswerTable =>
    Object.fromEntries(Object.keys(graph.states).map(name => [name, [answer]]))
  const labels = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `item-${i + 1}` }))

  it('refuses, before any agent runs, a batch that cannot fit in the agent calls of one run', async () => {
    const graph = chain(6)
    const { script, notes } = exportWorkflowScript(graph)
    // 6 calls per item: 166 items fit in 1000 calls, 167 do not
    await expect(runScript(script, { items: labels(167) }, answers(graph))).rejects.toThrow(/at least 6 agent calls.*at most 166 items per run/)
    const { result, calls } = await runScript(script, { items: labels(166) }, answers(graph))
    expect(calls).toHaveLength(996)
    expect(result.items.every(item => item.finalState === 'end' && !item.error)).toBe(true)
    expect(notes.some(n => /at most 1000 agent calls/.test(n) && /at least 6/.test(n) && /at most 166 items/.test(n))).toBe(true)
  })

  it('counts the cheapest path to a terminal state, not every state', async () => {
    // review: start runs without an agent, "approved" ends after one call
    const { script, notes } = exportWorkflowScript(review)
    const { result } = await runScript(script, { items: labels(200) }, { reviewing: [{ action: 'approved' }] })
    expect(result.items.filter(item => item.finalState === 'end')).toHaveLength(200)
    expect(notes.some(n => /at most 1000 agent calls/.test(n) && /at least 1\./.test(n))).toBe(true)
  })

  it('stops at 1000 agent calls: unfinished items keep their steps and say why', async () => {
    const { script } = exportWorkflowScript(review, { maxSteps: 25 })
    const { result, calls } = await runScript(script, { items: labels(200) }, {
      reviewing: [{ action: 'changes_requested' }],
      fixing: [{}],
    })
    expect(calls).toHaveLength(1000)
    expect(result.items).toHaveLength(200)
    for (const item of result.items) {
      expect(item.error).toMatch(/Stopped in state .*used all 1000 agent calls/)
      replay(review, item)
    }
  })

  it('returns batches of at most 2000 steps when the result is too large for one job', async () => {
    const graph = chain(11)
    const { script, notes } = exportWorkflowScript(graph)
    // 11 steps per item; 90 items = 990 calls and 990 steps: fits one job
    const small = await runScript(script, { items: labels(90) }, answers(graph))
    expect(small.result).not.toHaveProperty('batches')
    expect(small.result).not.toHaveProperty('warning')

    // Steps without agents: a silent chain reaches the step limit with no calls
    const silent = buildGraph({ name: 'silent', description: 'd', transitions: ['start -> a -> b -> c -> d -> e -> f -> g -> h -> i -> j -> end'] })
    const big = await runScript(exportWorkflowScript(silent).script, { items: labels(200) })
    const result = big.result as RunResult & { batches: string[][]; warning: string }
    expect(result.items).toHaveLength(200)
    expect(result.batches.flat()).toEqual(result.items.map(item => item.label))
    expect(result.batches.length).toBe(2)
    const stepsOf = new Map(result.items.map(item => [item.label, item.steps.length]))
    for (const batch of result.batches) {
      expect(batch.reduce((sum, label) => sum + stepsOf.get(label)!, 0)).toBeLessThanOrEqual(2000)
    }
    expect(result.warning).toMatch(/2200 steps.*accepts 2000.*2 calls/)
    expect(big.logs).toContain(result.warning)
    expect(notes.some(n => /"batches"/.test(n))).toBe(true)
  })

  it('refuses item data Eliph would refuse before any agent runs', async () => {
    const { script } = exportWorkflowScript(linear)
    const run = (data: unknown) => runScript(script, { items: [{ label: 'ok' }, { label: 'a', data }] }, {
      start: [new Error('no agent may run')],
    })
    await expect(run(JSON.parse('{"constructor": 1}'))).rejects.toThrow(/data of item "a": must not contain the key "constructor"/)
    await expect(run(JSON.parse('{"x": [{"__proto__": {"y": 1}}]}'))).rejects.toThrow(/data of item "a": must not contain the key "__proto__"/)
    await expect(run({ big: 'é'.repeat(33 * 1024) })).rejects.toThrow(/data of item "a" is 67594 bytes/)
    let deep: unknown = 1
    for (let i = 0; i < 33; i++) deep = { d: deep }
    await expect(run(deep)).rejects.toThrow(/data of item "a": data is nested more than 32 levels/)
    // Each of them is refused by the engine too, and what the script accepts is accepted
    for (const bad of [JSON.parse('{"constructor": 1}'), { big: 'é'.repeat(33 * 1024) }, deep]) {
      expect(() => mergeSessionData(undefined, bad)).toThrow()
    }
    let fits: unknown = 1
    for (let i = 0; i < 32; i++) fits = { d: fits }
    const ok = await runScript(script, { items: [{ label: 'a', data: fits }] }, { start: [{}], build: [{}], release: [{}] })
    replay(linear, ok.result.items[0])
  })

  it('drops forbidden keys inside returned data, at any depth', async () => {
    const { result } = await runScript(exportWorkflowScript(linear).script, { items: [{ label: 'a' }] }, {
      start: [{ data: JSON.parse('{"report": {"constructor": "x", "rows": [{"__proto__": {"p": 1}, "n": 1}]}}') }],
      build: [{}],
      release: [{}],
    })
    expect(result.items[0].steps[0]).toEqual({ data: { report: { rows: [{ n: 1 }] } } })
    expect(result.items[0].error).toBeUndefined()
    replay(linear, result.items[0])
  })

  it('stops an item where its data outgrows 64 KB or nests too deep, so the report replays', async () => {
    const big = (key: string) => ({ data: { [key]: 'x'.repeat(30 * 1024) } })
    const { result } = await runScript(exportWorkflowScript(linear).script, { items: [{ label: 'a' }, { label: 'b' }] }, {
      start: [big('one')],
      build: [big('two')],
      release: (call) => (call.opts.label.startsWith('a:') ? big('three') : {}),
    })
    const [a, b] = result.items
    expect(a.steps).toHaveLength(2)
    expect(a.finalState).toBe('release')
    expect(a.error).toMatch(/State "release".*9\d\d\d\d bytes.*65536/)
    replay(linear, a)
    expect(b.error).toBeUndefined()
    expect(replay(linear, b).currentState).toBe('end')

    let deep: unknown = 1
    for (let i = 0; i < 40; i++) deep = { d: deep }
    const nested = await runScript(exportWorkflowScript(linear).script, { items: [{ label: 'a' }] }, {
      start: [{}], build: [{ data: { deep } }], release: [{}],
    })
    expect(nested.result.items[0].steps).toHaveLength(1)
    expect(nested.result.items[0].error).toMatch(/Stopped in state "build".*nested more than 32 levels/)
    replay(linear, nested.result.items[0])
  })
})
