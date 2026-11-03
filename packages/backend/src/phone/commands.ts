/**
 * What a paired phone may ask (MOB-LINK-01). Every command arrives signed and
 * sealed and has passed the CommandVerifier (service.ts) before it gets here;
 * it then runs as the owner the phone was paired for, through the same code
 * the computer's own pages use, so every permission rule still applies.
 *
 * Commands (the signed `body`, JSON with `type` and an optional `ref`):
 *   chat.list                                  the owner's conversations
 *   chat.messages {id, before?}                one page of a conversation
 *   chat.send {id?, message, agentId?, model?} starts a turn; run frames follow
 *   chat.stop {runId}
 *   approval.pending                           pending approvals (each is marked shown to this phone)
 *   approval.pending {id}                      { pending } for one approval (also accepted unsigned)
 *   approval.detail {id}                       the full (masked) parameters of a shown approval
 *   approval.decide {id, approve, paramsHash?} first decision wins; 2FA owners get verification_required;
 *                                              a cut-short preview needs approval.detail first (full_view_required)
 *   tasks.list {place?}                        runs ('running' by default)
 *   schedules.list
 *   team.list                                  the owner's agents
 */

import { randomUUID } from 'node:crypto';
import { logAudit } from '../services/audit-logger.js';
import { markShown, wasShown } from './store.js';

export class CommandError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface CommandContext {
  deviceId: string;
  ownerId: string;
  /** Sends one more frame to the phone (sealed by the caller); false when the phone is gone. */
  push(frame: Record<string, unknown>): boolean;
  now(): number;
}

const CONVERSATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MESSAGE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const RUN_ID = /^[A-Za-z0-9_.:-]{8,128}$/;
const AGENT_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const MODEL = /^[A-Za-z0-9_.:/@+-]{1,160}$/;
const APPROVAL_ID = /^[0-9a-f-]{36}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MESSAGE_CHARS = 100_000;
const PAGE_LIMIT = 30;
const PAGE_CHARS = 150_000;
/** The largest full view a phone gets; a bigger request is decided on the computer. */
export const DETAIL_MAX_BYTES = 256 * 1024;
const DETAIL_PER_PHONE = 200;
/** Codes from deeper layers that may reach the phone as they are; anything else is internal_error. */
const SAFE_CODE = /^[a-z][a-z0-9_]{1,40}$/;

/**
 * Full views this phone fetched (approval id → the paramsHash it showed). Memory only: after a
 * restart, or once the phone is forgotten or paired again, it fetches the full view again.
 */
const detailShown = new Map<string, Map<string, string>>();

export function forgetDetails(deviceId: string): void {
  detailShown.delete(deviceId);
}

function recordDetail(deviceId: string, approvalId: string, hash: string): void {
  let m = detailShown.get(deviceId);
  if (!m) { m = new Map(); detailShown.set(deviceId, m); }
  m.delete(approvalId);
  m.set(approvalId, hash);
  while (m.size > DETAIL_PER_PHONE) m.delete(m.keys().next().value as string);
}

/** A preview that left something out (cut text or a nested value) cannot be approved from the list alone. */
function needsFullView(d: { truncated?: boolean; paramsPreview?: unknown }): boolean {
  return !!d.truncated || JSON.stringify(d.paramsPreview ?? null).includes('[object]');
}

type Body = Record<string, unknown>;

function only(body: Body, keys: string[]): void {
  for (const k of Object.keys(body)) if (k !== 'type' && k !== 'ref' && !keys.includes(k)) throw new CommandError('bad_format');
}

function audit(ctx: CommandContext, action: string, success: boolean, metadata: Record<string, unknown> = {}, resource?: { type: string; id: string }) {
  logAudit({
    event_type: action.startsWith('tool_approval.') ? 'data.update' : 'data.read', event_category: action.startsWith('tool_approval.') ? 'data_modification' : 'data_access',
    severity: action === 'tool_approval.approve' ? 'warning' : 'info', user_id: ctx.ownerId,
    resource_type: resource?.type ?? 'phone_command', resource_id: resource?.id ?? ctx.deviceId, action, success,
    metadata: { via: 'phone', device: ctx.deviceId, ...metadata },
  });
}

