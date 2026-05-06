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

describe('POST /keys', () => {
  it('creates a key and returns the raw key once', async () => {
    const app = buildApp(makeStores())
    await app.ready()
    const res = await app.inject({
      method: 'POST', url: '/keys',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'my-key' }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.rawKey).toBeDefined()
    expect(body.id).toBeDefined()
    expect(body.label).toBe('my-key')
  })
})

describe('GET /keys', () => {
  it('lists keys without exposing hashes', async () => {
    const stores = makeStores()
    const { rawKey } = await stores.apiKeyStore.create('existing')
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'GET', url: '/keys',
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].key).toBeUndefined()
  })
})

describe('DELETE /keys/:id', () => {
  it('deletes a key by id', async () => {
    const stores = makeStores()
    const { rawKey, record } = await stores.apiKeyStore.create('to-delete')
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'DELETE', url: `/keys/${record.id}`,
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(res.statusCode).toBe(204)
  })
})
