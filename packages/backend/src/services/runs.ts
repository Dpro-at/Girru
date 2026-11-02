/**
 * RUNS-01: one read model over everything that runs in Girru, for the Runs section and the
 * workspace_runs MCP tool. Nothing here starts work; it reads the sources where they already live:
 *
 *   chat     chat_run_journal (+ chat_sessions, the stored reply)       a reply in a chat
 *   task     task_runs (+ small_agent_runs)                             agent check-in tasks, small helpers
 *   code     coding_app_runs (+ the live registry)                      Claude Code / Codex / Gemini work from a chat
 *   job      job_executions (+ cron_jobs)                               system jobs (owner only)
 *   approval tool_approvals pending in a chat                           a chat that waits for the owner's OK
 *
 * Scope: `userId` null = the owner (everything); otherwise only that person's rows, and never
 * system jobs or agent check-ins (no person behind them). Every text that may hold a secret
 * passes redactImportText before it leaves this module.
 */
import { q } from '../repositories/sql-steps.js';
import { redactImportText } from '../memory/import/redact.js';
import { chatRuns } from './chat-runs.js';
import { liveCodingRuns } from './coding-runs.js';

export type RunKind = 'chat' | 'task' | 'helper' | 'code' | 'job' | 'handoff';
export type RunState = 'working' | 'queued' | 'waiting' | 'done' | 'failed' | 'stopped';
export type Place = 'running' | 'waiting' | 'finished' | 'failed';
export type StartedBy = 'you' | 'schedule' | 'card' | 'approval' | 'agent' | 'system' | 'manual';
export interface StopReason { code: string; title: string; text: string; bug: boolean; detail?: string }
export interface RunItem {
  id: string; kind: RunKind; title: string; state: RunState; reason: StopReason | null;
  agentId: string | null; agentName: string | null; app: string | null; model: string | null;
  projectId: string | null; projectName: string | null; startedBy: StartedBy;
  startedAt: string; endedAt: string | null; needsYou: boolean;
  /** Board RN6: the main task this run is a sub-task of (a chat reply that handed work over), or null. */
  parentId: string | null;
  link: { sessionId?: string; jobId?: string; taskRunId?: string; approvalId?: string };
}
export interface RunStep { title: string; meta: string; state: 'done' | 'now' | 'wait' | 'fail' | 'skip' }
export interface RunDetail { run: RunItem; subtasks: RunItem[]; subNotice: StopReason | null; steps: RunStep[]; log: Array<{ at: string; text: string }>; result: { text: string | null; tokensIn: number | null; tokensOut: number | null; costCents: number | null }; copy: string }
export interface ListFilter { userId: string | null; place: Place; kind?: RunKind; agentId?: string; projectId?: string; q?: string; before?: number; limit?: number }

export const PLACES: readonly Place[] = ['running', 'waiting', 'finished', 'failed'];
export const KINDS: readonly RunKind[] = ['chat', 'task', 'helper', 'code', 'job', 'handoff'];
const STATES: Record<Place, RunState[]> = { running: ['working', 'queued'], waiting: ['waiting'], finished: ['done'], failed: ['failed', 'stopped'] };

// ---------- small helpers ----------
const clean = (t: unknown, max = 600): string => redactImportText(String(t ?? '')).text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);
const sqlMs = (x: unknown): number => { const t = String(x ?? ''); if (!t) return NaN; return Date.parse(/T/.test(t) ? t : `${t.replace(' ', 'T')}Z`); };
const iso = (ms: number | null | undefined): string | null => (ms !== null && ms !== undefined && Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null);
const sqlText = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const human = (name: string) => name.replace(/[_.:-]+/g, ' ').trim();

/** The app behind a model id, as people know it. */
export function appOf(model: string | null | undefined): string | null {
  const m = String(model ?? '');
  if (!m) return null;
  if (/claude/i.test(m) && /^subscription:/.test(m)) return 'Claude Code';
  if (/^subscription:codex/.test(m)) return 'Codex';
  if (/^subscription:(gemini|antigravity|agy)/.test(m)) return 'Gemini';
  if (/^(local|ollama|lmstudio)[:/]/i.test(m)) return 'Local model';
  return null;
}

function startedByOf(runId: string): StartedBy {
  if (runId.startsWith('schedule-') || runId.startsWith('cardsch-')) return 'schedule';
  if (runId.startsWith('task-')) return 'card';
  if (runId.startsWith('approval-')) return 'approval';
  if (runId.startsWith('retry-')) return 'you';
  return 'you';
}

// ---------- why it stopped ----------
const R = (code: string, title: string, text: string, bug = false, detail?: string): StopReason => ({ code, title, text, bug, ...(detail ? { detail: clean(detail, 300) } : {}) });

