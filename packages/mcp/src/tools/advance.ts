import { ApiClient } from '../client'
import { workflowQuery } from './sessions'

/** Request body with `workflow` only when a workflow name was supplied. */
function withWorkflow<T extends object>(workflowName: string | undefined, body: T): T & { workflow?: string } {
  return workflowName ? { workflow: workflowName, ...body } : body
}

/** `data` and `note` only when supplied, so older request bodies are unchanged. */
function withExtras(args: { data?: Record<string, unknown>; note?: string }): { data?: Record<string, unknown>; note?: string } {
  const extras: { data?: Record<string, unknown>; note?: string } = {}
  if (args.data !== undefined) extras.data = args.data
  if (args.note !== undefined) extras.note = args.note
  return extras
}

export function makeAdvanceTools(client: ApiClient) {
  return {
    advance: async (args: { workflow_name?: string; session_id: string; completed_action?: string; data?: Record<string, unknown>; note?: string }) =>
      client.request('POST', `/session/${encodeURIComponent(args.session_id)}/advance`, withWorkflow(args.workflow_name, {
        completed_action: args.completed_action,
        ...withExtras(args),
      })),

    reset_state: async (args: { workflow_name?: string; session_id: string; target_state?: string; data?: Record<string, unknown>; note?: string }) =>
      client.request('POST', `/session/${encodeURIComponent(args.session_id)}/reset`, withWorkflow(args.workflow_name, {
        target_state: args.target_state,
        ...withExtras(args),
      })),

    requirements: async (args: { workflow_name?: string; session_id: string }) =>
      client.request('GET', `/session/${encodeURIComponent(args.session_id)}/requirements${workflowQuery(args.workflow_name)}`),
  }
}
