import {requireReviewerQuorumStep,quorumRequestHash} from '../auth/verification/reviewer-quorum.js';
import {claimApprovalWithReceiptStep,claimApprovalWithoutReceiptStep} from '../auth/verification/approval-proof.js';
import type {OperationContext} from '../auth/verification/operation-proof.js';
import { redactImportText } from '../memory/import/redact.js';
import {isToolExecClass} from './exec-policy.js';
/**
 * One-time approvals for risky agent tool calls (S1.3).
 *
 * Tools that send messages, delete data, spend money, install skills or
 * change credentials/settings do not run when the model calls them. The
 * registry stores a pending approval record (parameters encrypted) and the
 * agent gets a "waiting for approval" result. The owner approves (the call
 * runs exactly once, with the agent's grants re-checked at that moment) or
 * denies (it never runs). There is no blanket or automatic approval.
 *
 * Exception: in a channel turn, a send tool that the channel policy already
 * confined to the inbound conversation (or the operator's allowed_channels)
 * is the reply itself and runs without a separate approval.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { all, dialect, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { isParam, nowPlusText, nowText, offset } from '../db/pg/dialect.js';
import { getEncryptionService } from '../credentials/encryption.js';
import { isSecretKey } from '../credentials/secret-mask.js';
import type { Tool, ToolResult, ToolExecutionContext } from './types.js';
import { CHANNEL_SEND_TOOLS, createChannelToolPolicy, type ChannelToolPolicy } from './channel-policy.js';
import { approvalRunDrawers, toolMemoryDrawers } from './memory/scope.js';
import type { DrawerRef } from '../memory/drawers.js';
import { onApprovalDecided } from '../services/task-runs.js';

/** CHAT-BUILD-01: other parts (the chat) continue after the owner decides; a listener never blocks or fails the decision. */
type DecidedListener = (approvalId: string) => Promise<void> | void;
const decidedListeners = new Set<DecidedListener>();
export function addApprovalDecidedListener(fn: DecidedListener): () => void { decidedListeners.add(fn); return () => { decidedListeners.delete(fn); }; }
async function notifyDecided(id: string): Promise<void> {
  await onApprovalDecided(id);
  for (const fn of decidedListeners) { try { await fn(id); } catch (err: any) { console.warn('[Approvals] decided listener failed:', err?.name ?? 'Error'); } }
}

export type ApprovalCategory = 'message' | 'delete' | 'money' | 'install' | 'settings' | 'browser' | 'network' | 'other';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'executed' | 'failed' | 'expired';

