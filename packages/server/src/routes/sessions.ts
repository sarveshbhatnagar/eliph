import { FastifyInstance } from 'fastify'
import { IWorkflowStore, ISessionStore } from '@eliph/core'

export function sessionsRoutes(_ws: IWorkflowStore, _ss: ISessionStore) {
  return async (_app: FastifyInstance) => {}
}
