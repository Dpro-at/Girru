/**
 * STORE-MAP-01 P9 tools (boards P9c, P9d): what the owner does in Memory ›
 * People › person and in the personal-data review, from a chat with an agent.
 * Only while GIRRU_STORE_P9 is on.
 *
 * memory_person_export   everything about one person (memory/person.ts exportPerson).
 *                        The owner approves each call. Only when the person's drawer is
 *                        open for the run (so a place that stays on this computer never
 *                        reaches a model that is not local); memories that mention the
 *                        person in drawers not open for the run are given as a count.
 * memory_person_forget   forget the person in one action, after the owner approves the
 *                        call (irreversible, 'delete'). The same confirm as the window
 *                        (the person's key) and only mention ids the export listed in
 *                        drawers the agent may write.
 * memory_privacy_review  read only: waiting memories flagged as personal data or a
 *                        sensitive topic, with the kinds / topics (never the values),
 *                        the proposal id and its reviewHash.
 * memory_privacy_decide  keep or forget one of them (approve / reject the proposal with
 *                        its reviewHash), after the owner approves the call.
 *
 * Same gates as the owner-only routes: the owner's own turn, never a turn that
 * answers an outsider, only drawers open for the run.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { toolMemoryDrawers, toolMemoryWriteKinds } from './scope.js';
import { reviewOwner } from './review.js';
import { auditTool } from './scopes.js';
import { drawerId } from '../../memory/drawers.js';
import { PersonError, exportPerson, forgetPerson } from '../../memory/person.js';
import { privacyFlags } from '../../memory/personal-data.js';
import { MemoryFileError, approveProposal, listProposals, rejectProposal } from '../../memory/memory-files.js';
import { storeP9Enabled } from '../../services/store-p9.js';

const fail = (tool: string, msg: string): ToolResult => ({ content: [{ type: 'text', text: `${tool} refused: ${msg}` }], error: msg });
const ok = (text: string, data: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text }], data: { success: true, ...data } } as ToolResult);
const oneLine = (s: string, n = 300) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The owner, P9 on, and the person's drawer open for this run (writable when `write`). */
async function personGate(tool: string, person: unknown, context: ToolExecutionContext | undefined, write: boolean): Promise<{ owner: string; key: string; open: Set<string>; writable: Set<string> } | ToolResult> {
  if (!storeP9Enabled()) return fail(tool, 'not available yet');
  const owner = await reviewOwner(context);
  if (typeof owner !== 'string') return fail(tool, owner.refused);
  if (typeof person !== 'string' || !person) return fail(tool, 'person is required (the key from memory_scopes, e.g. "sam")');
  const drawers = toolMemoryDrawers(context);
  const open = new Set(drawers.map(drawerId));
  const kinds = toolMemoryWriteKinds(context);
  const writable = new Set(drawers.filter((d) => !d.readOnly && (!kinds || kinds.includes(d.kind))).map(drawerId));
  const own = `people:${person}`;
  if (!open.has(own)) return fail(tool, 'this person\'s memory is not open in this conversation (it may stay on this computer)');
  if (write && !writable.has(own)) return fail(tool, 'this agent may not change people memory');
  return { owner, key: person, open, writable };
}

