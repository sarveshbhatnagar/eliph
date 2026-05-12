export { SqliteWorkflowStore } from './workflow'
export { SqliteSessionStore } from './session'
export { SqliteApiKeyStore } from './apikey'
export { SqliteOrgKeyStore } from './orgkey'
export { SqliteUsageStore } from './usage'

import { openDb } from './db'
import { SqliteWorkflowStore } from './workflow'
import { SqliteSessionStore } from './session'
import { SqliteApiKeyStore } from './apikey'
import { SqliteOrgKeyStore } from './orgkey'
import { SqliteUsageStore } from './usage'

export function createStores(dbPath: string) {
  const db = openDb(dbPath)
  return {
    workflowStore: new SqliteWorkflowStore(db),
    sessionStore: new SqliteSessionStore(db),
    apiKeyStore: new SqliteApiKeyStore(db),
    orgKeyStore: new SqliteOrgKeyStore(db),
    usageStore: new SqliteUsageStore(db),
  }
}
