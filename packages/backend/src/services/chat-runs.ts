/**
 * Chat runs that outlive the page (CHAT-REBUILD-01).
 *
 * A run is one assistant turn in a saved conversation. It starts on a POST,
 * keeps going when the browser tab closes or reloads, and numbers every
 * event it produces so a client can (re)attach at any point with
 * `after=<seq>`. Stop aborts the turn and keeps what was written so far,
 * marked "stopped". When the run ends its turn is stored with its work
 * (reasoning, tool calls, text) and kept in memory a few minutes for late
 * readers.
 *
 * The turn itself is the same code as POST /api/chat (executeChatTurn): the
 * run hands it a reply whose raw stream feeds the run's event log, so agent
 * resolution, prompt, memory drawers, tool grants and approvals are
 * identical.
 */

import { EventEmitter } from 'node:events';
import type { FastifyReply } from 'fastify';
import { addAssistantMessage, type ToolCallPart, type TurnPart, type TurnStatus } from '../repositories/chat-conversations.js';
import { vaultRunSecrets } from './chat-secrets.js';
import { chunkText } from './chat-sse.js';
import { redactImportText } from '../memory/import/redact.js';
import { q } from '../repositories/sql-steps.js';
import { storeP8Enabled } from './store-p8.js';

/** CHAT-BUILD-01 stage 5: how often a running reply sends its live preview. */
export const PREVIEW_MS = 250;
/** Characters of the newest text a preview shows (the full reply comes with the checked events at the end). */
export const PREVIEW_CHARS = 16_000;
/**
 * The live preview of text written so far: secrets redacted, and the last
 * unfinished word held back so a half-written key never shows. Never stored;
 * the checked events replace it when the reply ends.
 */
export function previewText(text: string): string {
  const cut = text.search(/\S+$/);
  const stable = cut < 0 ? text : text.slice(0, cut);
  return redactImportText(stable.slice(-PREVIEW_CHARS)).text;
}

/** CHAT-LIVE-01: steps one live preview lists (the newest ones). */
export const PREVIEW_STEPS = 12;
const PLAN_TOOL = 'plan_steps';
const LIVE_HIDDEN = new Set([PLAN_TOOL]);
type LiveStep = { name: string; input: string; done: boolean; failed: boolean; ms?: number };
type LivePlanStep = { title: string; status: string; parent?: number };
/**
 * CHAT-LIVE-01 (LW1/LW3): what the reply is doing, for the live preview only:
 * its tool steps (inputs redacted and short) and its newest plan. Never
 * stored and never numbered; the checked events replace it at the end.
 */
export function liveWork(parts: readonly TurnPart[]): { steps?: LiveStep[]; plan?: LivePlanStep[] } {
  const calls = parts.flatMap((p) => (p.kind === 'tools' ? p.calls : []));
  const steps = calls.filter((c) => !LIVE_HIDDEN.has(c.name)).slice(-PREVIEW_STEPS).map((c) => ({
    name: c.name.slice(0, 64), input: redactImportText(String(c.input ?? '').slice(0, 300)).text, done: c.output !== undefined, failed: c.isError === true, ...(Number.isFinite(c.ms) ? { ms: c.ms } : {}),
  }));
  let plan: LivePlanStep[] | undefined;
  for (const c of calls) {
    if (c.name !== PLAN_TOOL || c.isError) continue;
    let raw: unknown; try { raw = JSON.parse(String(c.input ?? '')); } catch { continue; }
    const list = (raw as { steps?: unknown })?.steps;
    if (!Array.isArray(list) || !list.length) continue;
    plan = list.slice(0, 20).filter((x) => x && typeof x === 'object' && typeof (x as { title?: unknown }).title === 'string').map((x: any) => ({
      title: redactImportText(String(x.title).replace(/\s+/g, ' ').trim().slice(0, 120)).text,
      status: ['pending', 'active', 'done', 'skipped'].includes(x.status) ? x.status : 'pending',
      ...(Number.isInteger(x.parent) && x.parent > 0 ? { parent: x.parent } : {}),
    }));
  }
  return { ...(steps.length ? { steps } : {}), ...(plan?.length ? { plan } : {}) };
}

