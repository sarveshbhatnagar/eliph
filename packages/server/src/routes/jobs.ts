import { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { IWorkflowStore, ISessionStore, IUsageStore, IApiKeyStore, Session, WorkflowGraph, getNextTransitions, graphWarnings } from '@eliph/core'
import { requestOwnerId, canAccessSession } from '../middleware/auth'
import { Caller, ErrorBody, NOT_FOUND, advanceOnce, buildSession, graphFor, initialData, recordUsage, sessionOps } from './session-ops'
import { actorBody, dataBody, expectedStateBody, noteBody } from './sessions'

const authed = [{ BearerAuth: [] }]

/**
 * A job is a group of sessions ("runs") of the same procedure, one per piece of
 * work, so parallel workers never share a marker. It has no record of its own:
 * it is the set of sessions sharing a jobId, and every job route works only on
 * the sessions of that set the caller may access through /session/:id.
 */

/** Most runs in one job, most steps in one request, longest label. */
export const JOB_LIMITS = { maxItems: 200, maxSteps: 2000, maxLabelLength: 200 }

interface JobStep {
  completed_action?: string
  data?: Record<string, unknown>
  note?: string
}

interface JobItem {
  label: string
  data?: Record<string, unknown>
  steps?: JobStep[]
}

interface JobAdvanceStep extends JobStep {
  label?: string
  session_id?: string
  expected_state?: string
}

interface RunError {
  message: string
  code: string
  missing?: string[]
}

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', description: 'The jobId returned by POST /job.' } },
}

const stepProperties = {
  completed_action: { type: 'string', description: 'The action that was completed; selects the symbolic transition to take. Omit for a deterministic step.' },
  data: dataBody,
  note: noteBody,
}

const stepErrorProperties = {
  message: { type: 'string' },
  code: { type: 'string', description: 'The code the single-session advance would answer with, e.g. BAD_REQUEST, MISSING_REQUIRED_DATA, PAYLOAD_TOO_LARGE, STATE_MISMATCH, NOT_FOUND, CONFLICT.' },
  missing: { type: 'array', items: { type: 'string' }, description: 'MISSING_REQUIRED_DATA only: the session-data keys without a value.' },
}

const jobProperties = {
  jobId: { type: 'string' },
  workflow: { type: 'string', description: 'The procedure every run of the job follows.' },
  total: { type: 'integer', description: 'Number of runs.' },
  done: { type: 'boolean', description: 'true when every run is in a terminal state.' },
  counts: {
    type: 'object',
    additionalProperties: { type: 'integer' },
    description: 'Number of runs per current state.',
  },
  runs: { type: 'array', items: { $ref: 'JobRun#' }, description: 'One entry per piece of work, in creation order.' },
}
const jobRequired = ['jobId', 'workflow', 'total', 'done', 'counts', 'runs']

/** Shared schemas of the job routes; called by registerSharedSchemas. */
export function registerJobSchemas(app: FastifyInstance): void {
  app.addSchema({
    $id: 'JobRun',
    type: 'object',
    description: 'One run of a job: a session, addressable through the /session/{id} routes too.',
    properties: {
      id: { type: 'string', description: 'The session id of the run.' },
      label: { type: 'string', description: 'Name of the piece of work, unique inside the job.' },
      currentState: { type: 'string' },
      isTerminal: { type: 'boolean' },
      updatedAt: { type: 'string', format: 'date-time' },
      error: {
        type: 'object',
        description: 'POST /job only: present when one of the run\'s `steps` was refused. The run stays where the steps before it left it.',
        properties: { ...stepErrorProperties, atStep: { type: 'integer', description: 'Index (from 0) in the item\'s `steps` of the step that was refused.' } },
        required: ['message', 'code', 'atStep'],
      },
    },
    required: ['id', 'label', 'currentState', 'isTerminal'],
  })

  app.addSchema({
    $id: 'Job',
    type: 'object',
    description: 'Summary of a job: a group of sessions (runs) of the same procedure, one per piece of work.',
    properties: jobProperties,
    required: jobRequired,
  })
}

function badRequest(error: string) {
  return { error, code: 'BAD_REQUEST' }
}