/** Every code a source keeps, as one plain reason (the 15 of board RN2b). */
export function stopReason(kind: RunKind | 'schedule', state: RunState, code: string | null | undefined, extra: { step?: number; who?: string; error?: string | null } = {}): StopReason | null {
  const c = String(code ?? '');
  const at = extra.step ? ` at step ${extra.step}` : '';
  if (state === 'waiting') return R('needs_ok', 'Waits for your OK', `It asked for your OK${at}. Nothing was done yet; it goes on by itself after your answer.`);
  if (state === 'done' || state === 'working' || state === 'queued') return null;
  if (state === 'stopped') {
    if (c === 'archived') return R('skipped', 'Skipped', 'This time was skipped: the card is archived.');
    if (c === 'busy') return R('skipped', 'Skipped', 'This time was skipped: the chat was still busy.');
    return extra.who ? R('stopped_by_person', 'Someone stopped it', `${extra.who} stopped it${at}.`) : R('stopped_by_you', 'You stopped it', `It was stopped${at}. Not a bug in Girru.`);
  }
  // failed
  if (c === 'run_interrupted' || /lease|interrupt|restart/i.test(c)) return R('restarted', 'Girru closed while it ran', `Girru was restarted while it ran${at}. Nothing after that happened. Not a bug in Girru.`);
  if (['model_unavailable', 'local_model_missing', 'lmstudio_not_running', 'cli_missing', 'subscription_org_blocked', 'not_signed_in'].includes(c) || /ECONN|ENOTFOUND|fetch failed|offline|not running/i.test(c)) {
    const why = c === 'local_model_missing' ? 'The local model is not installed.' : c === 'lmstudio_not_running' ? 'The local model app was not running.' : c === 'cli_missing' ? 'The coding app is not installed on this computer.' : c === 'subscription_org_blocked' ? 'The coding app refused this account for automated use.' : c === 'model_unavailable' ? 'The model it uses was not available.' : 'A service it needs did not answer.';
    return R('offline', 'The app was offline', `${why} Not a bug in Girru.`, false, extra.error ?? undefined);
  }
  if (c === 'timed_out' || /time ?limit|timed? ?out|duration|TimeoutError/i.test(c)) return R('timed_out', 'Ran out of time', `It ran longer than its time limit${at}. Not a bug in Girru.`);
  if (/budget|cost|cap|spend/i.test(c)) return R('over_budget', 'Reached its spending cap', `It reached its spending cap${at}. Not a bug in Girru.`);
  if (/^uncertain_step/.test(c)) return R('unsure_step', 'Not sure a step finished', `A step may or may not have finished${at}. Please check before running it again.`);
  if (/verif|review/i.test(c)) return R('check_failed', 'Did not pass its check', 'The result did not pass its check.', false, c);
  if (c === 'secret_check_failed') return R('secret', 'Held back: it had a secret', 'The answer contained a saved key, so it was not shown or sent.');
  if (c === 'content_limit') return R('too_long', 'Too long', 'The chat got too long for the model. Start a fresh chat to go on.');
  if (/not (yet )?authori[sz]ed|authori[sz]ation|consent|permission ended/i.test(c)) return R('not_allowed_to_run', 'Not allowed to run', 'This schedule needs your OK before it runs. Allow it again to run.');
  if (/grant|not allowed|refused|forbidden|permission/i.test(c) || c === 'no_folder') return R('not_allowed', 'Not allowed', c === 'no_folder' ? 'The chat had no project folder the app may work in.' : 'Girru refused something this agent is not allowed to do. Change it on the agent page.');
  if (kind === 'schedule' && c === 'error') return R('bug', 'A bug', 'The schedule could not start its run. Copy details for a bug report.', true);
  return R('bug', 'A bug', `Something broke inside Girru${at}. Copy details for a bug report.`, true, extra.error ?? (c || undefined));
}

// ---------- sources ----------
interface Names { agents: Map<string, string>; projects: Map<string, string> }
async function names(): Promise<Names> {
  const [a, p] = await Promise.all([
    q.all<{ id: string; name: string }>('SELECT id, name FROM agents_config').catch(() => []),
    q.all<{ id: string; name: string }>('SELECT id, name FROM chat_projects').catch(() => []),
  ]);
  return { agents: new Map(a.map((r) => [r.id, r.name])), projects: new Map(p.map((r) => [r.id, r.name])) };
}
const userWhere = (col: string, userId: string | null): [string, string[]] => (userId === null ? ['1=1', []] : [`${col} = ?`, [userId]]);

interface ChatRow { run_id: string; session_id: string; user_id: string; agent_id: string | null; state: string; started_at: number; ended_at: number | null; error_code: string | null; title: string | null; s_agent: string | null; project_id: string | null; model: string | null; duration_ms: number | null; m_error: string | null }
const CHAT_STATE: Record<string, RunState> = { running: 'working', complete: 'done', stopped: 'stopped', error: 'failed', interrupted: 'failed' };
const CHAT_DB: Record<RunState, string[]> = { working: ['running'], queued: [], waiting: [], done: ['complete'], failed: ['error', 'interrupted'], stopped: ['stopped'] };

function chatItem(r: ChatRow, n: Names): RunItem {
  const agentId = r.agent_id ?? r.s_agent;
  const state = CHAT_STATE[r.state] ?? 'failed';
  const ended = r.ended_at ?? (r.duration_ms !== null && r.duration_ms !== undefined && state !== 'working' ? Number(r.started_at) + Number(r.duration_ms) : null);
  return {
    id: `chat:${r.run_id}`, kind: 'chat', title: clean(r.title || 'Chat reply', 160), state,
    reason: stopReason('chat', state, r.error_code ?? r.m_error),
    agentId, agentName: agentId ? n.agents.get(agentId) ?? null : null, app: appOf(r.model), model: r.model ?? null,
    projectId: r.project_id ?? null, projectName: r.project_id ? n.projects.get(r.project_id) ?? null : null,
    startedBy: startedByOf(r.run_id), startedAt: iso(Number(r.started_at))!, endedAt: iso(ended), needsYou: false, parentId: null,
    link: { sessionId: r.session_id },
  };
}
const CHAT_SELECT = `SELECT j.run_id, j.session_id, j.user_id, j.agent_id, j.state, j.started_at, j.ended_at, j.error_code, s.title, s.agent_id AS s_agent, s.project_id,
  m.model, m.duration_ms, m.error_code AS m_error
  FROM chat_run_journal j JOIN chat_sessions s ON s.id = j.session_id
  LEFT JOIN chat_messages m ON m.run_id = j.run_id AND m.role = 'assistant'`;

async function chatRows(f: ListFilter, states: RunState[], before: number, limit: number, n: Names): Promise<RunItem[]> {
  const db = states.flatMap((s) => CHAT_DB[s]);
  if (!db.length) return [];
  const [uw, up] = userWhere('j.user_id', f.userId);
  const extra: string[] = []; const args: string[] = [];
  if (f.agentId) { extra.push('COALESCE(j.agent_id, s.agent_id) = ?'); args.push(f.agentId); }
  if (f.projectId) { extra.push('s.project_id = ?'); args.push(f.projectId); }
  const rows = await q.all<ChatRow>(`${CHAT_SELECT} WHERE ${uw} AND j.state IN (${db.map(() => '?').join(',')}) AND j.started_at < ?${extra.map((e) => ` AND ${e}`).join('')} ORDER BY j.started_at DESC LIMIT ?`,
    ...up, ...db, before, ...args, limit);
  return rows.map((r) => chatItem(r, n));
}

