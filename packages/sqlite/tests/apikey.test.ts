import { createStores } from '../src/index'

describe('SqliteApiKeyStore', () => {
  async function setup() {
    const s = createStores(':memory:')
    const { record: orgKey } = await s.orgKeyStore.create('test-org', 100)
    return { stores: s, orgKeyId: orgKey.id }
  }

  it('create returns a rawKey and a record', async () => {
    const { stores, orgKeyId } = await setup()
    const { rawKey, record } = await stores.apiKeyStore.create('test-key', orgKeyId)
    expect(typeof rawKey).toBe('string')
    expect(rawKey.length).toBeGreaterThan(0)
    expect(record.label).toBe('test-key')
    expect(record.orgKeyId).toBe(orgKeyId)
    expect(record.id).toBeTruthy()
    expect(record.createdAt).toBeInstanceOf(Date)
  })

  it('find returns the record for the correct rawKey', async () => {
    const { stores, orgKeyId } = await setup()
    const { rawKey, record } = await stores.apiKeyStore.create('my-key', orgKeyId)
    const found = await stores.apiKeyStore.find(rawKey)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(record.id)
    expect(found!.label).toBe('my-key')
    expect(found!.orgKeyId).toBe(orgKeyId)
  })

  it('find returns null for a wrong key', async () => {
    const { stores, orgKeyId } = await setup()
    await stores.apiKeyStore.create('my-key', orgKeyId)
    expect(await stores.apiKeyStore.find('definitely-wrong')).toBeNull()
  })

  it('list returns all keys without the key hash', async () => {
    const { stores, orgKeyId } = await setup()
    await stores.apiKeyStore.create('key-a', orgKeyId)
    await stores.apiKeyStore.create('key-b', orgKeyId)
    const keys = await stores.apiKeyStore.list()
    expect(keys).toHaveLength(2)
    expect(keys.map(k => k.label)).toEqual(expect.arrayContaining(['key-a', 'key-b']))
    keys.forEach(k => expect((k as any).key).toBeUndefined())
  })

  it('list filters by orgKeyId', async () => {
    const { stores, orgKeyId } = await setup()
    const { record: org2 } = await stores.orgKeyStore.create('other-org', 100)
    await stores.apiKeyStore.create('key-a', orgKeyId)
    await stores.apiKeyStore.create('key-b', org2.id)
    const keys = await stores.apiKeyStore.list(orgKeyId)
    expect(keys).toHaveLength(1)
    expect(keys[0].label).toBe('key-a')
  })

  it('delete removes the key', async () => {
    const { stores, orgKeyId } = await setup()
    const { record } = await stores.apiKeyStore.create('my-key', orgKeyId)
    await stores.apiKeyStore.delete(record.id)
    expect(await stores.apiKeyStore.list()).toHaveLength(0)
  })

  it('deleted key can no longer be found', async () => {
    const { stores, orgKeyId } = await setup()
    const { rawKey, record } = await stores.apiKeyStore.create('my-key', orgKeyId)
    await stores.apiKeyStore.delete(record.id)
    expect(await stores.apiKeyStore.find(rawKey)).toBeNull()
  })
})