/** Built-in and known tools that always need approval. */
export const APPROVAL_REQUIRED_TOOLS: Readonly<Record<string, ApprovalCategory>> = {
  // sending messages on the owner's behalf
  telegram_send: 'message',
  discord_send: 'message',
  slack_send: 'message',
  whatsapp_send: 'message',
  // deleting data
  storage_delete: 'delete',
  memory_forget: 'delete', // CORE-07: complete, irreversible removal
  memory_doctor_fix: 'delete', // CORE-MEM-DOCTOR: deletes duplicate/expired copies (versioned); the approval is the confirm
  memory_scope_forget: 'delete', // MEM-SCALE-01: forget a whole project (CORE-07); the approval is the confirm
  memory_person_forget: 'delete', // STORE-MAP-01 P9: forget one person (CORE-07); the approval is the confirm
  memory_trash_empty: 'delete', // MEM-TRASH-01: forgets what is in the Trash (CORE-07); the approval is the confirm
  memory_project_trash: 'delete', // MEM-TRASH-01: deletes every memory of a project (restorable); the approval is the confirm
  specialty_apply: 'settings',
  memory_group_apply: 'settings', // MEM-UX-02: share-within changes which projects an agent reads; the approval is the confirm
  project_design_apply: 'settings', // DESIGN-FIND-01: changes the design agents follow and DESIGN.md; the approval is the confirm
  project_databases_apply: 'settings', // PROJECT-TECH-01: changes what an agent sees of a project's databases; the approval is the confirm
  // changing how memory is organised and who may read it
  memory_scope_apply: 'settings', // MEM-SCALE-01: project lifecycle, departments, pinned facts; the approval is the confirm
  memory_access_apply: 'settings', // MEM-SCALE-01: inherited access policies; the approval is the confirm
  memory_move: 'other', // MEM-CACHE-01: moving a memory changes which turns may load it; the owner approves each move
  memory_review_decide: 'other', // CORE-MEM-CONFLICT: keep new / old / both changes a memory; the approval is the confirm
  memory_review_routine: 'other', // MEM-GAPS-02: accepts every routine review of a preview; the approval is the confirm
  memory_graph_review: 'other', // CORE-MEM-GRAPH: an approved link is used by recall; the approval is the confirm
  memory_graph_topic: 'other', // MEM-GRAPH-CLUSTER: gives a memory a topic key / dismisses a suggestion; the approval is the confirm
  memory_person_export: 'other', // STORE-MAP-01 P9: hands everything about one person to the agent; the owner approves each export
  memory_corrected_checked: 'other', // STORE-MAP-01 P9b: marks a corrected memory as checked; the approval is the confirm
  memory_question_answer: 'other', // STORE-MAP-01 P9b: the owner approves the exact answer text that is saved
  memory_question_forget: 'other', // STORE-MAP-01 P9b: forgets an open question; the approval is the confirm
  open_in_code: 'other', // CODE-OPEN-01: the owner approves which file opens in Code
  memory_privacy_decide: 'other', // STORE-MAP-01 P9: keeps or drops a personal-data / sensitive memory; the approval is the confirm
  memory_graph_sync: 'other', // MEM-FINISH-01 (M14 Rebuild map): re-indexes the map and prunes orphan links; the approval is the confirm
  // spending money
  make_call: 'money',
  trading_execute: 'money',
  // installing code
  skill_install: 'install',
  // changing stored secrets / settings
  credentials_save: 'settings',
  memory_bridge_apply: 'settings', // MEM-BRIDGE-01: writes CLI configs / project files; the approval is the confirm
  discovery: 'other', // DISCOVER-01: reads what is on this computer (redacted); the owner approves each read, like the page that works only on this computer
  discovery_apply: 'settings', // DISCOVER-01: imports memories, skills, MCP servers (tokens), SSH hosts from this computer; the approval is the confirm
  // handing work to the owner's signed-in coding app (CORE-ROUTE-01)
  ask_coding_app: 'other',
};

/** Pending approvals per agent before new requests are refused. */
export const MAX_PENDING_PER_AGENT = 50;
/** A pending approval older than this can no longer be approved. */
export const APPROVAL_TTL_HOURS = 24;

/** Category when the tool needs approval, else null. A tool cannot opt out. */
export function approvalCategory(tool: Pick<Tool, 'name'> & { requiresApproval?: boolean;execClass?:boolean }): ApprovalCategory | null {
  if(isToolExecClass(tool))return 'other';
  const known = APPROVAL_REQUIRED_TOOLS[tool.name];
  if (known) return known;
  if (/_send$/.test(tool.name)) return 'message';
  if (tool.requiresApproval === true) return 'other';
  return null;
}

/** True when this call is a channel reply already confined by the channel policy. */
export function isConfinedChannelReply(policy: ChannelToolPolicy | undefined, name: string): boolean {
  return !!policy && Object.prototype.hasOwnProperty.call(CHANNEL_SEND_TOOLS, name)
    && CHANNEL_SEND_TOOLS[name].channel === policy.channel;
}

// ---------------------------------------------------------------------------
// Single-use execution tickets (only approveAndRun creates them)
// ---------------------------------------------------------------------------

export interface ApprovalTicket { readonly approvalId: string; readonly toolName: string }
const liveTickets = new WeakSet<ApprovalTicket>();