interface TaskRow { id: string; task_id: string; agent_id: string; user_id: string | null; status: string; status_reason: string | null; created_at: string; started_at: string | null; finished_at: string | null; checkpoint_step: number | null; output_preview: string | null; cost_cents: number | null; kind: string | null; model: string | null; requested_by: string | null; parent_run_id: string | null }
const TASK_STATE: Record<string, RunState> = { queued: 'queued', running: 'working', waiting_approval: 'waiting', completed: 'done', failed: 'failed', cancelled: 'stopped' };
const TASK_DB: Record<RunState, string[]> = { working: ['running'], queued: ['queued'], waiting: ['waiting_approval'], done: ['completed'], failed: ['failed'], stopped: ['cancelled'] };
const TASK_SELECT = `SELECT t.id, t.task_id, t.agent_id, t.user_id, t.status, t.status_reason, t.created_at, t.started_at, t.finished_at, t.checkpoint_step, t.output_preview, t.cost_cents, t.parent_run_id,
  h.kind, h.model, h.requested_by FROM task_runs t LEFT JOIN small_agent_runs h ON h.run_id = t.id`;

function taskItem(r: TaskRow, n: Names): RunItem {
  const helper = !!r.kind;
  const state = TASK_STATE[r.status] ?? 'failed';
  const agentName = n.agents.get(r.agent_id) ?? null;
  const step = r.checkpoint_step !== null && r.checkpoint_step !== undefined ? Number(r.checkpoint_step) + 1 : undefined;
  return {
    id: `task:${r.id}`, kind: helper ? 'helper' : 'task',
    title: helper ? `Small helper · ${human(String(r.kind))}` : `${agentName ?? 'Agent'} · a task from its check-in`,
    state, reason: stopReason('task', state, r.status === 'cancelled' ? null : r.status_reason, { step, error: r.status_reason }),
    agentId: r.agent_id, agentName, app: appOf(r.model), model: r.model ?? null, projectId: null, projectName: null,
    startedBy: helper ? (String(r.requested_by ?? '').startsWith('agent:') ? 'agent' : 'you') : 'schedule',
    startedAt: iso(sqlMs(r.started_at ?? r.created_at))!, endedAt: iso(sqlMs(r.finished_at)), needsYou: state === 'waiting', parentId: r.parent_run_id ?? null,
    link: { taskRunId: r.id },
  };
}
async function taskRows(f: ListFilter, states: RunState[], before: number, limit: number, n: Names): Promise<RunItem[]> {
  const db = states.flatMap((s) => TASK_DB[s]);
  if (!db.length) return [];
  // Agent check-in runs have no person behind them: the owner's only.
  const [uw, up]: [string, string[]] = f.userId === null ? ['1=1', []] : ['t.user_id = ?', [f.userId]];
  const extra = f.agentId ? ' AND t.agent_id = ?' : '';
  const rows = await q.all<TaskRow>(`${TASK_SELECT} WHERE ${uw} AND t.status IN (${db.map(() => '?').join(',')}) AND t.created_at < ?${extra} ORDER BY t.created_at DESC LIMIT ?`,
    ...up, ...db, sqlText(before), ...(f.agentId ? [f.agentId] : []), limit).catch(() => [] as TaskRow[]);
  return rows.map((r) => taskItem(r, n)).filter((x) => !f.kind || x.kind === f.kind);
}

interface CodeRow { id: string; session_id: string; user_id: string | null; agent_id: string | null; app: string; about: string; state: string; error_code: string | null; started_at: number; ended_at: number | null; project_id: string | null; parent_run_id?: string | null }
const CODE_DB: Record<RunState, string[]> = { working: ['running'], queued: [], waiting: [], done: ['complete'], failed: ['error', 'running'], stopped: ['stopped'] };
async function codeRows(f: ListFilter, states: RunState[], before: number, limit: number, n: Names): Promise<RunItem[]> {
  const db = [...new Set(states.flatMap((s) => CODE_DB[s]))];
  if (!db.length) return [];
  const live = new Set(liveCodingRuns().map((r) => r.id));
  const [uw, up] = userWhere('c.user_id', f.userId);
  const rows = await q.all<CodeRow>(`SELECT c.*, s.project_id FROM coding_app_runs c LEFT JOIN chat_sessions s ON s.id = c.session_id WHERE ${uw} AND c.state IN (${db.map(() => '?').join(',')}) AND c.started_at < ?${f.agentId ? ' AND c.agent_id = ?' : ''}${f.projectId ? ' AND s.project_id = ?' : ''} ORDER BY c.started_at DESC LIMIT ?`,
    ...up, ...db, before, ...(f.agentId ? [f.agentId] : []), ...(f.projectId ? [f.projectId] : []), limit).catch(() => [] as CodeRow[]);
  return rows.map((r) => codeItem(r, live, n)).filter((x) => states.includes(x.state));
}
function codeItem(r: CodeRow, live: Set<string>, n: Names): RunItem {
  // A row still "running" that is not live any more was cut off by a restart.
  const state: RunState = r.state === 'running' ? (live.has(r.id) ? 'working' : 'failed') : r.state === 'complete' ? 'done' : r.state === 'stopped' ? 'stopped' : 'failed';
  return {
    id: `code:${r.id}`, kind: 'code', title: clean(`${r.app} · ${r.about}`, 160), state,
    reason: stopReason('code', state, r.state === 'running' && state === 'failed' ? 'run_interrupted' : r.error_code),
    agentId: r.agent_id, agentName: r.agent_id ? n.agents.get(r.agent_id) ?? null : null, app: r.app, model: null,
    projectId: r.project_id ?? null, projectName: r.project_id ? n.projects.get(r.project_id) ?? null : null,
    startedBy: 'agent', startedAt: iso(Number(r.started_at))!, endedAt: iso(r.ended_at), needsYou: false, parentId: r.parent_run_id ?? null, link: { sessionId: r.session_id },
  };
}