export type RunFrame = Record<string, unknown> & { type: string };
export interface RunEvent { seq: number; frame: RunFrame }
export type RunStatus = 'running' | TurnStatus;

/** Notices a turn may show (CHAT-BUILD-01). */
export const NOTICE_SUMMARY_CHARS = 2400;
export const NOTICE_CODES = new Set(['rate_limited', 'claude_key_missing', 'local_model_slow', 'injection', 'summarized', 'plan_limit', 'images_not_seen']);
/** Notices kept with the stored reply (CH10): the owner sees them again when the chat opens. */
const KEPT_NOTICES = new Set(['injection', 'summarized', 'plan_limit', 'images_not_seen']);
/** Runs one user may have running at the same time. */
export const MAX_RUNNING_PER_USER = 3;
/** How long a finished run stays attachable in memory. */
export const FINISHED_TTL_MS = 10 * 60_000;
/** Events kept per run; older text/reasoning deltas are merged once over it. */
export const MAX_EVENTS = 20_000;
/** Stored answer text cap (the stream itself is not cut). */
export const MAX_ANSWER_CHARS = 1_000_000;

export class ChatRun {
  /** Only checked frames are visible to SSE readers. */
  readonly events: RunEvent[] = [];
  private readonly pendingEvents: RunEvent[] = [];
  private bufferedChars = 0;
  private published = false;
  readonly parts: TurnPart[] = [];
  /** CHAT-PRO-02 I: the agent writing this reply (null = the conversation's agent). */
  agentId: string | null = null;
  status: RunStatus = 'running';
  answer = '';
  readonly startedAt: number;
  endedAt?: number;
  readonly emitter = new EventEmitter();
  /** Fires 'close' on the fake response: the turn's own abort path stops model calls and tools. */
  readonly raw: FakeRaw;
  private seq = 0;
  private stopRequested = false;
  private reasoningFrom?: number;
  private openReasoning?: Extract<TurnPart, { kind: 'reasoning' }>;
  private readonly clock: () => number;

  constructor(readonly id: string, readonly userId: string, readonly sessionId: string, now: number, clock: () => number = Date.now) {
    this.startedAt = now;
    this.clock = clock;
    this.emitter.setMaxListeners(50);
    this.raw = new FakeRaw((frame) => this.push(frame));
  }

  get stopping() { return this.stopRequested; }

  /** CHAT-BUILD-01 stage 5 (CH10 Steer now): messages the owner sent while the agent works; the loop takes them at its next step. */
  private steers: string[] = [];
  private steerStep = 0;
  steer(text: string): boolean {
    if (this.status !== 'running' || this.stopRequested || this.steers.length >= 5) return false;
    this.steers.push(text);
    return true;
  }
  /** Called by the model loop before each step: the waiting steer messages (shown in the reply, sent to the model). */
  takeSteers(): string[] {
    if (!this.steers.length) return [];
    const taken = this.steers.splice(0);
    const step = ++this.steerStep;
    for (const text of taken) { this.parts.push({ kind: 'steer', text, step }); this.emit({ type: 'steer', content: text, step }); }
    return taken;
  }
  /** A notice from outside the turn's stream (a tool result that tried to give orders). */
  notice(code: string, text?: string) { this.push({ type: 'notice', code, ...(text ? { text } : {}) }); }

