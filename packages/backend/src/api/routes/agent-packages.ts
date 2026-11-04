/**
 * STORE-MAP-01 P5 (T4, S1, CX10): agent packages, owner only, while
 * GIRRU_STORE_P5 is on (404 otherwise).
 *
 *   GET  /api/agents/:id/package          the package (JSON; nothing written on disk)
 *   POST /api/agent-packages/preview      { package } -> what an import would create, leave out and miss
 *   GET  /api/agent-packages/status       { on: true } (lets the pages show Export/Import only with the switch on)
 *   POST /api/agent-packages/import       { package, expectedPackageHash, again? } -> { agentId }
 *
 * STORE-MAP-01 P7 (SEC2-4), owner only, while GIRRU_STORE_P7 is on (404 otherwise):
 *   GET    /api/agents/:id/user-export?tool=claude-code   what ~/.claude/agents/girru-<name>.md would be
 *   POST   /api/agents/:id/user-export   { tool?, previewHash, confirm: true }   write it (never over a file that is not Girru's)
 *   DELETE /api/agents/:id/user-export?tool=claude-code   remove Girru's file only
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
import { storeP7Enabled } from '../../services/store-p7.js';
import { UserExportError, userExportApply, userExportPreview, userExportRemove } from '../../services/agent-user-export.js';
import { bridgeHome } from '../../memory/bridge/service.js';
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

  fastify.get('/api/agent-packages/status', { config }, async (request, reply) => {
    if (owner(request, reply) === null) return reply;
    return { on: true };
  });

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

  // P7 (SEC2-4): the agent's optional user-level file for a coding app.
  const ownerP7 = (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): string | null => {
    reply.header('Cache-Control', 'no-store');
    if (!storeP7Enabled()) { reply.code(404).send({ code: 'not_found' }); return null; }
    const actor = actorOrReply(reply, actorOf(request), requireOwner);
    if (!actor) return null;
    if (!validAgentFileId(request.params.id)) { reply.code(400).send({ code: 'invalid_agent' }); return null; }
    return actor.userId ?? null;
  };
  const failExport = (reply: FastifyReply, route: string, err: unknown) =>
    err instanceof UserExportError ? reply.code(err.status).send({ code: err.code, message: err.message }) : sendInternalError(reply, `[AgentPackages] ${route}`, err);
  const toolOf = (request: FastifyRequest) => (request.query as Record<string, unknown> | undefined)?.tool;

  fastify.get<{ Params: { id: string } }>('/api/agents/:id/user-export', { config }, async (request, reply) => {
    if (ownerP7(request, reply) === null) return reply;
    try { return await userExportPreview(request.params.id, toolOf(request), bridgeHome()); } catch (err) { return failExport(reply, 'user-export preview', err); }
  });

  fastify.post<{ Params: { id: string } }>('/api/agents/:id/user-export', { config }, async (request, reply) => {
    const userId = ownerP7(request, reply);
    if (userId === null) return reply;
    const b = body(request);
    if (Object.keys(b).some((k) => !['tool', 'previewHash', 'confirm'].includes(k))) return reply.code(400).send({ code: 'invalid_request' });
    try {
      const r = await userExportApply(request.params.id, b, bridgeHome());
      logAudit({ event_type: 'data.update', event_category: 'data_modification', severity: 'info', user_id: userId, ip_address: request.ip,
        resource_type: 'agent', resource_id: request.params.id, action: 'agent.user_export', success: true, metadata: { tool: r.tool, file: r.file } });
      return r;
    } catch (err) { return failExport(reply, 'user-export apply', err); }
  });

  fastify.delete<{ Params: { id: string } }>('/api/agents/:id/user-export', { config }, async (request, reply) => {
    const userId = ownerP7(request, reply);
    if (userId === null) return reply;
    try {
      const r = await userExportRemove(request.params.id, toolOf(request), bridgeHome());
      if (r.removed) logAudit({ event_type: 'data.delete', event_category: 'data_modification', severity: 'info', user_id: userId, ip_address: request.ip,
        resource_type: 'agent', resource_id: request.params.id, action: 'agent.user_export.remove', success: true, metadata: { file: r.file } });
      return r;
    } catch (err) { return failExport(reply, 'user-export remove', err); }
  });
}