/** The answer to `approval.pending {id}`: true only when pending and given to this phone. */
export async function approvalPending(deviceId: string, id: unknown): Promise<boolean> {
  if (typeof id !== 'string' || !APPROVAL_ID.test(id)) return false;
  const { getApproval } = await import('../tools/approvals.js');
  const a = await getApproval(id);
  return !!a && a.status === 'pending' && await wasShown(deviceId, id);
}

export async function runCommand(ctx: CommandContext, body: Body): Promise<unknown> {
  switch (body.type) {
    case 'chat.list': return chatList(ctx, body);
    case 'chat.messages': return chatMessages(ctx, body);
    case 'chat.send': return chatSend(ctx, body);
    case 'chat.stop': return chatStop(ctx, body);
    case 'approval.pending': return body.id === undefined ? approvalList(ctx, body) : (only(body, ['id']), { type: 'approval.pending', id: body.id, pending: await approvalPending(ctx.deviceId, body.id) });
    case 'approval.detail': return approvalDetail(ctx, body);
    case 'approval.decide': return approvalDecide(ctx, body);
    case 'tasks.list': return tasksList(ctx, body);
    case 'schedules.list': return schedulesList(ctx, body);
    case 'team.list': return teamList(ctx, body);
    default: throw new CommandError('unknown_command');
  }
}

async function chatList(ctx: CommandContext, body: Body) {
  only(body, []);
  const { listConversations } = await import('../repositories/chat-conversations.js');
  const list = await listConversations(ctx.ownerId, 100);
  return {
    conversations: list.filter((c) => !c.archived).map((c) => ({
      id: c.id, title: c.title, agentId: c.agentId, projectId: c.projectId, pinned: c.pinned, preview: c.preview.slice(0, 200), updatedAt: c.updatedAt,
    })),
  };
}

async function chatMessages(ctx: CommandContext, body: Body) {
  only(body, ['id', 'before']);
  if (typeof body.id !== 'string' || !CONVERSATION_ID.test(body.id)) throw new CommandError('bad_format');
  if (body.before !== undefined && (typeof body.before !== 'string' || !MESSAGE_ID.test(body.before))) throw new CommandError('bad_format');
  const { findConversation, pageConversationMessages } = await import('../repositories/chat-conversations.js');
  const c = await findConversation(ctx.ownerId, body.id);
  if (!c) throw new CommandError('not_found');
  const page = await pageConversationMessages(c.id, { before: body.before as string | undefined, limit: PAGE_LIMIT, maxChars: PAGE_CHARS });
  if (!page) throw new CommandError('not_found');
  return {
    conversation: { id: c.id, title: c.title, agentId: c.agentId },
    messages: page.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, status: m.status, runId: m.runId, agentId: m.agentId ?? null, createdAt: m.createdAt })),
    hasMore: page.hasMore,
  };
}

async function chatSend(ctx: CommandContext, body: Body) {
  only(body, ['id', 'message', 'agentId', 'model']);
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > MESSAGE_CHARS) throw new CommandError('bad_format');
  if (body.id !== undefined && (typeof body.id !== 'string' || !CONVERSATION_ID.test(body.id))) throw new CommandError('bad_format');
  if (body.agentId !== undefined && (typeof body.agentId !== 'string' || !AGENT_ID.test(body.agentId))) throw new CommandError('bad_format');
  if (body.model !== undefined && (typeof body.model !== 'string' || !MODEL.test(body.model))) throw new CommandError('bad_format');
  const repo = await import('../repositories/chat-conversations.js');
  const c = body.id ? await repo.findConversation(ctx.ownerId, body.id) : await repo.createConversation(ctx.ownerId, { ...(body.agentId ? { agentId: body.agentId as string } : {}) });
  if (!c) throw new CommandError('not_found');
  const { startTurn } = await import('../api/routes/chat-conversations.js');
  const { dispatchReplyRound } = await import('../services/chat-reply-rounds.js');
  const runId = `phone-${randomUUID()}`;
  const input = { userId: ctx.ownerId, role: 'owner', c, runId, message: body.message, model: (body.model as string | undefined) ?? c.model, agentId: body.agentId as string | undefined };
  const out = await dispatchReplyRound(input, startTurn) ?? await startTurn(input);
  audit(ctx, 'phone.chat.send', out.code === 202, { status: out.code }, { type: 'chat_session', id: c.id });
  if (out.code !== 202) throw new CommandError(typeof out.body.code === 'string' ? out.body.code : 'refused');
  const started = typeof out.body.runId === 'string' ? out.body.runId : runId;
  return { conversationId: c.id, runId: started, follow: () => followRun(ctx, started) };
}

