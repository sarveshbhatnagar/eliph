import { ApiClient } from '../client'

export function makeAdvanceTools(client: ApiClient) {
  return {
    advance: async (args: { workflow_name: string; session_id: string; completed_action?: string }) =>
      client.request('POST', `/session/${args.session_id}/advance`, {
        workflow: args.workflow_name,
        completed_action: args.completed_action,
      }),

    reset_state: async (args: { workflow_name: string; session_id: string; target_state?: string }) =>
      client.request('POST', `/session/${args.session_id}/reset`, {
        workflow: args.workflow_name,
        target_state: args.target_state,
      }),

    requirements: async (args: { workflow_name: string; session_id: string }) =>
      client.request('GET', `/session/${args.session_id}/requirements?workflow=${encodeURIComponent(args.workflow_name)}`),
  }
}
