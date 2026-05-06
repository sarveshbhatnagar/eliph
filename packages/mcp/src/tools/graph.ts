import { IWorkflowStore, addTransition, removeTransition, removeState } from '@eliph/core'

export function makeGraphTools(workflowStore: IWorkflowStore) {
  return {
    add_transition: async (args: { workflow_name: string; transition: string }) => {
      const graph = await workflowStore.get(args.workflow_name)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      const updated = addTransition(graph, args.transition)
      await workflowStore.save(updated)
      return updated
    },
    remove_transition: async (args: { workflow_name: string; transition: string }) => {
      const graph = await workflowStore.get(args.workflow_name)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      const updated = removeTransition(graph, args.transition)
      await workflowStore.save(updated)
      return updated
    },
    remove_state: async (args: { workflow_name: string; state_name: string }) => {
      const graph = await workflowStore.get(args.workflow_name)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      const updated = removeState(graph, args.state_name)
      await workflowStore.save(updated)
      return updated
    },
    list_states: async (args: { workflow_name: string }) => {
      const graph = await workflowStore.get(args.workflow_name)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      return Object.values(graph.states)
    },
  }
}