/** Streams a run's frames to the phone as they come; ends with run.end. */
async function followRun(ctx: CommandContext, runId: string): Promise<void> {
  const { chatRuns } = await import('../services/chat-runs.js');
  const run = chatRuns.get(runId);
  if (!run) { ctx.push({ type: 'run.end', runId, status: 'unknown' }); return; }
  let last = 0;
  let done = false;
  const forward = (e: { seq: number; frame: Record<string, unknown> }) => {
    if (done || e.seq <= last) return;
    last = e.seq;
    if (e.frame.type === 'end') {
      done = true;
      ctx.push({ type: 'run.end', runId, status: e.frame.status ?? 'complete', ...(typeof e.frame.code === 'string' ? { code: e.frame.code } : {}) });
      stopListening();
      return;
    }
    // A refused frame (no session, or the link is backed up) ends the stream with a notice; the
    // phone reads the rest with chat.messages.
    if (!ctx.push({ type: 'run', runId, seq: e.seq, frame: e.frame })) { done = true; stopListening(); ctx.push({ type: 'run.end', runId, status: 'dropped', code: 'slow_link' }); }
  };
  const stopListening = () => { run.emitter.off('event', forward); };
  run.emitter.on('event', forward);
  for (const e of run.since(0)) forward(e);
}

async function chatStop(ctx: CommandContext, body: Body) {
  only(body, ['runId']);
  if (typeof body.runId !== 'string' || !RUN_ID.test(body.runId)) throw new CommandError('bad_format');
  const { chatRuns } = await import('../services/chat-runs.js');
  const run = chatRuns.get(body.runId);
  if (!run || run.userId !== ctx.ownerId) throw new CommandError('not_found');
  const { stopReplyRound } = await import('../services/chat-reply-rounds.js');
  const { stopDelegations } = await import('../tools/tasks/team.js');
  await stopReplyRound(ctx.ownerId, run.id);
  run.requestStop();
  stopDelegations(run.sessionId);
  audit(ctx, 'phone.chat.stop', true, {}, { type: 'chat_run', id: run.id });
  return { status: run.status === 'running' ? 'stopping' : run.status };
}

async function approvalList(ctx: CommandContext, body: Body) {
  only(body, []);
  const { listApprovals, getApprovalDetail } = await import('../tools/approvals.js');
  const pending = await listApprovals({ status: 'pending', limit: 50 });
  const out = [];
  for (const a of pending) {
    const d = await getApprovalDetail(a.id);
    if (!d || d.status !== 'pending') continue;
    out.push({ id: d.id, toolName: d.toolName, category: d.category, agentId: d.agentId, sessionId: d.sessionId, paramsPreview: d.paramsPreview, truncated: d.truncated, fullViewRequired: needsFullView(d), requestedAt: d.requestedAt, paramsHash: d.paramsHash });
  }
  await markShown(ctx.deviceId, out.map((a) => a.id), ctx.now());
  return { approvals: out };
}

/** The full, masked parameters of an approval this phone was shown; recorded so it may then approve. */
async function approvalDetail(ctx: CommandContext, body: Body) {
  only(body, ['id']);
  if (typeof body.id !== 'string' || !APPROVAL_ID.test(body.id)) throw new CommandError('bad_format');
  if (!(await approvalPending(ctx.deviceId, body.id))) throw new CommandError('not_pending');
  const { getApprovalDetail } = await import('../tools/approvals.js');
  const d = await getApprovalDetail(body.id);
  if (!d || d.status !== 'pending') throw new CommandError('not_pending');
  if (d.params === null || !d.paramsHash) throw new CommandError('full_view_unavailable');
  const out = { id: d.id, toolName: d.toolName, category: d.category, agentId: d.agentId, sessionId: d.sessionId, params: d.params, maskedFields: d.maskedFields, runScope: d.runScope, requestedAt: d.requestedAt, paramsHash: d.paramsHash };
  if (Buffer.byteLength(JSON.stringify(out)) > DETAIL_MAX_BYTES) throw new CommandError('too_large');
  recordDetail(ctx.deviceId, d.id, d.paramsHash);
  audit(ctx, 'phone.approval.detail', true, { tool: d.toolName }, { type: 'tool_approval', id: d.id });
  return out;
}