  /** Adds one frame from the turn; frames after the end are ignored. */
  push(frame: RunFrame) {
    if (this.status !== 'running' || this.published || this.error === 'content_limit') return;
    const size = JSON.stringify(frame).length;
    if (this.bufferedChars + size > MAX_ANSWER_CHARS * 4) { this.error = 'content_limit'; this.requestStop(); return; }
    this.bufferedChars += size;
    const type = frame.type === undefined && typeof frame.content === 'string' ? 'text' : String(frame.type);
    if (type === 'done' || (frame.done === true && type === 'text')) {
      if (type === 'text' && frame.content) this.addText('text', String(frame.content));
      return; // the run's own 'end' event closes the stream
    }
    if (type === 'error') { this.error = ['model_unavailable', 'local_model_missing', 'lmstudio_not_running'].includes(String(frame.code)) ? String(frame.code) : 'failed'; return; }
    if (type === 'text' || type === 'reasoning') {
      const content = typeof frame.content === 'string' ? frame.content : '';
      if (!content) return;
      this.addText(type, content);
      return;
    }
    if (type === 'tool_start' || type === 'tool_result') { this.addTools(type, frame); this.previewSoon(); return; }
    // CHAT-BUILD-01: notices (rate limit wait, key missing) are shown, never stored as answer text.
    if (type === 'notice' && NOTICE_CODES.has(String(frame.code))) {
      const code = String(frame.code);
      // The summary notice carries the summary itself (Read the summary); other notices are one line.
      const text = typeof frame.text === 'string' ? redactImportText(frame.text.slice(0, code === 'summarized' ? NOTICE_SUMMARY_CHARS : 300)).text : undefined;
      if (KEPT_NOTICES.has(code) && !this.parts.some((p) => p.kind === 'notice' && p.code === code)) this.parts.push({ kind: 'notice', code, ...(text ? { text } : {}) });
      this.emit({ type: 'notice', code, ...(Number.isFinite(frame.waitSec) ? { waitSec: Number(frame.waitSec) } : {}), ...(typeof frame.model === 'string' ? { model: frame.model.slice(0, 100) } : {}), ...(text ? { text } : {}) });
      return;
    }
    // Unknown frames (provider notes, metadata) are not shown or stored.
  }

  error?: string;

  /** Every event carries `at`: milliseconds since the run started (durations survive a re-attach). */
  private emit(frame: RunFrame) {
    const at = Math.max(0, this.clock() - this.startedAt);
    if (frame.type !== 'reasoning') this.closeReasoning(at);
    const event = { seq: ++this.seq, frame: { ...frame, at } };
    this.pendingEvents.push(event);
    if (this.pendingEvents.length > MAX_EVENTS) this.compact();
  }

  private closeReasoning(at: number) {
    if (this.openReasoning && this.reasoningFrom !== undefined) this.openReasoning.ms = at - this.reasoningFrom;
    this.openReasoning = undefined; this.reasoningFrom = undefined;
  }

  private addText(kind: 'text' | 'reasoning', content: string) {
    const last = this.parts.at(-1);
    if (last && last.kind === kind) last.text += content;
    else {
      const part: TurnPart = { kind, text: content };
      if (part.kind === 'reasoning') { this.reasoningFrom = Math.max(0, this.clock() - this.startedAt); this.openReasoning = part; }
      this.parts.push(part);
    }
    if (kind === 'text') { this.answer += content; this.previewSoon(); }
    this.emit({ type: kind, content });
  }

  /** The newest text part, shown live while the run works (CHAT-BUILD-01 stage 5). */
  private lastPreview = 0;
  /** CHAT-LIVE-01: the newest preview, sent at once to a reader that (re)attaches while the run works. */
  latestPreview?: Record<string, unknown>;
  private previewTimer?: ReturnType<typeof setTimeout>;
  private previewSoon() {
    if (this.previewTimer || this.published) return;
    const wait = Math.max(0, PREVIEW_MS - (this.clock() - this.lastPreview));
    this.previewTimer = setTimeout(() => {
      this.previewTimer = undefined;
      if (this.published || this.status !== 'running') return;
      this.lastPreview = this.clock();
      const last = this.parts.at(-1);
      const tool = [...this.parts].reverse().find((p): p is Extract<TurnPart, { kind: 'tools' }> => p.kind === 'tools');
      this.latestPreview = { type: 'preview', content: last?.kind === 'text' ? previewText(last.text) : '', ...(tool && last?.kind === 'tools' ? { tool: tool.calls.at(-1)?.name ?? '' } : {}), ...liveWork(this.parts) };
      this.emitter.emit('preview', this.latestPreview);
    }, wait);
    this.previewTimer.unref?.();
  }

