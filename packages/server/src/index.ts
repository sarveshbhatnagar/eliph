import { createStores } from '@eliph/sqlite'
import { buildApp } from './app'

const stores = createStores('./eliph.db')

const app = buildApp(stores)

app.listen({ port: 4000, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1) }
  console.log(`Eliph server listening at ${address}`)
})
