import Fastify from 'fastify'
import fastifySwagger from '@fastify/swagger'
import { InMemoryWorkflowStore, InMemorySessionStore, InMemoryApiKeyStore } from '@eliph/core'
import { registerSharedSchemas } from './app'
import { keysRoutes } from './routes/keys'
import { proceduresRoutes } from './routes/procedures'
import { sessionsRoutes } from './routes/sessions'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

export async function generateSpec(): Promise<object> {
  const stores = {
    workflowStore: new InMemoryWorkflowStore(),
    sessionStore: new InMemorySessionStore(),
    apiKeyStore: new InMemoryApiKeyStore(),
  }

  const app = Fastify()

  app.register(fastifySwagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Eliph API',
        description: 'Automata-driven agent workflow engine',
        version: '0.1.0',
      },
      components: {
        securitySchemes: {
          BearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
    },
    refResolver: {
      buildLocalReference (json: Record<string, unknown>, _baseUri: unknown, _fragment: unknown, i: number) {
        return (json.$id as string | undefined) ?? `def-${i}`
      },
    },
  })

  registerSharedSchemas(app)
  app.register(keysRoutes(stores.apiKeyStore))
  app.register(proceduresRoutes(stores.workflowStore, stores.sessionStore))
  app.register(sessionsRoutes(stores.workflowStore, stores.sessionStore))

  await app.ready()
  return app.swagger()
}

async function main() {
  const spec = await generateSpec()
  const outDir = resolve(__dirname, '../../../docs-site')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(resolve(outDir, 'openapi.json'), JSON.stringify(spec, null, 2))
  writeFileSync(resolve(outDir, 'index.html'), swaggerUiHtml())
  console.log(`Docs generated in ${outDir}`)
}

function swaggerUiHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Eliph API Docs</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
window.onload = () => {
  SwaggerUIBundle({
    url: './openapi.json',
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
    layout: 'BaseLayout',
    deepLinking: true
  })
}
</script>
</body>
</html>`
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
