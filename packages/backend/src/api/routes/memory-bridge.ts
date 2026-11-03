/**
 * Memory bridge for coding agents (MEM-BRIDGE-01).
 *
 * Owner only (auth gate owner tier + handler check):
 *   GET   /api/memory-bridge                                    status: CLIs (kill switch, registration), project folders, registrations
 *   PUT   /api/memory-bridge/clients/:client                    { enabled } kill switch (off also deletes the CLI's token)
 *   GET   /api/memory-bridge/clients/:client/registration       dry run: the server entry for the CLI's config file + previewHash
 *   POST  /api/memory-bridge/clients/:client/registration       { previewHash, confirm: true } backs up the file, then writes it
 *   POST  /api/memory-bridge/registrations/:id/undo             restores the backup (or removes only Girru's entry)
 *   GET   /api/memory-bridge/projects/:projectId/files          dry run of AGENTS.md / CLAUDE.md / GEMINI.md (+ .git/info/exclude)
 *   POST  /api/memory-bridge/projects/:projectId/files          { previewHash, confirm: true } writes them; kept in sync from then on
 *   PATCH /api/memory-bridge/projects/:projectId                { filesEnabled: false?, backflowEnabled?, gitExclude? }
 *   POST  /api/memory-bridge/projects/:projectId/backflow       imports the CLIs' own memory files as review proposals now
 *   GET   /api/memory-bridge/audit?limit=&client=&projectId=    what the bridge did (activity log), newest first
 *
 * STORE-MAP-01 P6 screens (only while GIRRU_STORE_P6 is on; otherwise not registered):
 *   GET   /api/memory/project-files                             every project's files and their states, needs-you first
 *   GET   /api/memory/project-files/:projectId/compare?path=    Girru's version beside the folder's
 *   POST  /api/memory/project-files/:projectId/rewrite          writes the files again (never over a file changed in both)
 *   POST  /api/memory/project-files/:projectId/use-girru        { path } Girru's version; the folder text becomes a proposal -> { project, undo }
 *   POST  /api/memory/project-files/:projectId/undo             { undo } puts the folder text back, withdraws the proposal
 *   PATCH /api/memory/project-files/:projectId                  { writeFiles?, companyFacts? }
 *   GET   /api/memory/project-files/needs-you                   task-number problems in the projects' task files
 *   POST  /api/memory/project-files/needs-you/:id               { action: new_task | add_task | leave }
 *   GET   /api/memory/place-settings                            which Memory places stay on this computer
 *   PUT   /api/memory/place-settings/:place                     { staysLocal }
 *
 * The dpro-memory MCP server (public in the gate; loopback only, own proof):
 *   POST  /api/memory-bridge/mcp/session   { client, nonce, proof } -> { token }   (install proof, CLI switched on)
 *   POST  /api/memory-bridge/mcp/call      header x-dpro-bridge-token; { client, cwd, tool, args } -> { text, data }
 *
 * Errors: { error, code } with 400 / 401 / 403 / 404 / 409 / 422.
 */
import { storeP8Enabled } from '../../services/store-p8.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { storeP4Enabled } from '../../services/store-p4.js';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import {
  activity, backflowNow, BridgeError, bridgeStatus, cleanUpTools, filesApply, filesPreview, mcpCall, openSession, registrationApply, registrationPreview,
  registrationUndo, setClient, setFolder,
} from '../../memory/bridge/service.js';
import { CAPABILITY_HEADER, CapabilityError, issueCapability, listCapabilities, revokeCapability } from '../../memory/bridge/capability.js';
import { findProject } from '../../repositories/chat-conversations.js';
import { projectScope } from '../../memory/outbox/events.js';
import { runBriefProjection, syncStatus } from '../../memory/outbox/projection.js';
import { isPilotProject } from '../../memory/outbox/pilot.js';
import { storeP6Enabled } from '../../services/store-p6.js';
import { storeP9Enabled } from '../../services/store-p9.js';
import { storeP9bEnabled } from '../../services/store-p9b.js';
import { storeP2Enabled } from '../../services/agent-context/switch.js';
import { storeP7Enabled } from '../../services/store-p7.js';
import { layoutApply, layoutPreview } from '../../memory/bridge/layout.js';
import { approveTaskFile, revokeTaskFile, taskTrust, TaskTrustError } from '../../services/task-file-trust.js';
import { storeP3Enabled } from '../../services/store-p3.js';
import { compareFile, listProjectFiles, patchProjectFiles, rewriteFiles, undoUseGirru, useGirruVersion } from '../../memory/bridge/project-files.js';
import { numberProblems, resolveNumberProblem } from '../../services/task-file.js';
import { BoardError } from '../../services/task-board.js';
import { PlaceSettingsError, placeSettings, setPlaceSetting } from '../../memory/place-settings.js';

