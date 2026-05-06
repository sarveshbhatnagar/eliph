import { FastifyInstance } from 'fastify'
import { IApiKeyStore } from '@eliph/core'

export function keysRoutes(_store: IApiKeyStore) {
  return async (_app: FastifyInstance) => {}
}
