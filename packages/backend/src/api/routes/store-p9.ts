/**
 * STORE-MAP-01 P9 routes (GIRRU_STORE_P9). Each answers 404 while the switch
 * is off; owner only.
 *
 *   GET   /api/memory/people/:key/export   everything about one person (PRIV6), as a download
 *   POST  /api/memory/people/:key/forget   forget the person in one action: { confirm: <key>, mentionIds? }
 *   GET   /api/memory/health                the local health view (five rows; OPS6, FAIL6)
 *   GET   /api/memory/health/support        the support file: versions, counts, ids; never memory text
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { PersonError, exportPerson, forgetPerson } from '../../memory/person.js';
import { memoryHealth, supportBundle } from '../../memory/health.js';
import { storeP9Enabled } from '../../services/store-p9.js';
import { repositories } from '../../repositories/index.js';
import { requestMeta } from '../../repositories/audit.js';
import { actorOf } from '../../auth/auth-gate.js';

const OWNER_ONLY = ['owner'] as const;
type Req = FastifyRequest<{ Params: Record<string, string>; Body: unknown }>;
const bodyOf = (r: { body?: unknown }): Record<string, any> => (r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body as Record<string, any> : {});

export async function storeP9Routes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  const asOwner = (fn: (ownerId: string, request: Req, reply: FastifyReply) => Promise<unknown>) => async (request: Req, reply: FastifyReply) => {
    if (!storeP9Enabled()) return reply.code(404).send({ code: 'not_found' });
    const ownerId = authorizeActiveRole(request, reply, OWNER_ONLY);
    if (ownerId === null) return reply;
    try { return await fn(ownerId, request, reply); } catch (err) {
      if (err instanceof PersonError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  };

  fastify.get('/api/memory/people/:key/export', { config }, asOwner(async (o, r, reply) => {
    const out = await exportPerson(o, r.params.key);
    reply.header('content-disposition', `attachment; filename="person-${out.person}-${out.exportedAt.slice(0, 10)}.json"`);
    return out;
  }));
  fastify.post('/api/memory/people/:key/forget', { config }, asOwner(async (o, r) => {
    const b = bodyOf(r);
    const out = await forgetPerson(o, r.params.key, o, { confirm: b.confirm, mentionIds: b.mentionIds });
    // Ids and counts only (S5).
    const actor = actorOf(r);
    if (actor) void repositories.audit.record(actor, {
      event_type: 'data.delete', event_category: 'data_modification', severity: 'info',
      resource_type: 'memory_person', resource_id: r.params.key, action: 'memory.forget_person', success: true,
      metadata: out,
    }, requestMeta(r));
    return out;
  }));
  fastify.get('/api/memory/health', { config }, asOwner((o) => memoryHealth(o)));
  fastify.get('/api/memory/health/support', { config }, asOwner(async (o, _r, reply) => {
    const out = await supportBundle(o);
    reply.header('content-disposition', `attachment; filename="girru-support-${String(out.createdAt).slice(0, 10)}.json"`);
    return out;
  }));
}