interface JobRow { id: number; job_id: string; success: number; error: string | null; executed_at: string; duration: number | null; started_by: string | null; name: string; action_type: string }
export function jobTitle(name: string): string {
  return /^memory-weekly-summary-/.test(name) ? 'Weekly memory summary' : /^memory-retention-/.test(name) ? 'Memory retention' : /^agent-evolution-/.test(name) ? 'Agent review' : /^memory-trash-/.test(name) ? 'Empty memory Trash' : name;
}
async function jobRows(f: ListFilter, states: RunState[], before: number, limit: number): Promise<RunItem[]> {
  if (f.userId !== null || f.agentId || f.projectId) return [];
  const want = states.filter((s) => s === 'done' || s === 'failed');
  if (!want.length) return [];
  const success = want.map((s) => (s === 'done' ? 1 : 0));
  const rows = await q.all<JobRow>(`SELECT e.id, e.job_id, e.success, e.error, e.executed_at, e.duration, e.started_by, j.name, j.action_type FROM job_executions e JOIN cron_jobs j ON j.id = e.job_id
    WHERE e.success IN (${success.map(() => '?').join(',')}) AND e.executed_at < ? ORDER BY e.executed_at DESC LIMIT ?`, ...success, new Date(before).toISOString(), limit).catch(() => [] as JobRow[]);
  return rows.map(jobItem);
}
function jobItem(r: JobRow): RunItem {
  const end = sqlMs(r.executed_at);
  const state: RunState = Number(r.success) ? 'done' : 'failed';
  return {
    id: `job:${r.id}`, kind: 'job', title: clean(jobTitle(r.name), 160), state, reason: stopReason('job', state, r.error, { error: r.error }),
    agentId: null, agentName: null, app: null, model: null, projectId: null, projectName: null,
    startedBy: r.started_by === 'manual' ? 'manual' : 'system', startedAt: iso(end - Number(r.duration ?? 0))!, endedAt: iso(end), needsYou: false, parentId: null, link: { jobId: r.job_id },
  };
}

interface ApprovalRow { id: string; agent_id: string | null; user_id: string | null; session_id: string; tool_name: string; requested_at: string; title: string | null; project_id: string | null; s_agent: string | null }
async function approvalRows(f: ListFilter, before: number, limit: number, n: Names): Promise<RunItem[]> {
  const [uw, up] = userWhere('a.user_id', f.userId);
  const rows = await q.all<ApprovalRow>(`SELECT a.id, a.agent_id, a.user_id, a.session_id, a.tool_name, a.requested_at, s.title, s.project_id, s.agent_id AS s_agent FROM tool_approvals a JOIN chat_sessions s ON s.id = a.session_id
    WHERE ${uw} AND a.status = 'pending' AND a.run_id IS NULL AND a.requested_at < ? ORDER BY a.requested_at DESC LIMIT ?`, ...up, sqlText(before), limit).catch(() => [] as ApprovalRow[]);
  return rows.map((r): RunItem => {
    const agentId = r.agent_id ?? r.s_agent;
    return {
      id: `approval:${r.id}`, kind: 'chat', title: clean(r.title || 'Chat', 160), state: 'waiting',
      reason: R('needs_ok', 'Waits for your OK', `It wants to use “${human(r.tool_name)}”. Nothing was done yet; it goes on after your answer.`),
      agentId, agentName: agentId ? n.agents.get(agentId) ?? null : null, app: null, model: null,
      projectId: r.project_id ?? null, projectName: r.project_id ? n.projects.get(r.project_id) ?? null : null,
      startedBy: 'you', startedAt: iso(sqlMs(r.requested_at))!, endedAt: null, needsYou: true, parentId: null, link: { sessionId: r.session_id, approvalId: r.id },
    };
  }).filter((x) => !f.agentId || x.agentId === f.agentId).filter((x) => !f.projectId || x.projectId === f.projectId);
}

interface HandoffRow { id: string; owner_id: string; session_id: string; coordinator_id: string; agent_id: string; model: string; status: string; created_at: string; ended_at: string | null; parent_run_id: string | null }
const HANDOFF_STATE: Record<string, RunState> = { started: 'working', answered: 'done', waiting_approval: 'waiting', failed: 'failed' };
const HANDOFF_DB: Record<RunState, string[]> = { working: ['started'], queued: [], waiting: ['waiting_approval'], done: ['answered'], failed: ['failed'], stopped: [] };
function handoffItem(r: HandoffRow, n: Names): RunItem {
  const state = HANDOFF_STATE[r.status] ?? 'failed';
  const from = n.agents.get(r.coordinator_id) ?? 'An agent', to = n.agents.get(r.agent_id) ?? 'an agent';
  return {
    id: `handoff:${r.id}`, kind: 'handoff', title: `${to} · a part handed over by ${from}`, state,
    reason: state === 'failed' ? R('bug', 'Did not finish', `${to} could not finish the part it was given.`, false) : stopReason('handoff', state, null),
    agentId: r.agent_id, agentName: n.agents.get(r.agent_id) ?? null, app: appOf(r.model), model: r.model || null, projectId: null, projectName: null,
    startedBy: 'agent', startedAt: iso(sqlMs(r.created_at))!, endedAt: iso(sqlMs(r.ended_at)), needsYou: state === 'waiting', parentId: r.parent_run_id ?? null, link: { sessionId: r.session_id },
  };
}
async function handoffRows(f: ListFilter, states: RunState[], before: number, limit: number, n: Names): Promise<RunItem[]> {
  const db = states.flatMap((s) => HANDOFF_DB[s]);
  if (!db.length || f.projectId) return [];
  const [uw, up] = userWhere('owner_id', f.userId);
  const rows = await q.all<HandoffRow>(`SELECT id, owner_id, session_id, coordinator_id, agent_id, model, status, created_at, ended_at, parent_run_id FROM team_delegation_results WHERE ${uw} AND status IN (${db.map(() => '?').join(',')}) AND created_at < ?${f.agentId ? ' AND agent_id = ?' : ''} ORDER BY created_at DESC LIMIT ?`,
    ...up, ...db, sqlText(before), ...(f.agentId ? [f.agentId] : []), limit).catch(() => [] as HandoffRow[]);
  return rows.map((r) => handoffItem(r, n));
}

