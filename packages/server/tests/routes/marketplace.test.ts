import { buildApp } from '../../src/app'
import { MARKETPLACE_OWNER_ID } from '../../src/middleware/auth'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore, InMemoryOrgKeyStore, InMemoryUsageStore, WorkflowGraph } from '@eliph/core'

const ADMIN = 'test-admin-secret'

const template: WorkflowGraph = {
  name: 'tpl',
  description: 'template',
  states: {
    start: { name: 'start', isTerminal: false },
    end: { name: 'end', isTerminal: true },
  },
  transitions: [{ from: 'start', to: 'end', type: 'deterministic' }],
}

const existing: WorkflowGraph = {
  name: 'tpl',
  description: 'mine',
  states: {
    start: { name: 'start', isTerminal: false },
    work: { name: 'work', isTerminal: false },
    end: { name: 'end', isTerminal: true },
  },
  transitions: [
    { from: 'start', to: 'work', type: 'deterministic' },
    { from: 'work', to: 'end', type: 'deterministic' },
  ],
}

let prevAdmin: string | undefined
beforeEach(() => {
  prevAdmin = process.env.ADMIN_SECRET
  process.env.ADMIN_SECRET = ADMIN
})
afterEach(() => {
  if (prevAdmin === undefined) delete process.env.ADMIN_SECRET
  else process.env.ADMIN_SECRET = prevAdmin
})

async function setup() {
  const orgKeyStore = new InMemoryOrgKeyStore()
  const apiKeyStore = new InMemoryApiKeyStore(orgKeyStore)
  const { record: org } = await orgKeyStore.create('test-org', 100)
  const stores = {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore,
    orgKeyStore,
    usageStore: new InMemoryUsageStore(),
  }
  const { rawKey, record: key } = await apiKeyStore.create('test', org.id)
  await stores.workflowStore.save(template, MARKETPLACE_OWNER_ID)
  const app = buildApp(stores)
  await app.ready()
  return { app, stores, rawKey, orgId: org.id, keyId: key.id }
}

function json(token: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

describe('POST /marketplace/:name/copy', () => {
  it('copies into an unused name', async () => {
    const { app, stores, rawKey, orgId } = await setup()
    const res = await app.inject({ method: 'POST', url: '/marketplace/tpl/copy', headers: json(rawKey), body: '{}' })
    expect(res.statusCode).toBe(201)
    expect((await stores.workflowStore.get('tpl', orgId))!.description).toBe('template')
  })

  it('returns 409 instead of overwriting an existing procedure', async () => {
    const { app, stores, rawKey, orgId } = await setup()
    await stores.workflowStore.save(existing, orgId)
    const res = await app.inject({ method: 'POST', url: '/marketplace/tpl/copy', headers: json(rawKey), body: '{}' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('CONFLICT')
    expect(res.json().error).toContain('overwrite: true')
    expect(await stores.workflowStore.get('tpl', orgId)).toEqual(existing)
  })

  it('returns 409 when the chosen workflow_name exists', async () => {
    const { app, stores, rawKey, orgId } = await setup()
    await stores.workflowStore.save({ ...existing, name: 'renamed' }, orgId)
    const res = await app.inject({
      method: 'POST', url: '/marketplace/tpl/copy', headers: json(rawKey),
      body: JSON.stringify({ workflow_name: 'renamed' }),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('"renamed"')
  })

  it('overwrites when overwrite: true', async () => {
    const { app, stores, rawKey, orgId } = await setup()
    await stores.workflowStore.save(existing, orgId)
    const res = await app.inject({
      method: 'POST', url: '/marketplace/tpl/copy', headers: json(rawKey),
      body: JSON.stringify({ overwrite: true }),
    })
    expect(res.statusCode).toBe(201)
    expect((await stores.workflowStore.get('tpl', orgId))!.description).toBe('template')
  })
})

describe('POST /admin/marketplace', () => {
  it('returns 409 when the template name exists and keeps it', async () => {
    const { app, stores } = await setup()
    const res = await app.inject({
      method: 'POST', url: '/admin/marketplace', headers: json(ADMIN),
      body: JSON.stringify({ workflow_name: 'tpl', description: 'new' }),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('CONFLICT')
    expect(await stores.workflowStore.get('tpl', MARKETPLACE_OWNER_ID)).toEqual(template)
  })

  it('creates a new template and overwrites with overwrite: true', async () => {
    const { app, stores } = await setup()
    const created = await app.inject({
      method: 'POST', url: '/admin/marketplace', headers: json(ADMIN),
      body: JSON.stringify({ workflow_name: 'fresh', description: 'new' }),
    })
    expect(created.statusCode).toBe(201)
    const replaced = await app.inject({
      method: 'POST', url: '/admin/marketplace', headers: json(ADMIN),
      body: JSON.stringify({ workflow_name: 'tpl', description: 'replaced', overwrite: true }),
    })
    expect(replaced.statusCode).toBe(201)
    const stored = await stores.workflowStore.get('tpl', MARKETPLACE_OWNER_ID)
    expect(stored!.description).toBe('replaced')
    expect(stored!.transitions).toHaveLength(0)
  })
})

describe('POST /admin/marketplace/:name/publish', () => {
  it('still republishes over an existing template', async () => {
    const { app, stores, orgId } = await setup()
    await stores.workflowStore.save(existing, orgId)
    const res = await app.inject({
      method: 'POST', url: '/admin/marketplace/tpl/publish', headers: json(ADMIN),
      body: JSON.stringify({ source_api_key_id: orgId }),
    })
    expect(res.statusCode).toBe(201)
    expect(await stores.workflowStore.get('tpl', MARKETPLACE_OWNER_ID)).toEqual(existing)
  })
})
