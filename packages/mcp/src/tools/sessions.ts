import { ApiClient } from '../client'

/** `?workflow=...` when a workflow name was supplied, otherwise '' (the API uses the session's own workflow). */
export function workflowQuery(workflowName?: string): string {
  return workflowName ? `?workflow=${encodeURIComponent(workflowName)}` : ''
}

export function makeSessionTools(client: ApiClient) {
  return {
    create_session: async (args: { workflow_name: string; data?: Record<string, unknown>; pin?: boolean }) => {
      // Optional fields only when supplied, so older request bodies are unchanged
      const body: { workflow: string; data?: Record<string, unknown>; pin?: boolean } = { workflow: args.workflow_name }
      if (args.data !== undefined) body.data = args.data
      if (args.pin !== undefined) body.pin = args.pin
      return client.request('POST', '/session', body)
    },

    update_session_data: async (args: { session_id: string; data: Record<string, unknown> }) =>
      client.request('PATCH', `/session/${encodeURIComponent(args.session_id)}/data`, { data: args.data }),

    list_sessions: async (args: { workflow_name?: string; active?: boolean; limit?: number } = {}) => {
      const params = new URLSearchParams()
      if (args.workflow_name) params.set('workflow', args.workflow_name)
      if (args.active !== undefined) params.set('active', String(args.active))
      if (args.limit !== undefined) params.set('limit', String(args.limit))
      const qs = params.toString()
      return client.request('GET', `/sessions${qs ? `?${qs}` : ''}`)
    },

    delete_session: async (args: { session_id: string }) => {
      await client.request('DELETE', `/session/${encodeURIComponent(args.session_id)}`)
      return { deleted: true }
    },

    current_state: async (args: { session_id: string; workflow_name?: string }) =>
      client.request('GET', `/session/${encodeURIComponent(args.session_id)}/state${workflowQuery(args.workflow_name)}`),

    next_transitions: async (args: { session_id: string; workflow_name?: string }) => {
      const transitions: any[] = await client.request('GET', `/session/${encodeURIComponent(args.session_id)}/next${workflowQuery(args.workflow_name)}`)
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
