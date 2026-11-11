// CHAT-REBUILD-01: the chat transcript model. Pure functions only: a saved
// message or a live run's events become a Turn; tool calls become one short
// human line ("Ran npm test", "Read config.ts"); a finished turn splits into
// its work (reasoning, tools, interim notes) and its final answer.
import type { LivePlanStep, LiveStep, RunEvent, WireMessage, WirePart } from './conversation-contract.js';

export type ToolCall = Readonly<{ id: string; name: string; input: string; output?: string; isError?: boolean; ms?: number; running: boolean; approvalId?: string }>;
export type Part =
  | Readonly<{ kind: 'reasoning'; text: string; startedAt?: number; endedAt?: number }>
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'tools'; step: number; calls: readonly ToolCall[] }>
  | Readonly<{ kind: 'steer'; text: string; step: number }>
  | Readonly<{ kind: 'notice'; code: 'injection' | 'summarized' | 'plan_limit' | 'images_not_seen' | 'choices'; text?: string }>
  | Readonly<{ kind: 'images'; images: readonly Readonly<{ id: string; type: string; name: string }>[] }>;
export type TurnStatus = 'running' | 'complete' | 'stopped' | 'error';
export type Turn = Readonly<{
  key: string; role: 'user' | 'assistant'; content: string; parts: readonly Part[]; status: TurnStatus;
  runId: string | null; durationMs: number | null; startedAt?: number; code?: 'model_unavailable' | 'local_model_missing' | 'lmstudio_not_running' | 'run_interrupted' | 'subscription_org_blocked'; lastSeq: number; pending?: boolean;
  /** Client clock time of the run's start, from the first event's `at` (keeps durations right after a re-attach). */
  base?: number;
  /** CHAT-PRO-02 I: the agent that wrote this reply (absent = the conversation's agent). */
  agentId?: string;
  /** CHAT-BUILD-01 stage 5: files this reply changed (Undo / Redo). */
  changes?: Readonly<{ files: number; undone: boolean; unavailable?: boolean; added?: number; removed?: number }>;
  /** CHAT-BUILD-01 stage 5: what the reply has written so far, shown live until its checked events arrive. */
  preview?: string;
  /** The tool it runs right now (live). */
  previewTool?: string;
  /** CHAT-LIVE-01: its steps so far and its plan, live (the checked parts replace them at the end). */
  previewSteps?: readonly LiveStep[];
  previewPlan?: readonly LivePlanStep[];
  /** CH2: when the message was saved (ISO), for the author line. */
  at?: string;
}>;

export function userTurn(key: string, content: string, runId: string | null, pending = false): Turn {
  return Object.freeze({ key, role: 'user', content, parts: [], status: 'complete', runId, durationMs: null, lastSeq: 0, ...(pending ? { pending } : {}) });
}

export function liveTurn(runId: string, now: number, agentId?: string): Turn {
  return Object.freeze({ key: `run:${runId}`, role: 'assistant', content: '', parts: [], status: 'running', runId, durationMs: null, startedAt: now, lastSeq: 0, ...(agentId ? { agentId } : {}) });
}

function fromWirePart(p: WirePart): Part {
  if (p.kind === 'tools') return { kind: 'tools', step: p.step, calls: p.calls.map(c => ({ ...c, running: false })) };
  if (p.kind === 'reasoning') return p.ms !== undefined ? { kind: 'reasoning', text: p.text, startedAt: 0, endedAt: p.ms } : { kind: 'reasoning', text: p.text };
  if (p.kind === 'steer' || p.kind === 'notice' || p.kind === 'images') return p;
  return { kind: 'text', text: p.text };
}