/** Why the items of a POST /job body are not acceptable, or null. Nothing is created when this answers. */
function itemsProblem(items: JobItem[]): string | null {
  if (items.length === 0) return 'items must contain at least one item: { label, data?, steps? }.'
  if (items.length > JOB_LIMITS.maxItems) {
    return `A job can have at most ${JOB_LIMITS.maxItems} items; got ${items.length}. Split the work over several jobs.`
  }
  const seen = new Set<string>()
  let steps = 0
  for (const [i, item] of items.entries()) {
    if (typeof item.label !== 'string' || item.label.trim() === '') return `Item ${i + 1} has no label. Every item needs a non-empty "label".`
    if (item.label.length > JOB_LIMITS.maxLabelLength) return `The label of item ${i + 1} is longer than ${JOB_LIMITS.maxLabelLength} characters.`
    if (seen.has(item.label)) return `Labels must be unique inside a job, but ${JSON.stringify(item.label)} is used more than once.`
    seen.add(item.label)
    steps += item.steps?.length ?? 0
  }
  if (steps > JOB_LIMITS.maxSteps) return `A request can carry at most ${JOB_LIMITS.maxSteps} steps in total; got ${steps}.`
  return null
}

/**
 * Lets requests that are waiting be served. Awaiting a store call only yields
 * to microtasks (the SQLite store is synchronous), so a long run of steps would
 * otherwise hold the event loop, and with it every other caller, until its end.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * The state a reported step leads to from `state`, without taking it: the
 * symbolic exit named by the action, or else the single deterministic exit.
 * undefined when the step is not one the procedure allows from there (or the
 * exit would be picked at random), which the advance itself then explains.
 */
function stepTarget(graph: WorkflowGraph, state: string, action: string | undefined): string | undefined {
  const exits = getNextTransitions(graph, state)
  if (action !== undefined) return exits.find(t => t.type === 'symbolic' && t.action === action)?.to
  if (exits.some(t => t.type === 'probabilistic')) return undefined
  const deterministic = exits.filter(t => t.type === 'deterministic')
  return deterministic.length === 1 ? deterministic[0].to : undefined
}

/**
 * How a run compares with the steps reported for it. `history` is the run's
 * own path (it begins with "start"). The reported steps are walked from
 * "start"; the run matches when its path is the beginning of theirs (the
 * steps after it are still to be applied) or theirs is the beginning of its
 * path (nothing to do). `skip` is the number of reported steps the run has
 * already taken; `states[i]` is the state step i must be taken from.
 */
function compareWithReport(graph: WorkflowGraph, history: string[], steps: JobStep[]): { diverged: false; skip: number; states: string[] } | { diverged: true; atStep: number } {
  const taken = history.length - 1
  const states: string[] = ['start']
  if (history[0] !== 'start') return { diverged: true, atStep: 0 }
  for (let i = 0; i < steps.length; i++) {
    const from = states[i]
    if (i >= taken) {
      // Beyond what the run has taken: only the state to take it from is needed
      const to = stepTarget(graph, from, steps[i].completed_action)
      if (to === undefined) break
      states.push(to)
      continue
    }
    const to = stepTarget(graph, from, steps[i].completed_action)
    if (to === undefined || to !== history[i + 1]) return { diverged: true, atStep: i }
    states.push(to)
  }
  return { diverged: false, skip: Math.min(taken, steps.length), states }
}

function runError(body: ErrorBody): RunError {
  return { message: body.error, code: body.code, ...(body.missing ? { missing: body.missing } : {}) }
}

