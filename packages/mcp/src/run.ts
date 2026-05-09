import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore } from '@eliph/core'
import { buildMcpServer } from './index'

const stores = {
  workflowStore: new InMemoryWorkflowStore(),
  sessionStore: new InMemorySessionStore(),
  apiKeyStore: new InMemoryApiKeyStore(),
}

buildMcpServer(stores).start().catch((err) => {
  console.error(err)
  process.exit(1)
})
