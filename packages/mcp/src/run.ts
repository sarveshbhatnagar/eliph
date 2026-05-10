import { buildMcpServer } from './index'

const apiUrl = process.env.ELIPH_API_URL ?? 'https://eliph-api.revalent.ai'
const apiKey = process.env.ELIPH_API_KEY

if (!apiKey) {
  console.error('Error: ELIPH_API_KEY env var is required')
  process.exit(1)
}

buildMcpServer(apiUrl, apiKey).start().catch((err) => {
  console.error(err)
  process.exit(1)
})
