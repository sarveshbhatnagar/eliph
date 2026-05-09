import { createStores } from '../src/index'

describe('SqliteApiKeyStore', () => {
  function store() {
    return createStores(':memory:').apiKeyStore
  }

  it('create returns a rawKey and a record', async () => {
    const { rawKey, record } = await store().create('test-key')
    expect(typeof rawKey).toBe('string')
    expect(rawKey.length).toBeGreaterThan(0)
    expect(record.label).toBe('test-key')
    expect(record.id).toBeTruthy()
    expect(record.createdAt).toBeInstanceOf(Date)
  })

  it('find returns the record for the correct rawKey', async () => {
    const s = store()
    const { rawKey, record } = await s.create('my-key')
    const found = await s.find(rawKey)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(record.id)
    expect(found!.label).toBe('my-key')
  })

  it('find returns null for a wrong key', async () => {
    const s = store()
    await s.create('my-key')
    expect(await s.find('definitely-wrong')).toBeNull()
  })

  it('list returns all keys without the key hash', async () => {
    const s = store()
    await s.create('key-a')
    await s.create('key-b')
    const keys = await s.list()
    expect(keys).toHaveLength(2)
    expect(keys.map(k => k.label)).toEqual(expect.arrayContaining(['key-a', 'key-b']))
    keys.forEach(k => expect((k as any).key).toBeUndefined())
  })

  it('delete removes the key', async () => {
    const s = store()
    const { record } = await s.create('my-key')
    await s.delete(record.id)
    expect(await s.list()).toHaveLength(0)
  })

  it('deleted key can no longer be found', async () => {
    const s = store()
    const { rawKey, record } = await s.create('my-key')
    await s.delete(record.id)
    expect(await s.find(rawKey)).toBeNull()
  })
})
