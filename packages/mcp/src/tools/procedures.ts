import { IWorkflowStore, WorkflowGraph } from '@eliph/core'

export function makeProcedureTools(workflowStore: IWorkflowStore) {
  return {
    procedures: async (args: { search_query?: string }) => {
      return await workflowStore.search(args.search_query ?? '')
    },
    procedure: async (args: { workflow_name: string }) => {
      const graph = await workflowStore.get(args.workflow_name)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      return graph
    },
    create_procedure: async (args: { workflow_name: string; description: string }) => {
      const graph: WorkflowGraph = {
        name: args.workflow_name,
        description: args.description,
        states: { start: { name: 'start', isTerminal: false } },
        transitions: [],
      }
      await workflowStore.save(graph)
      return graph
    },
  }
}
