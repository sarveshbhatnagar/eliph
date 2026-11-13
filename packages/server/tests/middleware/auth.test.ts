import jwt from 'jsonwebtoken'
import { buildApp } from '../../src/app'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore, InMemoryOrgKeyStore, InMemoryUsageStore } from '@eliph/core'

const JWT_SECRET = 'test-jwt-secret'

async function makeApp() {
  const orgKeyStore = new InMemoryOrgKeyStore()
  const apiKeyStore = new InMemoryApiKeyStore(orgKeyStore)
  const { record: org, rawKey: orgRawKey } = await orgKeyStore.create('test-org', 100)
  const stores = {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore,
    orgKeyStore,
    usageStore: new InMemoryUsageStore(),
  }
  const { rawKey, record: key } = await apiKeyStore.create('test', org.id)
  await stores.workflowStore.save({ name: 'flow', description: 'd', states: { start: { name: 'start', isTerminal: false } }, transitions: [] }, org.id)
  const app = buildApp(stores)
  await app.ready()
  return { app, stores, org, orgRawKey, rawKey, key }
}

describe('auth middleware', () => {
  let prev: string | undefined
  beforeEach(() => { prev = process.env.JWT_SECRET; process.env.JWT_SECRET = JWT_SECRET })
  afterEach(() => {
    if (prev === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = prev
  })

  it('accepts a JWT for an existing API key, scoped to its org', async () => {
    const { app, key } = await makeApp()
    const token = jwt.sign({ apiKeyId: key.id }, JWT_SECRET)
    const res = await app.inject({ method: 'GET', url: '/procedure/flow', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(200)
  })

  it('rejects a valid JWT whose API key was deleted with 401', async () => {
    const { app, stores, key } = await makeApp()
    const token = jwt.sign({ apiKeyId: key.id }, JWT_SECRET)
    await stores.apiKeyStore.delete(key.id)
    const res = await app.inject({ method: 'GET', url: '/procedures', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('UNAUTHORIZED')
  })

  it('verifies the JWT before scanning org keys', async () => {
    const { app, stores, key } = await makeApp()
    const findSpy = jest.spyOn(stores.orgKeyStore, 'find')
    const token = jwt.sign({ apiKeyId: key.id }, JWT_SECRET)
    const res = await app.inject({ method: 'GET', url: '/procedures', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(200)
    expect(findSpy).not.toHaveBeenCalled()
  })

  it('still accepts org keys and raw API keys', async () => {
    const { app, orgRawKey, rawKey } = await makeApp()
    const orgRes = await app.inject({ method: 'GET', url: '/procedure/flow', headers: { authorization: `Bearer ${orgRawKey}` } })
    expect(orgRes.statusCode).toBe(200)
    const keyRes = await app.inject({ method: 'GET', url: '/procedure/flow', headers: { authorization: `Bearer ${rawKey}` } })
    expect(keyRes.statusCode).toBe(200)
  })

  it('rejects a JWT signed with the wrong secret', async () => {
    const { app, key } = await makeApp()
    const token = jwt.sign({ apiKeyId: key.id }, 'wrong-secret')
    const res = await app.inject({ method: 'GET', url: '/procedures', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(401)
  })
})
