export { SqliteWorkflowStore } from './workflow'
export { SqliteSessionStore } from './session'
export { SqliteApiKeyStore } from './apikey'

import { openDb } from './db'
import { SqliteWorkflowStore } from './workflow'
import { SqliteSessionStore } from './session'
import { SqliteApiKeyStore } from './apikey'

export function createStores(dbPath: string) {
  const db = openDb(dbPath)
  return {
    workflowStore: new SqliteWorkflowStore(db),
    sessionStore: new SqliteSessionStore(db),
    apiKeyStore: new SqliteApiKeyStore(db),
  }
}
