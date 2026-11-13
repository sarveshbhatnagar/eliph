import { buildApp } from '../../src/app'
import { PROCEDURE_NAME_MAX_LENGTH } from '../../src/routes/procedures'
import { generateSpec } from '../../src/docs-builder'
import { createStores } from '@eliph/sqlite'

async function setup() {
  const stores = createStores(':memory:')
  const app = buildApp(stores)
  const org = await stores.orgKeyStore.create('org', 10)
  const { rawKey } = await stores.apiKeyStore.create('k', org.record.id)
  return { app, stores, headers: { authorization: `Bearer ${rawKey}` }, owner: org.record.id }
}

describe('409 CONFLICT is documented on session writes', () => {
  it.each([
    ['/session/{id}/advance', 'post'],
    ['/session/{id}/reset', 'post'],
    ['/session/{id}/data', 'patch'],
  ])('%s %s', async (path, method) => {
    const spec = await generateSpec() as any
    const op = spec.paths[path][method]
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['200', '409']))
    const schema = op.responses['409'].content['application/json'].schema
    expect(Object.keys(schema.properties)).toEqual(['error', 'code'])
    expect(op.description).toContain('409 CONFLICT')
  })

  it('documents the new procedure endpoints and requires on Transition', async () => {
    const spec = await generateSpec() as any
    expect(spec.paths['/procedure/{name}/transition/requires'].put).toBeDefined()
    expect(spec.paths['/procedure/{name}/stats'].get).toBeDefined()
    expect(spec.components.schemas.Transition.properties.requires).toBeDefined()
  })
})

describe(`procedure names are limited to ${PROCEDURE_NAME_MAX_LENGTH} characters on creation`, () => {
  const max = 'n'.repeat(PROCEDURE_NAME_MAX_LENGTH)
  const tooLong = 'n'.repeat(PROCEDURE_NAME_MAX_LENGTH + 1)

  it('POST /procedure accepts the maximum and rejects longer names', async () => {
    const { app, headers } = await setup()
    expect((await app.inject({ method: 'POST', url: '/procedure', headers, payload: { workflow_name: max, description: 'd' } })).statusCode).toBe(201)
    expect((await app.inject({ method: 'POST', url: '/procedure', headers, payload: { workflow_name: tooLong, description: 'd' } })).statusCode).toBe(400)
  })

  it('PUT /procedure/:name still accepts names the router can match and never saves an over-long one', async () => {
    const { app, stores, headers, owner } = await setup()
    const def = { description: 'd', transitions: ['start -> end'] }
    // The router (find-my-way maxParamLength) only matches path params up to 100 characters
    const routable = 'n'.repeat(100)
    expect((await app.inject({ method: 'PUT', url: `/procedure/${routable}`, headers, payload: def })).statusCode).toBe(201)
    const res = await app.inject({ method: 'PUT', url: `/procedure/${tooLong}`, headers, payload: def })
    expect([400, 404]).toContain(res.statusCode)
    expect(await stores.workflowStore.get(tooLong, owner)).toBeNull()
  })

  it('an existing longer name stays usable through the routes that take it in the body', async () => {
    const { app, stores, headers, owner } = await setup()
    const longer = 'n'.repeat(PROCEDURE_NAME_MAX_LENGTH + 50)
    await stores.workflowStore.save({
      name: longer,
      description: 'd',
      states: { start: { name: 'start', isTerminal: false }, end: { name: 'end', isTerminal: true } },
      transitions: [{ from: 'start', to: 'end', type: 'deterministic' }],
    }, owner)
    const s = await app.inject({ method: 'POST', url: '/session', headers, payload: { workflow: longer } })
    expect(s.statusCode).toBe(201)
    const adv = await app.inject({ method: 'POST', url: `/session/${s.json().id}/advance`, headers, payload: { workflow: longer } })
    expect(adv.statusCode).toBe(200)
    expect(adv.json().currentState).toBe('end')
    const list = await app.inject({ url: `/sessions?workflow=${longer}`, headers })
    expect(list.json()).toHaveLength(1)
    expect((await app.inject({ url: '/procedures', headers })).json().map((p: any) => p.name)).toContain(longer)
  })
})
