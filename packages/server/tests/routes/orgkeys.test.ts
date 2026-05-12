import { buildApp } from '../../src/app'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore, InMemoryOrgKeyStore, InMemoryUsageStore } from '@eliph/core'

const ADMIN = 'test-admin-secret'

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

beforeEach(() => { process.env.ADMIN_SECRET = ADMIN })
afterEach(() => { delete process.env.ADMIN_SECRET })

describe('POST /admin/org-keys', () => {
  it('admin can create an org key', async () => {
    const app = buildApp(makeStores())
    await app.ready()
    const res = await app.inject({
      method: 'POST', url: '/admin/org-keys',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ label: 'amazon', keyLimit: 500 }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.rawKey).toBeDefined()
    expect(body.label).toBe('amazon')
    expect(body.keyLimit).toBe(500)
  })

  it('non-admin cannot create an org key', async () => {
    const stores = makeStores()
    const { rawKey: orgRawKey, record: org } = await stores.orgKeyStore.create('some-org', 10)
    const { rawKey: apiRawKey } = await stores.apiKeyStore.create('key', org.id)
    const app = buildApp(stores)
    await app.ready()

    for (const token of [orgRawKey, apiRawKey, 'bad-token']) {
      const res = await app.inject({
        method: 'POST', url: '/admin/org-keys',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ label: 'hacker', keyLimit: 9999 }),
      })
      expect(res.statusCode).toBeGreaterThanOrEqual(400)
    }
  })
})

describe('GET /admin/org-keys', () => {
  it('admin can list org keys with key counts', async () => {
    const stores = makeStores()
    const { record: org } = await stores.orgKeyStore.create('amazon', 500)
    await stores.apiKeyStore.create('api-key-1', org.id)
    await stores.apiKeyStore.create('api-key-2', org.id)
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'GET', url: '/admin/org-keys',
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].label).toBe('amazon')
    expect(body[0].keyLimit).toBe(500)
    expect(body[0].keyCount).toBe(2)
  })
})

describe('DELETE /admin/org-keys/:id', () => {
  it('admin can revoke an org key', async () => {
    const stores = makeStores()
    const { record } = await stores.orgKeyStore.create('amazon', 500)
    const app = buildApp(stores)
    await app.ready()
    const res = await app.inject({
      method: 'DELETE', url: `/admin/org-keys/${record.id}`,
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    expect(res.statusCode).toBe(204)
    expect(await stores.orgKeyStore.list()).toHaveLength(0)
  })
})
