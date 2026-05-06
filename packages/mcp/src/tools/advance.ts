import { IWorkflowStore, ISessionStore, computeNextState, applyAdvance, applyReset, requirements } from '@eliph/core'

export function makeAdvanceTools(workflowStore: IWorkflowStore, sessionStore: ISessionStore) {
  return {
    advance: async (args: { workflow_name: string; session_id: string; completed_action?: string }) => {
      const [session, graph] = await Promise.all([
        sessionStore.get(args.session_id),
        workflowStore.get(args.workflow_name),
      ])
      if (!session) throw new Error(`Session "${args.session_id}" not found`)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      const newState = computeNextState(graph, session, args.completed_action)
      const updated = applyAdvance(session, newState)
      await sessionStore.save(updated)
      return updated
    },
    reset_state: async (args: { workflow_name: string; session_id: string; target_state?: string }) => {
      const [session, graph] = await Promise.all([
        sessionStore.get(args.session_id),
        workflowStore.get(args.workflow_name),
      ])
      if (!session) throw new Error(`Session "${args.session_id}" not found`)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      const target = args.target_state ?? 'start'
      if (!graph.states[target]) throw new Error(`State "${target}" does not exist`)
      const updated = applyReset(session, target)
      await sessionStore.save(updated)
      return updated
    },
    requirements: async (args: { workflow_name: string; session_id: string }) => {
      const [session, graph] = await Promise.all([
        sessionStore.get(args.session_id),
        workflowStore.get(args.workflow_name),
      ])
      if (!session) throw new Error(`Session "${args.session_id}" not found`)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      return requirements(graph, session.currentState)
    },
  }
}
