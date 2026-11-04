/**
 * CHAT-ORCH-01 (LW4): the main agent runs other chats as sub-sessions.
 *
 * session_start opens a new chat under this one (parent_id) with the chosen
 * agent and the task as its first message; it works on its own, in the same
 * project, with that agent's own model, rules and grants. session_list /
 * session_read watch them, session_message talks to one (Steer while it
 * works, else a new message), session_stop stops it.
 *
 * Gates: only in the owner's own chat (never a channel, a delegated child or
 * a task run), only for an agent that may coordinate (the main agent, or a
 * manager for its own people: coordinator + mayDelegate, as team_delegate).
 * Starting one asks the owner (approval card). Everything a sub-session does
 * goes through its own approvals as usual. Depth stops at 2, and at most
 * MAX_SESSIONS of one chat's family run at the same time.
 */
import { randomUUID } from 'node:crypto';
import type { Tool, ToolExecutionContext, ToolResult } from '../types.js';
import { one, sql } from '../../repositories/sql-steps.js';
import { createConversation, findConversation, listConversationMessages, listConversations, type Conversation } from '../../repositories/chat-conversations.js';
import { chatRuns } from '../../services/chat-runs.js';
import { mayDelegate } from '../../services/agent-org.js';
import { coordinator } from './team.js';

export const SESSION_TOOLS = ['session_start', 'session_list', 'session_read', 'session_message', 'session_stop'] as const;
/** Sub-sessions of one chat's family running at the same time (more wait for the owner to start them again). */
export const MAX_SESSIONS = 3;
/** A sub-session may itself start sub-sessions down to this depth (the parent chat is depth 0). */
export const MAX_DEPTH = 2;
const TASK_CHARS = 12_000;

const text = (t: string, details?: Record<string, unknown>, error?: string): ToolResult => ({ content: [{ type: 'text', text: t }], ...(details ? { details } : {}), ...(error ? { error } : {}) });
const refused = (why: string) => text(`Not done: ${why}.`, undefined, 'session_refused');

type Family = { me: Conversation; all: Conversation[]; children: Conversation[]; depth: number };

/** This chat, the owner's chats, this chat's descendants and how deep this chat is. */
async function family(context: ToolExecutionContext): Promise<Family | null> {
  const me = await findConversation(context.userId!, context.sessionId!);
  if (!me) return null;
  const chats = await listConversations(context.userId!, 500);
  const byId = new Map(chats.map(c => [c.id, c]));
  let depth = 0;
  for (let p = me.parentId ? byId.get(me.parentId) : undefined; p && depth < 10; p = p.parentId ? byId.get(p.parentId) : undefined) depth++;
  const out: Conversation[] = [];
  const walk = (id: string, d: number) => { if (d > MAX_DEPTH + 1) return; for (const c of chats) if (c.parentId === id) { out.push(c); walk(c.id, d + 1); } };
  walk(me.id, 1);
  return { me, all: chats, children: out, depth };
}

/** The chat a session tool may act on: one of this chat's descendants. */
function target(f: Family, id: unknown): Conversation | null {
  return typeof id === 'string' ? f.children.find(c => c.id === id) ?? null : null;
}

