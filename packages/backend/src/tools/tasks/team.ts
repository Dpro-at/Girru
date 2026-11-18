import { all, one, sql } from '../../repositories/sql-steps.js';
import type { Tool, ToolExecutionContext, ToolResult } from '../types.js';
import { runTeamAssignment } from '../../services/team-delegation.js';
import { subscriptionModel } from '../../services/subscription-chat.js';
import { currentChatRun } from '../../services/chat-run-context.js';
import { mayDelegate, orgRows, placeAgents, teamRole, type OrgRow } from '../../services/agent-org.js';
import { storeP8Enabled } from '../../services/store-p8.js';

type Agent = { id: string; name: string; model: string; provider: string; temperature: number; max_tokens: number };
/** CH6/CH10: why a hand-off did not finish, so the chat can offer the owner's next step (it never re-runs by itself). */
export type TeamFailure = 'timed_out' | 'no_model' | 'model_unavailable';
const WHY: Record<TeamFailure, string> = { timed_out: 'the agent ran out of time (4 minutes)', no_model: 'the agent has no model set', model_unavailable: 'the agent\'s model is not available' };
const fail = (why?: TeamFailure): ToolResult => why
  ? { content: [{ type: 'text', text: `Team request did not finish (${why}): ${WHY[why]}. Nothing runs again by itself; tell the owner.` }], error: 'team_request_refused', details: { status: why } }
  : { content: [{ type: 'text', text: 'Team request could not run. Check the selected agent, configured reply source, grants and approval.' }], error: 'team_request_refused' };
/** The whole hand-off's time limit (every model call and tool of the child together). */
export const DELEGATION_MS = 240_000;
/** A failed hand-off's reason: the time limit (not the owner's Stop), or a model the child cannot use; otherwise none. */
export function teamFailure(err: unknown, timedOut: boolean, stopped: boolean): TeamFailure | undefined {
  if (stopped) return undefined;
  if (timedOut) return 'timed_out';
  return err instanceof Error && err.message === 'model_unavailable' ? 'model_unavailable' : undefined;
}

/**
 * The calling agent may coordinate at all: an owner chat, not itself a delegated child or task run,
 * and not a sub-agent. Who it may give work to is mayDelegate (AGENTS-ORG-01): the main agent anyone
 * but other agents' sub-agents; a manager (anyone else) the agents under it and its own sub-agents.
 */
export async function coordinator(context?: ToolExecutionContext): Promise<OrgRow[] | null> {
  if (!context?.userId || !context.agentId || !context.sessionId || context.toolPolicy || context.delegatedFrom?.length || context.taskId) return null;
  const owner = await sql().read(one<{ role: string }>('SELECT role FROM users WHERE id=?', context.userId));
  if (owner?.role !== 'owner') return null;
  const rows = await orgRows();
  const me = rows.find(r => r.id === context.agentId);
  if (!me || (me.parent_agent_id && rows.some(r => r.id === me.parent_agent_id))) return null;
  return rows;
}

export const teamListTool: Tool = {
  name: 'team_list',
  description: 'List the team agents you may give work to with their role, department and configured reply sources: as the main agent, the team; as a manager, the agents under you; and your own sub-agents. Only in an owner chat. No agents or grants are created.',
  input_schema: { type: 'object', properties: {} },
  async execute(_params, context) {
    const rows = await coordinator(context);
    if (!rows) return fail();
    const allowed = new Set(rows.filter(r => mayDelegate(context!.agentId!, r.id, rows)).map(r => r.id));
    // Each agent's role (its place in the chart wins: main agent, sub-agent) and department ("" = none).
    const placement = placeAgents(rows), byId = new Map(rows.map(r => [r.id, r]));
    const agents = (await sql().read(all<Agent>('SELECT id,name,model,provider FROM agents_config WHERE id<>? ORDER BY name,id', context!.agentId!))).filter(a => allowed.has(a.id)).slice(0, 100)
      .map(a => { const r = byId.get(a.id)!; return { ...a, role: teamRole(r, placement.get(a.id)), department: r.department || null }; });
    return { content: [{ type: 'text', text: JSON.stringify(agents) }], details: { count: agents.length, limit: 100 } };
  },
};

