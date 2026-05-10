import { ApiClient } from '../client'

export function makeSessionTools(client: ApiClient) {
  return {
    create_session: async (args: { workflow_name: string }) =>
      client.request('POST', '/session', { workflow: args.workflow_name }),

    delete_session: async (args: { session_id: string }) => {
      await client.request('DELETE', `/session/${args.session_id}`)
      return { deleted: true }
    },

    current_state: async (args: { session_id: string; workflow_name: string }) =>
      client.request('GET', `/session/${args.session_id}/state?workflow=${encodeURIComponent(args.workflow_name)}`),

    next_transitions: async (args: { session_id: string; workflow_name: string }) => {
      const transitions: any[] = await client.request('GET', `/session/${args.session_id}/next?workflow=${encodeURIComponent(args.workflow_name)}`)
      return transitions.map(t => ({
        ...t,
        advance_with: t.type === 'symbolic'
          ? { completed_action: t.action }
          : t.type === 'deterministic'
          ? 'call advance() with no completed_action'
          : 'call advance() with no completed_action (probabilistic — result is random)',
      }))
    },
  }
}