async function state(c: Conversation): Promise<{ state: 'working' | 'needs_you' | 'done' | 'stopped' | 'failed' | 'new'; last: string; at?: string }> {
  const run = chatRuns.activeFor(c.id);
  const waiting = (await sql().read(one<{ n: number }>("SELECT COUNT(*) AS n FROM tool_approvals WHERE session_id = ? AND status = 'pending'", c.id)).catch(() => undefined))?.n ?? 0;
  const msgs = await listConversationMessages(c.id);
  const reply = [...msgs].reverse().find(m => m.role === 'assistant');
  const last = (reply?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (run) return { state: waiting ? 'needs_you' : 'working', last };
  if (waiting) return { state: 'needs_you', last, at: reply?.createdAt };
  if (!reply) return { state: 'new', last };
  return { state: reply.status === 'complete' ? 'done' : reply.status === 'stopped' ? 'stopped' : 'failed', last, at: reply.createdAt };
}

const agentName = async (id: string | null) => id ? (await sql().read(one<{ name: string }>('SELECT name FROM agents_config WHERE id = ?', id)))?.name ?? id : 'the main agent';

/** The owner's own chat with an agent that may coordinate; else the reason. */
async function gate(context?: ToolExecutionContext): Promise<{ rows: NonNullable<Awaited<ReturnType<typeof coordinator>>>; f: Family } | string> {
  const rows = await coordinator(context);
  if (!rows) return 'sessions are only for the main agent or a manager, in the owner\'s own chat';
  const f = await family(context!);
  if (!f) return 'this chat is not available';
  return { rows, f };
}

export const sessionStartTool: Tool = {
  name: 'session_start',
  requiresApproval: true,
  selfOnly: true,
  description: `Start a sub-session: a new chat under this one where one agent works on one self-contained task on its own (its own model, rules and approvals), in this chat's project. Use it to split bigger work into parts that can run side by side; keep small things to yourself. The owner approves each start. At most ${MAX_SESSIONS} run at the same time. It returns at once with the session id; watch it with session_list / session_read, talk to it with session_message, stop it with session_stop. Its final reply is its report.`,
  input_schema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'An agent you may give work to (team_list)' },
      task: { type: 'string', description: `The task, what to deliver and how to report (up to ${TASK_CHARS} characters)` },
      title: { type: 'string', description: 'A short name for the session (shown in the sidebar)' },
    },
    required: ['agent_id', 'task'],
  },
  async execute(params, context) {
    const g = await gate(context);
    if (typeof g === 'string') return refused(g);
    const { rows, f } = g;
    const agentId = typeof params?.agent_id === 'string' ? params.agent_id : '';
    const task = typeof params?.task === 'string' ? params.task.trim() : '';
    if (!task || task.length > TASK_CHARS) return refused(`give the task in 1 to ${TASK_CHARS} characters`);
    if (!agentId || agentId === context!.agentId || !mayDelegate(context!.agentId!, agentId, rows)) return refused('pick an agent you may give work to (see team_list)');
    if (f.depth + 1 > MAX_DEPTH) return refused('a sub-session cannot start more sessions this deep');
    const root = (() => { let c = f.me; const byId = new Map(f.all.map(x => [x.id, x])); for (let i = 0; i < 10 && c.parentId && byId.get(c.parentId); i++) c = byId.get(c.parentId)!; return c; })();
    const tree = f.all.filter(c => { for (let p: Conversation | undefined = c, i = 0; p && i < 10; p = p.parentId ? f.all.find(x => x.id === p!.parentId) : undefined, i++) if (p.id === root.id) return c.id !== root.id; return false; });
    if (tree.filter(c => chatRuns.activeFor(c.id)).length >= MAX_SESSIONS) return refused(`${MAX_SESSIONS} sessions of this chat are already working; wait for one to finish`);
    const owner = await sql().read(one<{ role: string }>('SELECT role FROM users WHERE id = ?', context!.userId!));
    const title = (typeof params?.title === 'string' && params.title.trim() ? params.title : task).replace(/\s+/g, ' ').trim().slice(0, 80);
    const made = await createConversation(context!.userId!, { title, agentId, projectId: f.me.projectId ?? null, parentId: f.me.id, ...(f.me.mode ? { mode: f.me.mode } : {}) });
    const c = await findConversation(context!.userId!, made.id);
    if (!c) return refused('the session could not be made');
    const by = await agentName(context!.agentId ?? null);
    const message = `${task}\n\n(Started by ${by} from the chat "${f.me.title ?? 'Chat'}". Work on your own; when you are done, end with a short report of what you did and what is left.)`;
    // Late import: the chat routes import the tools, so the tools load the routes only when a session starts.
    const { startTurn } = await import('../../api/routes/chat-conversations.js');
    const out = await startTurn({ userId: context!.userId!, role: owner?.role ?? 'owner', c, runId: `session-${randomUUID()}`, message, displayMessage: task });
    if (out.code !== 202) return refused(`the session could not start (${String((out.body as { code?: string }).code ?? out.code)})`);
    const name = await agentName(agentId);
    return text(`Started the session "${title}" with ${name} (id ${c.id}). It works on its own; check it with session_list.`, { session: { id: c.id, title, agentId, agentName: name } });
  },
};

