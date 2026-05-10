import { createStores } from '../src/index'

describe('SqliteOrgKeyStore', () => {
  function stores() {
    return createStores(':memory:')
  }

  it('create returns a rawKey and a record', async () => {
    const { orgKeyStore } = stores()
    const { rawKey, record } = await orgKeyStore.create('acme', 50)
    expect(typeof rawKey).toBe('string')
    expect(rawKey.length).toBeGreaterThan(0)
    expect(record.label).toBe('acme')
    expect(record.keyLimit).toBe(50)
    expect(record.id).toBeTruthy()
    expect(record.createdAt).toBeInstanceOf(Date)
  })

  it('find returns the record for the correct rawKey', async () => {
    const { orgKeyStore } = stores()
    const { rawKey, record } = await orgKeyStore.create('acme', 50)
    const found = await orgKeyStore.find(rawKey)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(record.id)
    expect(found!.label).toBe('acme')
    expect(found!.keyLimit).toBe(50)
  })

  it('find returns null for wrong key', async () => {
    const { orgKeyStore } = stores()
    await orgKeyStore.create('acme', 50)
    expect(await orgKeyStore.find('wrong')).toBeNull()
  })

  it('list returns all org keys with keyCount', async () => {
    const { orgKeyStore } = stores()
    await orgKeyStore.create('acme', 50)
    await orgKeyStore.create('globex', 100)
    const list = await orgKeyStore.list()
    expect(list).toHaveLength(2)
    expect(list.map(k => k.label)).toEqual(expect.arrayContaining(['acme', 'globex']))
    list.forEach(k => expect(k.keyCount).toBe(0))
  })

  it('countKeys reflects api keys created under this org', async () => {
    const { orgKeyStore, apiKeyStore } = stores()
    const { record } = await orgKeyStore.create('acme', 50)
    await apiKeyStore.create('key-1', record.id)
    await apiKeyStore.create('key-2', record.id)
    expect(await orgKeyStore.countKeys(record.id)).toBe(2)
  })

  it('list shows updated keyCount', async () => {
    const { orgKeyStore, apiKeyStore } = stores()
    const { record } = await orgKeyStore.create('acme', 50)
    await apiKeyStore.create('key-1', record.id)
    const list = await orgKeyStore.list()
    expect(list[0].keyCount).toBe(1)
  })

  it('delete removes the org key', async () => {
    const { orgKeyStore } = stores()
    const { record } = await orgKeyStore.create('acme', 50)
    await orgKeyStore.delete(record.id)
    expect(await orgKeyStore.list()).toHaveLength(0)
  })
})
