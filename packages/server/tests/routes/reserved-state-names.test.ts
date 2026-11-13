import { buildApp } from '../../src/app'
import { createStores } from '@eliph/sqlite'

describe('state names that collide with built-in object members', () => {
  async function setup() {
    const stores = createStores(':memory:')
    const app = buildApp(stores)
    const org = await stores.orgKeyStore.create('org', 10)
    const { rawKey } = await stores.apiKeyStore.create('k', org.record.id)
    const headers = { authorization: `Bearer ${rawKey}` }
    await app.inject({ method: 'POST', url: '/procedure', headers, payload: { workflow_name: 'wf', description: 'd' } })
    await app.inject({ method: 'POST', url: '/procedure/wf/transition', headers, payload: { transition: 'start -> end' } })
    return { app, headers }
  }

  it('add_transition rejects them and the procedure stays readable', async () => {
    const { app, headers } = await setup()
    for (const name of ['constructor', '__proto__', 'toString']) {
      const res = await app.inject({ method: 'POST', url: '/procedure/wf/transition', headers, payload: { transition: `start -> ${name}` } })
      expect(res.statusCode).toBe(400)
    }
    const graph = await app.inject({ url: '/procedure/wf', headers })
    expect(graph.statusCode).toBe(200)
    expect(Object.keys(graph.json().states).sort()).toEqual(['end', 'start'])
  })

  it('state description, terminal and reset do not treat them as existing states', async () => {
    const { app, headers } = await setup()
    const patch = await app.inject({ method: 'PATCH', url: '/procedure/wf/state/constructor', headers, payload: { description: 'x' } })
    expect(patch.statusCode).toBe(404)
    const terminal = await app.inject({ method: 'POST', url: '/procedure/wf/state/constructor/terminal', headers })
    expect(terminal.statusCode).toBe(400)

    const session = (await app.inject({ method: 'POST', url: '/session', headers, payload: { workflow: 'wf' } })).json()
    const reset = await app.inject({ method: 'POST', url: `/session/${session.id}/reset`, headers, payload: { target_state: 'constructor' } })
    expect(reset.statusCode).toBe(400)
    const state = await app.inject({ url: `/session/${session.id}/state`, headers })
    expect(state.json().currentState).toBe('start')
  })
})