/** Board RN6: the sub-tasks of one run (hand-offs, coding apps, small helpers it started), oldest first. */
export async function subtasksOf(userId: string | null, parentId: string): Promise<RunItem[]> {
  const n = await names();
  const live = new Set(liveCodingRuns().map((x) => x.id));
  const [cw, cp] = userWhere('c.user_id', userId), [tw, tp]: [string, string[]] = userId === null ? ['1=1', []] : ['t.user_id = ?', [userId]], [hw, hp] = userWhere('owner_id', userId);
  const [codes, tasks, handoffs] = await Promise.all([
    q.all<CodeRow>(`SELECT c.*, s.project_id FROM coding_app_runs c LEFT JOIN chat_sessions s ON s.id = c.session_id WHERE c.parent_run_id = ? AND ${cw} LIMIT 50`, parentId, ...cp).catch(() => [] as CodeRow[]),
    q.all<TaskRow>(`${TASK_SELECT} WHERE t.parent_run_id = ? AND ${tw} LIMIT 50`, parentId, ...tp).catch(() => [] as TaskRow[]),
    q.all<HandoffRow>(`SELECT id, owner_id, session_id, coordinator_id, agent_id, model, status, created_at, ended_at, parent_run_id FROM team_delegation_results WHERE parent_run_id = ? AND ${hw} LIMIT 50`, parentId, ...hp).catch(() => [] as HandoffRow[]),
  ]);
  return [...codes.map((r) => codeItem(r, live, n)), ...tasks.map((r) => taskItem(r, n)), ...handoffs.map((r) => handoffItem(r, n))]
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}
/** A failed or stopped sub-task, said on its main task in plain words. */
export function subNotice(subs: RunItem[]): StopReason | null {
  const bad = subs.find((s) => s.state === 'failed' || s.state === 'stopped');
  if (!bad) return null;
  const why = bad.reason ? bad.reason.title.toLowerCase() : 'it did not finish';
  return { code: 'subtask_stopped', title: `A sub-task stopped: ${why}`, text: `${bad.title} — ${bad.reason?.text ?? 'it did not finish.'}`, bug: bad.reason?.bug ?? false };
}

// ---------- list ----------
export const MAX_LIMIT = 100;
/** One page of a place, newest first, merged across the sources (keyset by start time). */
export async function listRuns(f: ListFilter): Promise<{ runs: RunItem[]; next: number | null }> {
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), MAX_LIMIT);
  const before = Number.isFinite(Number(f.before)) && Number(f.before) > 0 ? Number(f.before) : Date.now() + 60_000;
  const states = STATES[f.place];
  const n = await names();
  const want = (k: RunKind) => !f.kind || f.kind === k;
  const parts = await Promise.all([
    want('chat') ? chatRows(f, states, before, limit, n) : [],
    want('task') || want('helper') ? taskRows(f, states, before, limit, n) : [],
    want('code') ? codeRows(f, states, before, limit, n) : [],
    want('job') ? jobRows(f, states, before, limit) : [],
    want('chat') && f.place === 'waiting' ? approvalRows(f, before, limit, n) : [],
    want('handoff') ? handoffRows(f, states, before, limit, n) : [],
  ]);
  const needle = (f.q ?? '').trim().toLowerCase();
  const all = parts.flat()
    .filter((r) => !needle || `${r.title} ${r.agentName ?? ''} ${r.projectName ?? ''} ${r.app ?? ''} ${r.reason?.title ?? ''}`.toLowerCase().includes(needle))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || (a.id < b.id ? 1 : -1));
  const runs = all.slice(0, limit);
  return { runs, next: runs.length === limit ? Date.parse(runs[runs.length - 1].startedAt) : null };
}

/** The two numbers the sidebar shows: working now, and waiting for the person. */
export async function runCounts(userId: string | null): Promise<{ running: number; waiting: number }> {
  const [r, w] = await Promise.all([listRuns({ userId, place: 'running', limit: MAX_LIMIT }), listRuns({ userId, place: 'waiting', limit: MAX_LIMIT })]);
  return { running: r.runs.length, waiting: w.runs.length };
}

// ---------- one run ----------
export class RunNotFound extends Error {}
const ID = /^(chat|task|code|job|approval|handoff):([A-Za-z0-9_.:-]{1,160})$/;
export function parseRunId(id: unknown): { source: string; key: string } | null {
  const m = typeof id === 'string' ? ID.exec(id) : null;
  return m ? { source: m[1], key: m[2] } : null;
}
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);

interface StoredPart { kind: string; text?: string; calls?: Array<{ name: string; isError?: boolean; output?: string; ms?: number; approvalId?: string }> }
function partsSteps(parts: StoredPart[], running: boolean, failed: boolean): RunStep[] {
  const steps: RunStep[] = [];
  for (const p of parts) {
    if (p.kind === 'tools') for (const c of p.calls ?? []) steps.push({ title: human(c.name), meta: `tool${c.ms ? ` · ${(c.ms / 1000).toFixed(1)} s` : ''}${c.approvalId ? ' · asked for your OK' : ''}`, state: c.approvalId && !c.output ? 'wait' : c.isError ? 'fail' : c.output === undefined && running ? 'now' : 'done' });
    else if (p.kind === 'reasoning') steps.push({ title: 'Thought it through', meta: 'model call', state: 'done' });
  }
  steps.push({ title: 'Answer in the chat', meta: running ? 'writing…' : failed ? 'did not finish' : 'model call', state: running ? 'now' : failed ? 'fail' : 'done' });
  return steps;
}