/** Consume a ticket for this tool. True once per ticket. */
export function consumeApprovalTicket(ticket: unknown, toolName: string): boolean {
  if (!ticket || typeof ticket !== 'object' || !liveTickets.has(ticket as ApprovalTicket)) return false;
  const t = ticket as ApprovalTicket;
  liveTickets.delete(t);
  return t.toolName === toolName;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

const PREVIEW_MAX = 300;

/**
 * Top-level parameters that hold a real secret for one specific tool even
 * though their name is generic (e.g. `value`). Elsewhere `value` is shown.
 */
export const TOOL_SECRET_PARAMS: Readonly<Record<string, readonly string[]>> = {
  credentials_save: ['value'],
};

/** A masked leaf: never the value, only a non-reversible fingerprint. */
export interface MaskedLeaf { masked: true; fingerprint: string }

/** First 8 hex characters of SHA-256: lets the owner compare, never reveals. */
export function secretFingerprint(value: string | number): string {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function isSecretParam(toolName: string, key: string, depth: number): boolean {
  if (isSecretKey(key)) return true;
  return depth === 0 && (TOOL_SECRET_PARAMS[toolName] ?? []).includes(key);
}

const MAX_MASK_DEPTH = 20;

/**
 * Exact parameters for the owner's view. Only string/number leaves at or
 * below a real secret key are replaced by `{ masked: true, fingerprint }`;
 * objects/arrays are always walked so every other field stays visible.
 * Each masked leaf's path is pushed to `maskedFields`.
 */
export function maskApprovalParams(
  toolName: string,
  value: unknown,
  maskedFields: string[] = [],
  path = '',
  secret = false,
  depth = 0,
): unknown {
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (typeof value === 'string' || typeof value === 'number') {
    if (!secret || value === '') return value;
    maskedFields.push(path || '$');
    return { masked: true, fingerprint: secretFingerprint(value) } satisfies MaskedLeaf;
  }
  if (typeof value !== 'object') return value;
  if (depth > MAX_MASK_DEPTH) {
    // Too deep to inspect: hide it rather than risk showing a secret.
    maskedFields.push(path || '$');
    return { masked: true, fingerprint: secretFingerprint(JSON.stringify(value)) } satisfies MaskedLeaf;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => maskApprovalParams(toolName, v, maskedFields, `${path}[${i}]`, secret, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${k}` : k;
    out[k] = maskApprovalParams(toolName, v, maskedFields, childPath, secret || isSecretParam(toolName, k, depth), depth + 1);
  }
  return out;
}

/** Short list preview. `truncated` = lossy: the owner must open the full view. */
function previewParams(toolName: string, params: Record<string, any>): { preview: string; truncated: boolean } {
  const out: Record<string, unknown> = {};
  let truncated = false;
  for (const [key, value] of Object.entries(params || {})) {
    const secret = isSecretParam(toolName, key, 0);
    if (typeof value === 'string') {
      if (secret) out[key] = maskApprovalParams(toolName, value, [], key, true);
      else if (value.length > PREVIEW_MAX) { truncated = true; out[key] = `${value.slice(0, PREVIEW_MAX)}…`; }
      else out[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = secret ? maskApprovalParams(toolName, value, [], key, true) : value;
    }
    else { truncated = true; out[key] = '[object]'; }
  }
  return { preview: JSON.stringify(out), truncated };
}

/** Deterministic JSON (sorted keys) so the hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const keys = Object.keys(value as object).filter((k) => (value as any)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`).join(',')}}`;
}

function paramsHash(salt: string, params: unknown): string {
  return createHmac('sha256', salt).update(canonicalJson(params)).digest('hex');
}

/**
 * Non-secret scope of the run that asked (CORE-07b): the drawers the turn
 * could reach (effective, see tools/memory/scope.ts) and its task id. Stored
 * with the approval and shown to the owner; the call re-runs with it.
 */
export interface ApprovalRunScope {
  memoryDrawers: DrawerRef[];
  /** Owner-selected project boundary, bound into the approval hash. */
  fileReadRoot?: string;
  taskId?: string;
  /** CORE-08: durable task run + step that asked; the run continues once decided. */
  runId?: string;
  runStep?: number;
}

export function runScopeOf(context: ToolExecutionContext): ApprovalRunScope {
  const scope: ApprovalRunScope = { memoryDrawers: toolMemoryDrawers(context).map((d) => ({kind:d.kind,...(d.key?{key:d.key}:{}),...(d.readOnly===true?{readOnly:true}:{} )})) };
  if (typeof context.taskId === 'string' && context.taskId) scope.taskId = context.taskId;
  if (typeof context.fileReadRoot === 'string' && context.fileReadRoot) scope.fileReadRoot = context.fileReadRoot;
  if (context.taskRun && typeof context.taskRun.runId === 'string' && Number.isInteger(context.taskRun.stepIndex)) {
    scope.runId = context.taskRun.runId;
    scope.runStep = context.taskRun.stepIndex;
  }
  return scope;
}

/**
 * What the hash binds: the parameters, plus the run scope when one was stored.
 * Rows from before run_scope (null) keep the old hash over the parameters only.
 */
function hashedPayload(params: unknown, scope: ApprovalRunScope | null): unknown {
  return scope ? { params, runScope: scope } : params;
}

function parseRunScope(raw: unknown): ApprovalRunScope | null | 'invalid' {
  if (raw === null || raw === undefined) return null;
  try {
    const v = JSON.parse(String(raw));
    if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.memoryDrawers)) return 'invalid';
    if (v.taskId !== undefined && typeof v.taskId !== 'string') return 'invalid';
    if (v.runId !== undefined && typeof v.runId !== 'string') return 'invalid';
    if (v.runStep !== undefined && !Number.isInteger(v.runStep)) return 'invalid';
    if (v.fileReadRoot !== undefined && (typeof v.fileReadRoot !== 'string' || !v.fileReadRoot || v.fileReadRoot.length > 4096 || v.fileReadRoot.includes('\0'))) return 'invalid';
    return v as ApprovalRunScope;
  } catch {
    return 'invalid';
  }
}

function sameHash(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export interface ApprovalRecord {
  id: string;
  status: ApprovalStatus;
  agentId: string | null;
  userId: string | null;
  sessionId: string | null;
  toolName: string;
  category: string | null;
  paramsPreview: Record<string, unknown> | null;
  /** True when the preview is lossy: open the full view before approving. */
  truncated: boolean;
  channel: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  executedAt: string | null;
  resultPreview: string | null;
  error: string | null;
  /** CH6: when the owner changed the waiting request (Change the task…); null when it is the agent's own. */
  editedAt: string | null;
}

function toRecord(row: any): ApprovalRecord {
  let preview: Record<string, unknown> | null = null;
  try { preview = row.params_preview ? JSON.parse(row.params_preview) : null; } catch { preview = null; }
  let channel: string | null = null;
  try { channel = row.origin ? JSON.parse(row.origin).channel ?? null : null; } catch { channel = null; }
  return {
    id: row.id,
    status: row.status,
    agentId: row.agent_id,
    userId: row.user_id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    category: row.category,
    paramsPreview: preview,
    truncated: row.preview_truncated === 1,
    channel,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    executedAt: row.executed_at,
    resultPreview: row.result_preview,
    error: row.error,
    editedAt: row.edited_at ?? null,
  };
}

/** requested_at is TEXT ('YYYY-MM-DD HH:MM:SS', UTC) on both drivers. */
function* expireOldStep(): Step<void> {
  const d = yield* dialect();
  yield* run(`UPDATE tool_approvals SET status = 'expired' WHERE status = 'pending' AND requested_at < ${nowPlusText(d)}`,
    offset(-APPROVAL_TTL_HOURS, 'hours'));
}

const expireOld = () => sql().read(expireOldStep());

/**
 * Store a pending approval for a tool call and return the result the agent
 * sees. Nothing is executed here.
 */
export async function requestApproval(
  tool: Tool,
  params: Record<string, any>,
  context: ToolExecutionContext,
  category: ApprovalCategory
): Promise<ToolResult> {
  const agentId = context.agentId ?? null;
  const pending = await sql().read((function* () {
    const d = yield* dialect();
    return (yield* one<{ n: number }>(`SELECT COUNT(*) AS n FROM tool_approvals WHERE status = 'pending' AND agent_id ${isParam(d)}`, agentId))!.n;
  })());
  if (pending >= MAX_PENDING_PER_AGENT) {
    return {
      content: [{ type: 'text', text: `Tool "${tool.name}" was not run: too many approval requests are already waiting for the owner. Do not retry; tell the user.` }],
      error: 'Too many pending approvals',
    };
  }

  const { encrypted, iv, authTag } = await getEncryptionService().encrypt(JSON.stringify(params ?? {}));
  const id = randomUUID();
  const salt = randomBytes(16).toString('hex');
  const runScope = runScopeOf(context);
  const hash = paramsHash(salt, hashedPayload(params ?? {}, runScope));
  const { preview, truncated } = previewParams(tool.name, params);
  const policy = context.toolPolicy;
  const origin = policy
    ? JSON.stringify({ channel: policy.channel, conversationId: policy.conversationId, allowedDestinations: policy.allowedDestinations })
    : null;
  await sql().read(run(`
    INSERT INTO tool_approvals (id, status, agent_id, user_id, session_id, tool_name, category,
      params_encrypted, params_iv, params_tag, params_preview, origin, delegated_from,
      params_hash, params_salt, preview_truncated, run_scope, run_id, run_step)
    VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    id, agentId, context.userId ?? null, context.sessionId ?? null, tool.name, category,
    encrypted, iv, authTag, preview, origin,
    context.delegatedFrom?.length ? JSON.stringify(context.delegatedFrom) : null,
    hash, salt, truncated ? 1 : 0, canonicalJson(runScope),
    runScope.runId ?? null, runScope.runStep ?? null,
  ));
  console.log(`[Approvals] ⏸️  Pending approval ${id} for ${tool.name} (agent ${agentId ?? '(none)'})`);

  return {
    content: [{
      type: 'text',
      text: `Waiting for owner approval: "${tool.name}" was NOT run. Approval request ${id} is pending; ` +
        `the owner must approve it once before it runs. Do not call this tool again for the same action; ` +
        `tell the user it is waiting for approval. It shows in Approvals › Waiting for me; you never approve it yourself.`,
    }],
    details: { status: 'pending_approval', approvalId: id, tool: tool.name, category },
  };
}

