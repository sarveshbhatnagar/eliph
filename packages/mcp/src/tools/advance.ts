import { ApiClient } from '../client'
import { workflowQuery } from './sessions'

/** Request body with `workflow` only when a workflow name was supplied. */
function withWorkflow<T extends object>(workflowName: string | undefined, body: T): T & { workflow?: string } {
  return workflowName ? { workflow: workflowName, ...body } : body
}

interface Extras { data?: Record<string, unknown>; note?: string; expected_state?: string; actor?: string }

/**
 * `data`, `note`, `expected_state` and `actor` only when supplied, so older request bodies are unchanged.
 * A null or empty expected_state/actor counts as not supplied: callers that fill unused fields mean "none".
 */
function withExtras(args: Extras): Extras {
  const extras: Extras = {}
  if (args.data !== undefined) extras.data = args.data
  if (args.note !== undefined) extras.note = args.note
  if (args.expected_state) extras.expected_state = args.expected_state
  if (args.actor) extras.actor = args.actor
  return extras
}

export function makeAdvanceTools(client: ApiClient) {
  return {
    advance: async (args: { workflow_name?: string; session_id: string; completed_action?: string } & Extras) =>
      client.request('POST', `/session/${encodeURIComponent(args.session_id)}/advance`, withWorkflow(args.workflow_name, {
        completed_action: args.completed_action,
        ...withExtras(args),
      })),

    reset_state: async (args: { workflow_name?: string; session_id: string; target_state?: string } & Extras) =>
      client.request('POST', `/session/${encodeURIComponent(args.session_id)}/reset`, withWorkflow(args.workflow_name, {
        target_state: args.target_state,
        ...withExtras(args),
      })),

    requirements: async (args: { workflow_name?: string; session_id: string }) =>
      client.request('GET', `/session/${encodeURIComponent(args.session_id)}/requirements${workflowQuery(args.workflow_name)}`),
  }
}