export async function runDetail(userId: string | null, id: string): Promise<RunDetail> {
  const p = parseRunId(id);
  if (!p) throw new RunNotFound();
  const n = await names();
  let run: RunItem, steps: RunStep[] = [], log: Array<{ at: string; text: string }> = [], result: RunDetail['result'] = { text: null, tokensIn: null, tokensOut: null, costCents: null };
  if (p.source === 'chat') {
    const r = await q.one<ChatRow>(`${CHAT_SELECT} WHERE j.run_id = ?`, p.key);
    if (!r || (userId !== null && r.user_id !== userId)) throw new RunNotFound();
    run = chatItem(r, n);
    const live = chatRuns.get(r.run_id);
    const msg = await q.one<{ content: string; parts: string | null; tokens_in: number | null; tokens_out: number | null }>("SELECT content, parts, tokens_in, tokens_out FROM chat_messages WHERE run_id = ? AND role = 'assistant'", r.run_id);
    let parts: StoredPart[] = [];
    try { parts = live ? (live.parts as unknown as StoredPart[]) : JSON.parse(msg?.parts ?? '[]'); } catch { parts = []; }
    steps = partsSteps(parts, run.state === 'working', run.state === 'failed');
    const started = Number(r.started_at);
    log.push({ at: clock(started), text: `run started · ${run.startedBy === 'schedule' ? 'by its schedule' : run.startedBy === 'card' ? 'from a board card' : run.startedBy === 'approval' ? 'after your OK' : 'from the chat'}${run.agentName ? ` · ${run.agentName}` : ''}` });
    for (const s of steps.slice(0, -1)) log.push({ at: '', text: `${s.title} · ${s.meta}${s.state === 'fail' ? ' · error' : ''}` });
    if (live) log.push({ at: clock(Date.now()), text: `writing… ${live.answer.length.toLocaleString('en')} characters so far` });
    if (run.endedAt) log.push({ at: clock(Date.parse(run.endedAt)), text: `run ${run.state === 'done' ? 'finished' : run.state}${run.reason ? ` · ${run.reason.title.toLowerCase()}` : ''}` });
    result = { text: msg?.content ? clean(msg.content, 1200) : live ? clean(live.answer, 1200) : null, tokensIn: msg?.tokens_in ?? null, tokensOut: msg?.tokens_out ?? null, costCents: null };
  } else if (p.source === 'task') {
    const r = await q.one<TaskRow>(`${TASK_SELECT} WHERE t.id = ?`, p.key);
    if (!r || (userId !== null && r.user_id !== userId)) throw new RunNotFound();
    run = taskItem(r, n);
    const rows = await q.all<{ step_index: number; kind: string; tool_name: string | null; status: string; error: string | null; started_at: string | null; completed_at: string | null; model: string | null; input_tokens: number | null; output_tokens: number | null }>(
      'SELECT step_index, kind, tool_name, status, error, started_at, completed_at, model, input_tokens, output_tokens FROM task_run_steps WHERE run_id = ? ORDER BY step_index, attempt', r.id);
    const STEP: Record<string, RunStep['state']> = { started: 'now', completed: 'done', failed: 'fail', unknown: 'fail', waiting_approval: 'wait', retry: 'now' };
    steps = rows.map((s) => ({ title: s.kind === 'tool' ? human(s.tool_name ?? 'tool') : 'Model call', meta: `${s.kind === 'tool' ? 'tool' : 'model call'}${s.model ? ` · ${s.model}` : ''}${s.status === 'unknown' ? ' · outcome unknown' : ''}${s.error ? ` · ${clean(s.error, 80)}` : ''}`, state: STEP[s.status] ?? 'done' }));
    log = rows.map((s) => ({ at: Number.isFinite(sqlMs(s.started_at)) ? clock(sqlMs(s.started_at)) : '', text: `step ${Number(s.step_index) + 1} · ${s.kind === 'tool' ? human(s.tool_name ?? 'tool') : 'model call'} · ${s.status.replace('_', ' ')}` }));
    if (r.status_reason) log.push({ at: run.endedAt ? clock(Date.parse(run.endedAt)) : '', text: `reason: ${clean(r.status_reason, 200)}` });
    const tin = rows.reduce((a, s) => a + Number(s.input_tokens ?? 0), 0), tout = rows.reduce((a, s) => a + Number(s.output_tokens ?? 0), 0);
    result = { text: r.output_preview ? clean(r.output_preview, 1200) : null, tokensIn: tin || null, tokensOut: tout || null, costCents: r.cost_cents ?? null };
  } else if (p.source === 'code') {
    const r = await q.one<CodeRow>('SELECT c.*, s.project_id FROM coding_app_runs c LEFT JOIN chat_sessions s ON s.id = c.session_id WHERE c.id = ?', p.key);
    if (!r || (userId !== null && r.user_id !== userId)) throw new RunNotFound();
    run = codeItem(r, new Set(liveCodingRuns().map((x) => x.id)), n);
    steps = [{ title: `Asked ${r.app}: ${clean(r.about, 120)}`, meta: 'hand-off', state: run.state === 'working' ? 'now' : run.state === 'done' ? 'done' : 'fail' }];
    log = [{ at: clock(Number(r.started_at)), text: `${r.app} started · ${clean(r.about, 120)}` }, ...(r.ended_at ? [{ at: clock(Number(r.ended_at)), text: `${r.app} ${r.state === 'complete' ? 'answered' : r.state}` }] : [])];
  } else if (p.source === 'job') {
    if (userId !== null || !/^\d{1,18}$/.test(p.key)) throw new RunNotFound();
    const r = await q.one<JobRow & { output: string | null }>('SELECT e.id, e.job_id, e.success, e.error, e.output, e.executed_at, e.duration, e.started_by, j.name, j.action_type FROM job_executions e JOIN cron_jobs j ON j.id = e.job_id WHERE e.id = ?', Number(p.key));
    if (!r) throw new RunNotFound();
    run = jobItem(r);
    steps = [{ title: human(r.action_type), meta: `system job${r.duration ? ` · ${(Number(r.duration) / 1000).toFixed(1)} s` : ''}`, state: Number(r.success) ? 'done' : 'fail' }];
    log = [{ at: clock(Date.parse(run.startedAt)), text: `${run.startedBy === 'manual' ? 'Run now' : 'scheduled run'} started` }, { at: clock(sqlMs(r.executed_at)), text: Number(r.success) ? 'finished' : `failed · ${clean(r.error, 200)}` }];
    result = { text: r.output ? clean(r.output, 1200) : null, tokensIn: null, tokensOut: null, costCents: null };
  } else if (p.source === 'handoff') {
    const r = await q.one<HandoffRow>('SELECT id, owner_id, session_id, coordinator_id, agent_id, model, status, created_at, ended_at, parent_run_id FROM team_delegation_results WHERE id = ?', p.key);
    if (!r || (userId !== null && r.owner_id !== userId)) throw new RunNotFound();
    run = handoffItem(r, n);
    steps = [{ title: run.title, meta: 'hand-off', state: run.state === 'working' ? 'now' : run.state === 'waiting' ? 'wait' : run.state === 'done' ? 'done' : 'fail' }];
    log = [{ at: clock(Date.parse(run.startedAt)), text: 'part handed over' }, ...(run.endedAt ? [{ at: clock(Date.parse(run.endedAt)), text: `answer: ${run.state}` }] : [])];
  } else {
    const rows = await approvalRows({ userId, place: 'waiting' }, Date.now() + 60_000, MAX_LIMIT, n);
    const found = rows.find((x) => x.id === id);
    if (!found) throw new RunNotFound();
    run = found;
    steps = [{ title: run.reason?.text ?? 'Waits for your OK', meta: 'waits for your OK', state: 'wait' }];
    log = [{ at: clock(Date.parse(run.startedAt)), text: 'asked for your OK' }];
  }
  const subtasks = p.source === 'chat' ? await subtasksOf(userId, run.id) : [];
  const notice = subNotice(subtasks);
  if (subtasks.length) log.push({ at: '', text: `${subtasks.length} sub-task${subtasks.length === 1 ? '' : 's'}: ${subtasks.map((s) => `${s.title} (${s.state})`).join(' · ')}` });
  return { run, subtasks, subNotice: notice, steps, log, result, copy: copyText(run, steps, log) };
}