/** Agent ids accepted by the optional `agentId` filter (same shape as agent ids elsewhere). */
export const APPROVAL_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export async function listApprovals(filter: { status?: string; limit?: number; agentId?: string } = {}): Promise<ApprovalRecord[]> {
  await expireOld();
  const limit = Math.min(Math.max(Number(filter.limit) || 100, 1), 500);
  if (filter.agentId !== undefined && !APPROVAL_AGENT_ID.test(filter.agentId)) throw new Error('Invalid agent id');
  const where: string[] = [], args: string[] = [];
  if (filter.status) { where.push('status = ?'); args.push(filter.status); }
  if (filter.agentId !== undefined) { where.push('agent_id = ?'); args.push(filter.agentId); }
  const rows = await sql().read(all(`SELECT * FROM tool_approvals${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY requested_at DESC LIMIT ?`, ...args, limit));
  return rows.map(toRecord);
}

export async function getApproval(id: string): Promise<ApprovalRecord | null> {
  await expireOld();
  const row = await sql().read(one('SELECT * FROM tool_approvals WHERE id = ?', id));
  return row ? toRecord(row) : null;
}

export interface ApprovalDetail extends ApprovalRecord {
  /** Exact parameters that will run; only real secret string/number leaves are masked. */
  params: unknown;
  /** Paths (e.g. `apiKey`, `auth.token`, `keys[0]`) of every masked leaf in `params`. */
  maskedFields: string[];
  /** Send this back with the approve call; binds the approval to these parameters and this scope. */
  paramsHash: string | null;
  /** Scope the call re-runs with (∩ policies at approval time); null for old rows. */
  runScope: ApprovalRunScope | null;
}

