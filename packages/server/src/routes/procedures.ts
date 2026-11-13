import { FastifyInstance } from 'fastify'
import {
  IWorkflowStore, ISessionStore, IApiKeyStore, WorkflowGraph, TransitionDefinition, StateDefinition, addTransition, removeTransition, removeState,
  markStateTerminal, buildGraph, hasState, DEFINITION_LIMITS, REQUIRES_LIMITS, REQUIRES_NAME_PATTERN, setTransitionRequires, computeProcedureStats,
} from '@eliph/core'
import { requestOwnerId, sessionOwnerIdsForListing } from '../middleware/auth'
import { withWarnings, workflowExistsConflict, overwriteProperty } from './workflow-helpers'

const authed = [{ BearerAuth: [] }]


/**
 * States of `current` that `replacement` drops and that hold at least one of
 * this owner's sessions. findByState is not owner-scoped, so filter by owner.
 */
async function strandedStates(sessionStore: ISessionStore, current: WorkflowGraph, replacement: WorkflowGraph, owner: string): Promise<string[]> {
  const removed = Object.keys(current.states).filter(s => !Object.prototype.hasOwnProperty.call(replacement.states, s))
  const stranded: string[] = []
  for (const state of removed) {
    const sessions = (await sessionStore.findByState(current.name, state)).filter(s => s.workflowOwnerId === owner && !s.pinnedGraph)
    if (sessions.length > 0) stranded.push(state)
  }
  return stranded
}

/** Longest name accepted when a procedure is created (POST /procedure, PUT /procedure/:name). */
export const PROCEDURE_NAME_MAX_LENGTH = 200

/** At most this many of the newest sessions are analysed by GET /procedure/:name/stats. */
export const STATS_MAX_SESSIONS = 1000

const requiresSchema = {
  type: 'array',
  maxItems: REQUIRES_LIMITS.maxNames,
  items: { type: 'string', minLength: 1, maxLength: REQUIRES_LIMITS.maxNameLength, pattern: REQUIRES_NAME_PATTERN },
  description: `Session-data keys (at most ${REQUIRES_LIMITS.maxNames}, each 1-${REQUIRES_LIMITS.maxNameLength} characters of letters, digits, "_", "." or "-") `
    + 'that must have a value (not null or a blank string) before the transition can be taken.',
}

const nameParams = {
  type: 'object',
  properties: { name: { type: 'string' } },
}

const statsResponse = {
  type: 'object',
  properties: {
    workflow: { type: 'string' },
    sessionsAnalyzed: { type: 'integer' },
    truncated: { type: 'boolean', description: `true when there are more than ${STATS_MAX_SESSIONS} sessions and only the newest ${STATS_MAX_SESSIONS} were analysed.` },
    totals: {
      type: 'object',
      properties: {
        sessions: { type: 'integer' },
        completed: { type: 'integer', description: 'Sessions currently in a terminal state.' },
        active: { type: 'integer', description: 'Sessions not in a terminal state.' },
      },
      required: ['sessions', 'completed', 'active'],
    },
    states: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          state: { type: 'string' },
          entered: { type: 'integer', description: 'Times sessions entered the state (created in it, advanced or reset into it).' },
          currentlyHere: { type: 'integer', description: 'Sessions whose current state it is.' },
          exits: {
            type: 'array',
            description: 'Advances out of the state, by target state and completed_action, most frequent first.',
            items: {
              type: 'object',
              properties: {
                to: { type: 'string' },
                action: { type: 'string', nullable: true },
                count: { type: 'integer' },
              },
              required: ['to', 'action', 'count'],
            },
          },
          resetsAway: { type: 'integer', description: 'Resets made while in this state.' },
          avgDwellMs: { type: 'number', nullable: true, description: 'Mean milliseconds between entering the state and leaving it; null if no session has left it.' },
        },
        required: ['state', 'entered', 'currentlyHere', 'exits', 'resetsAway', 'avgDwellMs'],
      },
    },
  },
  required: ['workflow', 'sessionsAnalyzed', 'truncated', 'totals', 'states'],
}

