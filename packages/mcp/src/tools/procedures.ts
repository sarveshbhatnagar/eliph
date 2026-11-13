import { ApiClient } from '../client'

export function makeProcedureTools(client: ApiClient) {
  return {
    browse_marketplace: async (args: { search_query?: string }) =>
      client.request('GET', `/marketplace?q=${encodeURIComponent(args.search_query ?? '')}`),

    copy_from_marketplace: async (args: { template_name: string; workflow_name?: string; overwrite?: boolean }) =>
      client.request('POST', `/marketplace/${encodeURIComponent(args.template_name)}/copy`, {
        ...(args.workflow_name ? { workflow_name: args.workflow_name } : {}),
        ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
      }),

    procedures: async (args: { search_query?: string }) =>
      client.request('GET', `/procedures?q=${encodeURIComponent(args.search_query ?? '')}`),

    procedure: async (args: { workflow_name: string }) =>
      client.request('GET', `/procedure/${encodeURIComponent(args.workflow_name)}`),

    create_procedure: async (args: { workflow_name: string; description: string; overwrite?: boolean }) =>
      client.request('POST', '/procedure', {
        workflow_name: args.workflow_name,
        description: args.description,
        ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
      }),

    define_procedure: async (args: {
      workflow_name: string
      description: string
      transitions: string[]
      states?: Record<string, { description?: string; terminal?: boolean }>
      overwrite?: boolean
    }) =>
      client.request('PUT', `/procedure/${encodeURIComponent(args.workflow_name)}`, {
        description: args.description,
        transitions: args.transitions,
        ...(args.states !== undefined ? { states: args.states } : {}),
        ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
      }),

    update_description: async (args: { workflow_name: string; description: string }) =>
      client.request('PATCH', `/procedure/${encodeURIComponent(args.workflow_name)}`, { description: args.description }),

    delete_procedure: async (args: { workflow_name: string }) => {
      await client.request('DELETE', `/procedure/${encodeURIComponent(args.workflow_name)}`)
      return { deleted: true }
    },
  }
}