export function jobsRoutes(workflowStore: IWorkflowStore, sessionStore: ISessionStore, usageStore: IUsageStore, apiKeyStore: IApiKeyStore) {
  const ops = sessionOps(workflowStore, sessionStore, usageStore, apiKeyStore)

  /**
   * The runs of a job the caller may access, in creation order. Each session is
   * checked with the same rule as /session/:id, so a job never shows, advances
   * or deletes a session its caller could not reach directly. Empty for an
   * unknown job and for a job of another org alike.
   */
  async function accessibleRuns(req: Caller, jobId: string): Promise<Session[]> {
    const allowedOwners = new Map<string, boolean>()
    const runs: Session[] = []
    for (const session of await sessionStore.listByJob(jobId)) {
      // listByJob is trusted for nothing: the session must really name this job
      if (session.jobId !== jobId) continue
      let allowed = allowedOwners.get(session.workflowOwnerId)
      if (allowed === undefined) {
        allowed = await canAccessSession(req, session, apiKeyStore)
        allowedOwners.set(session.workflowOwnerId, allowed)
      }
      if (allowed) runs.push(session)
    }
    return runs
  }

  /** The job summary of `runs` (not empty). `errors` adds the per-run step error of POST /job. */
  async function summarize(jobId: string, runs: Session[], errors?: Map<string, RunError & { atStep: number }>) {
    const graphs = new Map<string, Promise<WorkflowGraph | null>>()
    const graphOf = (s: Session) => {
      if (s.pinnedGraph) return Promise.resolve<WorkflowGraph | null>(s.pinnedGraph)
      const key = JSON.stringify([s.workflowOwnerId, s.workflowName])
      let graph = graphs.get(key)
      if (!graph) {
        graph = workflowStore.get(s.workflowName, s.workflowOwnerId)
        graphs.set(key, graph)
      }
      return graph
    }
    // State names are user text: count in a Map so a name like "__proto__" is only ever a key
    const counts = new Map<string, number>()
    let done = true
    const rows = []
    for (const s of runs) {
      const graph = await graphOf(s)
      // A run whose procedure was deleted cannot be finished: it is never terminal
      const isTerminal = graph?.states[s.currentState]?.isTerminal ?? false
      if (!isTerminal) done = false
      counts.set(s.currentState, (counts.get(s.currentState) ?? 0) + 1)
      const error = errors?.get(s.id)
      rows.push({
        id: s.id,
        label: s.label ?? '',
        currentState: s.currentState,
        isTerminal,
        updatedAt: s.updatedAt ?? s.createdAt,
        ...(error ? { error } : {}),
      })
    }
    return { jobId, workflow: runs[0].workflowName, total: runs.length, done, counts: Object.fromEntries(counts), runs: rows }
  }

  return async (app: FastifyInstance) => {
    app.post<{ Body: { workflow: string; items: JobItem[]; pin?: boolean; actor?: string } }>('/job', {
      schema: {
        tags: ['Jobs'],
        summary: 'Create a job: one session (run) per piece of work',
        description: 'A job groups sessions of the same procedure, one per item, so workers handling different pieces of work in parallel never '
          + 'share a session. Each run is an ordinary session (same ownership and rules as POST /session) that also carries `jobId` and `label`. '
          + 'An item may bring `steps`: they are applied in order right after creation with the same rules as POST /session/{id}/advance, which '
          + 'reports work that already happened (for example a finished workflow-script run) in one call. A step that is refused stops that run '
          + 'only: the run keeps the steps before it and gets an `error`; the other runs are not affected. '
          + `Limits: ${JOB_LIMITS.maxItems} items, ${JOB_LIMITS.maxSteps} steps in total, labels unique and at most ${JOB_LIMITS.maxLabelLength} characters. `
          + 'If the body is not acceptable the response is 400 (404 for an unknown workflow) and nothing is created.',
        security: authed,
        body: {
          type: 'object',
          required: ['workflow', 'items'],
          properties: {
            workflow: { type: 'string' },
            items: {
              type: 'array',
              description: `One entry per piece of work (1-${JOB_LIMITS.maxItems}).`,
              items: {
                type: 'object',
                required: ['label'],
                properties: {
                  label: { type: 'string', description: `Name of the piece of work, unique inside the job (max ${JOB_LIMITS.maxLabelLength} characters).` },
                  data: { ...dataBody, description: 'Optional initial session data of the run (JSON object, max 64 KB serialized).' },
                  steps: {
                    type: 'array',
                    description: 'Optional. Advances applied in order right after the run is created.',
                    items: { type: 'object', properties: stepProperties },
                  },
                },
              },
            },
            pin: {
              type: 'boolean',
              description: 'Optional, default false. true pins every run to a snapshot of the procedure as it is now (see POST /session).',
            },
            actor: actorBody,
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              ...jobProperties,
              warnings: { type: 'array', items: { type: 'string' }, description: 'Advisory problems with the procedure graph (as on POST /session).' },
            },
            required: jobRequired,
          },
        },
      } as any,
    }, async (req, reply) => {
      const { workflow, items, pin } = req.body
      const actor = req.body.actor ? req.body.actor : undefined
      const problem = itemsProblem(items)
      if (problem) return reply.code(400).send(badRequest(problem))
      const owner = requestOwnerId(req)
      const graph = await workflowStore.get(workflow, owner)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      // All initial data is checked before the first run is saved
      const datas: Record<string, unknown>[] = []
      for (const item of items) {
        const data = initialData(item.data)
        if (!data.ok) return reply.code(data.status).send({ ...data.body, error: `Item ${JSON.stringify(item.label)}: ${data.body.error}` })
        datas.push(data.data)
      }

      const jobId = randomUUID()
      const runs: Session[] = []
      const errors = new Map<string, RunError & { atStep: number }>()
      // Runs are listed by creation time, so each gets its own millisecond (the last one: now)
      // and a job keeps the order of its items in every store.
      const lastCreatedAt = Date.now()
      for (const [i, item] of items.entries()) {
        // Each run is a save of its own; other requests get a turn between them
        if (i > 0) await yieldToEventLoop()
        const now = new Date(lastCreatedAt - (items.length - 1 - i))
        let session = buildSession(owner, graph, workflow, { data: datas[i], pin, jobId, label: item.label, actor, now })
        // The steps are decided in memory and the run is saved once, as it stands after the last accepted step
        let advanced = 0
        for (const [atStep, step] of (item.steps ?? []).entries()) {
          const result = advanceOnce(session, graph, { completed_action: step.completed_action, data: step.data, note: step.note, actor })
          if (!result.ok) {
            errors.set(session.id, { ...runError(result.body), atStep })
            break
          }
          session = result.session
          advanced++
        }
        await sessionStore.save(session)
        recordUsage(req, usageStore, 'session_created')
        for (let n = 0; n < advanced; n++) recordUsage(req, usageStore, 'advance')
        runs.push(session)
      }
      reply.code(201).send({ ...(await summarize(jobId, runs, errors)), warnings: graphWarnings(graph) })
    })

    app.get<{ Params: { id: string } }>('/job/:id', {
      schema: {
        tags: ['Jobs'],
        summary: 'Get the status of a job',
        description: 'Where every run of the job is, and whether all of them are finished. 404 for an unknown job and for a job of another org alike.',
        security: authed,
        params: idParams,
        response: { 200: { $ref: 'Job#' } },
      } as any,
    }, async (req, reply) => {
      const runs = await accessibleRuns(req, req.params.id)
      if (runs.length === 0) return reply.code(404).send(NOT_FOUND)
      reply.send(await summarize(req.params.id, runs))
    })

    app.post<{ Params: { id: string }; Body: { steps: JobAdvanceStep[]; actor?: string } }>('/job/:id/advance', {
      schema: {
        tags: ['Jobs'],
        summary: 'Advance runs of a job',
        description: 'Applies the steps in order, each with the same rules as POST /session/{id}/advance (including `expected_state` and required '
          + 'data). A step names its run by `label` or `session_id`; several steps for the same run are allowed. A step that is refused does not '
          + 'fail the request or the other steps: it is reported in `results` (one entry per step, in order) with the code the single-session '
          + 'route would answer, NOT_FOUND when the job has no such run. '
          + `At most ${JOB_LIMITS.maxSteps} steps per request.`,
        security: authed,
        params: idParams,
        body: {
          type: 'object',
          required: ['steps'],
          properties: {
            steps: {
              type: 'array',
              description: `Steps to apply in order (1-${JOB_LIMITS.maxSteps}).`,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'The label of the run to advance. Give this or session_id.' },
                  session_id: { type: 'string', description: 'The session id of the run to advance. Give this or label.' },
                  ...stepProperties,
                  expected_state: expectedStateBody,
                },
              },
            },
            actor: actorBody,
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ...jobProperties,
              results: {
                type: 'array',
                description: 'One entry per step, in request order.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'The label of the run (the label the step asked for when the job has no such run).' },
                    id: { type: 'string', description: 'The session id of the run; absent when the job has no such run.' },
                    ok: { type: 'boolean' },
                    currentState: { type: 'string', description: 'The state of the run after this step; absent when the job has no such run.' },
                    error: { type: 'object', properties: stepErrorProperties, required: ['message', 'code'] },
                  },
                  required: ['ok'],
                },
              },
            },
            required: [...jobRequired, 'results'],
          },
        },
      } as any,
    }, async (req, reply) => {
      const jobId = req.params.id
      // An empty label or session_id means "not given" (a JSON null arrives as "")
      const steps = req.body.steps.map(s => ({ ...s, label: s.label || undefined, session_id: s.session_id || undefined }))
      const actor = req.body.actor ? req.body.actor : undefined
      if (steps.length === 0) return reply.code(400).send(badRequest('steps must contain at least one step.'))
      if (steps.length > JOB_LIMITS.maxSteps) {
        return reply.code(400).send(badRequest(`A request can carry at most ${JOB_LIMITS.maxSteps} steps; got ${steps.length}.`))
      }
      const unnamed = steps.findIndex(s => s.label === undefined && s.session_id === undefined)
      if (unnamed !== -1) return reply.code(400).send(badRequest(`Step ${unnamed + 1} names no run. Every step needs a "label" or a "session_id".`))

      const runs = await accessibleRuns(req, jobId)
      if (runs.length === 0) return reply.code(404).send(NOT_FOUND)
      // Steps are resolved inside this job's accessible runs only, never by a lookup outside it
      const byId = new Map(runs.map(r => [r.id, r]))
      const byLabel = new Map(runs.filter(r => r.label !== undefined).map(r => [r.label as string, r]))

      const results = []
      for (const [i, step] of steps.entries()) {
        // Every step is a full load-decide-save of its own; other requests get a turn between them
        if (i > 0) await yieldToEventLoop()
        const run = step.session_id !== undefined ? byId.get(step.session_id) : byLabel.get(step.label as string)
        if (!run || (step.label !== undefined && run.label !== step.label)) {
          const named = step.session_id !== undefined && step.label !== undefined
            ? `session "${step.session_id}" with label ${JSON.stringify(step.label)}`
            : step.session_id !== undefined ? `session "${step.session_id}"` : `label ${JSON.stringify(step.label)}`
          results.push({
            ...(step.label !== undefined ? { label: step.label } : {}),
            ok: false,
            error: { message: `This job has no run for ${named}.`, code: 'NOT_FOUND' },
          })
          continue
        }
        const result = await ops.advance(req, run.id, {
          completed_action: step.completed_action, expected_state: step.expected_state, data: step.data, note: step.note, actor,
        }, jobId)
        if (result.ok) {
          results.push({ label: run.label ?? '', id: run.id, ok: true, currentState: result.session.currentState })
        } else {
          results.push({
            label: run.label ?? '',
            id: run.id,
            ok: false,
            // Absent when the run disappeared while the request was running
            ...(result.session ? { currentState: result.session.currentState } : {}),
            error: runError(result.body),
          })
        }
      }
      // Read again so the summary shows the runs as they are now
      const after = await accessibleRuns(req, jobId)
      const summary = after.length > 0
        ? await summarize(jobId, after)
        : { jobId, workflow: runs[0].workflowName, total: 0, done: false, counts: {}, runs: [] }
      reply.send({ ...summary, results })
    })

    app.post<{ Params: { id: string }; Body: { items: Array<{ label: string; steps?: JobStep[] }>; actor?: string } }>('/job/:id/sync', {
      schema: {
        tags: ['Jobs'],
        summary: 'Bring runs of a job up to date with the steps reported for them',
        description: 'For each item, `steps` is the whole path of that run from "start" (the same steps POST /job accepts). The steps the run has '
          + 'already taken are skipped and only the rest are applied, with the same rules as POST /session/{id}/advance, so the call can be '
          + 'repeated safely: workers can report after every step while a workflow is running, and the final result can be sent again at the end '
          + 'to fill in anything that was missed. A run whose own path is not the beginning of the reported steps (or the other way round) is '
          + 'left untouched and reported with code DIVERGED. Per-item problems do not fail the request: see `results` (one entry per item, in order). '
          + `At most ${JOB_LIMITS.maxItems} items and ${JOB_LIMITS.maxSteps} steps per request.`,
        security: authed,
        params: idParams,
        body: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              description: 'One entry per run to bring up to date.',
              items: {
                type: 'object',
                required: ['label'],
                properties: {
                  label: { type: 'string', description: 'The label of the run.' },
                  steps: { type: 'array', description: 'Every step of the run so far, in order, from "start".', items: { type: 'object', properties: stepProperties } },
                },
              },
            },
            actor: actorBody,
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ...jobProperties,
              results: {
                type: 'array',
                description: 'One entry per item, in request order.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    id: { type: 'string', description: 'The session id of the run; absent when the job has no such run.' },
                    ok: { type: 'boolean', description: 'true when the run now holds every reported step.' },
                    currentState: { type: 'string' },
                    skipped: { type: 'integer', description: 'Reported steps the run had already taken.' },
                    applied: { type: 'integer', description: 'Reported steps applied by this request.' },
                    error: {
                      type: 'object',
                      properties: {
                        ...stepErrorProperties,
                        code: { type: 'string', description: 'DIVERGED, NOT_FOUND, or the code the single-session advance would answer with.' },
                        atStep: { type: 'integer', description: 'Index (from 0) in the item\'s `steps` of the step that did not fit or was refused.' },
                      },
                      required: ['message', 'code'],
                    },
                  },
                  required: ['label', 'ok'],
                },
              },
            },
            required: [...jobRequired, 'results'],
          },
        },
      } as any,
    }, async (req, reply) => {
      const jobId = req.params.id
      const items = req.body.items
      const actor = req.body.actor ? req.body.actor : undefined
      if (items.length === 0) return reply.code(400).send(badRequest('items must contain at least one item: { label, steps }.'))
      if (items.length > JOB_LIMITS.maxItems) {
        return reply.code(400).send(badRequest(`A request can carry at most ${JOB_LIMITS.maxItems} items; got ${items.length}.`))
      }
      const seen = new Set<string>()
      let total = 0
      for (const [i, item] of items.entries()) {
        if (typeof item.label !== 'string' || item.label === '') return reply.code(400).send(badRequest(`Item ${i + 1} has no label.`))
        if (seen.has(item.label)) return reply.code(400).send(badRequest(`Label ${JSON.stringify(item.label)} is used more than once.`))
        seen.add(item.label)
        total += item.steps?.length ?? 0
      }
      if (total > JOB_LIMITS.maxSteps) {
        return reply.code(400).send(badRequest(`A request can carry at most ${JOB_LIMITS.maxSteps} steps in total; got ${total}.`))
      }

      const runs = await accessibleRuns(req, jobId)
      if (runs.length === 0) return reply.code(404).send(NOT_FOUND)
      // Items are resolved inside this job's accessible runs only, never by a lookup outside it
      const byLabel = new Map(runs.filter(r => r.label !== undefined).map(r => [r.label as string, r]))

      const results = []
      for (const [i, item] of items.entries()) {
        if (i > 0) await yieldToEventLoop()
        const steps = item.steps ?? []
        const run = byLabel.get(item.label)
        if (!run) {
          results.push({ label: item.label, ok: false, error: { message: `This job has no run for label ${JSON.stringify(item.label)}.`, code: 'NOT_FOUND' } })
          continue
        }
        const graph = await graphFor(workflowStore, run)
        if (!graph) {
          results.push({ label: item.label, id: run.id, ok: false, currentState: run.currentState, error: { message: 'The procedure of this run no longer exists.', code: 'NOT_FOUND' } })
          continue
        }
        const compared = compareWithReport(graph, run.history, steps)
        if (compared.diverged) {
          results.push({
            label: item.label, id: run.id, ok: false, currentState: run.currentState, skipped: 0, applied: 0,
            error: {
              message: `The run took a different path (${run.history.join(' -> ')}) than the reported steps from step ${compared.atStep + 1} on. Nothing was changed.`,
              code: 'DIVERGED',
              atStep: compared.atStep,
            },
          })
          continue
        }
        let currentState = run.currentState
        let applied = 0
        let error: (RunError & { atStep: number }) | undefined
        for (let n = compared.skip; n < steps.length; n++) {
          await yieldToEventLoop()
          const step = steps[n]
          // Taken only from the state the report says it starts in, so a step another caller
          // records at the same moment is never applied twice
          const result = await ops.advance(req, run.id, {
            completed_action: step.completed_action, expected_state: compared.states[n], data: step.data, note: step.note, actor,
          }, jobId)
          if (!result.ok) {
            if (result.session) currentState = result.session.currentState
            error = { ...runError(result.body), atStep: n }
            break
          }
          currentState = result.session.currentState
          applied++
        }
        results.push({ label: item.label, id: run.id, ok: !error, currentState, skipped: compared.skip, applied, ...(error ? { error } : {}) })
      }
      const after = await accessibleRuns(req, jobId)
      const summary = after.length > 0
        ? await summarize(jobId, after)
        : { jobId, workflow: runs[0].workflowName, total: 0, done: false, counts: {}, runs: [] }
      reply.send({ ...summary, results })
    })

    app.delete<{ Params: { id: string } }>('/job/:id', {
      schema: {
        tags: ['Jobs'],
        summary: 'Delete a job and all its runs',
        description: 'Deletes every session of the job. Idempotent like DELETE /session/{id}: an unknown job and a job of another org both answer 204, and the latter is left untouched.',
        security: authed,
        params: idParams,
        response: { 204: { type: 'null' } },
      } as any,
    }, async (req, reply) => {
      for (const run of await accessibleRuns(req, req.params.id)) await sessionStore.delete(run.id)
      reply.code(204).send()
    })
  }
}
