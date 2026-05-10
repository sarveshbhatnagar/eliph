import { ApiClient } from '../client'

export function makeProcedureTools(client: ApiClient) {
  return {
    procedures: async (args: { search_query?: string }) =>
      client.request('GET', `/procedures?q=${encodeURIComponent(args.search_query ?? '')}`),

    procedure: async (args: { workflow_name: string }) =>
      client.request('GET', `/procedure/${encodeURIComponent(args.workflow_name)}`),

    create_procedure: async (args: { workflow_name: string; description: string }) =>
      client.request('POST', '/procedure', { workflow_name: args.workflow_name, description: args.description }),
  }
}