/** Full view for the owner (decrypts the stored parameters). */
export async function getApprovalDetail(id: string): Promise<ApprovalDetail | null> {
  await expireOld();
  const row = await sql().read(one('SELECT * FROM tool_approvals WHERE id = ?', id));
  if (!row) return null;
  let params: unknown = null;
  let maskedFields: string[] = [];
  try {
    const raw = JSON.parse(await getEncryptionService().decrypt(row.params_encrypted, row.params_iv, row.params_tag));
    params = maskApprovalParams(row.tool_name, raw, maskedFields);
  } catch {
    params = null;
    maskedFields = [];
  }
  const hideEmbedded = (value: unknown, path = ''): unknown => {
    if (typeof value === 'string') {
      const redacted = redactImportText(value);
      if (redacted.total) maskedFields.push(path);
      return redacted.text;
    }
    if (Array.isArray(value)) return value.map((v, i) => hideEmbedded(v, `${path}[${i}]`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hideEmbedded(v, path ? `${path}.${k}` : k)]));
    return value;
  };
  params = hideEmbedded(params);
  const scope = parseRunScope(row.run_scope);
  const record = toRecord(row);
  return { ...record, paramsPreview: hideEmbedded(record.paramsPreview) as Record<string, unknown> | null,
    resultPreview: record.resultPreview ? redactImportText(record.resultPreview).text : null,
    error: record.error ? redactImportText(record.error).text : null,
    params, maskedFields, paramsHash: row.params_hash ?? null, runScope: scope === 'invalid' ? null : scope };
}

