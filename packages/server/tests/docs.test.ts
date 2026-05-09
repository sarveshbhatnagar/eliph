import { generateSpec } from '../../src/docs-builder'

describe('generateSpec', () => {
  it('returns a valid OpenAPI 3.0 spec', async () => {
    const spec = await generateSpec() as any
    expect(spec.openapi).toMatch(/^3\./)
    expect(spec.info.title).toBe('Eliph API')
  })

  it('includes all expected paths', async () => {
    const spec = await generateSpec() as any
    const paths = Object.keys(spec.paths)
    expect(paths).toContain('/keys')
    expect(paths).toContain('/procedures')
    expect(paths).toContain('/procedure/{name}')
    expect(paths).toContain('/procedure/{name}/transition')
    expect(paths).toContain('/procedure/{name}/state/{state}')
    expect(paths).toContain('/procedure/{name}/states')
    expect(paths).toContain('/session')
    expect(paths).toContain('/session/{id}/state')
    expect(paths).toContain('/session/{id}/next')
    expect(paths).toContain('/session/{id}/advance')
    expect(paths).toContain('/session/{id}/reset')
    expect(paths).toContain('/session/{id}/requirements')
  })

  it('includes all shared component schemas', async () => {
    const spec = await generateSpec() as any
    const schemas = Object.keys(spec.components.schemas)
    expect(schemas).toContain('WorkflowGraph')
    expect(schemas).toContain('Session')
    expect(schemas).toContain('Transition')
    expect(schemas).toContain('State')
    expect(schemas).toContain('ApiKey')
  })

  it('includes BearerAuth security scheme', async () => {
    const spec = await generateSpec() as any
    expect(spec.components.securitySchemes).toHaveProperty('BearerAuth')
    expect(spec.components.securitySchemes.BearerAuth.scheme).toBe('bearer')
  })
})