  private addTools(type: 'tool_start' | 'tool_result', frame: RunFrame) {
    const step = Number.isSafeInteger(frame.step) ? (frame.step as number) : 0;
    type ToolsPart = Extract<TurnPart, { kind: 'tools' }>;
    let part = [...this.parts].reverse().find((p): p is ToolsPart => p.kind === 'tools' && p.step === step);
    if (type === 'tool_start') {
      const tools = Array.isArray(frame.tools) ? frame.tools : [];
      const calls: ToolCallPart[] = tools.map((t: any, i: number) => ({
        id: typeof t?.id === 'string' ? t.id : `s${step}-${i}`,
        name: typeof t?.name === 'string' ? t.name : 'tool',
        input: typeof t?.input === 'string' ? t.input : JSON.stringify(t?.input ?? {}),
      }));
      if (!part) { part = { kind: 'tools', step, calls: [] }; this.parts.push(part); }
      part.calls.push(...calls);
      this.emit({ type: 'tool_start', step, tools: calls });
      return;
    }
    const results = Array.isArray(frame.results) ? frame.results : [];
    const out = results.map((r: any, i: number) => {
      const call = part?.calls.find((c: ToolCallPart) => c.id === r?.id) ?? part?.calls[i];
      const output = typeof r?.output === 'string' ? r.output : '';
      // CHAT-BUILD-01 stage 5: a call waiting for the owner carries its approval id, so the chat can show Allow once / Deny.
      // Only the approval gate's own text for this very tool counts (a page cannot make a card for another request);
      // the card also checks the stored request's tool and chat before Allow once.
      const toolName = typeof r?.name === 'string' ? r.name : call?.name ?? '';
      const gate = /^Waiting for owner approval: "([^"]{1,128})" was NOT run\. Approval request ([A-Za-z0-9-]{8,64}) is pending;/.exec(output);
      const approvalId = gate && gate[1] === toolName ? gate[2] : undefined;
      const res = { id: call?.id ?? (typeof r?.id === 'string' ? r.id : `s${step}-${i}`), name: typeof r?.name === 'string' ? r.name : call?.name ?? 'tool',
        output, isError: r?.isError === true, ms: Number.isFinite(r?.ms) ? Number(r.ms) : undefined, ...(approvalId ? { approvalId } : {}) };
      if (call) Object.assign(call, { output: res.output, isError: res.isError, ...(res.ms !== undefined ? { ms: res.ms } : {}), ...(approvalId ? { approvalId } : {}) });
      return res;
    });
    this.emit({ type: 'tool_result', step, results: out });
  }

  /** Over the event cap: merge adjacent text/reasoning deltas (sequence numbers stay). */
  private compact() {
    for (let i = this.pendingEvents.length - 2; i >= 0 && this.pendingEvents.length > MAX_EVENTS * 0.8; i--) {
      const a = this.pendingEvents[i], b = this.pendingEvents[i + 1];
      if ((a.frame.type === 'text' || a.frame.type === 'reasoning') && a.frame.type === b.frame.type) {
        b.frame = { ...b.frame, content: String(a.frame.content) + String(b.frame.content) };
        this.pendingEvents.splice(i, 1);
      }
    }
  }

  /** Check the complete turn before exposing model-controlled bytes. This
   * also catches secrets split across chunks. Unexpected failure drops all.
   */
  async publishChecked(check: typeof vaultRunSecrets = vaultRunSecrets) {
    if (this.published) return;
    try {
      const target = { userId: this.userId, sessionId: this.sessionId, answer: this.answer, parts: this.parts, events: this.pendingEvents };
      await check(target);
      this.answer = target.answer.slice(0, MAX_ANSWER_CHARS);
    } catch {
      this.answer = ''; this.parts.length = 0; this.pendingEvents.length = 0;
      this.error = 'secret_check_failed';
    }
    this.published = true;
    this.seq = 0;
    for (const event of this.pendingEvents) {
      const frames = event.frame.type === 'text' || event.frame.type === 'reasoning'
        ? chunkText(String(event.frame.content ?? ''), 16_000).map(content => ({ ...event.frame, content }))
        : [event.frame];
      for (const frame of frames) {
        const checked = { seq: ++this.seq, frame };
        this.events.push(checked);
        this.emitter.emit('event', checked);
      }
    }
    this.pendingEvents.length = 0;
  }

  /** Ends the run once: emits the closing event and resolves the final status. */
  finish(status: TurnStatus, now: number) {
    if (this.status !== 'running') return;
    this.closeReasoning(now - this.startedAt);
    this.endedAt = now;
    const event = { seq: ++this.seq, frame: { type: 'end', status, ms: now - this.startedAt, at: now - this.startedAt, ...(this.error ? { code: this.error } : {}) } };
    this.status = status;
    this.events.push(event);
    this.emitter.emit('event', event);
    this.emitter.emit('end');
  }

  /** Closes an open thinking part before the turn is stored. */
  settle(now: number) { this.closeReasoning(now - this.startedAt); }

  requestStop() {
    if (this.status !== 'running' || this.stopRequested) return;
    this.stopRequested = true;
    this.raw.close();
  }

  /** Events after `after`; the caller then listens for new ones. */
  since(after: number): RunEvent[] {
    if (after <= 0) return [...this.events];
    const i = this.events.findIndex((e) => e.seq > after);
    return i < 0 ? [] : this.events.slice(i);
  }
}

