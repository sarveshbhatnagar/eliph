import { FastifyInstance } from 'fastify'
import { IOrgKeyStore, IUsageStore } from '@eliph/core'

export function orgKeysRoutes(orgKeyStore: IOrgKeyStore, usageStore: IUsageStore) {
  return async (app: FastifyInstance) => {

    // POST /admin/org-keys — create an org key
    app.post<{ Body: { label: string; keyLimit: number } }>('/admin/org-keys', {
      schema: {
        tags: ['Admin'],
        summary: 'Create an org key (admin only)',
        security: [{ BearerAuth: [] }],
        body: {
          type: 'object',
          required: ['label', 'keyLimit'],
          properties: {
            label: { type: 'string' },
            keyLimit: { type: 'integer', minimum: 1 },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              rawKey: { type: 'string' },
              id: { type: 'string' },
              label: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
              keyLimit: { type: 'integer' },
            },
          },
        },
      },
    }, async (req, reply) => {
      if (req.authContext?.type !== 'admin') {
        return reply.code(403).send({ error: 'Admin access required', code: 'FORBIDDEN' })
      }
      const { label, keyLimit } = req.body
      if (!label) return reply.code(400).send({ error: 'label is required', code: 'BAD_REQUEST' })
      const { rawKey, record } = await orgKeyStore.create(label, keyLimit)
      reply.code(201).send({ rawKey, id: record.id, label: record.label, createdAt: record.createdAt, keyLimit: record.keyLimit })
    })

    // GET /admin/org-keys — list all org keys with key counts
    app.get('/admin/org-keys', {
      schema: {
        tags: ['Admin'],
        summary: 'List all org keys with usage counts (admin only)',
        security: [{ BearerAuth: [] }],
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                createdAt: { type: 'string', format: 'date-time' },
                keyLimit: { type: 'integer' },
                keyCount: { type: 'integer' },
              },
            },
          },
        },
      },
    }, async (req, reply) => {
      if (req.authContext?.type !== 'admin') {
        return reply.code(403).send({ error: 'Admin access required', code: 'FORBIDDEN' })
      }
      reply.send(await orgKeyStore.list())
    })

    // DELETE /admin/org-keys/:id — revoke an org key
    app.delete<{ Params: { id: string } }>('/admin/org-keys/:id', {
      schema: {
        tags: ['Admin'],
        summary: 'Revoke an org key (admin only)',
        security: [{ BearerAuth: [] }],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
        response: { 204: { type: 'null' } },
      },
    }, async (req, reply) => {
      if (req.authContext?.type !== 'admin') {
        return reply.code(403).send({ error: 'Admin access required', code: 'FORBIDDEN' })
      }
      await orgKeyStore.delete(req.params.id)
      reply.code(204).send()
    })

    // POST /admin/org-keys/:id/regenerate — issue a new raw key
    app.post<{ Params: { id: string } }>('/admin/org-keys/:id/regenerate', {
      schema: {
        tags: ['Admin'],
        summary: 'Regenerate the raw key for an org (admin only)',
        security: [{ BearerAuth: [] }],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
        response: {
          200: {
            type: 'object',
            properties: { rawKey: { type: 'string' } },
          },
        },
      },
    }, async (req, reply) => {
      if (req.authContext?.type !== 'admin') {
        return reply.code(403).send({ error: 'Admin access required', code: 'FORBIDDEN' })
      }
      const { rawKey } = await orgKeyStore.regenerate(req.params.id)
      reply.send({ rawKey })
    })

    // PATCH /admin/org-keys/:id — update key limit
    app.patch<{ Params: { id: string }; Body: { keyLimit: number } }>('/admin/org-keys/:id', {
      schema: {
        tags: ['Admin'],
        summary: 'Update key limit for an org key (admin only)',
        security: [{ BearerAuth: [] }],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['keyLimit'],
          properties: { keyLimit: { type: 'integer', minimum: 1 } },
        },
        response: { 204: { type: 'null' } },
      },
    }, async (req, reply) => {
      if (req.authContext?.type !== 'admin') {
        return reply.code(403).send({ error: 'Admin access required', code: 'FORBIDDEN' })
      }
      await orgKeyStore.updateLimit(req.params.id, req.body.keyLimit)
      reply.code(204).send()
    })

    // GET /admin/usage/:orgKeyId — usage breakdown by API key
    app.get<{ Params: { orgKeyId: string }; Querystring: { from?: string; to?: string } }>(
      '/admin/usage/:orgKeyId', {
        schema: {
          tags: ['Admin'],
          summary: 'Usage breakdown for an org by API key label (admin only)',
          security: [{ BearerAuth: [] }],
          params: { type: 'object', properties: { orgKeyId: { type: 'string' } } },
          querystring: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'ISO date e.g. 2026-05-01' },
              to:   { type: 'string', description: 'ISO date e.g. 2026-05-31' },
            },
          },
        } as any,
      }, async (req, reply) => {
        if (req.authContext?.type !== 'admin') {
          return reply.code(403).send({ error: 'Admin access required', code: 'FORBIDDEN' })
        }
        const from = req.query.from ? new Date(req.query.from) : undefined
        const to   = req.query.to   ? new Date(req.query.to)   : undefined
        const rows = await usageStore.query(req.params.orgKeyId, from, to)
        const totalAdvances = rows.reduce((s, r) => s + r.advances, 0)
        const totalSessions = rows.reduce((s, r) => s + r.sessionsCreated, 0)
        reply.send({ orgKeyId: req.params.orgKeyId, totalAdvances, totalSessions, byKey: rows })
      }
    )
  }
}
