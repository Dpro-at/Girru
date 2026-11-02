/**
 * STORE-MAP-01 P3 (FD2): the one list of departments. Owner only; answers
 * 404 `p3_off` while GIRRU_STORE_P3 is off.
 *
 *   GET    /api/departments                        list with agents and projects (+ open upgrade questions)
 *   POST   /api/departments                        { name } make one
 *   PATCH  /api/departments/:id                    { version, name?, letter?, color?, leadAgentId? } (409 version_conflict)
 *   POST   /api/departments/:id/merge              { into } -> { mergeId, into }
 *   POST   /api/departments/merges/:mergeId/undo   puts the merged department back
 *   POST   /api/departments/questions/:id          { departmentId | null } answers an upgrade question (D9)
 *
 * Deleting stays on the memory route (preview, then delete with its hash);
 * while P3 is on it also lets agents, boards and rules go.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { ScopeInputError, createDepartment } from '../../memory/scopes/store.js';
import { invalidateScopeTree } from '../../memory/scopes/tree.js';
import { answerDepartmentQuestion, departmentsOverview, mergeDepartments, undoMerge, updateDepartment } from '../../services/departments.js';
import { storeP3Enabled } from '../../services/store-p3.js';

type Req = FastifyRequest<{ Params: Record<string, string>; Body: unknown }>;
const bodyOf = (r: { body?: unknown }): Record<string, any> => (r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body as Record<string, any> : {});

export async function departmentsRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  const asOwner = (fn: (ownerId: string, request: Req) => Promise<unknown>) => async (request: Req, reply: FastifyReply) => {
    const ownerId = authorizeActiveRole(request, reply, ['owner'] as const);
    if (ownerId === null) return reply;
    if (!storeP3Enabled()) return reply.code(404).send({ error: 'Not found', code: 'p3_off' });
    try {
      const out = await fn(ownerId, request);
      invalidateScopeTree(ownerId);
      return out;
    } catch (err) {
      if (err instanceof ScopeInputError) return reply.code(err.status).send({ error: err.message, code: err.code });
      throw err;
    }
  };

  fastify.get('/api/departments', { config }, asOwner((o) => departmentsOverview(o)));
  fastify.post('/api/departments', { config }, asOwner(async (o, r) => ({ department: await createDepartment(o, bodyOf(r).name, o) })));
  fastify.patch('/api/departments/:id', { config }, asOwner(async (o, r) => ({ department: await updateDepartment(o, r.params.id, bodyOf(r)) })));
  fastify.post('/api/departments/:id/merge', { config }, asOwner((o, r) => mergeDepartments(o, r.params.id, String(bodyOf(r).into ?? ''), o)));
  fastify.post('/api/departments/merges/:mergeId/undo', { config }, asOwner(async (o, r) => ({ department: await undoMerge(o, r.params.mergeId) })));
  fastify.post('/api/departments/questions/:id', { config }, asOwner(async (o, r) => {
    const v = bodyOf(r).departmentId;
    await answerDepartmentQuestion(o, r.params.id, typeof v === 'string' && v ? v : null);
    return { ok: true };
  }));
}