const OWNER_ONLY = ['owner'] as const;
export const BRIDGE_TOKEN_HEADER = 'x-dpro-bridge-token';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string | undefined>; Body: unknown }>;
const bodyOf = (r: { body?: unknown }): Record<string, any> => (r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body as Record<string, any> : {});

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof BridgeError || err instanceof CapabilityError || err instanceof TaskTrustError || err instanceof PlaceSettingsError || err instanceof BoardError) return reply.code(err.status).send({ error: err.message, code: err.code });
  throw err;
}

export async function memoryBridgeRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  const owner = (request: FastifyRequest, reply: FastifyReply) => authorizeActiveRole(request, reply, OWNER_ONLY);
  /** Runs `fn` for the owner; BridgeError -> its status. */
  const asOwner = (fn: (ownerId: string, request: Req) => Promise<unknown>) => async (request: Req, reply: FastifyReply) => {
    const ownerId = owner(request, reply);
    if (ownerId === null) return reply;
    try { return await fn(ownerId, request); } catch (err) { return fail(reply, err); }
  };

  fastify.get('/api/memory-bridge', { config }, asOwner((o) => bridgeStatus(o)));
  fastify.put('/api/memory-bridge/clients/:client', { config }, asOwner((o, r) => setClient(o, r.params.client, bodyOf(r).enabled)));
  fastify.get('/api/memory-bridge/clients/:client/registration', { config }, asOwner(async (o, r) => ({ preview: await registrationPreview(o, r.params.client) })));
  fastify.post('/api/memory-bridge/clients/:client/registration', { config }, asOwner((o, r) => registrationApply(o, r.params.client, bodyOf(r))));
  fastify.post('/api/memory-bridge/registrations/:id/undo', { config }, asOwner((o, r) => registrationUndo(o, r.params.id)));
  fastify.get('/api/memory-bridge/projects/:projectId/files', { config }, asOwner(async (o, r) => ({ preview: await filesPreview(o, r.params.projectId) })));
  fastify.post('/api/memory-bridge/projects/:projectId/files', { config }, asOwner(async (o, r) => ({ result: await filesApply(o, r.params.projectId, bodyOf(r)) })));
  // STORE-MAP-01 P7: the project folder layout, a dry run first, then the write the owner confirmed.
  if (storeP7Enabled()) {
    fastify.get('/api/memory-bridge/projects/:projectId/layout', { config }, asOwner(async (o, r) => ({ preview: await layoutPreview(o, r.params.projectId) })));
    fastify.post('/api/memory-bridge/projects/:projectId/layout', { config }, asOwner(async (o, r) => ({ result: await layoutApply(o, r.params.projectId, bodyOf(r)) })));
    // OPS8: Girru's entries out of every tool config (the uninstaller calls this).
    fastify.post('/api/memory-bridge/clean-up', { config }, asOwner((o) => cleanUpTools(o)));
    // SEC2-3: tasks from the project's file run tools only after the owner approves the project once.
    fastify.get('/api/memory-bridge/projects/:projectId/task-approval', { config }, asOwner(async (o, r) => ({ approval: await taskTrust(o, r.params.projectId) })));
    fastify.post('/api/memory-bridge/projects/:projectId/task-approval', { config }, asOwner(async (o, r) => ({ approval: await approveTaskFile(o, r.params.projectId, bodyOf(r)) })));
    fastify.delete('/api/memory-bridge/projects/:projectId/task-approval', { config }, asOwner(async (o, r) => ({ approval: await revokeTaskFile(o, r.params.projectId) })));
  }
  fastify.patch('/api/memory-bridge/projects/:projectId', { config }, asOwner(async (o, r) => ({ folder: await setFolder(o, r.params.projectId, bodyOf(r)) })));
  fastify.post('/api/memory-bridge/projects/:projectId/backflow', { config }, asOwner(async (o, r) => ({ result: await backflowNow(o, r.params.projectId) })));
  fastify.get('/api/memory-bridge/audit', { config }, asOwner(async (o, r) => ({
    entries: await activity(o, { limit: r.query?.limit, client: r.query?.client, projectId: r.query?.projectId }),
  })));

  // STORE-MAP-01 P2: which storage switches are on (the app shows the matching words). P6 is named only while it is on.
  fastify.get('/api/store-switches', { config }, asOwner(async () => ({ p2: storeP2Enabled(), p3: storeP3Enabled(), p4: storeP4Enabled(), ...(storeP6Enabled() ? { p6: true } : {}), ...(storeP8Enabled() ? { p8: true } : {}), ...(storeP9Enabled() ? { p9: true } : {}), ...(storeP9bEnabled() ? { p9b: true } : {}) })));

  // --- STORE-MAP-01 P6 screens: project files, task-number problems, place settings (owner only) ---
  if (storeP6Enabled()) {
    fastify.get('/api/memory/project-files', { config }, asOwner((o) => listProjectFiles(o)));
    fastify.get('/api/memory/project-files/needs-you', { config }, asOwner(async (o) => ({ items: await numberProblems(o) })));
    fastify.post('/api/memory/project-files/needs-you/:id', { config }, asOwner((o, r) => resolveNumberProblem(o, r.params.id, bodyOf(r).action)));
    fastify.get('/api/memory/project-files/:projectId/compare', { config }, asOwner((o, r) => compareFile(o, r.params.projectId, r.query?.path)));
    fastify.post('/api/memory/project-files/:projectId/rewrite', { config }, asOwner((o, r) => rewriteFiles(o, r.params.projectId)));
    fastify.post('/api/memory/project-files/:projectId/use-girru', { config }, asOwner((o, r) => useGirruVersion(o, r.params.projectId, bodyOf(r).path)));
    fastify.post('/api/memory/project-files/:projectId/undo', { config }, asOwner((o, r) => undoUseGirru(o, r.params.projectId, bodyOf(r).undo)));
    fastify.patch('/api/memory/project-files/:projectId', { config }, asOwner((o, r) => patchProjectFiles(o, r.params.projectId, bodyOf(r))));
    fastify.get('/api/memory/place-settings', { config }, asOwner((o) => placeSettings(o)));
    fastify.put('/api/memory/place-settings/:place', { config }, asOwner((o, r) => setPlaceSetting(o, r.params.place, bodyOf(r).staysLocal)));
  }

  // --- STORE-MAP-01 pilot: session capabilities and the brief projection (owner only) ---
  const pilotProject = async (o: string, id: string) => {
    const p = await findProject(o, id);
    if (!p) throw new BridgeError('Not found', 404, 'not_found');
    // P6 rolls the change log and the brief projection out to every project.
    if (!isPilotProject(p.id) && !storeP6Enabled()) throw new BridgeError('This project is not in the storage pilot', 409, 'not_pilot');
    return p;
  };
  fastify.post('/api/memory-bridge/projects/:projectId/capabilities', { config }, asOwner(async (o, r) => {
    const b = bodyOf(r);
    const issued = await issueCapability({ ownerId: o, actorId: o, actorRole: 'owner', projectId: r.params.projectId,
      scopes: Array.isArray(b.scopes) ? b.scopes : [], client: typeof b.client === 'string' ? b.client : null, ttlMs: b.ttlMs });
    return { token: issued.token, capability: issued.capability };
  }));
  fastify.get('/api/memory-bridge/projects/:projectId/capabilities', { config }, asOwner(async (o, r) => ({ capabilities: await listCapabilities(o, r.params.projectId) })));
  fastify.delete('/api/memory-bridge/capabilities/:id', { config }, asOwner(async (o, r) => {
    if (!(await revokeCapability(o, r.params.id))) throw new BridgeError('Not found', 404, 'not_found');
    return { revoked: true };
  }));
  fastify.get('/api/memory-bridge/projects/:projectId/sync', { config }, asOwner(async (o, r) => ({ sync: await syncStatus(projectScope(await pilotProject(o, r.params.projectId))) })));
  fastify.post('/api/memory-bridge/projects/:projectId/sync', { config }, asOwner(async (o, r) => {
    const p = await pilotProject(o, r.params.projectId);
    const action = bodyOf(r).action;
    if (action !== 'rebuild' && action !== 'use_girru_version') throw new BridgeError('action must be rebuild or use_girru_version', 400, 'invalid_action');
    return { result: await runBriefProjection(projectScope(p), action === 'rebuild' ? { force: true } : { force: true, overwrite: true }) };
  }));

  // --- the dpro-memory MCP server (no user token; its own proof, this machine only) ---
  const local = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (LOOPBACK.has(request.socket?.remoteAddress ?? '')) return true;
    reply.code(403).send({ error: 'Only from this computer', code: 'forbidden' });
    return false;
  };

  fastify.post('/api/memory-bridge/mcp/session', async (request: Req, reply) => {
    if (!local(request, reply)) return reply;
    try { return await openSession(bodyOf(request).client, bodyOf(request).nonce, bodyOf(request).proof); } catch (err) { return fail(reply, err); }
  });

  fastify.post('/api/memory-bridge/mcp/call', async (request: Req, reply) => {
    if (!local(request, reply)) return reply;
    const b = bodyOf(request);
    try { return await mcpCall(b.client, request.headers[BRIDGE_TOKEN_HEADER], b.cwd, b.tool, b.args ?? {}, request.headers[CAPABILITY_HEADER]); } catch (err) { return fail(reply, err); }
  });
}