export function proceduresRoutes(workflowStore: IWorkflowStore, sessionStore: ISessionStore, apiKeyStore: IApiKeyStore) {
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { q?: string } }>('/procedures', {
      schema: {
        tags: ['Procedures'],
        summary: 'Search procedures by name or description',
        security: authed,
        querystring: {
          type: 'object',
          properties: { q: { type: 'string' } },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      } as any,
    }, async (req, reply) => {
      const q = req.query.q ?? ''
      reply.send(await workflowStore.search(q, requestOwnerId(req)))
    })

    app.delete<{ Params: { name: string } }>('/procedure/:name', {
      schema: {
        tags: ['Procedures'],
        summary: 'Delete a procedure',
        security: authed,
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        response: { 204: { type: 'null' } },
      } as any,
    }, async (req, reply) => {
      await workflowStore.delete(req.params.name, requestOwnerId(req))
      reply.code(204).send()
    })

    app.patch<{ Params: { name: string }; Body: { description: string } }>('/procedure/:name', {
      schema: {
        tags: ['Procedures'],
        summary: 'Update a procedure description',
        security: authed,
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['description'],
          properties: { description: { type: 'string' } },
        },
        response: { 200: { $ref: 'WorkflowGraph#' } },
      } as any,
    }, async (req, reply) => {
      const owner = requestOwnerId(req)
      const graph = await workflowStore.get(req.params.name, owner)
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      const updated = { ...graph, description: req.body.description }
      await workflowStore.save(updated, owner)
      reply.send(updated)
    })

    app.get<{ Params: { name: string } }>('/procedure/:name', {
      schema: {
        tags: ['Procedures'],
        summary: 'Get a procedure by name',
        security: authed,
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { $ref: 'WorkflowGraphWithWarnings#' },
        },
      } as any,
    }, async (req, reply) => {
      const graph = await workflowStore.get(req.params.name, requestOwnerId(req))
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      reply.send(withWarnings(graph))
    })

    app.post<{ Body: { workflow_name: string; description: string; overwrite?: boolean } }>('/procedure', {
      schema: {
        tags: ['Procedures'],
        summary: 'Create a new procedure',
        security: authed,
        body: {
          type: 'object',
          required: ['workflow_name', 'description'],
          properties: {
            workflow_name: { type: 'string', maxLength: PROCEDURE_NAME_MAX_LENGTH },
            description: { type: 'string' },
            overwrite: overwriteProperty,
          },
        },
        response: {
          201: { $ref: 'WorkflowGraphWithWarnings#' },
        },
      } as any,
    }, async (req, reply) => {
      const { workflow_name, description, overwrite } = req.body
      const owner = requestOwnerId(req)
      if (overwrite !== true && await workflowStore.get(workflow_name, owner)) {
        return reply.code(409).send(workflowExistsConflict(workflow_name))
      }
      const graph: WorkflowGraph = {
        name: workflow_name,
        description,
        states: { start: { name: 'start', isTerminal: false } },
        transitions: [],
      }
      await workflowStore.save(graph, owner)
      reply.code(201).send(withWarnings(graph))
    })

    app.put<{
      Params: { name: string }
      Body: { description: string; transitions: TransitionDefinition[]; states?: Record<string, StateDefinition>; overwrite?: boolean }
    }>('/procedure/:name', {
      schema: {
        tags: ['Procedures'],
        summary: 'Define a whole procedure in one call',
        description:
          'Creates (201) or, with overwrite: true, replaces (200) a procedure from its full definition. ' +
          'Transitions are applied in order with the same rules as POST /procedure/:name/transition. ' +
          'The whole graph is validated before anything is saved: on any error the response is 400 and nothing changes. ' +
          'Replacing is refused (409) while any of your sessions is in a state the new definition removes.',
        security: authed,
        params: {
          type: 'object',
          properties: { name: { type: 'string', maxLength: PROCEDURE_NAME_MAX_LENGTH } },
        },
        body: {
          type: 'object',
          required: ['description', 'transitions'],
          properties: {
            description: { type: 'string' },
            transitions: {
              type: 'array',
              maxItems: DEFINITION_LIMITS.maxTransitionStrings,
              items: {
                anyOf: [
                  { type: 'string', maxLength: DEFINITION_LIMITS.maxTransitionLength },
                  {
                    type: 'object',
                    required: ['transition', 'requires'],
                    properties: {
                      transition: { type: 'string', maxLength: DEFINITION_LIMITS.maxTransitionLength, description: 'One transition (not a chain).' },
                      requires: requiresSchema,
                    },
                  },
                ],
              },
              description: 'Transitions applied in order. Each entry is a transition string (chains allowed), e.g. "start -> review", '
                + 'or an object { "transition": "review -approved-> end", "requires": ["pr_url"] } for a single transition that may only be taken '
                + 'once those session-data keys have values.',
            },
            states: {
              type: 'object',
              maxProperties: DEFINITION_LIMITS.maxStates,
              description: 'Optional per-state settings: { "<state>": { "description"?: string, "terminal"?: boolean } }. Every state named here must appear in a transition (or be "start").',
              additionalProperties: {
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  terminal: { type: 'boolean' },
                },
              },
            },
            overwrite: overwriteProperty,
          },
        },
        response: {
          200: { $ref: 'WorkflowGraphWithWarnings#' },
          201: { $ref: 'WorkflowGraphWithWarnings#' },
        },
      } as any,
    }, async (req, reply) => {
      const name = req.params.name
      const { description, transitions, states, overwrite } = req.body
      const owner = requestOwnerId(req)

      let graph: WorkflowGraph
      try {
        graph = buildGraph({ name, description, transitions, states })
      } catch (e: any) {
        return reply.code(400).send({ error: `${e.message} Nothing was saved.`, code: 'BAD_REQUEST' })
      }

      const existing = await workflowStore.get(name, owner)
      if (existing && overwrite !== true) {
        return reply.code(409).send(workflowExistsConflict(name, 'name'))
      }
      if (existing) {
        const stranded = await strandedStates(sessionStore, existing, graph, owner)
        if (stranded.length > 0) {
          return reply.code(409).send({
            error:
              `Cannot replace procedure "${name}": active sessions are in states the new definition removes ` +
              `(${stranded.map(s => `"${s}"`).join(', ')}). Nothing was changed. ` +
              `Keep those states in the definition, or move/delete those sessions first.`,
            code: 'CONFLICT',
            states: stranded,
          })
        }
      }

      await workflowStore.save(graph, owner)
      reply.code(existing ? 200 : 201).send(withWarnings(graph))
    })

    app.post<{ Params: { name: string }; Body: { transition: string } }>(
      '/procedure/:name/transition', {
        schema: {
          tags: ['Procedures'],
          summary: 'Add a transition to a procedure',
          security: authed,
          params: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
          body: {
            type: 'object',
            required: ['transition'],
            properties: { transition: { type: 'string' } },
          },
          response: {
            200: { $ref: 'WorkflowGraphWithWarnings#' },
          },
        } as any,
      }, async (req, reply) => {
        const owner = requestOwnerId(req)
        const graph = await workflowStore.get(req.params.name, owner)
        if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
        try {
          const updated = addTransition(graph, req.body.transition)
          await workflowStore.save(updated, owner)
          reply.send(withWarnings(updated))
        } catch (e: any) {
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.put<{ Params: { name: string }; Body: { transition: string; requires: string[] } }>(
      '/procedure/:name/transition/requires', {
        schema: {
          tags: ['Procedures'],
          summary: 'Set the session data a transition requires',
          description: 'Sets the session-data keys that must have a value before the named existing transition can be taken; an empty array '
            + 'clears the requirement. `transition` names one transition exactly as it was added (no chains); 400 if no such transition exists.',
          security: authed,
          params: nameParams,
          body: {
            type: 'object',
            required: ['transition', 'requires'],
            properties: {
              transition: { type: 'string', description: 'One existing transition, e.g. "review -approved-> merged".' },
              requires: requiresSchema,
            },
          },
          response: {
            200: { $ref: 'WorkflowGraphWithWarnings#' },
          },
        } as any,
      }, async (req, reply) => {
        const owner = requestOwnerId(req)
        const graph = await workflowStore.get(req.params.name, owner)
        if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
        let updated: WorkflowGraph
        try {
          updated = setTransitionRequires(graph, req.body.transition, req.body.requires)
        } catch (e: any) {
          return reply.code(400).send({ error: `${e.message} Nothing was changed.`, code: 'BAD_REQUEST' })
        }
        await workflowStore.save(updated, owner)
        reply.send(withWarnings(updated))
      }
    )

    app.get<{ Params: { name: string } }>('/procedure/:name/stats', {
      schema: {
        tags: ['Procedures'],
        summary: 'Per-state statistics of a procedure\'s sessions',
        description: `Aggregates the event logs of your sessions of this procedure (the newest ${STATS_MAX_SESSIONS}; \`truncated\` says whether there were more): `
          + 'how often each state was entered, where sessions left to (by action), resets away from it and the mean time spent in it. '
          + 'Use it to find the step where runs stall or backtrack. Sessions created before the event log existed count in the totals, '
          + '`currentlyHere` and (from their history) `entered`, but not in exits or dwell times.',
        security: authed,
        params: nameParams,
        response: { 200: statsResponse },
      } as any,
    }, async (req, reply) => {
      const graph = await workflowStore.get(req.params.name, requestOwnerId(req))
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      const ownerIds = await sessionOwnerIdsForListing(req, apiKeyStore)
      const sessions = await sessionStore.list(ownerIds, { workflowName: req.params.name, limit: STATS_MAX_SESSIONS + 1 })
      const truncated = sessions.length > STATS_MAX_SESSIONS
      reply.send(computeProcedureStats(graph.name, graph, sessions.slice(0, STATS_MAX_SESSIONS), truncated))
    })

    app.delete<{ Params: { name: string }; Body: { transition: string } }>(
      '/procedure/:name/transition', {
        schema: {
          tags: ['Procedures'],
          summary: 'Remove a transition from a procedure',
          security: authed,
          params: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
          body: {
            type: 'object',
            required: ['transition'],
            properties: { transition: { type: 'string' } },
          },
          response: {
            200: { $ref: 'WorkflowGraphWithWarnings#' },
          },
        } as any,
      }, async (req, reply) => {
        const owner = requestOwnerId(req)
        const graph = await workflowStore.get(req.params.name, owner)
        if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
        try {
          const updated = removeTransition(graph, req.body.transition)
          await workflowStore.save(updated, owner)
          reply.send(withWarnings(updated))
        } catch (e: any) {
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.delete<{ Params: { name: string; state: string } }>(
      '/procedure/:name/state/:state', {
        schema: {
          tags: ['Procedures'],
          summary: 'Remove a state from a procedure',
          security: authed,
          params: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              state: { type: 'string' },
            },
          },
          response: {
            200: { $ref: 'WorkflowGraphWithWarnings#' },
          },
        } as any,
      }, async (req, reply) => {
        const owner = requestOwnerId(req)
        const graph = await workflowStore.get(req.params.name, owner)
        if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
        // findByState is not owner-scoped: only this owner's sessions block removal
        const active = (await sessionStore.findByState(req.params.name, req.params.state))
          .filter(s => s.workflowOwnerId === owner && !s.pinnedGraph)
        if (active.length > 0) {
          return reply.code(409).send({ error: 'Active sessions exist in this state', code: 'CONFLICT' })
        }
        try {
          const updated = removeState(graph, req.params.state)
          await workflowStore.save(updated, owner)
          reply.send(withWarnings(updated))
        } catch (e: any) {
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.patch<{ Params: { name: string; state: string }; Body: { description: string } }>(
      '/procedure/:name/state/:state', {
        schema: {
          tags: ['Procedures'],
          summary: 'Update the description of a state',
          security: authed,
          params: {
            type: 'object',
            properties: { name: { type: 'string' }, state: { type: 'string' } },
          },
          body: {
            type: 'object',
            required: ['description'],
            properties: { description: { type: 'string' } },
          },
          response: { 200: { $ref: 'WorkflowGraph#' } },
        } as any,
      }, async (req, reply) => {
        const owner = requestOwnerId(req)
        const graph = await workflowStore.get(req.params.name, owner)
        if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
        if (!hasState(graph, req.params.state)) {
          return reply.code(404).send({ error: `State "${req.params.state}" does not exist`, code: 'NOT_FOUND' })
        }
        const updated = {
          ...graph,
          states: {
            ...graph.states,
            [req.params.state]: { ...graph.states[req.params.state], description: req.body.description },
          },
        }
        await workflowStore.save(updated, owner)
        reply.send(updated)
      }
    )

    app.post<{ Params: { name: string; state: string } }>(
      '/procedure/:name/state/:state/terminal', {
        schema: {
          tags: ['Procedures'],
          summary: 'Mark a state as terminal (no further advances allowed)',
          security: authed,
          params: {
            type: 'object',
            properties: { name: { type: 'string' }, state: { type: 'string' } },
          },
          response: { 200: { $ref: 'WorkflowGraphWithWarnings#' } },
        } as any,
      }, async (req, reply) => {
        const owner = requestOwnerId(req)
        const graph = await workflowStore.get(req.params.name, owner)
        if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
        try {
          const updated = markStateTerminal(graph, req.params.state)
          await workflowStore.save(updated, owner)
          reply.send(withWarnings(updated))
        } catch (e: any) {
          reply.code(400).send({ error: e.message, code: 'BAD_REQUEST' })
        }
      }
    )

    app.get<{ Params: { name: string } }>('/procedure/:name/states', {
      schema: {
        tags: ['Procedures'],
        summary: 'List all states in a procedure',
        security: authed,
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: { $ref: 'State#' } },
        },
      } as any,
    }, async (req, reply) => {
      const graph = await workflowStore.get(req.params.name, requestOwnerId(req))
      if (!graph) return reply.code(404).send({ error: 'Workflow not found', code: 'NOT_FOUND' })
      reply.send(Object.values(graph.states))
    })
  }
}
