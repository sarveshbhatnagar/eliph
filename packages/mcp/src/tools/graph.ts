import { ApiClient } from '../client'

export function makeGraphTools(client: ApiClient) {
  return {
    add_transition: async (args: { workflow_name: string; transition: string }) =>
      client.request('POST', `/procedure/${encodeURIComponent(args.workflow_name)}/transition`, { transition: args.transition }),

    remove_transition: async (args: { workflow_name: string; transition: string }) =>
      client.request('DELETE', `/procedure/${encodeURIComponent(args.workflow_name)}/transition`, { transition: args.transition }),

    remove_state: async (args: { workflow_name: string; state_name: string }) =>
      client.request('DELETE', `/procedure/${encodeURIComponent(args.workflow_name)}/state/${encodeURIComponent(args.state_name)}`),

    list_states: async (args: { workflow_name: string }) =>
      client.request('GET', `/procedure/${encodeURIComponent(args.workflow_name)}/states`),

    mark_terminal: async (args: { workflow_name: string; state_name: string }) =>
      client.request('POST', `/procedure/${encodeURIComponent(args.workflow_name)}/state/${encodeURIComponent(args.state_name)}/terminal`),
  }
}
