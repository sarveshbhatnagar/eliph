import { IWorkflowStore, ISessionStore, Session, getNextTransitions } from '@eliph/core'
import { randomUUID } from 'crypto'

export function makeSessionTools(workflowStore: IWorkflowStore, sessionStore: ISessionStore) {
  return {
    create_session: async (args: { workflow_name: string }) => {
      const graph = await workflowStore.get(args.workflow_name)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      const session: Session = {
        id: randomUUID(),
        workflowName: args.workflow_name,
        currentState: 'start',
        history: ['start'],
        createdAt: new Date(),
      }
      await sessionStore.save(session)
      return session
    },
    delete_session: async (args: { session_id: string }) => {
      await sessionStore.delete(args.session_id)
      return { deleted: true }
    },
    current_state: async (args: { session_id: string }) => {
      const session = await sessionStore.get(args.session_id)
      if (!session) throw new Error(`Session "${args.session_id}" not found`)
      return { currentState: session.currentState, history: session.history }
    },
    next_transitions: async (args: { workflow_name: string; session_id: string }) => {
      const [session, graph] = await Promise.all([
        sessionStore.get(args.session_id),
        workflowStore.get(args.workflow_name),
      ])
      if (!session) throw new Error(`Session "${args.session_id}" not found`)
      if (!graph) throw new Error(`Workflow "${args.workflow_name}" not found`)
      return getNextTransitions(graph, session.currentState)
    },
  }
}