/** "Copy details": the same text for a bug report, a chat, or MCP. Secrets are already hidden. */
export function copyText(run: RunItem, steps: RunStep[], log: Array<{ at: string; text: string }>): string {
  const kind = { chat: 'Chat reply', task: 'Agent task', helper: 'Small helper', code: 'Coding app', job: 'System job', handoff: 'Hand-off' }[run.kind];
  const lines = [
    `Run: ${run.title}`,
    `Kind: ${kind}${run.agentName ? ` · Agent: ${run.agentName}` : ''}`,
    ...(run.app || run.model || run.projectName ? [`App: ${[run.app, run.model].filter(Boolean).join(' · ') || '—'}${run.projectName ? ` · Project: ${run.projectName}` : ''}`] : []),
    `Time: ${run.startedAt}${run.endedAt ? ` – ${run.endedAt}` : ' (still running)'}`,
    `State: ${run.state}${run.reason ? ` · ${run.reason.title}: ${run.reason.text}` : ''}`,
    ...(run.reason?.detail ? [`Error: ${run.reason.detail}`] : []),
    `Steps: ${steps.map((s, i) => `${i + 1} ${s.title} (${s.state})`).join(' · ') || '—'}`,
    'Last log lines:', ...log.slice(-8).map((l) => `  ${l.at ? `${l.at} ` : ''}${l.text}`),
    `Run id: ${run.id}`,
  ];
  return clean(lines.join('\n'), 6000);
}

// ---------- schedules ----------
export type ScheduleKind = 'job' | 'chatsch' | 'cardsch' | 'checkin';
export interface ScheduleItem {
  id: string; kind: ScheduleKind; title: string; when: string; enabled: boolean;
  nextRun: string | null; lastRun: string | null; lastResult: 'done' | 'failed' | 'skipped' | null; lastReason: StopReason | null;
  agentId: string | null; agentName: string | null;
  link: { jobId?: string; sessionId?: string; boardId?: string; cardId?: string; agentId?: string; runId?: string };
}
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** The same words the old Scheduled tasks page used for a cron line. */
export function cronLabel(expression: string): string {
  if (expression === '* * * * *') return 'Every minute';
  const interval = /^\*\/(\d+) \* \* \* \*$/.exec(expression); if (interval) return `Every ${interval[1]} minutes`;
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expression); if (daily) return `Every day at ${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')}`;
  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(expression); if (weekly) return `Every ${DAYS[Number(weekly[3])]} at ${weekly[2].padStart(2, '0')}:${weekly[1].padStart(2, '0')}`;
  return 'Custom schedule';
}
const everyLabel = (every: string, at: string, weekday: number | null) => every === 'hourly' ? `Every hour at :${at.slice(3, 5)}` : every === 'weekly' ? `Every ${DAYS[Number(weekday ?? 0)]} at ${at}` : `Every day at ${at}`;
const lastOf = (result: string | null, reason: string | null): [ScheduleItem['lastResult'], StopReason | null] =>
  result === 'started' ? ['done', null] : result === 'busy' || result === 'skipped' ? ['skipped', stopReason('schedule', 'stopped', reason ?? 'busy')] : result === 'failed' ? ['failed', stopReason('schedule', 'failed', reason ?? 'error')] : [null, null];

