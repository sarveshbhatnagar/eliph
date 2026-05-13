import { ApiClient } from '../client'

export function makeProcedureTools(client: ApiClient) {
  return {
    browse_marketplace: async (args: { search_query?: string }) =>
      client.request('GET', `/marketplace?q=${encodeURIComponent(args.search_query ?? '')}`),

    copy_from_marketplace: async (args: { template_name: string; workflow_name?: string }) =>
      client.request('POST', `/marketplace/${encodeURIComponent(args.template_name)}/copy`,
        args.workflow_name ? { workflow_name: args.workflow_name } : {}),
    procedures: async (args: { search_query?: string }) =>
      client.request('GET', `/procedures?q=${encodeURIComponent(args.search_query ?? '')}`),

    procedure: async (args: { workflow_name: string }) =>
      client.request('GET', `/procedure/${encodeURIComponent(args.workflow_name)}`),

    create_procedure: async (args: { workflow_name: string; description: string }) =>
      client.request('POST', '/procedure', { workflow_name: args.workflow_name, description: args.description }),

    update_description: async (args: { workflow_name: string; description: string }) =>
      client.request('PATCH', `/procedure/${encodeURIComponent(args.workflow_name)}`, { description: args.description }),

    delete_procedure: async (args: { workflow_name: string }) => {
      await client.request('DELETE', `/procedure/${encodeURIComponent(args.workflow_name)}`)
      return { deleted: true }
    },
  }
}