// A coordinator gets one active child at a time; no background queue or detached inference.
const active = new Set<string>();
/** CHAT-BUILD-01: one model call of a delegated agent (was 30 s, too short for real work). */
export const CHILD_CALL_MS = 120_000;
/** Running delegations per conversation, so Stop in that chat reaches them. */
const delegations = new Map<string, Set<AbortController>>();
/** CH6: the step each delegated agent of a conversation is on now (the tool it runs), for the hand-off card's live line. */
const steps = new Map<string, Map<string, { tool: string; at: string }>>();
const setStep = (session: string, agent: string, tool: string | null) => {
  if (!session) return;
  const m = steps.get(session) ?? new Map();
  if (tool) m.set(agent, { tool, at: new Date().toISOString() }); else m.delete(agent);
  if (m.size) steps.set(session, m); else steps.delete(session);
};
/** The live steps of this conversation's delegated agents. */
export function delegationSteps(sessionId: string): { agentId: string; tool: string; at: string }[] {
  return [...(steps.get(sessionId)?.entries() ?? [])].map(([agentId, s]) => ({ agentId, ...s }));
}
/** Stops every delegated agent working for this conversation; returns how many were stopped. */
export function stopDelegations(sessionId: string): number {
  const set = delegations.get(sessionId);
  if (!set) return 0;
  for (const c of set) c.abort();
  return set.size;
}
const untilAborted = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => signal.aborted ? Promise.reject(Error('cancelled'))
  : new Promise<T>((resolve, reject) => { const stop = () => reject(Error('cancelled')); signal.addEventListener('abort', stop, { once: true }); work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop)); });