export const sessionListTool: Tool = {
  name: 'session_list',
  selfOnly: true,
  description: 'List the sub-sessions of this chat (and theirs) with who works on each, its state (working, needs_you, done, stopped, failed) and its last line.',
  input_schema: { type: 'object', properties: {} },
  async execute(_params, context) {
    const g = await gate(context);
    if (typeof g === 'string') return refused(g);
    const rows = await Promise.all(g.f.children.slice(0, 30).map(async c => ({ id: c.id, title: c.title ?? 'Chat', parentId: c.parentId, agent: await agentName(c.agentId), ...(await state(c)) })));
    return text(rows.length ? JSON.stringify(rows) : 'No sub-sessions in this chat yet.', { sessions: rows });
  },
};

export const sessionReadTool: Tool = {
  name: 'session_read',
  selfOnly: true,
  description: 'Read one sub-session: its state and its newest replies (its report when it is done).',
  input_schema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  async execute(params, context) {
    const g = await gate(context);
    if (typeof g === 'string') return refused(g);
    const c = target(g.f, params?.session_id);
    if (!c) return refused('that is not a sub-session of this chat');
    const s = await state(c);
    const replies = (await listConversationMessages(c.id)).filter(m => m.role === 'assistant').slice(-3).map(m => ({ status: m.status, text: m.content.slice(0, 4000) }));
    return text(JSON.stringify({ id: c.id, title: c.title, agent: await agentName(c.agentId), state: s.state, replies }), { session: { id: c.id, state: s.state } });
  },
};

export const sessionMessageTool: Tool = {
  name: 'session_message',
  selfOnly: true,
  description: 'Send a message to one sub-session: while it works it sees it at its next step (Steer); otherwise it answers it as a new message.',
  input_schema: { type: 'object', properties: { session_id: { type: 'string' }, text: { type: 'string' } }, required: ['session_id', 'text'] },
  async execute(params, context) {
    const g = await gate(context);
    if (typeof g === 'string') return refused(g);
    const c = target(g.f, params?.session_id);
    const t = typeof params?.text === 'string' ? params.text.trim() : '';
    if (!c) return refused('that is not a sub-session of this chat');
    if (!t || t.length > 4000) return refused('give the message in 1 to 4000 characters');
    const by = await agentName(context!.agentId ?? null);
    const run = chatRuns.activeFor(c.id);
    if (run) return run.steer(`${by}: ${t}`) ? text('Sent; the session sees it at its next step.') : refused('the session cannot take more messages right now');
    const owner = await sql().read(one<{ role: string }>('SELECT role FROM users WHERE id = ?', context!.userId!));
    const { startTurn } = await import('../../api/routes/chat-conversations.js');
    const out = await startTurn({ userId: context!.userId!, role: owner?.role ?? 'owner', c, runId: `session-${randomUUID()}`, message: `${by}: ${t}`, displayMessage: t });
    return out.code === 202 ? text('Sent; the session is answering.') : refused(`the session could not answer (${String((out.body as { code?: string }).code ?? out.code)})`);
  },
};

export const sessionStopTool: Tool = {
  name: 'session_stop',
  selfOnly: true,
  description: 'Stop one sub-session that is working. What it did so far is kept; you can message it again later.',
  input_schema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  async execute(params, context) {
    const g = await gate(context);
    if (typeof g === 'string') return refused(g);
    const c = target(g.f, params?.session_id);
    if (!c) return refused('that is not a sub-session of this chat');
    const run = chatRuns.activeFor(c.id);
    if (!run) return text('It was not working.');
    run.requestStop();
    return text(`Stopped "${c.title ?? 'the session'}". What it did so far is kept.`);
  },
};

export const sessionTools: Tool[] = [sessionStartTool, sessionListTool, sessionReadTool, sessionMessageTool, sessionStopTool];
