/**
 * project_sync / project_sync_apply tools (PROJECT-SYNC-01): one call brings a project's shared state
 * up to date — the managed section of AGENTS.md / CLAUDE.md / GEMINI.md, the handoff for the next
 * agent, and lasting facts as proposals for the owner.
 *
 * project_sync        read only: the whole plan with one previewHash. Writes nothing.
 * project_sync_apply  every call needs one-time owner approval (approvals.ts, 'settings'); the
 *                     approval is the explicit confirm, and the previewHash must be the one the owner
 *                     saw. Anything changed in between -> refused, preview again.
 *
 * It adds no permission: the same `previewFiles` / `applyFiles` as the owner's own path (only between
 * Girru's markers), and a fact is still only a proposal. Owner's own turns only.
 */
import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { toolActor } from '../../repositories/actor.js';
import { BridgeError } from '../../memory/bridge/service.js';
import { syncApply, syncPreview, type SyncPlan } from '../../memory/bridge/project-sync.js';

const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `Project sync refused: ${msg}` }], error: msg });
const ok = (text: string, data: unknown): ToolResult => ({ content: [{ type: 'text', text }], data: { success: true, ...(data as object) } } as ToolResult);

/** The owner id when this is the owner's own turn, else a refusal text. */
function ownerOf(context?: ToolExecutionContext): string | { refused: string } {
  if (context?.toolPolicy) return { refused: 'not available when answering someone else' };
  let a;
  try { a = toolActor(context); } catch { return { refused: 'no user for this run' }; }
  if (a.channel) return { refused: 'not available in a channel turn' };
  if (a.role !== 'owner' || !a.userId) return { refused: 'only for the owner' };
  return a.userId;
}

async function guarded(context: ToolExecutionContext | undefined, fn: (owner: string) => Promise<ToolResult>): Promise<ToolResult> {
  const owner = ownerOf(context);
  if (typeof owner !== 'string') return fail(owner.refused);
  try { return await fn(owner); } catch (err) {
    if (err instanceof BridgeError) return fail(err.message);
    throw err;
  }
}

const list = (what: string) => ({ type: 'array' as const, items: { type: 'string' as const }, description: what });

/** The plan as the owner reads it before approving: every part, and what it would not do. */
function planText(plan: SyncPlan): string {
  const lines = [`Project sync for ${plan.folder}`];
  lines.push(plan.filesSkipped ? `Files: left alone — ${plan.filesSkipped}` : plan.fileChanges
    ? `Files: ${plan.fileChanges} change(s) in ${plan.files.filter((f) => f.action !== 'unchanged').map((f) => f.relative).join(', ') || 'the managed section'}${plan.conflicts ? ` · ${plan.conflicts} conflict(s)` : ''}`
    : 'Files: already up to date');
  lines.push(plan.handoff
    ? `Handoff: done ${plan.handoff.done.length} · left ${plan.handoff.left.length} · next ${plan.handoff.next.length} · questions ${plan.handoff.questions.length}`
    : `Handoff: none${plan.handoffSkipped ? ` (${plan.handoffSkipped})` : ''}`);
  lines.push(plan.memory.length
    ? `Memory: ${plan.memory.length} fact(s) would wait for your review:\n${plan.memory.map((m) => `  - ${m}`).join('\n')}`
    : 'Memory: nothing proposed');
  lines.push(`Approve project_sync_apply with preview_hash ${plan.previewHash.slice(0, 12)}… to write this.`);
  return lines.join('\n');
}

export const projectSyncTool: Tool = {
  name: 'project_sync',
  description: `Plan one update of everything a project shares with the other coding tools, and show it as one preview (read only, writes nothing).
Covers the managed section of AGENTS.md / CLAUDE.md / GEMINI.md, the handoff for the next agent, and lasting facts for the owner to review.
Give it after finishing a piece of work; then ask the owner to approve project_sync_apply with the preview_hash it returns.`,
  input_schema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'The project to sync' },
      handoff: {
        type: 'object',
        description: 'The note for the next agent in this project (of any brand). Never keys, passwords or tokens.',
        properties: { done: list('What is finished'), left: list('What is still open'), next: list('The next steps'), questions: list('Open questions for the owner') },
      },
      memory: list('Lasting facts worth keeping, at most 10: one per entry. Each becomes a proposal the owner reviews.'),
    },
    required: ['project_id'],
  },
  idempotent: true,
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    return guarded(context, async (owner) => {
      const plan = await syncPreview(owner, params.project_id, { handoff: params.handoff, memory: params.memory });
      return ok(planText(plan), { plan });
    });
  },
};

export const projectSyncApplyTool: Tool = {
  name: 'project_sync_apply',
  description: `Write the project sync the owner approved: the handoff, the proposals, then the managed files.
Send the same handoff and memory as the preview, with its preview_hash and confirm true. A project that changed since that preview is refused, so preview it again.`,
  input_schema: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      preview_hash: { type: 'string', description: 'The previewHash project_sync returned' },
      handoff: { type: 'object', description: 'The same handoff as the preview' },
      memory: list('The same facts as the preview'),
      confirm: { type: 'boolean', description: 'true after the owner reviewed the preview' },
    },
    required: ['project_id', 'preview_hash', 'confirm'],
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    // The owner's approval of this call is the explicit confirm.
    return guarded(context, async (owner) => {
      const r = await syncApply(owner, params.project_id, {
        handoff: params.handoff, memory: params.memory, previewHash: params.preview_hash, confirm: params.confirm,
      });
      const parts = [
        r.handoffId ? 'handoff saved' : 'no handoff',
        r.proposals.length ? `${r.proposals.length} fact(s) waiting for your review` : 'nothing proposed',
        r.filesSkipped ? `the files were left alone (${r.filesSkipped})`
          : r.filesError ? `the files were NOT written (${r.filesError}) — the next sync writes them`
            : `${r.fileChanges} file change(s) written`,
      ];
      if (r.notProposed.length) parts.push(`not proposed: ${r.notProposed.map((n) => n.reason).join('; ')}`);
      return ok(`Project sync: ${parts.join(' · ')}.`, r);
    });
  },
};