export const teamResultsTool: Tool = {
  name: 'team_results',
  description: 'Read the latest five delegated results for this owner conversation. Use after an approved delegation to collect and combine results. Started or waiting_approval means unfinished; never retry it automatically.',
  input_schema: { type: 'object', properties: {} },
  async execute(_params, context) {
    if (!await coordinator(context)) return fail();
    const { teamResults } = await import('../../services/team-results.js');
    const results = await teamResults(context!.userId!, context!.sessionId!, context!.agentId!);
    // Keep a bounded receipt for the calling model; full individual answers are already bounded.
    const text = JSON.stringify(results);
    if (Buffer.byteLength(text, 'utf8') > 22000) return { content: [{ type: 'text', text: JSON.stringify(results.slice(0, 1)) }], details: { omittedOlderResults: true } };
    return { content: [{ type: 'text', text }] };
  },
};
export const teamDelegateTool: Tool = {
  name: 'team_delegate',
  execClass: true,
  requiresApproval: true,
  description: 'Delegate one self-contained task to an agent you may give work to (see team_list: the team for the main agent, the agents under a manager, your own sub-agents), using that agent\'s own configured model, personality and specialties. Wait for its answer, review evidence, then combine results. Calls require the owner\'s approval and an explicit tool grant. Child tools are limited by both agents; recursive delegation is forbidden. A waiting approval is unfinished work.',
  input_schema: { type: 'object', properties: {
    agent_id: { type: 'string', description: 'Exact existing agent ID from team_list.' },
    request: { type: 'string', description: 'Self-contained task, expected deliverable and acceptance criteria (maximum 12000 characters).' },
    reply_source: { type: 'string', enum: ['subscription:claude', 'subscription:codex', 'subscription:gemini'], description: 'Optional explicit subscription source for this approved task only. Omit to use the agent\'s saved model. Does not change agent settings.' },
  }, required: ['agent_id', 'request'] },
  async execute(params, context) {
    const rows = await coordinator(context);
    if (!rows || typeof params.agent_id !== 'string' || !mayDelegate(context!.agentId!, params.agent_id, rows) || typeof params.request !== 'string' || !params.request.trim() || params.request.length > 12000 || params.agent_id === context!.agentId) return fail();
    if (params.reply_source !== undefined && !['subscription:claude', 'subscription:codex', 'subscription:gemini'].includes(params.reply_source)) return fail();
    // STORE-MAP-01 P8 (D26): an optional structured handoff and task number for the specialist.
    const p8 = storeP8Enabled();
    const handover = p8 ? await (await import('../../services/team-handover.js')).handoverOf(params, context!.userId!, context!.sessionId!) : null;
    if (typeof handover === 'string') return { content: [{ type: 'text', text: `Team request not sent: ${handover}.` }], error: 'team_request_refused' };
    const key = context!.userId!;
    if (active.has(key)) return fail();
    active.add(key);
    const stopper = new AbortController();
    const session = context!.sessionId ?? '';
    if (session) { const set = delegations.get(session) ?? new Set(); set.add(stopper); delegations.set(session, set); }
    let resultId: string | undefined;
    const limit = AbortSignal.timeout(DELEGATION_MS);
    const { startTeamResult, finishTeamResult } = await import('../../services/team-results.js');
    try {
      const saved = await sql().read(one<Agent>('SELECT id,name,model,provider,temperature,max_tokens FROM agents_config WHERE id=?', params.agent_id));
      const target = saved ? { ...saved, model: params.reply_source ?? saved.model } : undefined;
      if (!target) return fail();
      if (!target.model?.trim()) return fail('no_model');
      if (!subscriptionModel(target.model) && !['ollama', 'local', 'claude'].includes(target.provider)) return fail('model_unavailable');
      const { chatWorkspace, runSubscription } = await import('../../services/subscription-chat.js');
      const folder = context!.fileReadRoot ?? await chatWorkspace(context!.sessionId!);
      // Recompute rather than copy the parent's grants/permissions to the child.
      const { createAgentToolsRegistry } = await import('../index.js');
      const registry = await createAgentToolsRegistry({
        userId: context!.userId, accessOwnerId: context!.accessOwnerId, sessionId: context!.sessionId,
        agentId: target.id, delegatedFrom: [context!.agentId!], workspaceDir: folder,
        fileReadRoot: folder, memoryDrawers: context!.memoryDrawers, chatPlan: false, handoffTools: false,
      });
      const { subscriptionAgentContext } = await import('../../services/subscription-agent-context.js');
      const instructions = await subscriptionAgentContext(target.id, { delegatedBy: context!.agentId!, sessionId: context!.sessionId });
      const signal = AbortSignal.any([limit, stopper.signal]);
      // The chat's thinking level goes with the hand-off (read once here, in the lead's run).
      const thinking = currentChatRun()?.thinking;
      const reply = async (prompt: string): Promise<string> => {
        if (signal.aborted) throw Error('cancelled');
        if (subscriptionModel(target.model)) return runSubscription(target.model, folder, prompt, signal, { appToolsOnly: true, thinking, agentId: target.id });
        if (target.provider === 'ollama' || target.provider === 'local') {
          const { ollamaToolChat } = await import('../../llm/ollama-tool-chat.js');
          const result = await ollamaToolChat({ model: target.model, messages: [{ role: 'user', content: prompt }], tools: [], temperature: target.temperature, maxTokens: Math.min(target.max_tokens || 2048, 8192), timeoutMs: CHILD_CALL_MS, signal });
          return result.content;
        }
        const { resolveProviderApiKey } = await import('../../credentials/authority.js');
        const { modelCall } = await import('../../llm/model-call.js');
        const apiKey = await resolveProviderApiKey('claude', { agentId: target.id, noGlobal: true });
        if (!apiKey) throw Error('model_unavailable');
        const result = await untilAborted(modelCall({ actor: target.id }, { purpose: 'task_run', prompt, maxOutputTokens: Math.min(target.max_tokens || 2048, 8192), timeoutMs: CHILD_CALL_MS, noLocal: true, paid: { provider: 'claude', model: target.model, apiKey } }), signal);
        if (!result.ok || result.provider !== 'claude') throw Error('model_unavailable');
        return result.text;
      };
      resultId = await startTeamResult({ owner: key, session: context!.sessionId!, coordinator: context!.agentId!, agent: target.id, model: target.model });
      let brief = '';
      if (handover) {
        // P8: the lead's note becomes the specialist's handoff (naming the lead); the specialist's run knows its task and
        // keeps its own note and working notes under this hand-off. Only a model not on this computer gets the new tools.
        const h = await import('../../services/team-handover.js');
        await h.saveLeadHandoff(key, context!.agentId!, target.id, handover);
        const lead = await sql().read(one<{ name: string }>('SELECT name FROM agents_config WHERE id=?', context!.agentId!));
        brief = h.handoverBlock(lead?.name ?? 'the lead agent', handover);
        const remote = !!subscriptionModel(target.model) || target.provider === 'claude';
        registry.updateContext({ delegation: { leadAgentId: context!.agentId!, runId: resultId, cardId: handover.cardId, taskNo: handover.taskNo, conversationId: handover.conversationId } });
        // A local model keeps exactly today's tools (no handoff tools for a delegated part, LOCAL-ONLY-01).
        if (remote) { registry.updateContext({ handoffTools: undefined }); (await import('../index.js')).useRemoteModelTools(registry); }
      }
      setStep(session, target.id, 'thinking');
      const result = await runTeamAssignment({ agentId: target.id, agentName: target.name, model: target.model, request: params.request.trim(), instructions: brief ? `${instructions}\n\n${brief}` : instructions }, {
        signal, tools: registry.getAll(), reply, execute: async (name, args) => { setStep(session, target.id, name); try { return await registry.execute(name, args); } finally { setStep(session, target.id, 'thinking'); } },
      });
      await finishTeamResult(resultId, result);
      if (handover) await (await import('../../services/team-handover.js')).afterHandover(key, resultId, context!.agentId!, target.id, handover).catch(() => undefined);
      return result;
    } catch (err) {
      const out = fail(teamFailure(err, limit.aborted, stopper.signal.aborted));
      if (resultId) await finishTeamResult(resultId, out).catch(() => {});
      return out;
    }
    finally { active.delete(key); setStep(session, params.agent_id as string, null); const set = delegations.get(session); set?.delete(stopper); if (set && !set.size) delegations.delete(session); }
  },
};

/**
 * STORE-MAP-01 P8 (D26): team_delegate with a structured handoff and the task
 * number. Offered in place of team_delegate only to models that are not on this
 * computer (tools/index.ts useRemoteModelTools), so a local model's list stays
 * as it was (LOCAL-ONLY-01). The same execute reads both only while P8 is on.
 */
const handoverList = (what: string, max = 8) => ({ type: 'array', items: { type: 'string' }, description: `${what} (up to ${max} short lines)` });
export const teamDelegateToolP8: Tool = {
  ...teamDelegateTool,
  description: `${teamDelegateTool.description} To hand over part of a task, give task (its number, like T-12) and handoff: what is done, what is left, the next steps, blockers and the files touched; the agent starts from it.`,
  input_schema: { type: 'object', properties: {
    ...teamDelegateTool.input_schema.properties,
    task: { type: 'string', description: 'Optional task number in this chat\'s project, like T-12.' },
    handoff: { type: 'object', description: 'Optional handoff for the agent: where the task stands.', properties: {
      done: handoverList('What is finished'), left: handoverList('What is still open'), next: handoverList('The next steps'),
      blockers: handoverList('What blocks the work'), files: handoverList('Files changed so far', 30),
    } },
  }, required: ['agent_id', 'request'] },
};