async function approvalDecide(ctx: CommandContext, body: Body) {
  only(body, ['id', 'approve', 'decision', 'paramsHash']);
  if (typeof body.id !== 'string' || !APPROVAL_ID.test(body.id)) throw new CommandError('bad_format');
  // PROTOCOL.md writes `approve: true|false`; `decision: approve|deny` is read the same. Both present must agree.
  const fromDecision = body.decision === 'approve' ? true : body.decision === 'deny' ? false : body.decision === undefined ? undefined : null;
  if (fromDecision === null || (typeof body.approve !== 'boolean' && fromDecision === undefined)) throw new CommandError('bad_format');
  if (typeof body.approve === 'boolean' && fromDecision !== undefined && body.approve !== fromDecision) throw new CommandError('bad_format');
  const approve = typeof body.approve === 'boolean' ? body.approve : fromDecision as boolean;
  if (body.paramsHash !== undefined && (typeof body.paramsHash !== 'string' || !HASH.test(body.paramsHash))) throw new CommandError('bad_format');
  if (approve && body.paramsHash === undefined) throw new CommandError('params_hash_required');
  // Rules 1 and 2: still pending, and given to this phone. Approve also re-checks pending inside its claim.
  if (!(await approvalPending(ctx.deviceId, body.id))) throw new CommandError('not_pending');
  const A = await import('../tools/approvals.js');
  try {
    if (!approve) {
      const record = await A.denyApproval(body.id, ctx.ownerId);
      audit(ctx, 'tool_approval.deny', true, { tool: record.toolName, agentId: record.agentId }, { type: 'tool_approval', id: record.id });
      return { id: record.id, status: record.status };
    }
    // The phone approves only what it showed in full: a cut-short preview needs the full view of this very hash.
    const d = await A.getApprovalDetail(body.id);
    if (d && needsFullView(d) && detailShown.get(ctx.deviceId)?.get(body.id) !== body.paramsHash) throw new CommandError('full_view_required');
    const { record, result } = await A.approveAndRun(body.id, ctx.ownerId, body.paramsHash);
    audit(ctx, 'tool_approval.approve', record.status === 'executed', { tool: record.toolName, agentId: record.agentId, status: record.status }, { type: 'tool_approval', id: record.id });
    return { id: record.id, status: record.status, ok: !result.error, preview: record.resultPreview, error: record.error };
  } catch (err) {
    // The owner's second factor is never skipped: the phone is told to decide on the computer.
    if (err instanceof A.ApprovalVerificationRequiredError) { audit(ctx, approve ? 'tool_approval.approve' : 'tool_approval.deny', false, { code: 'verification_required' }, { type: 'tool_approval', id: body.id }); throw new CommandError('verification_required'); }
    if (err instanceof A.ApprovalStateError) throw new CommandError(err.status === 404 ? 'not_found' : err.status === 409 ? 'not_pending' : 'refused');
    if (err instanceof CommandError) throw err;
    const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && SAFE_CODE.test(code)) throw new CommandError(code);
    throw err;
  }
}

async function tasksList(_ctx: CommandContext, body: Body) {
  only(body, ['place']);
  const R = await import('../services/runs.js');
  const place = (body.place ?? 'running') as (typeof R.PLACES)[number];
  if (!R.PLACES.includes(place)) throw new CommandError('bad_format');
  const page = await R.listRuns({ userId: null, place, limit: 50 });
  return { runs: page.runs, counts: await R.runCounts(null) };
}

async function schedulesList(ctx: CommandContext, body: Body) {
  only(body, []);
  const { listSchedules } = await import('../services/runs.js');
  return { schedules: await listSchedules(null, ctx.ownerId) };
}

async function teamList(ctx: CommandContext, body: Body) {
  only(body, []);
  const { repositories } = await import('../repositories/index.js');
  const { userActor } = await import('../repositories/actor.js');
  const rows = await repositories.agents.listConfigs(userActor({ id: ctx.ownerId, role: 'owner' }));
  return { agents: rows.map((a) => ({ id: a.id, name: a.name, emoji: a.emoji, description: a.description, model: a.model, primary: !!Number(a.is_primary), role: a.role ?? null, department: a.department ?? null })) };
}