/**
 * The response object a run hands to executeChatTurn: it parses the SSE
 * `data:` frames the turn writes and drops heartbeats; `close()` stands for
 * the client going away, which every turn path already treats as abort.
 */
export class FakeRaw extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  statusCode = 200;
  constructor(private readonly onFrame: (frame: RunFrame) => void) { super(); }
  writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; }
  flushHeaders() { this.headersSent = true; }
  setHeader() { return this; }
  getHeader() { return undefined; }
  write(chunk: unknown) {
    if (this.writableEnded) return false;
    if (typeof chunk !== 'string') return true;
    for (const block of chunk.split(/\n\n/)) {
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try { const f = JSON.parse(data); if (f && typeof f === 'object' && !Array.isArray(f)) this.onFrame(f); } catch { /* not a frame */ }
    }
    return true;
  }
  end(chunk?: unknown) { if (chunk) this.write(chunk); if (!this.writableEnded) { this.writableEnded = true; this.emit('finish'); } return this; }
  close() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}

/** A FastifyReply stand-in over a FakeRaw: a refusal before the stream becomes the run's error. */
export function runReply(run: ChatRun): FastifyReply {
  let status = 200;
  const reply: any = {
    raw: run.raw,
    sent: false,
    statusCode: 200,
    header() { return reply; },
    headers() { return reply; },
    code(c: number) { status = c; reply.statusCode = c; return reply; },
    status(c: number) { return reply.code(c); },
    send(body: any) {
      reply.sent = true;
      if (status >= 400) run.push({ type: 'error', code: typeof body?.code === 'string' ? body.code : `http_${status}` });
      else if (body && typeof body.content === 'string') run.push({ type: 'text', content: body.content });
      return reply;
    },
  };
  return reply as FastifyReply;
}

export interface StartRunInput {
  runId: string;
  userId: string;
  sessionId: string;
  /** CHAT-PRO-02 I: the agent writing this reply (stored with it). */
  agentId?: string | null;
  execute: (reply: FastifyReply) => Promise<unknown>;
  onPersisted?: (status: TurnStatus) => Promise<void>;
  /** Called only after the stored run is closed, so a next participant can acquire the writer. */
  onFinished?: (status: TurnStatus) => Promise<void>;
  /** CHAT-BUILD-01: the turn could not be stored; the caller must still close its journal row. */
  onUnstored?: () => Promise<void>;
}

