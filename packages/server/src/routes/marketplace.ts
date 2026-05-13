import { FastifyInstance } from 'fastify'
import { IWorkflowStore } from '@eliph/core'
import { MARKETPLACE_OWNER_ID, ADMIN_OWNER_ID } from '../middleware/auth'

function ownerId(req: any): string {
  const ctx = req.authContext
  if (ctx?.type === 'api') return ctx.apiKeyId
  return ADMIN_OWNER_ID
}

export function marketplaceRoutes(workflowStore: IWorkflowStore) {
  return async (app: FastifyInstance) => {

    // GET /marketplace — browse all templates (public)
    app.get<{ Querystring: { q?: string } }>('/marketplace', {
      schema: {
        tags: ['Marketplace'],
        summary: 'Browse workflow templates (public)',
        querystring: {
          type: 'object',
          properties: { q: { type: 'string', description: 'Optional search term' } },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      } as any,
    }, async (req, reply) => {
      reply.send(await workflowStore.search(req.query.q ?? '', MARKETPLACE_OWNER_ID))
    })

    // GET /marketplace/:name — get a template (public)
    app.get<{ Params: { name: string } }>('/marketplace/:name', {
      schema: {
        tags: ['Marketplace'],
        summary: 'Get a marketplace workflow template (public)',
        params: { type: 'object', properties: { name: { type: 'string' } } },
        response: { 200: { $ref: 'WorkflowGraph#' } },
      } as any,
    }, async (req, reply) => {
      const graph = await workflowStore.get(req.params.name, MARKETPLACE_OWNER_ID)
      if (!graph) return reply.code(404).send({ error: 'Template not found', code: 'NOT_FOUND' })
      reply.send(graph)
    })

    // POST /marketplace/:name/copy — copy template into caller's namespace
    app.post<{ Params: { name: string }; Body: { workflow_name?: string } }>(
      '/marketplace/:name/copy', {
        schema: {
          tags: ['Marketplace'],
          summary: 'Copy a marketplace template into your workflow namespace',
          security: [{ BearerAuth: [] }],
          params: { type: 'object', properties: { name: { type: 'string' } } },
          body: {
            type: 'object',
            properties: { workflow_name: { type: 'string', description: 'Optional new name (defaults to template name)' } },
          },
          response: { 201: { $ref: 'WorkflowGraph#' } },
        } as any,
      }, async (req, reply) => {
        const ctx = req.authContext
        if (!ctx || ctx.type !== 'api') {
          return reply.code(401).send({ error: 'API key required to copy templates', code: 'UNAUTHORIZED' })
        }
        const template = await workflowStore.get(req.params.name, MARKETPLACE_OWNER_ID)
        if (!template) return reply.code(404).send({ error: 'Template not found', code: 'NOT_FOUND' })

        const copied = {
          ...template,
          name: req.body?.workflow_name ?? template.name,
        }
        await workflowStore.save(copied, ctx.apiKeyId)
        reply.code(201).send(copied)
      }
    )

    // POST /admin/marketplace — publish a workflow as a marketplace template
    app.post<{ Body: { workflow_name: string; description: string } }>(
      '/admin/marketplace', {
        schema: {
          tags: ['Marketplace'],
          summary: 'Publish a new workflow template to the marketplace (admin only)',
          security: [{ BearerAuth: [] }],
          body: {
            type: 'object',
            required: ['workflow_name', 'description'],
            properties: {
              workflow_name: { type: 'string' },
              description: { type: 'string' },
            },
          },
          response: { 201: { $ref: 'WorkflowGraph#' } },
        } as any,
      }, async (req, reply) => {
        if (req.authContext?.type !== 'admin') {
          return reply.code(403).send({ error: 'Admin access required', code: 'FORBIDDEN' })
        }
        const graph = {
          name: req.body.workflow_name,
          description: req.body.description,
          states: { start: { name: 'start', isTerminal: false } },
          transitions: [] as any[],
        }
        await workflowStore.save(graph, MARKETPLACE_OWNER_ID)
        reply.code(201).send(graph)
      }
    )

    // POST /admin/marketplace/:name/publish — publish an existing user workflow as a template
    app.post<{ Params: { name: string }; Body: { source_api_key_id: string } }>(
      '/admin/marketplace/:name/publish', {
        schema: {
          tags: ['Marketplace'],
          summary: 'Publish an existing user workflow to the marketplace (admin only)',
          security: [{ BearerAuth: [] }],
          params: { type: 'object', properties: { name: { type: 'string' } } },
          body: {
            type: 'object',
            required: ['source_api_key_id'],
            properties: { source_api_key_id: { type: 'string', description: 'API key ID that owns the source workflow' } },
          },
          response: { 201: { $ref: 'WorkflowGraph#' } },
        } as any,
      }, async (req, reply) => {
        if (req.authContext?.type !== 'admin') {
          return reply.code(403).send({ error: 'Admin access required', code: 'FORBIDDEN' })
        }
        const source = await workflowStore.get(req.params.name, req.body.source_api_key_id)
        if (!source) return reply.code(404).send({ error: 'Source workflow not found', code: 'NOT_FOUND' })
        await workflowStore.save(source, MARKETPLACE_OWNER_ID)
        reply.code(201).send(source)
      }
    )

    // DELETE /admin/marketplace/:name — remove a template
    app.delete<{ Params: { name: string } }>('/admin/marketplace/:name', {
      schema: {
        tags: ['Marketplace'],
        summary: 'Remove a workflow template from the marketplace (admin only)',
        security: [{ BearerAuth: [] }],
        params: { type: 'object', properties: { name: { type: 'string' } } },
        response: { 204: { type: 'null' } },
      } as any,
    }, async (req, reply) => {
      if (req.authContext?.type !== 'admin') {
        return reply.code(403).send({ error: 'Admin access required', code: 'FORBIDDEN' })
      }
      await workflowStore.delete(req.params.name, MARKETPLACE_OWNER_ID)
      reply.code(204).send()
    })
  }
}