/** A stored message as a transcript turn. */
export function fromWire(m: WireMessage): Turn {
  // A message you sent keeps only its images (CHAT-GAPS-01); a reply keeps all its parts.
  const parts = m.role === 'assistant' ? (m.parts?.length ? m.parts.map(fromWirePart) : m.content ? [{ kind: 'text' as const, text: m.content }] : []) : (m.parts ?? []).filter(p => p.kind === 'images').map(fromWirePart);
  return Object.freeze({ key: m.id, role: m.role === 'user' ? 'user' : 'assistant', content: m.content, parts, status: m.status, runId: m.runId, durationMs: m.durationMs, lastSeq: 0, ...(m.code ? { code: m.code } : {}), ...(m.createdAt ? { at: m.createdAt } : {}), ...(m.agentId ? { agentId: m.agentId } : {}), ...(m.changes ? { changes: m.changes } : {}) });
}

/** Applies one run event to the live assistant turn (events at or below lastSeq are ignored). */
export function applyEvent(turn: Turn, e: RunEvent, received: number): Turn {
  if (e.type === 'preview') return turn.status === 'running' ? Object.freeze({ ...turn, preview: e.content, previewTool: e.tool, ...(e.steps ? { previewSteps: e.steps } : {}), ...(e.plan ? { previewPlan: e.plan } : {}) }) : turn;
  if (e.seq <= turn.lastSeq) return turn;
  // Server time when known: replayed events keep their real spacing.
  const base = turn.base ?? (e.at !== undefined ? received - e.at : undefined);
  const now = e.at !== undefined && base !== undefined ? base + e.at : received;
  if (base !== undefined && turn.base === undefined) turn = { ...turn, base, startedAt: base };
  const parts = [...turn.parts];
  const last = parts.at(-1);
  let content = turn.content;
  // Thinking ends when anything else arrives.
  const closeReasoning = () => {
    const i = parts.length - 1;
    const p = parts[i];
    if (p?.kind === 'reasoning' && p.endedAt === undefined) parts[i] = { ...p, endedAt: now };
  };
  switch (e.type) {
    case 'reasoning':
      if (last?.kind === 'reasoning' && last.endedAt === undefined) parts[parts.length - 1] = { ...last, text: last.text + e.content };
      else parts.push({ kind: 'reasoning', text: e.content, startedAt: now });
      break;
    case 'text':
      closeReasoning();
      if (last?.kind === 'text') parts[parts.length - 1] = { ...last, text: last.text + e.content };
      else parts.push({ kind: 'text', text: e.content });
      content += e.content;
      break;
    case 'tool_start': {
      closeReasoning();
      const calls = e.tools.map(t => ({ id: t.id, name: t.name, input: t.input, running: true }));
      const i = parts.findIndex(p => p.kind === 'tools' && p.step === e.step);
      if (i >= 0) { const p = parts[i] as Extract<Part, { kind: 'tools' }>; parts[i] = { ...p, calls: [...p.calls, ...calls] }; }
      else parts.push({ kind: 'tools', step: e.step, calls });
      break;
    }
    case 'tool_result': {
      const i = parts.findIndex(p => p.kind === 'tools' && p.step === e.step);
      if (i >= 0) {
        const p = parts[i] as Extract<Part, { kind: 'tools' }>;
        parts[i] = { ...p, calls: p.calls.map((c, k) => {
          const r = e.results.find(x => x.id === c.id) ?? e.results[k];
          return r ? { ...c, output: r.output, isError: r.isError, ms: r.ms, running: false, ...(r.approvalId ? { approvalId: r.approvalId } : {}) } : c;
        }) };
      }
      break;
    }
    case 'steer':
      closeReasoning();
      parts.push({ kind: 'steer', text: e.content, step: e.step });
      break;
    case 'notice':
      if ((e.code === 'injection' || e.code === 'summarized' || e.code === 'plan_limit' || e.code === 'images_not_seen') && !parts.some(p => p.kind === 'notice' && p.code === e.code)) parts.push({ kind: 'notice', code: e.code, ...(e.text ? { text: e.text } : {}) });
      break;
    case 'end':
      closeReasoning();
      return Object.freeze({ ...turn, parts: parts.map(p => (p.kind === 'tools' ? { ...p, calls: p.calls.map(c => (c.running ? { ...c, running: false } : c)) } : p)),
        content, status: e.status, durationMs: e.ms, lastSeq: e.seq, preview: undefined, previewTool: undefined, previewSteps: undefined, previewPlan: undefined, ...(e.code ? { code: e.code } : {}) });
  }
  return Object.freeze({ ...turn, parts, content, lastSeq: e.seq });
}