/** Internal reader: caller must authorize the exact reviewer target before invoking this. No expiry writes. */
export async function readBoundReviewerParams(id:string,expectedParamsHash:string,expectedRequestHash:string){
  const row=await sql().read(one('SELECT * FROM tool_approvals WHERE id=?',id));
  if(!row||row.status!=='pending'||row.params_hash!==expectedParamsHash||quorumRequestHash(row)!==expectedRequestHash)return null;
  // Bound both work and output; an oversized request must never be silently truncated for review.
  if(typeof row.params_encrypted!=='string'||row.params_encrypted.length>2097152||row.params_encrypted.length%2!==0||!/^[a-f0-9]+$/i.test(row.params_encrypted)||typeof row.params_iv!=='string'||!/^[a-f0-9]{32}$/i.test(row.params_iv)||typeof row.params_tag!=='string'||!/^[a-f0-9]{32}$/i.test(row.params_tag))return null;
  try{
    const plain=await getEncryptionService().decrypt(row.params_encrypted,row.params_iv,row.params_tag);
    if(plain.length>1048576)return null;
    const raw=JSON.parse(plain),scope=parseRunScope(row.run_scope);
    if(scope==='invalid'||!row.params_salt||!sameHash(paramsHash(row.params_salt,hashedPayload(raw,scope)),row.params_hash))return null;
    const maskedFields:string[]=[];
    const hide=(value:unknown,path='',depth=0):unknown=>{
      if(depth>40)throw Error('Review nesting limit');
      if(typeof value==='string'){const redacted=redactImportText(value);if(redacted.total)maskedFields.push(path);return redacted.text;}
      if(Array.isArray(value))return value.map((v,i)=>hide(v,`${path}[${i}]`,depth+1));
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,hide(v,path?`${path}.${key}`:key,depth+1)]));
      return value;
    };
    const params=hide(maskApprovalParams(row.tool_name,raw,maskedFields));
    const runScope=hide(scope,'runScope');
    const result={params,maskedFields,runScope};
    return JSON.stringify(result).length<=1048576?result:null;
  }catch{return null;}
}

export class ApprovalStateError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Deny a pending approval. It will never run. */
export async function denyApproval(id: string, ownerId: string): Promise<ApprovalRecord> {
  await expireOld();
  const res = await sql().read((function* () {
    const d = yield* dialect();
    return yield* run(`UPDATE tool_approvals SET status = 'denied', decided_at = ${nowText(d)}, decided_by = ? WHERE id = ? AND status = 'pending'`, ownerId, id);
  })());
  const record = await getApproval(id);
  if (!record) throw new ApprovalStateError('Approval not found', 404);
  if (res.changes !== 1) throw new ApprovalStateError(`Approval is ${record.status}, not pending`, 409);
  await notifyDecided(id);
  return record;
}

/**
 * CH6 "Change the task…" (Mohamed 2026-10-28): the only tools whose waiting request the owner may rewrite before
 * Allow once, the one parameter that may change and its limit (the tool's own). Every other parameter, the agent,
 * the run scope and the origin stay exactly as the agent asked; any other tool cannot be edited at all.
 */
export const EDITABLE_REQUESTS: Readonly<Record<string, { param: string; max: number }>> = { team_delegate: { param: 'request', max: 12000 } };

/**
 * Replace a waiting hand-off's task with the owner's text. The owner sends the paramsHash of the full view they
 * edited; the parameters are re-encrypted with a new salt and a new hash over the edited parameters + the same run
 * scope, in one compare-and-set on (pending, old hash). The old hash, any proof receipt or reviewer vote bound to it
 * no longer matches, so Allow once covers exactly the edited text. Nothing runs here.
 */
