import { buildApp } from '../../src/app'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore, InMemoryOrgKeyStore, InMemoryUsageStore } from '@eliph/core'

function makeStores() {
  const orgKeyStore = new InMemoryOrgKeyStore()
  const apiKeyStore = new InMemoryApiKeyStore(orgKeyStore)
  return {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore,
    orgKeyStore,
    usageStore: new InMemoryUsageStore(),
  }
}

const ADMIN = 'test-admin-secret'

describe('auth middleware', () => {
  it('allows GET /health without any token', async () => {
    const app = buildApp(makeStores())
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
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
      method: 'GET', url: '/procedures',
      headers: { authorization: 'Bearer bad-key' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('allows API key to access procedures', async () => {
    const stores = makeStores()
    const { record: org } = await stores.orgKeyStore.create('test-org', 10)
    const { rawKey } = await stores.apiKeyStore.create('test-key', org.id)
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'GET', url: '/procedures',
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(res.statusCode).not.toBe(401)
  })

  it('allows admin secret to access procedures', async () => {
    process.env.ADMIN_SECRET = ADMIN
    const app = buildApp(makeStores())
    await app.ready()
    const res = await app.inject({
      method: 'GET', url: '/procedures',
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    expect(res.statusCode).not.toBe(401)
    delete process.env.ADMIN_SECRET
  })
})

describe('POST /keys', () => {
  it('creates a key with a valid org key', async () => {
    const stores = makeStores()
    const { rawKey: orgRawKey } = await stores.orgKeyStore.create('test-org', 10)
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'POST', url: '/keys',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orgRawKey}` },
      body: JSON.stringify({ label: 'my-key' }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.rawKey).toBeDefined()
    expect(body.id).toBeDefined()
    expect(body.label).toBe('my-key')
    expect(body.orgKeyId).toBeDefined()
  })

  it('rejects POST /keys without org key', async () => {
    const stores = makeStores()
    const { record: org } = await stores.orgKeyStore.create('test-org', 10)
    const { rawKey: apiRawKey } = await stores.apiKeyStore.create('test-key', org.id)
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'POST', url: '/keys',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiRawKey}` },
      body: JSON.stringify({ label: 'another-key' }),
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects POST /keys when key limit is reached', async () => {
    const stores = makeStores()
    const { rawKey: orgRawKey, record: org } = await stores.orgKeyStore.create('test-org', 1)
    await stores.apiKeyStore.create('existing-key', org.id)
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'POST', url: '/keys',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orgRawKey}` },
      body: JSON.stringify({ label: 'over-limit' }),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('KEY_LIMIT_REACHED')
  })
})

describe('GET /keys', () => {
  it('org key sees only its own keys', async () => {
    const stores = makeStores()
    const { rawKey: orgRawKey, record: org } = await stores.orgKeyStore.create('test-org', 10)
    const { record: org2 } = await stores.orgKeyStore.create('other-org', 10)
    await stores.apiKeyStore.create('mine', org.id)
    await stores.apiKeyStore.create('theirs', org2.id)
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'GET', url: '/keys',
      headers: { authorization: `Bearer ${orgRawKey}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].label).toBe('mine')
    expect(body[0].key).toBeUndefined()
  })

  it('admin sees all keys', async () => {
    process.env.ADMIN_SECRET = ADMIN
    const stores = makeStores()
    const { record: org } = await stores.orgKeyStore.create('test-org', 10)
    await stores.apiKeyStore.create('key-a', org.id)
    await stores.apiKeyStore.create('key-b', org.id)
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'GET', url: '/keys',
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
    delete process.env.ADMIN_SECRET
  })
})

describe('DELETE /keys/:id', () => {
  it('org key can delete its own key', async () => {
    const stores = makeStores()
    const { rawKey: orgRawKey, record: org } = await stores.orgKeyStore.create('test-org', 10)
    const { record } = await stores.apiKeyStore.create('to-delete', org.id)
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'DELETE', url: `/keys/${record.id}`,
      headers: { authorization: `Bearer ${orgRawKey}` },
    })
    expect(res.statusCode).toBe(204)
  })

  it('org key cannot delete another org\'s key', async () => {
    const stores = makeStores()
    const { rawKey: orgRawKey } = await stores.orgKeyStore.create('test-org', 10)
    const { record: org2 } = await stores.orgKeyStore.create('other-org', 10)
    const { record } = await stores.apiKeyStore.create('their-key', org2.id)
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'DELETE', url: `/keys/${record.id}`,
      headers: { authorization: `Bearer ${orgRawKey}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