export const memoryPersonExportTool: Tool = {
  name: 'memory_person_export',
  description: `Everything the owner's memory holds about one person, after the owner approves this call: their memories and
replaced facts, memories elsewhere that mention them (by the memory map or their name as a whole word), their memory map
entries and handoff lines that name them. An agent's own notes appear as a count only. Give the person's key (memory_scopes).
Use it before memory_person_forget to see which mentions can be forgotten too.`,
  input_schema: { type: 'object', properties: { person: { type: 'string', description: 'The person\'s key, e.g. "sam"' } }, required: ['person'] },
  async execute(params: { person?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const g = await personGate('memory_person_export', params?.person, context, false);
    if (!('owner' in g)) return g;
    try {
      const out = await exportPerson(g.owner, g.key);
      const mentions = out.mentions.filter((m) => g.open.has(m.drawer));
      const hidden = out.mentions.length - mentions.length;
      auditTool(context, 'memory.person_export', 'memory_person', g.key, { drawer: out.drawer.length, mentions: out.mentions.length, graph: out.graph.length, handoffs: out.handoffs.length });
      const text = [
        `${out.person}: ${out.drawer.length} memories in their place.`,
        ...out.drawer.map((m) => `- ${m.id}${m.status === 'replaced' ? ' (replaced)' : ''}: ${oneLine(m.content)}`),
        `Memories elsewhere that mention them: ${out.mentions.length}${hidden ? ` (${hidden} in places not open here, count only)` : ''}.`,
        ...mentions.map((m) => `- ${m.id} [${m.drawer}, ${m.why === 'graph' ? 'linked' : 'names them'}]: ${oneLine(m.content)}`),
        `Memory map entries: ${out.graph.length}. Handoff notes that name them: ${out.handoffs.length} (they stay when the person is forgotten). Agents' own notes: ${out.agentNotes.count}.`,
      ].join('\n');
      return ok(text, { export: { ...out, mentions, agentNotes: { count: out.agentNotes.count, ids: [] } }, hiddenMentions: hidden });
    } catch (err) {
      if (err instanceof PersonError) return fail('memory_person_export', err.message);
      throw err;
    }
  },
};

export const memoryPersonForgetTool: Tool = {
  name: 'memory_person_forget',
  description: `Forget one person in one action, after the owner approves this call. Cannot be undone: the person's memories with
their history and their memory map entries are erased, plus the mentioning memories you list (only ids memory_person_export
listed). They stay forgotten even when a backup is put back. Handoff notes that name them stay (work records).
confirm must be the person's key, exactly as the owner types it in the window.`,
  input_schema: {
    type: 'object',
    properties: {
      person: { type: 'string', description: 'The person\'s key, e.g. "sam"' },
      confirm: { type: 'string', description: 'The person\'s key again' },
      mention_ids: { type: 'array', items: { type: 'string' }, description: 'Mentioning memories to forget too (from memory_person_export)' },
    },
    required: ['person', 'confirm'],
  },
  async execute(params: { person?: unknown; confirm?: unknown; mention_ids?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const g = await personGate('memory_person_forget', params?.person, context, true);
    if (!('owner' in g)) return g;
    const ids = params.mention_ids === undefined ? [] : params.mention_ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return fail('memory_person_forget', 'mention_ids must be a list of memory ids');
    try {
      if (ids.length) {
        const exp = await exportPerson(g.owner, g.key);
        const drawerOf = new Map(exp.mentions.map((m) => [m.id, m.drawer]));
        if (ids.some((id) => !g.writable.has(drawerOf.get(id) ?? ''))) return fail('memory_person_forget', 'some mentions are not in places this agent may change');
      }
      const out = await forgetPerson(g.owner, g.key, `agent:${context?.agentId ?? 'unknown'}`, { confirm: params.confirm, mentionIds: ids });
      auditTool(context, 'memory.forget_person', 'memory_person', g.key, out);
      return ok(`Forgotten: ${g.key} (${out.drawer} memories, ${out.mentions} mentions, ${out.graph} map entries).`, out);
    } catch (err) {
      if (err instanceof PersonError) return fail('memory_person_forget', err.message);
      throw err;
    }
  },
};

/** Waiting proposals in the open drawers that the review flags as personal data or a sensitive topic. */
async function flagged(owner: string, open: Set<string>) {
  const out = [];
  for (const p of await listProposals(owner, 'pending')) {
    if (!open.has(p.drawerId)) continue;
    const texts = p.changes.map((c) => ('after' in c && c.after ? c.after.content : ''));
    const flags = privacyFlags(p.reasons ?? [], texts);
    if (flags) out.push({ id: p.id, drawer: p.drawerId, reviewHash: p.reviewHash, text: oneLine(texts.join(' ')), fromChannel: (p.reasons ?? []).includes('outsider'), ...flags });
  }
  return out;
}

export const memoryPrivacyReviewTool: Tool = {
  name: 'memory_privacy_review',
  description: `List waiting memories that hold other people's personal data (e-mail, phone, address, bank account, card, ID number)
or a sensitive topic (health, religion, politics, sexuality, origin, union, genetic). They are never saved by themselves.
Each item gives the kinds or topics, the proposal id and its reviewHash. Decide one with memory_privacy_decide.
Only the memory drawers open for this conversation are read.`,
  input_schema: { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 50 } } },
  async execute(params: { limit?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    if (!storeP9Enabled()) return fail('memory_privacy_review', 'not available yet');
    const owner = await reviewOwner(context);
    if (typeof owner !== 'string') return fail('memory_privacy_review', owner.refused);
    const limit = typeof params?.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(params.limit))) : 20;
    const items = (await flagged(owner, new Set(toolMemoryDrawers(context).map(drawerId)))).slice(0, limit);
    const text = items.length
      ? items.map((x, i) => `${i + 1}. [${x.drawer}] "${x.text}"${x.sensitive.length ? ` — sensitive: ${x.sensitive.join(', ')}` : ''}${x.personalData.length ? ` — personal data: ${x.personalData.join(', ')}` : ''}${x.fromChannel ? ' — from a channel' : ''} (proposal ${x.id}, reviewHash ${x.reviewHash})`).join('\n')
      : 'No personal data or sensitive memory waits in the open drawers.';
    return ok(text, { items });
  },
};

