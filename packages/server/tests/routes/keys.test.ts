import { buildApp } from '../../src/app'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore } from '@eliph/core'

function makeStores() {
  return {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore: new InMemoryApiKeyStore(),
  }
}

describe('auth middleware', () => {
  it('allows POST /keys without a token', async () => {
    const app = buildApp(makeStores())
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/keys', body: { label: 'test' } })
    expect(res.statusCode).not.toBe(401)
  })

  it('rejects requests without Authorization header', async () => {
    const app = buildApp(makeStores())
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/procedures' })
    expect(res.statusCode).toBe(401)
  })

  it('rejects requests with invalid key', async () => {
    const app = buildApp(makeStores())
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/procedures',
      headers: { authorization: 'Bearer bad-key' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('allows requests with valid key', async () => {
    const stores = makeStores()
    const { rawKey } = await stores.apiKeyStore.create('test')
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/procedures',
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(res.statusCode).not.toBe(401)
  })
})