export class ChatRunRegistry {
  private readonly runs = new Map<string, ChatRun>();
  constructor(private readonly now: () => number = Date.now, private readonly persist = addAssistantMessage) {}

  get(runId: string): ChatRun | undefined { this.sweep(); return this.runs.get(runId); }

  /** The running run of a conversation, if any. */
  activeFor(sessionId: string): ChatRun | undefined {
    for (const r of this.runs.values()) if (r.sessionId === sessionId && r.status === 'running') return r;
    return undefined;
  }

  runningCount(userId: string): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.userId === userId && r.status === 'running') n++;
    return n;
  }

  /** Starts the turn in the background; resolves when the run is registered (not when it ends). */
  start(input: StartRunInput): ChatRun {
    this.sweep();
    const run = new ChatRun(input.runId, input.userId, input.sessionId, this.now(), this.now);
    run.agentId = input.agentId ?? null;
    this.runs.set(run.id, run);
    void (async () => {
      try { await input.execute(runReply(run)); }
      catch (err) { if (!run.error) run.error = 'failed'; console.error('[ChatRuns] Turn failed', { runId: run.id, name: (err as Error)?.name ?? 'Error' }); }
      run.settle(this.now());
      await run.publishChecked();
      const status: TurnStatus = run.error ? 'error' : run.stopping ? 'stopped' : 'complete';
      let durableStatus = status;
      try {
        await this.persist(run.sessionId, { runId: run.id, content: run.answer, parts: run.parts, status, durationMs: this.now() - run.startedAt, agentId: input.agentId ?? null });
        await input.onPersisted?.(status);
      } catch (err) {
        durableStatus = 'error';
        console.error('[ChatRuns] Could not store the turn', { runId: run.id, name: (err as Error)?.name ?? 'Error' });
        await input.onUnstored?.().catch(() => undefined);
      }
      run.raw.end();
      run.finish(status, this.now());
      // STORE-MAP-01 P8 (D27): the reply's working notes become its handoff (when it wrote none) and lesson suggestions.
      if (storeP8Enabled()) await distillChatRun(run.id, input.userId, input.sessionId, input.agentId ?? null).catch(() => console.warn('[ChatRuns] Working notes not distilled', { runId: run.id }));
      try { await input.onFinished?.(durableStatus); }
      catch { console.error('[ChatRuns] Follow-up paused', { runId: run.id }); }
    })();
    return run;
  }

  /** Drops finished runs older than the TTL. */
  sweep() {
    const t = this.now();
    for (const [id, r] of this.runs) if (r.endedAt !== undefined && t - r.endedAt > FINISHED_TTL_MS) this.runs.delete(id);
  }
}

/** P8: a chat reply's working notes, distilled without a model (memory/handoff/run-notes.ts). */
async function distillChatRun(runId: string, userId: string, sessionId: string, agentId: string | null): Promise<void> {
  const { distillRun } = await import('../memory/handoff/run-notes.js');
  if (!(await q.one('SELECT 1 AS x FROM run_notes WHERE owner_id = ? AND run_kind = ? AND run_id = ? LIMIT 1', userId, 'chat', runId))) return;
  const { conversationScope } = await import('../memory/handoff/scope.js');
  const scope = await conversationScope(userId, sessionId, agentId);
  const project = scope?.projectId ? await q.one<{ id: string; slug: string }>('SELECT id, slug FROM chat_projects WHERE id = ? AND user_id = ?', scope.projectId, userId) : undefined;
  const { projectDrawer } = await import('../memory/bridge/brief.js');
  await distillRun({ ownerId: userId, runKind: 'chat', runId }, { scope, agentId: scope?.agentId ?? agentId ?? '_main', drawer: project ? projectDrawer(project) : null });
}

export const chatRuns = new ChatRunRegistry();
