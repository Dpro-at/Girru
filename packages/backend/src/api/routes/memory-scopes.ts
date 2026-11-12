/**
 * Memory at scale API (MEM-SCALE-01). Owner only (auth gate owner tier for
 * /api/memory/scopes* and /api/memory/access*, route access 'owner',
 * handler role check). Every change is written to the audit log.
 *
 * Scope tree and explorer
 *   GET  /api/memory/scopes/tree?fresh=1           company / departments / projects / people / agents, counts + health
 *   GET  /api/memory/scopes/search?q=&kinds=&limit= scopes by name (department, project, people, agent)
 *   GET  /api/memory/scopes/agents?q=&cursor=&limit= agents as scopes, paged
 *   GET  /api/memory/scopes/memories?scope=&q=&type=&layer=&topic=&source=&agent=&importance=&from=&to=&cursor=&limit=
 *                                                   memories of one scope, newest first, cursor paging + facets;
 *                                                   scope also kind:<drawer kind>; items carry usedIn (MEM-GAPS-02)
 *   GET  /api/memory/scopes/memories/:id           one memory: text, used in N replies, linked entities, readers, validity (P3)
 *   PUT  /api/memory/scopes/memories/:id/checked   { checked } Mark as checked / undo (GIRRU_STORE_P3)
 * Review rules per scope (MEM-GAPS-02)
 *   GET  /api/memory/scopes/rules?scope=           { scope, own, effective }
 *   GET  /api/memory/scopes/rules/all              { rules: [{ scope, own }] }
 *   PUT  /api/memory/scopes/rules                  { scope, routine?, important?, contradiction?, reviewerAgentId?, weeklyDay?, weeklyHour? }
 * Departments
 *   POST /api/memory/scopes/departments            { name } -> 201 { department }
 *   PATCH /api/memory/scopes/departments/:id       { name } -> { department }
 *   POST /api/memory/scopes/departments/:id/delete-preview            -> { department, effects, previewHash }
 *   POST /api/memory/scopes/departments/:id/delete { expectedPreviewHash, confirm: true } -> { department, effects }
 * Pinned facts (company | department:<id> | project:<slug>)
 *   GET  /api/memory/scopes/pinned?scope=          -> { scope, facts }
 *   POST /api/memory/scopes/pinned                 { scope, text } -> 201 { fact }
 *   PATCH /api/memory/scopes/pinned/:id            { text?, position? } -> { fact }
 *   DELETE /api/memory/scopes/pinned/:id           -> { ok: true }
 * Project lifecycle (pin | unpin | archive | unarchive | move | merge | forget)
 *   POST /api/memory/scopes/projects/:slug/preview { action, target?, departmentId? } -> { action, project, target?, department?, effects, previewHash }
 *   POST /api/memory/scopes/projects/:slug/apply   { action, target?, departmentId?, expectedPreviewHash, confirm: true } -> { action, project, effects, result }
 *   GET  /api/memory/scopes/projects/:slug/export  -> { project, files: [{ name, content }] }
 *   POST /api/memory/scopes/ask-agent              { agentId, request, text, drawer? } -> { text, note, agentId }  Ask an agent in the shared editor (MR5; proposal only, nothing saved)
 *   GET  /api/memory/scopes/hidden-keys            -> { total, drawers: [{ drawer, count, memories, kinds }] } keys hidden since the owner last answered (MR2; runs the one-time pass first)
 *   POST /api/memory/scopes/hidden-keys/answer     { answer: 'keep' | 'move', drawer? } -> { answered, moved }  Keep hidden here / Move to Connections
 *   POST /api/memory/scopes/hidden-keys/:id/reveal -> { value }  the owner's Show (audited; never cached)
 *   POST /api/memory/scopes/projects/:slug/kind    { kind: 'project' | 'library' } -> { slug, kind, before }  ("It's a project" / "Not a project", MEM-READ-01 MR3)
 * Access by inheritance
 *   GET  /api/memory/access                        -> { version, rules, templates }
 *   POST /api/memory/access/preview                { changes } -> { previewHash, version, agentsAffected, projectsAffected, ... }
 *   POST /api/memory/access/apply                  { changes, expectedPreviewHash, confirm: true } -> { version, preview }
 *   GET  /api/memory/access/effective/:agentId?project= -> effective access per drawer kind + why
 *   GET  /api/memory/access/agents?scope=&column=&mode=&q=&cursor=&limit= -> agents with that access (MEM-GAPS-02)
 *   GET  /api/memory/access/counts?column=&mode=   -> agents with access per company / department / project
 *   GET  /api/memory/access/templates/:id?cursor=&limit= -> one role template + the agents that use it
 *
 * Errors: 400 { error, code } (invalid_scope, preview_hash_required, confirm_required),
 * 404 not_found, 409 (preview_changed, name_taken, no_change, too_many, target_archived).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { repositories } from '../../repositories/index.js';
import type { Actor } from '../../repositories/actor.js';
import { requestMeta } from '../../repositories/audit.js';
import { actorOrReply, requireOwner } from '../../repositories/scope.js';
import { resolveFileAgent } from '../../memory/memory-files.js';
import { classifyLibraryProjects, setProjectKind } from '../../memory/scopes/project-kinds.js';
import { answerHiddenKeys, hiddenKeysReport, hideKeysOnce, revealKey } from '../../memory/hidden-keys.js';
import { AskAgentError, askAgentToEdit } from '../../memory/ask-agent.js';
import { provenanceJobStatus, setChecked } from '../../memory/validity.js';
import { vectorJobStatus } from '../../memory/vectors.js';
import { storeP3Enabled } from '../../services/store-p3.js';
import { adoptProjectMemory, currentProjectKey, deletedProjectMemory } from '../../memory/project-keys.js';
import { createProject as createChatProject, findProject as findChatProject } from '../../repositories/chat-conversations.js';
import {
  ScopeInputError, accessOverview, addPinnedFact, applyAccessChanges, applyProjectAction, createDepartment, deleteDepartment, effectiveAccess,
  exploreScope, exportProject, invalidateScopeTree, listAgentScopes, listPinnedFacts, parseActionInput, parsePinnedScope, pinnedScopeId,
  previewAccessChanges, previewDeleteDepartment, previewProjectAction, removePinnedFact, renameDepartment, scopeTree, searchScopes, updatePinnedFact,
  accessCounts, agentsWithAccess, listScopeRules, memoryDetail, scopeRules, setScopeRules, templateDetail,
} from '../../memory/scopes/index.js';

function ownerOf(request: FastifyRequest, reply: FastifyReply): Actor | null {
  return actorOrReply(reply, actorOf(request), requireOwner);
}

const q = (request: FastifyRequest): Record<string, unknown> => {
  const v = request.query;
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
};

function body(request: FastifyRequest): Record<string, unknown> {
  const b = request.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new ScopeInputError('Body must be a JSON object');
  return b as Record<string, unknown>;
}

function send(reply: FastifyReply, err: unknown) {
  if (err instanceof ScopeInputError) return reply.code(err.status).send({ error: err.message, code: err.code });
  throw err;
}

function audit(request: FastifyRequest, owner: Actor, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>, success = true) {
  void repositories.audit.record(owner, {
    event_type: 'data.update', event_category: 'data_modification', severity: success ? 'info' : 'warning',
    resource_type: resourceType, resource_id: resourceId, action, success, metadata,
  }, requestMeta(request));
}

function requireConfirm(b: Record<string, unknown>): void {
  if (b.confirm !== true) throw new ScopeInputError('Confirm the change (confirm: true)', 400, 'confirm_required');
}

/**
 * STORE-MAP-01 P3 compatibility (one release): a project named by its old slug
 * (a link, a saved filter, a merge target) is answered with its id.
 */