/**
 * The finished turn's work (everything up to the last tool step, plus any
 * thinking) and its answer (the text after the last tool step).
 */
export function splitWork(parts: readonly Part[]): { work: Part[]; answer: Part[] } {
  const lastTools = parts.map(p => p.kind).lastIndexOf('tools');
  const work: Part[] = []; const answer: Part[] = [];
  parts.forEach((p, i) => {
    if (p.kind === 'reasoning' || i <= lastTools) work.push(p);
    else answer.push(p);
  });
  return { work, answer };
}

export const toolCount = (parts: readonly Part[]) => parts.reduce((n, p) => n + (p.kind === 'tools' ? p.calls.length : 0), 0);

function args(input: string): Record<string, unknown> {
  try { const v = JSON.parse(input); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
const first = (a: Record<string, unknown>, keys: string[]) => { for (const k of keys) if (typeof a[k] === 'string' && (a[k] as string).trim()) return (a[k] as string).trim(); return ''; };
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
const oneLine = (s: string, n = 80) => { const l = s.split('\n')[0]; return l.length > n ? `${l.slice(0, n - 1)}…` : l; };

export type ToolKind = 'command' | 'read' | 'write' | 'edit' | 'search' | 'web' | 'browser' | 'memory' | 'board' | 'other';
export type ToolView = { kind: ToolKind; verb: string; target: string; command?: string; args: Record<string, unknown> };

/** How a tool call reads in the transcript; verbs change tense while it runs. */
export function toolView(call: Pick<ToolCall, 'name' | 'input' | 'running'>): ToolView {
  const a = args(call.input); const n = call.name.toLowerCase(); const live = call.running;
  const v = (now: string, done: string) => (live ? now : done);
  if (/^(exec|terminal|bash|shell|run_command|execute_code|sandbox)/.test(n)) {
    const cmd = first(a, ['command', 'cmd', 'script', 'code']);
    return { kind: 'command', verb: v('Running', 'Ran'), target: oneLine(cmd || n), command: cmd, args: a };
  }
  if (/read|cat_file|open_file|view_file/.test(n) && !/browser/.test(n)) return { kind: 'read', verb: v('Reading', 'Read'), target: base(first(a, ['path', 'file', 'file_path', 'filename'])) || n, args: a };
  if (/edit|patch|replace/.test(n)) return { kind: 'edit', verb: v('Editing', 'Edited'), target: base(first(a, ['path', 'file', 'file_path'])) || n, args: a };
  if (/write|create_file|save_file/.test(n)) return { kind: 'write', verb: v('Writing', 'Wrote'), target: base(first(a, ['path', 'file', 'file_path', 'filename'])) || n, args: a };
  if (/memory/.test(n)) return { kind: 'memory', verb: /save|store|remember|write|add/.test(n) ? v('Saving to memory', 'Saved to memory') : v('Searching memory', 'Searched memory'), target: oneLine(first(a, ['query', 'text', 'content', 'key'])), args: a };
  if (/^board_/.test(n)) return { kind: 'board', verb: v('Updating the board', 'Updated the board'), target: oneLine(first(a, ['title', 'cardId', 'text'])), args: a };
  if (/search|grep|find/.test(n)) { const q = first(a, ['query', 'q', 'pattern', 'text']); return { kind: 'search', verb: v('Searching', 'Searched'), target: q ? `“${oneLine(q, 60)}”` : n, args: a }; }
  if (/browser|navigate|screenshot|click/.test(n)) return { kind: 'browser', verb: v('Browsing', 'Browsed'), target: oneLine(first(a, ['url', 'selector', 'action']) || n), args: a };
  if (/web|url|download|http|curl|wget/.test(n) || typeof a.url === 'string') { const u = first(a, ['url', 'href', 'uri']); return { kind: 'web', verb: v('Opening', 'Opened'), target: u ? oneLine(u.replace(/^[a-z]+:\/\//i, ''), 70) : n, args: a }; }
  return { kind: 'other', verb: v('Using', 'Used'), target: n.replace(/_/g, ' '), args: a };
}

const KIND_LABEL: Record<ToolKind, [string, string, string]> = {
  command: ['ran', 'command', 'commands'], read: ['read', 'file', 'files'], write: ['wrote', 'file', 'files'], edit: ['edited', 'file', 'files'],
  search: ['searched', 'time', 'times'], web: ['opened', 'page', 'pages'], browser: ['used the browser', 'time', 'times'],
  memory: ['used memory', 'time', 'times'], board: ['updated the board', 'time', 'times'], other: ['used', 'tool', 'tools'],
};
const kindCount = (k: ToolKind, n: number) => `${KIND_LABEL[k][0]} ${n} ${n === 1 ? KIND_LABEL[k][1] : KIND_LABEL[k][2]}`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const kindOf = (c: ToolCall) => toolView({ ...c, running: false }).kind;

/** One line for a group of finished tool calls: "Ran 3 commands, read 2 files, searched 1 time". */
export function workSummary(parts: readonly Part[]): string {
  const counts = new Map<ToolKind, number>();
  for (const p of parts) if (p.kind === 'tools') for (const c of p.calls) { const k = kindOf(c); counts.set(k, (counts.get(k) ?? 0) + 1); }
  return cap([...counts].map(([k, n]) => kindCount(k, n)).join(', '));
}

/** "Ran 6 commands", "Read 1 file". */
export const groupLabel = (kind: ToolKind, n: number) => cap(kindCount(kind, n));

export type ReasoningPart = Extract<Part, { kind: 'reasoning' }>;
export type WorkSegment = Readonly<{ kind: ToolKind | 'thought'; label: string; failed: number }>;
/** CH10 item 10: the folded work row's parts, first-seen order: "Thought for 12s · Ran 6 commands · Read 4 files". */
export function workSegments(parts: readonly Part[]): WorkSegment[] {
  const thoughts = parts.filter((p): p is ReasoningPart => p.kind === 'reasoning' && !!p.text.trim());
  const timed = thoughts.filter(p => p.startedAt !== undefined && p.endedAt !== undefined);
  const secs = Math.round(timed.reduce((n, p) => n + (p.endedAt! - p.startedAt!), 0) / 1000);
  const out: WorkSegment[] = thoughts.length ? [{ kind: 'thought', label: !timed.length ? 'Thought' : secs < 1 ? 'Thought briefly' : `Thought for ${duration(secs * 1000)}`, failed: 0 }] : [];
  const counts = new Map<ToolKind, { n: number; failed: number }>();
  // CHAT-LIVE-01 (LW6): a call that waits for the owner is not counted as done ("Edited 1 file"); its card says it waits.
  for (const p of parts) if (p.kind === 'tools') for (const c of p.calls) { if (c.approvalId || /^Waiting for owner approval/.test(c.output ?? '')) continue; const k = kindOf(c); const e = counts.get(k) ?? { n: 0, failed: 0 }; e.n++; if (c.isError) e.failed++; counts.set(k, e); }
  for (const [k, e] of counts) out.push({ kind: k, label: groupLabel(k, e.n), failed: e.failed });
  return out;
}

export type WorkItem = Readonly<{ kind: 'part'; part: Part }> | Readonly<{ kind: 'group'; tool: ToolKind; calls: readonly ToolCall[]; entries: readonly (ToolCall | ReasoningPart)[] }>;
/**
 * CH2 item 4: a finished reply's work in its order, with back-to-back calls of
 * one kind in one group ("Ran 6 commands"). Thinking between two calls of the
 * same kind stays inside that group, in place; anything else ends the group.
 */
export function workGroups(parts: readonly Part[]): WorkItem[] {
  const out: WorkItem[] = []; let held: ReasoningPart[] = [];
  const flush = () => { for (const part of held) out.push({ kind: 'part', part }); held = []; };
  for (const p of parts) {
    if ((p.kind === 'text' && !p.text.trim()) || p.kind === 'images') continue;
    if (p.kind === 'reasoning' && out.at(-1)?.kind === 'group') { held.push(p); continue; }
    if (p.kind !== 'tools') { flush(); out.push({ kind: 'part', part: p }); continue; }
    for (const c of p.calls) {
      const k = kindOf(c); const last = out.at(-1);
      if (last?.kind === 'group' && last.tool === k) { out[out.length - 1] = { ...last, calls: [...last.calls, c], entries: [...last.entries, ...held, c] }; held = []; }
      else { flush(); out.push({ kind: 'group', tool: k, calls: [c], entries: [c] }); }
    }
  }
  flush();
  return out;
}

/** "12s", "1m 05s", "1h 02m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Files the agent wrote or edited in these turns (newest last, no duplicates). */
export function turnOutputs(turns: readonly Turn[]): { path: string; kind: 'write' | 'edit' }[] {
  const out = new Map<string, 'write' | 'edit'>();
  for (const t of turns) for (const p of t.parts) if (p.kind === 'tools') for (const c of p.calls) {
    if (c.isError || c.running) continue;
    const v = toolView({ ...c, running: false });
    if (v.kind !== 'write' && v.kind !== 'edit') continue;
    // CHAT-LIVE-01 (LW6): only real files of the folder: not a private draft, not a call that waits for the owner.
    if (/private draft|^Waiting for owner approval/.test(c.output ?? '')) continue;
    const path = ['path', 'file', 'file_path', 'filename'].map(k => v.args[k]).find(x => typeof x === 'string') as string | undefined;
    if (path) { out.delete(path); out.set(path, v.kind); }
  }
  return [...out].map(([path, kind]) => ({ path, kind }));
}

/** A rough size of the conversation in tokens (about 4 characters each). */
export function approxTokens(turns: readonly Turn[]): number {
  let chars = 0;
  for (const t of turns) { chars += t.content.length; for (const p of t.parts) if (p.kind === 'tools') for (const c of p.calls) chars += c.input.length + (c.output?.length ?? 0); }
  return Math.round(chars / 4);
}

/** The agent's live task plan (CHAT-PRO-02 H): its latest plan_steps call. */
export const PLAN_TOOL = 'plan_steps';
export type PlanStatus = 'pending' | 'active' | 'done' | 'skipped';
export type PlanStep = Readonly<{ title: string; status: PlanStatus; parent?: number }>;
const PLAN_STATUS: readonly string[] = ['pending', 'active', 'done', 'skipped'];

/** The newest plan in this turn (a refused call does not replace the last good plan), or null. */
export function turnPlan(parts: readonly Part[]): PlanStep[] | null {
  let plan: PlanStep[] | null = null;
  for (const p of parts) if (p.kind === 'tools') for (const c of p.calls) {
    if (c.name !== PLAN_TOOL || c.isError) continue;
    const steps = args(c.input).steps;
    if (!Array.isArray(steps) || !steps.length) continue;
    const clean = steps.slice(0, 20).filter((s): s is { title: string; status?: string; parent?: unknown } => !!s && typeof s === 'object' && typeof (s as { title?: unknown }).title === 'string' && !!(s as { title: string }).title.trim())
      .map(s => ({ title: s.title.trim().slice(0, 120), status: (PLAN_STATUS.includes(s.status ?? '') ? s.status : 'pending') as PlanStatus, ...(Number.isInteger(s.parent) && (s.parent as number) > 0 ? { parent: s.parent as number } : {}) }));
    if (clean.length) plan = clean;
  }
  return plan;
}

/** CHAT-PRO-02 I step 2: an agent's suggestion to put the task on the board (the owner decides). */
export const SUGGEST_TOOL = 'board_suggest_card';
export type CardSuggestion = Readonly<{ title: string; description: string; agents: readonly string[]; priority: 'low' | 'normal' | 'high' | 'urgent' }>;

/** The card suggestions in this turn (successful calls only), at most 3. */
export function turnSuggestions(parts: readonly Part[]): CardSuggestion[] {
  const out: CardSuggestion[] = [];
  for (const p of parts) if (p.kind === 'tools') for (const c of p.calls) {
    if (c.name !== SUGGEST_TOOL || c.isError || c.output === undefined) continue;
    const a = args(c.input);
    const title = typeof a.title === 'string' ? a.title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (!title || out.length >= 3) continue;
    out.push(Object.freeze({
      title, description: typeof a.description === 'string' ? a.description.trim().slice(0, 2000) : '',
      agents: Array.isArray(a.agents) ? a.agents.filter((x): x is string => typeof x === 'string').map(x => x.trim().replace(/^@/, '')).filter(Boolean).slice(0, 10) : [],
      priority: (['low', 'normal', 'high', 'urgent'] as const).find(x => x === a.priority) ?? 'normal',
    }));
  }
  return out;
}

/** CP11a: an agent's offer to run steps on the owner's other computers (the newest successful one). */
export const OFFER_TOOL = 'computer_offer';
export type ComputerOffer = Readonly<{ why: string; steps: readonly Readonly<{ title: string; computer: string; text: string }>[] }>;
export function turnOffer(parts: readonly Part[]): ComputerOffer | null {
  let offer: ComputerOffer | null = null;
  for (const p of parts) if (p.kind === 'tools') for (const c of p.calls) {
    if (c.name !== OFFER_TOOL || c.isError || c.output === undefined) continue;
    const a = args(c.input), raw = Array.isArray(a.steps) ? a.steps : [];
    const steps = raw.slice(0, 6).filter((x): x is {title: string; computer: string; text: string} => !!x && typeof x === 'object' && ['title', 'computer', 'text'].every(k => typeof (x as Record<string, unknown>)[k] === 'string' && ((x as Record<string, string>)[k]).trim().length > 0))
      .map(x => ({ title: x.title.trim().slice(0, 120), computer: x.computer.trim().slice(0, 64), text: x.text.trim().slice(0, 8000) }));
    if (steps.length) offer = { why: typeof a.why === 'string' ? a.why.trim().slice(0, 300) : '', steps };
  }
  return offer;
}

/** The parts without plan updates and card suggestions: both are shown on their own, not as tool work. */
export function withoutPlan(parts: readonly Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    if (p.kind !== 'tools') { out.push(p); continue; }
    const calls = p.calls.filter(c => c.name !== PLAN_TOOL && c.name !== SUGGEST_TOOL && c.name !== CHOICE_TOOL && c.name !== SESSION_START && c.name !== OFFER_TOOL);
    if (calls.length) out.push(calls.length === p.calls.length ? p : { ...p, calls });
  }
  return out;
}

/** CHAT-LIVE-01 (LW1): the live row's words: what the reply does right now, in plain words. */
export function livePhase(turn: Pick<Turn, 'preview' | 'previewSteps'>): { verb: string; target: string } {
  const now = [...(turn.previewSteps ?? [])].reverse().find(s => !s.done);
  if (now) {
    if (now.name === CHOICE_TOOL) return { verb: 'Waiting for you', target: '' };
    if (/^team_delegate|^session_/.test(now.name)) return { verb: 'Asking a teammate', target: '' };
    const v = toolView({ name: now.name, input: now.input, running: true });
    const verb = v.kind === 'search' && /web/.test(now.name) ? 'Searching the web' : v.kind === 'web' ? 'Opening' : v.verb;
    return { verb, target: v.kind === 'other' ? '' : v.target };
  }
  return turn.preview ? { verb: 'Answering', target: '' } : { verb: 'Thinking', target: '' };
}

/** CHAT-LIVE-01 (LW1): the live steps as tool calls (for the same step lines as a finished reply). */
export function liveCalls(steps: readonly LiveStep[] | undefined): ToolCall[] {
  return (steps ?? []).filter(s => s.name !== CHOICE_TOOL).map((s, i) => ({ id: `live-${i}`, name: s.name, input: s.input, running: !s.done, ...(s.done ? { output: '' } : {}), ...(s.failed ? { isError: true } : {}), ...(s.ms !== undefined ? { ms: s.ms } : {}) }));
}

/** CHAT-LIVE-01 (LW2): the agent's question with buttons. */
export const CHOICE_TOOL = 'ask_choice';
export type ChoiceAsk = Readonly<{ question: string; options: readonly string[]; reasons?: readonly string[]; multiple: boolean; suggested?: number }>;
/** The newest question in this turn that the agent really asked (a refused call shows nothing). */
export function turnChoice(parts: readonly Part[]): ChoiceAsk | null {
  let out: ChoiceAsk | null = null;
  for (const p of parts) if (p.kind === 'tools') for (const c of p.calls) {
    if (c.name !== CHOICE_TOOL || c.isError || c.output === undefined) continue;
    const a = args(c.input);
    const question = typeof a.question === 'string' ? a.question.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    // CHAT-CONTENT-01: an answer is a text or { label, reason }; reasons may also come as their own list.
    const raw = Array.isArray(a.options) ? a.options : [];
    const given = Array.isArray(a.reasons) ? a.reasons : [];
    const items: { label: string; reason: string }[] = [];
    raw.forEach((o, i) => {
      const label = (typeof o === 'string' ? o : o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string' ? (o as { label: string }).label : '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const r = o && typeof o === 'object' && typeof (o as { reason?: unknown }).reason === 'string' ? (o as { reason: string }).reason : typeof given[i] === 'string' ? given[i] as string : '';
      if (label && !items.some(x => x.label === label)) items.push({ label, reason: r.replace(/\s+/g, ' ').trim().slice(0, 140) });
    });
    const options = items.slice(0, 5).map(x => x.label), reasons = items.slice(0, 5).map(x => x.reason);
    if (!question || options.length < 2) continue;
    const n = Number(a.suggested);
    out = Object.freeze({ question, options, ...(reasons.some(Boolean) ? { reasons } : {}), multiple: a.multiple === true, ...(Number.isInteger(n) && n >= 1 && n <= options.length ? { suggested: n } : {}) });
  }
  return out;
}

/** The live plan of a running reply, else the newest finished plan (LW3). */
export function planOf(turn: Pick<Turn, 'status' | 'parts' | 'previewPlan'>): PlanStep[] | null {
  if (turn.status === 'running' && turn.previewPlan?.length) return turn.previewPlan.map(s => ({ ...s }));
  return turnPlan(turn.parts);
}

/** CHAT-ORCH-01 (LW4): the sub-sessions this reply started (successful starts only). */
export const SESSION_START = 'session_start';
export type StartedSession = Readonly<{ id: string; title: string; agentId: string }>;
export function turnSessions(parts: readonly Part[]): StartedSession[] {
  const out: StartedSession[] = [];
  for (const p of parts) if (p.kind === 'tools') for (const c of p.calls) {
    if (c.name !== SESSION_START || c.isError || !c.output) continue;
    const id = /\(id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/.exec(c.output)?.[1];
    if (!id || out.some(x => x.id === id)) continue;
    const a = args(c.input);
    const title = (typeof a.title === 'string' && a.title.trim() ? a.title : typeof a.task === 'string' ? a.task : 'Session').replace(/\s+/g, ' ').trim().slice(0, 80);
    out.push(Object.freeze({ id, title, agentId: typeof a.agent_id === 'string' ? a.agent_id : '' }));
  }
  return out.slice(0, 10);
}