/** Every schedule the person may see: system jobs and agent check-ins for the owner; their own chat and card schedules. */
export async function listSchedules(userId: string | null, ownerId: string | null): Promise<ScheduleItem[]> {
  const n = await names();
  const out: ScheduleItem[] = [];
  if (userId === null) {
    const jobs = await q.all<{ id: string; name: string; cron_expression: string; enabled: number; next_run: string | null; last_run: string | null; success: number | null; error: string | null }>(
      `SELECT j.id, j.name, j.cron_expression, j.enabled, j.next_run, j.last_run, e.success, e.error FROM cron_jobs j
       LEFT JOIN job_executions e ON e.id = (SELECT MAX(x.id) FROM job_executions x WHERE x.job_id = j.id)
       WHERE j.action_type <> 'paper-runtime-cycle' ORDER BY j.name`).catch(() => []);
    for (const j of jobs) out.push({ id: `job:${j.id}`, kind: 'job', title: clean(jobTitle(j.name), 160), when: cronLabel(j.cron_expression), enabled: !!Number(j.enabled),
      nextRun: Number(j.enabled) ? iso(sqlMs(j.next_run)) : null, lastRun: iso(sqlMs(j.last_run)), lastResult: j.success === null || j.success === undefined ? null : Number(j.success) ? 'done' : 'failed',
      lastReason: j.success !== null && j.success !== undefined && !Number(j.success) ? stopReason('job', 'failed', j.error, { error: j.error }) : null, agentId: null, agentName: null, link: { jobId: j.id } });
    const agents = await q.all<{ id: string; name: string; cron_schedule: string | null; last_heartbeat: string | null }>('SELECT id, name, cron_schedule, last_heartbeat FROM agents_config WHERE cron_enabled = 1 AND cron_schedule IS NOT NULL').catch(() => []);
    for (const a of agents) out.push({ id: `checkin:${a.id}`, kind: 'checkin', title: `${clean(a.name, 80)} checks its tasks`, when: cronLabel(String(a.cron_schedule)), enabled: true, nextRun: null,
      lastRun: iso(sqlMs(a.last_heartbeat)), lastResult: null, lastReason: null, agentId: a.id, agentName: a.name, link: { agentId: a.id } });
  }
  const who = userId ?? ownerId;
  if (who) {
    const chats = await q.all<{ session_id: string; every: string; at_time: string; weekday: number | null; paused: number; next_run: string; last_run: string | null; last_result: string | null; last_reason: string | null; last_run_id: string | null; title: string | null; agent_id: string | null }>(
      'SELECT c.session_id, c.every, c.at_time, c.weekday, c.paused, c.next_run, c.last_run, c.last_result, c.last_reason, c.last_run_id, s.title, s.agent_id FROM chat_schedules c JOIN chat_sessions s ON s.id = c.session_id WHERE c.user_id = ?', who).catch(() => []);
    for (const c of chats) { const [lr, why] = lastOf(c.last_result, c.last_reason); out.push({ id: `chatsch:${c.session_id}`, kind: 'chatsch', title: clean(c.title || 'Chat', 160), when: everyLabel(c.every, c.at_time, c.weekday), enabled: !Number(c.paused),
      nextRun: Number(c.paused) ? null : iso(sqlMs(c.next_run)), lastRun: iso(sqlMs(c.last_run)), lastResult: lr, lastReason: why, agentId: c.agent_id, agentName: c.agent_id ? n.agents.get(c.agent_id) ?? null : null,
      link: { sessionId: c.session_id, ...(c.last_run_id ? { runId: `chat:${c.last_run_id}` } : {}) } }); }
    const cards = await q.all<{ card_id: string; every: string; at_time: string; weekday: number | null; paused: number; next_run: string; last_run: string | null; last_result: string | null; last_reason: string | null; last_run_id: string | null; agent_id: string | null; title: string | null; board_id: string }>(
      'SELECT s.card_id, s.every, s.at_time, s.weekday, s.paused, s.next_run, s.last_run, s.last_result, s.last_reason, s.last_run_id, s.agent_id, c.title, c.board_id FROM card_schedules s JOIN board_cards c ON c.id = s.card_id WHERE s.user_id = ?', who).catch(() => []);
    for (const c of cards) { const [lr, why] = lastOf(c.last_result, c.last_reason); out.push({ id: `cardsch:${c.card_id}`, kind: 'cardsch', title: clean(c.title || 'Board task', 160), when: everyLabel(c.every, c.at_time, c.weekday), enabled: !Number(c.paused),
      nextRun: Number(c.paused) ? null : iso(sqlMs(c.next_run)), lastRun: iso(sqlMs(c.last_run)), lastResult: lr, lastReason: why, agentId: c.agent_id, agentName: c.agent_id ? n.agents.get(c.agent_id) ?? null : null,
      link: { boardId: c.board_id, cardId: c.card_id, ...(c.last_run_id ? { runId: `chat:${c.last_run_id}` } : {}) } }); }
  }
  return out.sort((a, b) => Number(b.enabled) - Number(a.enabled) || (Date.parse(a.nextRun ?? '9999') - Date.parse(b.nextRun ?? '9999')) || a.title.localeCompare(b.title));
}

/** The last runs a schedule made (newest first, at most 10). */
export async function scheduleRuns(userId: string | null, ownerId: string | null, id: string): Promise<RunItem[]> {
  const m = /^(job|chatsch|cardsch|checkin):([A-Za-z0-9_.:-]{1,160})$/.exec(id);
  if (!m) throw new RunNotFound();
  const [, kind, key] = m;
  const n = await names();
  const who = userId ?? ownerId;
  if (kind === 'job' || kind === 'checkin') {
    if (userId !== null) throw new RunNotFound();
    if (kind === 'job') return (await q.all<JobRow>('SELECT e.id, e.job_id, e.success, e.error, e.executed_at, e.duration, e.started_by, j.name, j.action_type FROM job_executions e JOIN cron_jobs j ON j.id = e.job_id WHERE e.job_id = ? ORDER BY e.id DESC LIMIT 10', key)).map(jobItem);
    return (await q.all<TaskRow>(`${TASK_SELECT} WHERE t.agent_id = ? AND t.user_id IS NULL ORDER BY t.created_at DESC LIMIT 10`, key)).map((r) => taskItem(r, n));
  }
  if (!who) throw new RunNotFound();
  if (kind === 'chatsch') {
    if (!(await q.one('SELECT 1 FROM chat_schedules WHERE session_id = ? AND user_id = ?', key, who))) throw new RunNotFound();
    return (await q.all<ChatRow>(`${CHAT_SELECT} WHERE j.session_id = ? AND j.user_id = ? AND j.run_id LIKE ? ORDER BY j.started_at DESC LIMIT 10`, key, who, 'schedule-%')).map((r) => chatItem(r, n));
  }
  const s = await q.one<{ last_run_id: string | null }>('SELECT last_run_id FROM card_schedules WHERE card_id = ? AND user_id = ?', key, who);
  if (!s) throw new RunNotFound();
  const rows = await q.all<ChatRow>(`${CHAT_SELECT} WHERE j.user_id = ? AND j.run_id LIKE ? AND j.session_id IN (SELECT conversation_id FROM board_card_chats WHERE card_id = ?) ORDER BY j.started_at DESC LIMIT 10`, who, 'cardsch-%', key).catch(() => [] as ChatRow[]);
  if (!rows.length && s.last_run_id) { const one = await q.one<ChatRow>(`${CHAT_SELECT} WHERE j.run_id = ? AND j.user_id = ?`, s.last_run_id, who); if (one) rows.push(one); }
  return rows.map((r) => chatItem(r, n));
}