export async function editApprovalRequest(id: string, ownerId: string, expectedHash: unknown, text: unknown): Promise<{ detail: ApprovalDetail; changed: boolean }> {
  await expireOld();
  const row = await sql().read(one<any>('SELECT * FROM tool_approvals WHERE id = ?', id));
  if (!row) throw new ApprovalStateError('Approval not found', 404);
  const rule = EDITABLE_REQUESTS[row.tool_name];
  if (!rule) throw new ApprovalStateError('Only a hand-off’s task can be changed', 400);
  if (row.status !== 'pending') throw new ApprovalStateError(`Approval is ${row.status}, not pending`, 409);
  if (typeof text !== 'string' || !text.trim() || text.length > rule.max) throw new ApprovalStateError(`The task must be 1 to ${rule.max} characters`, 400);
  if (!sameHash(row.params_hash, expectedHash)) throw new ApprovalStateError('paramsHash does not match the stored parameters; open the full view and change it again', 409);
  const scope = parseRunScope(row.run_scope);
  let params: Record<string, any>;
  try { params = JSON.parse(await getEncryptionService().decrypt(row.params_encrypted, row.params_iv, row.params_tag)); }
  catch { throw new ApprovalStateError('Stored parameters could not be read', 409); }
  if (scope === 'invalid' || !row.params_salt || !sameHash(paramsHash(row.params_salt, hashedPayload(params, scope)), row.params_hash)
    || !params || typeof params !== 'object' || Array.isArray(params) || typeof params[rule.param] !== 'string') throw new ApprovalStateError('Stored parameters changed after the request', 409);
  if (params[rule.param] === text) return { detail: (await getApprovalDetail(id))!, changed: false };
  const next = { ...params, [rule.param]: text };
  const { encrypted, iv, authTag } = await getEncryptionService().encrypt(JSON.stringify(next));
  const salt = randomBytes(16).toString('hex');
  const hash = paramsHash(salt, hashedPayload(next, scope));
  const { preview, truncated } = previewParams(row.tool_name, next);
  const res = await sql().read((function* () {
    const d = yield* dialect();
    return yield* run(`UPDATE tool_approvals SET params_encrypted = ?, params_iv = ?, params_tag = ?, params_preview = ?, preview_truncated = ?, params_hash = ?, params_salt = ?, edited_at = ${nowText(d)}, edited_by = ? WHERE id = ? AND status = 'pending' AND params_hash = ?`,
      encrypted, iv, authTag, preview, truncated ? 1 : 0, hash, salt, ownerId, id, row.params_hash);
  })());
  if (res.changes !== 1) throw new ApprovalStateError('The request changed or stopped waiting; open it again', 409);
  return { detail: (await getApprovalDetail(id))!, changed: true };
}

/** A known pre-claim refusal: no decision or execution has happened. */
export class ApprovalVerificationRequiredError extends ApprovalStateError {
 constructor(){super('Verification is required for this approval',403);}
}

/**
 * Approve once and run the stored call. The pending -> approved transition
 * is atomic, so concurrent approvals run it at most once. The agent's grants,
 * the exec gate and (for channel turns) the channel policy are checked again.
 */
