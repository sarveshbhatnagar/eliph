import { ApiClient } from '../client'
import { workflowQuery } from './sessions'

/** Request body with `workflow` only when a workflow name was supplied. */
function withWorkflow<T extends object>(workflowName: string | undefined, body: T): T & { workflow?: string } {
  return workflowName ? { workflow: workflowName, ...body } : body
}

export function makeAdvanceTools(client: ApiClient) {
  return {
    advance: async (args: { workflow_name?: string; session_id: string; completed_action?: string }) =>
      client.request('POST', `/session/${args.session_id}/advance`, withWorkflow(args.workflow_name, {
        completed_action: args.completed_action,
      })),

    reset_state: async (args: { workflow_name?: string; session_id: string; target_state?: string }) =>
      client.request('POST', `/session/${args.session_id}/reset`, withWorkflow(args.workflow_name, {
        target_state: args.target_state,
      })),

    requirements: async (args: { workflow_name?: string; session_id: string }) =>
      client.request('GET', `/session/${args.session_id}/requirements${workflowQuery(args.workflow_name)}`),
  }
}
