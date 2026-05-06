import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore } from '@eliph/core'
import { buildApp } from './app'

const stores = {
  workflowStore: new InMemoryWorkflowStore(),
  sessionStore: new InMemorySessionStore(),
  apiKeyStore: new InMemoryApiKeyStore(),
}

const app = buildApp(stores)

app.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1) }
  console.log(`Eliph server listening at ${address}`)
})
