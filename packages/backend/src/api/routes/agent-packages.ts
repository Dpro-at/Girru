/**
 * STORE-MAP-01 P5 (T4, S1, CX10): agent packages, owner only, while
 * GIRRU_STORE_P5 is on (404 otherwise).
 *
 *   GET  /api/agents/:id/package          the package (JSON; nothing written on disk)
 *   POST /api/agent-packages/preview      { package } -> what an import would create, leave out and miss
 *   POST /api/agent-packages/import       { package, expectedPackageHash, again? } -> { agentId }
 *
 * Errors: { code } — 400 invalid_package | not_an_agent_package | schema_version | newer_package |
 * hash_mismatch | secret_found, 404 not_found, 409 preview_changed | already_imported, 413 too_large | too_many_files.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { actorOrReply, requireOwner } from '../../repositories/scope.js';
import { logAudit } from '../../services/audit-logger.js';
import { validAgentFileId } from '../../services/agent-files.js';
import { AgentPackageError, MAX_PACKAGE_BYTES, exportAgentPackage, importAgentPackage, planAgentPackage } from '../../services/agent-package.js';
import { storeP5Enabled } from '../../services/store-p5.js';
import { sendInternalError } from '../error-handler.js';

export async function agentPackagesRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  const big = { config, bodyLimit: MAX_PACKAGE_BYTES + 64 * 1024 };
  const owner = (request: FastifyRequest, reply: FastifyReply): string | null => {
    reply.header('Cache-Control', 'no-store');
    if (!storeP5Enabled()) { reply.code(404).send({ code: 'not_found' }); return null; }
    const actor = actorOrReply(reply, actorOf(request), requireOwner);
    return actor ? actor.userId ?? null : null;
  };
  const fail = (reply: FastifyReply, route: string, err: unknown) =>
    err instanceof AgentPackageError ? reply.code(err.status).send({ code: err.code, ...(err.detail ? { detail: err.detail } : {}) }) : sendInternalError(reply, `[AgentPackages] ${route}`, err);
  const body = (request: FastifyRequest) => (request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {});

  fastify.get<{ Params: { id: string } }>('/api/agents/:id/package', { config }, async (request, reply) => {
    if (owner(request, reply) === null) return reply;
    if (!validAgentFileId(request.params.id)) return reply.code(400).send({ code: 'invalid_agent' });
    try { return await exportAgentPackage(request.params.id); } catch (err) { return fail(reply, 'export', err); }
  });

  fastify.post('/api/agent-packages/preview', big, async (request, reply) => {
    if (owner(request, reply) === null) return reply;
    const b = body(request);
    if (Object.keys(b).some((k) => k !== 'package')) return reply.code(400).send({ code: 'invalid_package' });
    try {
      const plan = await planAgentPackage(b.package);
      // The preview names files and sizes; the texts themselves stay in the package the owner has.
      return { ...plan, knowledge: plan.knowledge.map((k) => ({ name: k.name, bytes: Buffer.byteLength(k.content, 'utf8'), read: k.read })), personality: { ...plan.personality, text: plan.personality.text.slice(0, 2000) } };
    } catch (err) { return fail(reply, 'preview', err); }
  });

  fastify.post('/api/agent-packages/import', big, async (request, reply) => {
    const userId = owner(request, reply);
    if (userId === null) return reply;
    const b = body(request);
    if (Object.keys(b).some((k) => !['package', 'expectedPackageHash', 'again'].includes(k)) || (b.again !== undefined && typeof b.again !== 'boolean')) return reply.code(400).send({ code: 'invalid_package' });
    try {
      const { agentId, plan } = await importAgentPackage(b.package, userId, { expectedPackageHash: b.expectedPackageHash, again: b.again === true });
      logAudit({ event_type: 'data.create', event_category: 'data_modification', severity: 'info', user_id: userId, ip_address: request.ip,
        resource_type: 'agent', resource_id: agentId, action: 'agent_package.import', success: true,
        metadata: { packageHash: plan.packageHash, schemaVersion: plan.schemaVersion, refused: plan.refused.length, missing: plan.missing.length } });
      return { agentId, refused: plan.refused, missing: plan.missing };
    } catch (err) { return fail(reply, 'import', err); }
  });
}