async function oldProjectNames(ownerId: string, request: FastifyRequest): Promise<void> {
  if (!storeP3Enabled()) return;
  const params = request.params as Record<string, string> | undefined;
  if (params?.slug) params.slug = await currentProjectKey(ownerId, params.slug);
  const fix = async (o: Record<string, unknown> | undefined, k: string) => {
    const v = o?.[k];
    if (typeof v !== 'string') return;
    if (k === 'target') o![k] = await currentProjectKey(ownerId, v);
    else if (v.startsWith('project:')) o![k] = `project:${await currentProjectKey(ownerId, v.slice(8))}`;
  };
  const query = request.query as Record<string, unknown> | undefined;
  const b = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : undefined;
  await fix(query, 'scope');
  await fix(b, 'scope');
  await fix(b, 'target');
}

export async function memoryScopeRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  type Handler = (owner: Actor, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  const route = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, handler: Handler) => fastify.route({
    method, url, config,
    handler: async (request, reply) => {
      const owner = ownerOf(request, reply);
      if (owner === null) return reply;
      try {
        await oldProjectNames(owner.userId!, request);
        return await handler(owner, request, reply);
      } catch (err) { return send(reply, err); }
    },
  });

  // ---- tree, search, agents, explorer ----
  route('GET', '/api/memory/scopes/tree', async (owner, request) => {
    const fresh = q(request).fresh;
    // MR3: projects found in downloaded code move to "Not projects" on their own (once).
    const marked = await classifyLibraryProjects(owner.userId!).catch(() => 0);
    if (marked) invalidateScopeTree(owner.userId!);
    return scopeTree(owner.userId!, { fresh: marked > 0 || fresh === '1' || fresh === 'true' });
  });
  // ---- Ask an agent in the shared editor (MEM-READ-01 MR5): a proposal only; the owner's Save is the only write ----
  route('POST', '/api/memory/scopes/ask-agent', async (owner, request, reply) => {
    const b = body(request);
    try {
      const out = await askAgentToEdit(owner.userId!, { agentId: b.agentId, request: b.request, text: b.text, drawer: b.drawer });
      audit(request, owner, 'memory.ask_agent', 'agents_config', out.agentId, { chars: typeof b.text === 'string' ? b.text.length : 0 });
      return out;
    } catch (err) {
      if (err instanceof AskAgentError) return reply.code(err.status).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  // ---- hidden keys (MEM-READ-01 MR2) ----
  route('GET', '/api/memory/scopes/hidden-keys', async (owner) => {
    await hideKeysOnce(owner.userId!).catch(() => undefined);
    const r = await hiddenKeysReport(owner.userId!);
    return { total: r.total, drawers: r.drawers };
  });
  route('POST', '/api/memory/scopes/hidden-keys/answer', async (owner, request) => {
    const b = body(request);
    if (b.answer !== 'keep' && b.answer !== 'move') throw new ScopeInputError('answer must be keep or move');
    if (b.drawer !== undefined && (typeof b.drawer !== 'string' || b.drawer.length > 200)) throw new ScopeInputError('Invalid drawer');
    const out = await answerHiddenKeys(owner.userId!, b.answer, b.drawer as string | undefined);
    audit(request, owner, 'memory.hidden_keys_answer', 'memory_hidden_keys', String(b.drawer ?? 'all'), { answer: b.answer, answered: out.answered, moved: out.moved });
    return out;
  });
  route('POST', '/api/memory/scopes/hidden-keys/:id/reveal', async (owner, request, reply) => {
    const id = (request.params as { id: string }).id;
    const value = await revealKey(owner.userId!, id);
    if (value === null) return reply.code(404).send({ error: 'Not found', code: 'not_found' });
    audit(request, owner, 'memory.hidden_key_reveal', 'memory_hidden_keys', id, {});
    reply.header('Cache-Control', 'no-store');
    return { value };
  });
  route('POST', '/api/memory/scopes/projects/:slug/kind', async (owner, request) => {
    const slug = (request.params as { slug: string }).slug;
    const out = await setProjectKind(owner.userId!, slug, body(request).kind, owner.userId!);
    invalidateScopeTree(owner.userId!);
    audit(request, owner, 'memory_scope.project_kind', 'memory_project', slug, { kind: out.kind, before: out.before });
    return out;
  });
  route('GET', '/api/memory/scopes/search', async (owner, request) => {
    const x = q(request);
    return { hits: await searchScopes(owner.userId!, x.q, x.kinds, x.limit) };
  });
  route('GET', '/api/memory/scopes/agents', async (owner, request) => listAgentScopes(owner.userId!, q(request)));
  route('GET', '/api/memory/scopes/memories', async (owner, request) => exploreScope(owner.userId!, q(request)));
  route('GET', '/api/memory/scopes/memories/:id', async (owner, request) => ({ memory: await memoryDetail(owner.userId!, (request.params as { id: string }).id) }));
  // STORE-MAP-01 P3 (FD3): "Mark as checked" and its undo. 404 while the switch is off.
  route('PUT', '/api/memory/scopes/memories/:id/checked', async (owner, request, reply) => {
    if (!storeP3Enabled()) return reply.code(404).send({ error: 'Not found', code: 'p3_off' });
    const trust = await setChecked(owner.userId!, (request.params as { id: string }).id, body(request).checked === true);
    if (!trust) return reply.code(404).send({ error: 'Memory not found', code: 'not_found' });
    audit(request, owner, 'memory.checked', 'memories', (request.params as { id: string }).id, { trust });
    return { trust };
  });

  // ---- review rules per scope ----
  route('GET', '/api/memory/scopes/rules', async (owner, request) => scopeRules(owner.userId!, q(request).scope ?? 'company'));
  route('GET', '/api/memory/scopes/rules/all', async (owner) => ({ rules: await listScopeRules(owner.userId!) }));
  route('PUT', '/api/memory/scopes/rules', async (owner, request) => {
    const { scope, ...changes } = body(request);
    const out = await setScopeRules(owner.userId!, scope ?? 'company', changes, owner.userId!);
    audit(request, owner, 'memory_scope.rules_set', 'memory_scope_rules', out.scope, { changes });
    return out;
  });

  // ---- departments ----
  route('POST', '/api/memory/scopes/departments', async (owner, request, reply) => {
    const department = await createDepartment(owner.userId!, body(request).name, owner.userId!);
    invalidateScopeTree(owner.userId!);
    audit(request, owner, 'memory_scope.department_create', 'memory_department', department.id, { name: department.name });
    return reply.code(201).send({ department });
  });
  route('PATCH', '/api/memory/scopes/departments/:id', async (owner, request) => {
    const id = (request.params as { id: string }).id;
    const department = await renameDepartment(owner.userId!, id, body(request).name);
    invalidateScopeTree(owner.userId!);
    audit(request, owner, 'memory_scope.department_rename', 'memory_department', id, { name: department.name });
    return { department };
  });
  route('POST', '/api/memory/scopes/departments/:id/delete-preview', async (owner, request) => previewDeleteDepartment(owner.userId!, (request.params as { id: string }).id));
  route('POST', '/api/memory/scopes/departments/:id/delete', async (owner, request) => {
    const id = (request.params as { id: string }).id;
    const b = body(request);
    requireConfirm(b);
    const out = await deleteDepartment(owner.userId!, id, b.expectedPreviewHash);
    audit(request, owner, 'memory_scope.department_delete', 'memory_department', id, { name: out.department.name, effects: out.effects });
    return { department: out.department, effects: out.effects };
  });

  // ---- pinned facts ----
  route('GET', '/api/memory/scopes/pinned', async (owner, request) => {
    const scope = parsePinnedScope(q(request).scope ?? 'company');
    return { scope: pinnedScopeId(scope), facts: await listPinnedFacts(owner.userId!, scope) };
  });
  route('POST', '/api/memory/scopes/pinned', async (owner, request, reply) => {
    const b = body(request);
    const fact = await addPinnedFact(owner.userId!, parsePinnedScope(b.scope), b.text, owner.userId!);
    invalidateScopeTree(owner.userId!);
    audit(request, owner, 'memory_scope.pinned_add', 'memory_pinned_fact', fact.id, { scope: fact.scope, chars: fact.text.length });
    return reply.code(201).send({ fact });
  });
  route('PATCH', '/api/memory/scopes/pinned/:id', async (owner, request) => {
    const id = (request.params as { id: string }).id;
    const b = body(request);
    const fact = await updatePinnedFact(owner.userId!, id, { text: b.text, position: b.position });
    audit(request, owner, 'memory_scope.pinned_update', 'memory_pinned_fact', id, { scope: fact.scope, chars: fact.text.length });
    return { fact };
  });
  route('DELETE', '/api/memory/scopes/pinned/:id', async (owner, request, reply) => {
    const id = (request.params as { id: string }).id;
    const fact = await removePinnedFact(owner.userId!, id);
    if (!fact) return reply.code(404).send({ error: 'Pinned fact not found', code: 'not_found' });
    invalidateScopeTree(owner.userId!);
    audit(request, owner, 'memory_scope.pinned_remove', 'memory_pinned_fact', id, { scope: fact.scope });
    return { ok: true };
  });

  // ---- project lifecycle ----
  // STORE-MAP-01 P3 (FD4d): data jobs after the update, for Memory › Health and backup.
  route('GET', '/api/memory/scopes/jobs', async (_owner, _request, reply) => {
    if (!storeP3Enabled()) return reply.code(404).send({ error: 'Not found', code: 'p3_off' });
    const [sources, vectors] = await Promise.all([provenanceJobStatus(), vectorJobStatus()]);
    return { jobs: [{ id: 'sources', ...sources }, { id: 'vectors', ...vectors }] };
  });
  // STORE-MAP-01 P3 (FD1): a real project made from Memory (no folder needed); the memory a deleted
  // project with the same name left behind, and "Use its memory". 404 while the switch is off.
  route('POST', '/api/memory/scopes/projects', async (owner, request, reply) => {
    if (!storeP3Enabled()) return reply.code(404).send({ error: 'Not found', code: 'p3_off' });
    const name = body(request).name;
    if (typeof name !== 'string' || !name.trim()) throw new ScopeInputError('Give the project a name');
    const p = await createChatProject(owner.userId!, { name });
    invalidateScopeTree(owner.userId!);
    return reply.code(201).send({ project: { key: p.id, name: p.name } });
  });
  route('GET', '/api/memory/scopes/projects/:slug/deleted-memory', async (owner, request, reply) => {
    if (!storeP3Enabled()) return reply.code(404).send({ error: 'Not found', code: 'p3_off' });
    const p = await findChatProject(owner.userId!, (request.params as { slug: string }).slug);
    if (!p) throw new ScopeInputError('Project not found', 404, 'not_found');
    return { memory: await deletedProjectMemory(owner.userId!, p) };
  });
  route('POST', '/api/memory/scopes/projects/:slug/adopt', async (owner, request, reply) => {
    if (!storeP3Enabled()) return reply.code(404).send({ error: 'Not found', code: 'p3_off' });
    const projectId = body(request).projectId;
    if (typeof projectId !== 'string') throw new ScopeInputError('projectId is required');
    const p = await findChatProject(owner.userId!, projectId);
    const offer = p ? await deletedProjectMemory(owner.userId!, p) : null;
    if (!offer || offer.key !== (request.params as { slug: string }).slug) throw new ScopeInputError('Nothing to take over', 409, 'nothing_to_adopt');
    const moved = await adoptProjectMemory(owner.userId!, offer.key, projectId);
    invalidateScopeTree(owner.userId!);
    audit(request, owner, 'memory_scope.project_adopt', 'memory_project', projectId, { from: offer.key, moved });
    return { moved };
  });
  route('POST', '/api/memory/scopes/projects/:slug/preview', async (owner, request) =>
    previewProjectAction(owner.userId!, (request.params as { slug: string }).slug, parseActionInput(body(request))));
  route('POST', '/api/memory/scopes/projects/:slug/apply', async (owner, request) => {
    const slug = (request.params as { slug: string }).slug;
    const b = body(request);
    const input = parseActionInput(b);
    requireConfirm(b);
    const agent = await resolveFileAgent().catch(() => '(none)');
    try {
      const { preview, result } = await applyProjectAction(owner.userId!, slug, input, b.expectedPreviewHash, owner.userId!, agent);
      audit(request, owner, `memory_scope.project_${input.action}`, 'memory_project', slug, { effects: preview.effects, result: { ...result, conflictReviews: undefined } });
      return { action: input.action, project: preview.project, effects: preview.effects, result };
    } catch (err) {
      if (err instanceof ScopeInputError && err.status === 409) audit(request, owner, `memory_scope.project_${input.action}`, 'memory_project', slug, { code: err.code }, false);
      throw err;
    }
  });
  route('GET', '/api/memory/scopes/projects/:slug/export', async (owner, request) => {
    const slug = (request.params as { slug: string }).slug;
    const out = await exportProject(owner.userId!, slug);
    audit(request, owner, 'memory_scope.project_export', 'memory_project', slug, { files: out.files.map((f) => f.name) });
    return out;
  });

  // ---- access by inheritance ----
  route('GET', '/api/memory/access', async (owner) => accessOverview(owner.userId!));
  route('POST', '/api/memory/access/preview', async (owner, request) => previewAccessChanges(owner.userId!, body(request).changes, owner.userId!));
  route('POST', '/api/memory/access/apply', async (owner, request) => {
    const b = body(request);
    requireConfirm(b);
    try {
      const out = await applyAccessChanges(owner.userId!, b.changes, b.expectedPreviewHash, owner.userId!);
      invalidateScopeTree(owner.userId!);
      const { sample: _sample, ...counts } = out.preview;
      audit(request, owner, 'memory_access.apply', 'memory_access', owner.userId!, { changes: b.changes, counts, version: out.version });
      return out;
    } catch (err) {
      if (err instanceof ScopeInputError && err.status === 409) audit(request, owner, 'memory_access.apply', 'memory_access', owner.userId!, { code: err.code }, false);
      throw err;
    }
  });
  route('GET', '/api/memory/access/agents', async (owner, request) => agentsWithAccess(owner.userId!, q(request)));
  route('GET', '/api/memory/access/counts', async (owner, request) => accessCounts(owner.userId!, q(request)));
  route('GET', '/api/memory/access/templates/:id', async (owner, request) => templateDetail(owner.userId!, (request.params as { id: string }).id, q(request)));
  route('GET', '/api/memory/access/effective/:agentId', async (owner, request, reply) => {
    const project = q(request).project;
    const out = await effectiveAccess(owner.userId!, (request.params as { agentId: string }).agentId, typeof project === 'string' && project ? project : null);
    if (!out) return reply.code(404).send({ error: 'Agent not found', code: 'not_found' });
    return out;
  });
}
