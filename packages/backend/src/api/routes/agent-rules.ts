/**
 * Agents › Rules (RULES-01): the owner's rules for how the agents work. Owner
 * only (auth gate owner tier + handler check). Agents never change rules; they
 * suggest one with the rule_suggest tool (or the MCP workspace_rules suggest),
 * and the owner decides here.
 *
 *   GET    /api/agent-rules                         -> { rules, suggestions, departments, starter }
 *   POST   /api/agent-rules                         { text, projectId?, who?, targets?, paused? } -> 201 { rule }
 *   POST   /api/agent-rules/starter                 -> { added: rule[] }  our usual rules, added paused
 *   PUT    /api/agent-rules/:id                     partial rule -> { rule }
 *   POST   /api/agent-rules/:id/delete              -> { ok, undoMs }  kept for Undo
 *   POST   /api/agent-rules/:id/undo-delete         -> { rule }
 *   GET    /api/agent-rules/:id/versions            -> { versions }
 *   POST   /api/agent-rules/:id/versions/:v/restore -> { rule }
 *   POST   /api/agent-rules/suggestions             { text, reason?, projectId?, who?, targets? } -> 201 { rule }  (MCP agents)
 *   POST   /api/agent-rules/:id/accept | /dismiss   a suggestion -> { rule }
 *   GET    /api/agent-rules/effective?agentId=&projectId=  -> { rules }  what that agent gets, in order
 *   GET    /api/agent-rules/conflicts?agentId=&projectId=  -> { conflicts: [{a,b,why}], checked }  rules there that disagree (local model; b wins)
 *   POST   /api/agent-rules/:id/put-back             -> { rule }  a rule Girru ships, back as it came
 *   GET    /api/agent-rules/files/:projectId         -> { files }  what writing the coding app files would do (reads only)
 *   POST   /api/agent-rules/files/:projectId         { mode: private|project } -> { files }  write them (the owner's button)
 *   PUT    /api/agent-rules/files/:projectId/tasks   { on } -> { files }  TASKLOG-01: the project's task file on or off
 *   files.tasks = { on, file: '.girru/tasks.md', open (tasks on the board), problems: [{ line, message }] }
 *   400 { error, code: 'invalid_rule' } · 404 { error, code: 'not_found' }
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { storeP2Enabled } from '../../services/agent-context/switch.js';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { q } from '../../repositories/sql-steps.js';
import { RuleFilesError, filesState, setTasks, syncWrittenProjects, writeFiles } from '../../services/agent-rule-files.js';
import { TASKS_FILE, ensureTaskFile, fileProblems, openTasks, syncTasks, taskFileOn, watchTaskFiles } from '../../services/task-file.js';
import {
  RuleInputError, STARTER_RULES, suggestRule, UNDO_MS, addStarterRules, createRule, decideSuggestion, deleteRule, editRule,
  effectiveByPrecedence, effectiveRules, listRules, putBack, ruleConflicts, restoreVersion, ruleVersions, undoDelete,
} from '../../services/agent-rules.js';

const OWNER_ONLY = ['owner'] as const;
const owner = (request: FastifyRequest, reply: FastifyReply) => authorizeActiveRole(request, reply, OWNER_ONLY);
const ID = /^[0-9a-f-]{36}$/;
type Req = FastifyRequest<{ Params: { id?: string; v?: string }; Querystring: { agentId?: string; projectId?: string }; Body: unknown }>;
const bad = (reply: FastifyReply, err: unknown) => {
  if (err instanceof RuleInputError) return reply.code(400).send({ error: err.message, code: 'invalid_rule' });
  throw err;
};
const missing = (reply: FastifyReply) => reply.code(404).send({ error: 'Rule not found', code: 'not_found' });

export async function agentRulesRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  const id = (request: Req) => (ID.test(request.params.id ?? '') ? request.params.id! : null);
  // RULES-03: after a rule changes, the coding app files of the projects the owner already wrote follow.
  fastify.addHook('onResponse', async (request, reply) => {
    if ((request.method === 'POST' || request.method === 'PUT') && reply.statusCode < 300 && !/\/(suggestions|files\/[^/]+)$/.test(request.url.split('?')[0])) void syncWrittenProjects();
  });
  const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;
  // TASKLOG-01: the task file part of the files sheet.
  const withTasks = async <T extends { projectId: string }>(f: T) => {
    const on = await taskFileOn(f.projectId);
    return { ...f, tasks: { on, file: TASKS_FILE, open: on ? await openTasks(f.projectId) : 0, problems: on ? await fileProblems(f.projectId) : [] } };
  };
  const afterWrite = async (pid: string) => {
    if (await taskFileOn(pid)) { await ensureTaskFile(pid); await syncTasks(pid).catch(() => undefined); }
    await watchTaskFiles().catch(() => undefined);
    return filesState(pid);
  };
  const filesError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof RuleFilesError) return reply.code(err.code === 'not_found' ? 404 : 400).send({ error: err.message, code: err.code });
    throw err;
  };
  fastify.post('/api/agent-rules/:id/put-back', { config }, async (request: Req, reply) => {
    if (owner(request, reply) === null) return reply;
    const rid = id(request); if (!rid) return missing(reply);
    try { const rule = await putBack(rid); return rule ? { rule } : missing(reply); } catch (err) { return bad(reply, err); }
  });
  fastify.get('/api/agent-rules/files/:id', { config }, async (request: Req, reply) => {
    if (owner(request, reply) === null) return reply;
    const pid = String(request.params.id); if (!PROJECT.test(pid)) return missing(reply);
    try { return { files: await withTasks(await filesState(pid)) }; } catch (err) { return filesError(reply, err); }
  });
  fastify.post('/api/agent-rules/files/:id', { config }, async (request: Req, reply) => {
    if (owner(request, reply) === null) return reply;
    const pid = String(request.params.id); if (!PROJECT.test(pid)) return missing(reply);
    const b = request.body as { mode?: unknown } | null;
    if (!b || typeof b !== 'object' || Object.keys(b).length !== 1 || (b.mode !== 'private' && b.mode !== 'project')) return reply.code(400).send({ error: 'mode is private or project', code: 'invalid_rule' });
    try { await writeFiles(pid, b.mode); return { files: await withTasks(await afterWrite(pid)) }; } catch (err) { return filesError(reply, err); }
  });
  fastify.put('/api/agent-rules/files/:id/tasks', { config }, async (request: Req, reply) => {
    if (owner(request, reply) === null) return reply;
    const pid = String(request.params.id); if (!PROJECT.test(pid)) return missing(reply);
    const b = request.body as { on?: unknown } | null;
    if (!b || typeof b !== 'object' || Object.keys(b).length !== 1 || typeof b.on !== 'boolean') return reply.code(400).send({ error: 'on is true or false', code: 'invalid_rule' });
    try { await setTasks(pid, b.on); return { files: await withTasks(await afterWrite(pid)) }; } catch (err) { return filesError(reply, err); }
  });

  fastify.get('/api/agent-rules', { config }, async (request: Req, reply) => {
    if (owner(request, reply) === null) return reply;
    const deps = await q.all<{ department: string }>("SELECT DISTINCT lower(department) AS department FROM agents_config WHERE department IS NOT NULL AND department <> '' ORDER BY 1");
    return { ...(await listRules()), departments: deps.map((d) => d.department), starter: STARTER_RULES, precedence: storeP2Enabled() };
  });
  fastify.post('/api/agent-rules', { config, bodyLimit: 20000 }, async (request: Req, reply) => {
    const by = owner(request, reply); if (by === null) return reply;
    try { return reply.code(201).send({ rule: await createRule(request.body, by) }); } catch (err) { return bad(reply, err); }
  });
  fastify.post('/api/agent-rules/starter', { config }, async (request: Req, reply) => {
    const by = owner(request, reply); if (by === null) return reply;
    try { return { added: await addStarterRules(by) }; } catch (err) { return bad(reply, err); }
  });
  // An agent working over MCP suggests a rule; it waits for the owner like one from the rule_suggest tool.
  fastify.post('/api/agent-rules/suggestions', { config, bodyLimit: 20000 }, async (request: Req, reply) => {
    if (owner(request, reply) === null) return reply;
    const b = request.body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return reply.code(400).send({ error: 'A suggestion is { text, reason? }', code: 'invalid_rule' });
    const { reason, ...rule } = b;
    try { return reply.code(201).send({ rule: await suggestRule(rule, null, reason) }); } catch (err) { return bad(reply, err); }
  });
  fastify.get('/api/agent-rules/effective', { config }, async (request: Req, reply) => {
    if (owner(request, reply) === null) return reply;
    const { agentId, projectId } = request.query;
    if (typeof agentId !== 'string' || !agentId || agentId.length > 120) return reply.code(400).send({ error: 'agentId is required', code: 'invalid_rule' });
    const project = typeof projectId === 'string' && projectId ? projectId : null;
    // STORE-MAP-01 P2 (AG6): strongest group first, each rule with its group.
    if (storeP2Enabled()) return { rules: await effectiveByPrecedence(agentId, project), precedence: true };
    return { rules: await effectiveRules(agentId, project) };
  });
  fastify.get('/api/agent-rules/conflicts', { config }, async (request: Req, reply) => {
    if (owner(request, reply) === null) return reply;
    const { agentId, projectId } = request.query;
    if (typeof agentId !== 'string' || !agentId || agentId.length > 120) return reply.code(400).send({ error: 'agentId is required', code: 'invalid_rule' });
    const project = typeof projectId === 'string' && projectId ? projectId : null;
    return ruleConflicts(storeP2Enabled() ? await effectiveByPrecedence(agentId, project) : await effectiveRules(agentId, project));
  });
  fastify.put('/api/agent-rules/:id', { config, bodyLimit: 20000 }, async (request: Req, reply) => {
    if (owner(request, reply) === null) return reply;
    const rid = id(request); if (!rid) return missing(reply);
    try { const rule = await editRule(rid, request.body); return rule ? { rule } : missing(reply); } catch (err) { return bad(reply, err); }
  });
  fastify.post('/api/agent-rules/:id/delete', { config }, async (request: Req, reply) => {
    if (owner(request, reply) === null) return reply;
    const rid = id(request); if (!rid) return missing(reply);
    try { return (await deleteRule(rid)) ? { ok: true, undoMs: UNDO_MS } : missing(reply); } catch (err) { return bad(reply, err); }
  });
  fastify.post('/api/agent-rules/:id/undo-delete', { config }, async (request: Req, reply) => {
    if (owner(request, reply) === null) return reply;
    const rid = id(request); if (!rid) return missing(reply);
    const rule = await undoDelete(rid); return rule ? { rule } : missing(reply);
  });
  fastify.get('/api/agent-rules/:id/versions', { config }, async (request: Req, reply) => {
    if (owner(request, reply) === null) return reply;
    const rid = id(request); if (!rid) return missing(reply);
    return { versions: await ruleVersions(rid) };
  });
  fastify.post('/api/agent-rules/:id/versions/:v/restore', { config }, async (request: Req, reply) => {
    if (owner(request, reply) === null) return reply;
    const rid = id(request), v = Number(request.params.v);
    if (!rid || !Number.isInteger(v) || v < 1) return missing(reply);
    try { const rule = await restoreVersion(rid, v); return rule ? { rule } : missing(reply); } catch (err) { return bad(reply, err); }
  });
  for (const [path, use] of [['accept', true], ['dismiss', false]] as const) {
    fastify.post(`/api/agent-rules/:id/${path}`, { config }, async (request: Req, reply) => {
      if (owner(request, reply) === null) return reply;
      const rid = id(request); if (!rid) return missing(reply);
      const rule = await decideSuggestion(rid, use); return rule ? { rule } : missing(reply);
    });
  }
}