export const memoryPrivacyDecideTool: Tool = {
  name: 'memory_privacy_decide',
  description: `Keep or forget one waiting memory from memory_privacy_review, after the owner approves this call.
decision: keep (it is saved where it waits) or forget (it is dropped). Give the proposal id and the reviewHash;
if it changed since, nothing happens.`,
  input_schema: {
    type: 'object',
    properties: { proposal_id: { type: 'string' }, decision: { type: 'string', enum: ['keep', 'forget'] }, review_hash: { type: 'string' } },
    required: ['proposal_id', 'decision', 'review_hash'],
  },
  async execute(params: { proposal_id?: unknown; decision?: unknown; review_hash?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    if (!storeP9Enabled()) return fail('memory_privacy_decide', 'not available yet');
    const owner = await reviewOwner(context);
    if (typeof owner !== 'string') return fail('memory_privacy_decide', owner.refused);
    if (params.decision !== 'keep' && params.decision !== 'forget') return fail('memory_privacy_decide', 'decision must be keep or forget');
    const drawers = toolMemoryDrawers(context);
    const item = (await flagged(owner, new Set(drawers.map(drawerId)))).find((x) => x.id === params.proposal_id);
    if (!item) return fail('memory_privacy_decide', 'no waiting personal data or sensitive memory with that id in the open drawers');
    if (params.decision === 'keep') {
      const kinds = toolMemoryWriteKinds(context);
      const d = drawers.find((x) => drawerId(x) === item.drawer);
      if (!d || d.readOnly || (kinds && !kinds.includes(d.kind))) return fail('memory_privacy_decide', `this agent may not write ${item.drawer}`);
    }
    const actor = `agent:${context?.agentId ?? 'unknown'}`;
    try {
      if (params.decision === 'keep') await approveProposal(owner, item.id, actor, params.review_hash);
      else await rejectProposal(owner, item.id, actor, params.review_hash);
      auditTool(context, params.decision === 'keep' ? 'memory_proposal.approve' : 'memory_proposal.reject', 'memory_proposal', item.id, { drawer: item.drawer, privacy: true });
      return ok(params.decision === 'keep' ? `Kept in ${item.drawer}.` : 'Forgotten; it was not saved.', { proposalId: item.id, decision: params.decision });
    } catch (err) {
      if (err instanceof MemoryFileError) return fail('memory_privacy_decide', err.message);
      throw err;
    }
  },
};