export async function approveAndRun(id: string, ownerId: string, expectedHash: unknown, proof?:{receipt:unknown;context:OperationContext}): Promise<{ record: ApprovalRecord; result: ToolResult }> {
  await expireOld();
  const current = await sql().read(one<{ status: string; params_hash: string | null }>('SELECT status, params_hash FROM tool_approvals WHERE id = ?', id));
  if (!current) throw new ApprovalStateError('Approval not found', 404);
  if (current.status === 'pending' && !sameHash(current.params_hash, expectedHash)) {
    // The owner must approve exactly what they saw in the full view.
    throw new ApprovalStateError('paramsHash does not match the stored parameters; open the full view and approve again', 409);
  }
  // One UPDATE claims the approval: on PostgreSQL a concurrent approve waits on
  // the row lock, then sees it no longer 'pending' (runs at most once).
  if(proof!==undefined&&(!proof||!proof.context||proof.context.userId!==ownerId))throw new ApprovalStateError('Approval verification refused',403);
  const claimed = await sql().tx(function*(){
    const hash=typeof expectedHash==='string'?expectedHash:'';
    yield* requireReviewerQuorumStep(ownerId,id,hash);
    return proof!==undefined?{kind:'claimed',changes:(yield* claimApprovalWithReceiptStep(proof.receipt,proof.context,id,hash))?1:0}:yield* claimApprovalWithoutReceiptStep(ownerId,id,hash);
  });
  if(claimed.kind==='required')throw new ApprovalVerificationRequiredError();
  if(claimed.kind==='forbidden')throw new ApprovalStateError('Owner approval context changed',403);
  const row = await sql().read(one('SELECT * FROM tool_approvals WHERE id = ?', id));
  if (!row) throw new ApprovalStateError('Approval not found', 404);
  if (claimed.changes !== 1){if(proof!==undefined)throw new ApprovalStateError('Approval verification refused',403);throw new ApprovalStateError(`Approval is ${row.status}, not pending`,409);}

  const finish = async (status: 'executed' | 'failed', resultPreview: string | null, error: string | null) => {
    await sql().read((function* () {
      const d = yield* dialect();
      yield* run(`UPDATE tool_approvals SET status = ?, executed_at = ${nowText(d)}, result_preview = ?, error = ? WHERE id = ?`,
        status, resultPreview, error, id);
    })());
    // CORE-08: a run waiting on this approval continues (result replayed, never re-run).
    await notifyDecided(id);
  };

  let params: Record<string, any>;
  const runScope = parseRunScope(row.run_scope);
  try {
    const plain = await getEncryptionService().decrypt(row.params_encrypted, row.params_iv, row.params_tag);
    params = JSON.parse(plain);
    if (runScope === 'invalid' || !row.params_salt || !sameHash(paramsHash(row.params_salt, hashedPayload(params, runScope)), row.params_hash)) {
      await finish('failed', null, 'Stored parameters changed after the request');
      const result: ToolResult = { content: [{ type: 'text', text: 'Approval failed: the parameters changed after the request; nothing was run.' }], error: 'params mismatch' };
      return { record: (await getApproval(id))!, result };
    }
  } catch {
    await finish('failed', null, 'Stored parameters could not be decrypted');
    const result: ToolResult = { content: [{ type: 'text', text: 'Approval failed: stored parameters could not be read.' }], error: 'decrypt failed' };
    return { record: (await getApproval(id))!, result };
  }

  let toolPolicy: ChannelToolPolicy | undefined;
  try {
    toolPolicy = row.origin ? createChannelToolPolicy(JSON.parse(row.origin)) : undefined;
  } catch {
    toolPolicy = createChannelToolPolicy({});
  }
  let delegatedFrom: string[] = [];
  try { delegatedFrom = row.delegated_from ? JSON.parse(row.delegated_from) : []; } catch { delegatedFrom = ['(invalid)']; }

  // CORE-07b: the turn's own scope, never wider than the policies allow now.
  // Old rows without a stored scope keep the previous default (owner +
  // experience drawers).
  const scoped = runScope && typeof runScope === 'object'
    ? { memoryDrawers: approvalRunDrawers(runScope.memoryDrawers, { toolPolicy }), ...(runScope.taskId ? { taskId: runScope.taskId } : {}), ...(runScope.fileReadRoot ? { fileReadRoot: runScope.fileReadRoot } : {}) }
    : {};
  // CORE-08: the call keeps the idempotency key of the run step that asked.
  let taskRun: ToolExecutionContext['taskRun'];
  if (runScope && typeof runScope === 'object' && runScope.runId && Number.isInteger(runScope.runStep)) {
    const step = await sql().read(one<{ idempotency_key: string }>('SELECT idempotency_key FROM task_run_steps WHERE run_id = ? AND step_index = ?',
      runScope.runId, runScope.runStep ?? null));
    if (step) taskRun = { runId: runScope.runId, stepIndex: runScope.runStep!, idempotencyKey: step.idempotency_key };
  }

  const { createAgentToolsRegistry } = await import('./index.js');
  const registry = await createAgentToolsRegistry({
    workspaceDir: process.cwd(),
    userId: row.user_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    delegatedFrom,
    toolPolicy,
    ...scoped,
    ...(taskRun ? { taskRun } : {}),
  });
  const ticket: ApprovalTicket = Object.freeze({ approvalId: id, toolName: row.tool_name });
  liveTickets.add(ticket);
  let result: ToolResult;
  try {
    result = await registry.execute(row.tool_name, params, { approvalTicket: ticket });
  } finally {
    liveTickets.delete(ticket);
  }
  // CH6: the agent that asked learns the owner changed its request (the text that ran is in the hand-off's result).
  if (row.edited_at && EDITABLE_REQUESTS[row.tool_name]) result = { ...result, content: [{ type: 'text', text: 'The owner changed the task before allowing it; this is the result of the changed task.' }, ...(result.content || [])] };
  const text = (result.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  await finish(result.error ? 'failed' : 'executed', text.slice(0, 500) || null, result.error ? String(result.error).slice(0, 300) : null);
  return { record: (await getApproval(id))!, result };
}
