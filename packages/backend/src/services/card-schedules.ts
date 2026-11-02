/**
 * Tasks that repeat (TASKPAGE-03, board TaskPage3 › Repeats). One schedule per card:
 * every hour / day / week, at a time (and a weekday), run as one agent with one app.
 * Each run is a Continue of the card (a new chat that goes on with the task), started
 * through `start` by the chat routes, so the owner gates, rules and Mode are the same
 * as a Continue pressed by hand. Same time rules and claiming as chat schedules: the
 * next run is set before starting, so a busy or failed run never repeats in a loop.
 * Runs only while the background is on, once a minute.
 */
import { randomUUID } from 'node:crypto';
import { q } from '../repositories/sql-steps.js';
import { BoardError } from './task-board.js';
import { nextRun, type Every } from './chat-schedules.js';

export type Notify = 'important' | 'all' | 'none';
export type Thinking = 'quick' | 'normal' | 'deep';
/** RUNS-01 (board RN6): how a repeating task runs and tells the owner (notify, a new chat each run or the same chat, thinking, project). */
export interface CardRunOptions { notify: Notify; newChat: boolean; thinking: Thinking | null; projectId: string | null }
export interface CardSchedule extends CardRunOptions { every: Every; at: string; weekday: number | null; agentId: string | null; model: string; paused: boolean; nextRun: string; lastRun: string | null; lastResult: 'started' | 'busy' | 'failed' | null }
interface Row { card_id: string; user_id: string; every: Every; at_time: string; weekday: number | null; agent_id: string | null; model: string; paused: number; next_run: string; last_run: string | null; last_result: string | null; notify?: string | null; new_chat?: number | null; thinking?: string | null; project_id?: string | null }
const AT = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,99}$/;
const bad = (m: string) => new BoardError(400, 'invalid_board', m);
const toSchedule = (r: Row): CardSchedule => ({ every: r.every, at: r.at_time, weekday: r.weekday ?? null, agentId: r.agent_id, model: r.model ?? '', paused: !!r.paused, nextRun: r.next_run, lastRun: r.last_run,
  lastResult: r.last_result === 'started' || r.last_result === 'busy' || r.last_result === 'failed' ? r.last_result : null, ...runOptions(r) });
export const runOptions = (r: Pick<Row, 'notify' | 'new_chat' | 'thinking' | 'project_id'>): CardRunOptions => ({ notify: r.notify === 'all' || r.notify === 'none' ? r.notify : 'important', newChat: r.new_chat === undefined || r.new_chat === null ? true : !!Number(r.new_chat),
  thinking: r.thinking === 'quick' || r.thinking === 'normal' || r.thinking === 'deep' ? r.thinking : null, projectId: r.project_id ?? null });
const PROJECT = /^[A-Za-z0-9_.:-]{1,120}$/;

async function ownedCard(ownerId: string, boardId: string, cardId: string) {
  const c = await q.one<{ id: string }>('SELECT c.id FROM board_cards c JOIN boards b ON b.id = c.board_id WHERE c.id = ? AND c.board_id = ? AND b.owner_id = ?', cardId, boardId, ownerId);
  if (!c) throw new BoardError(404, 'not_found', 'Card not found');
}
export async function getCardSchedule(ownerId: string, boardId: string, cardId: string): Promise<CardSchedule | null> {
  await ownedCard(ownerId, boardId, cardId);
  const r = await q.one<Row>('SELECT * FROM card_schedules WHERE card_id = ?', cardId);
  return r ? toSchedule(r) : null;
}
/** The repeat line of a board's cards (how often, next run, paused). */
export async function boardSchedules(boardId: string): Promise<Map<string, CardSchedule>> {
  const rows = await q.all<Row>('SELECT s.* FROM card_schedules s JOIN board_cards c ON c.id = s.card_id WHERE c.board_id = ?', boardId).catch(() => [] as Row[]);
  return new Map(rows.map((r) => [r.card_id, toSchedule(r)]));
}

/** Set or change how a card repeats: { every, at, weekday?, agentId?, model?, paused?, notify?, newChat?, thinking?, projectId? }. */
export async function setCardSchedule(ownerId: string, boardId: string, cardId: string, input: unknown, now: Date = new Date()): Promise<CardSchedule | null> {
  const v = input as Record<string, unknown> | null;
  // { every: 'never' } takes the schedule away (the same as DELETE).
  if (v && typeof v === 'object' && !Array.isArray(v) && v.every === 'never' && Object.keys(v).length === 1) { await deleteCardSchedule(ownerId, boardId, cardId); return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => !['every', 'at', 'weekday', 'agentId', 'model', 'paused', 'notify', 'newChat', 'thinking', 'projectId'].includes(k))) throw bad('A schedule is { every, at, weekday?, agentId?, model?, paused?, notify?, newChat?, thinking?, projectId? }');
  if (!['hourly', 'daily', 'weekly'].includes(String(v.every))) throw bad('every must be hourly, daily or weekly');
  if (typeof v.at !== 'string' || !AT.test(v.at)) throw bad('at must be a time like 09:00');
  const weekday = v.every === 'weekly' ? Number(v.weekday) : null;
  if (v.every === 'weekly' && !(Number.isInteger(weekday) && weekday! >= 0 && weekday! <= 6)) throw bad('weekday must be 0 (Sunday) to 6');
  if (v.agentId !== undefined && v.agentId !== null && (typeof v.agentId !== 'string' || !(await q.one('SELECT id FROM agents_config WHERE id = ?', v.agentId)))) throw bad('Unknown agent');
  if (v.model !== undefined && (typeof v.model !== 'string' || (v.model !== '' && !MODEL.test(v.model)))) throw bad('invalid model');
  if (v.paused !== undefined && typeof v.paused !== 'boolean') throw bad('paused must be true or false');
  if (v.notify !== undefined && !['important', 'all', 'none'].includes(String(v.notify))) throw bad('notify must be important, all or none');
  if (v.newChat !== undefined && typeof v.newChat !== 'boolean') throw bad('newChat must be true or false');
  if (v.thinking !== undefined && v.thinking !== null && !['quick', 'normal', 'deep'].includes(String(v.thinking))) throw bad('thinking must be quick, normal or deep');
  if (v.projectId !== undefined && v.projectId !== null && (typeof v.projectId !== 'string' || !PROJECT.test(v.projectId) || !(await q.one('SELECT id FROM chat_projects WHERE id = ? AND user_id = ?', v.projectId, ownerId)))) throw bad('Unknown project');
  await ownedCard(ownerId, boardId, cardId);
  // Options left out keep what the schedule had (a Pause from Runs sends only the schedule itself).
  const had = await q.one<Row>('SELECT * FROM card_schedules WHERE card_id = ?', cardId);
  const o = { ...runOptions(had ?? {}), ...(v.notify !== undefined ? { notify: v.notify as Notify } : {}), ...(v.newChat !== undefined ? { newChat: v.newChat as boolean } : {}), ...(v.thinking !== undefined ? { thinking: v.thinking as Thinking | null } : {}), ...(v.projectId !== undefined ? { projectId: v.projectId as string | null } : {}) };
  const next = nextRun(v.every as Every, v.at, weekday, now).toISOString();
  await q.run(`INSERT INTO card_schedules (card_id, user_id, every, at_time, weekday, agent_id, model, paused, next_run, notify, new_chat, thinking, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (card_id) DO UPDATE SET every = excluded.every, at_time = excluded.at_time, weekday = excluded.weekday, agent_id = excluded.agent_id, model = excluded.model, paused = excluded.paused, next_run = excluded.next_run,
      notify = excluded.notify, new_chat = excluded.new_chat, thinking = excluded.thinking, project_id = excluded.project_id, updated_at = CURRENT_TIMESTAMP`,
    cardId, ownerId, v.every as string, v.at, weekday, (v.agentId as string | null | undefined) ?? null, (v.model as string | undefined) ?? '', v.paused ? 1 : 0, next, o.notify, o.newChat ? 1 : 0, o.thinking, o.projectId);
  await event(cardId, ownerId, 'repeats', `${v.every}${v.every === 'weekly' ? `:${weekday}` : ''}:${v.at}${v.paused ? ':paused' : ''}`);
  return (await getCardSchedule(ownerId, boardId, cardId))!;
}
/** Never again: the schedule goes; the task stays. */
export async function deleteCardSchedule(ownerId: string, boardId: string, cardId: string): Promise<boolean> {
  await ownedCard(ownerId, boardId, cardId);
  const gone = (await q.run('DELETE FROM card_schedules WHERE card_id = ?', cardId)).changes > 0;
  if (gone) await event(cardId, ownerId, 'repeats', 'never');
  return gone;
}
async function event(cardId: string, ownerId: string, kind: string, detail: string) {
  await q.run('INSERT INTO board_card_events (id, card_id, kind, actor_kind, actor_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', randomUUID(), cardId, kind, 'user', ownerId, detail.slice(0, 200), new Date().toISOString().replace('T', ' ').slice(0, 19)).catch(() => undefined);
}

export type StartRun = (ownerId: string, boardId: string, cardId: string, agentId: string | null, model: string, runKey: string, options: CardRunOptions) => Promise<'started' | 'busy' | 'failed'>;
/** One tick: every due, unpaused card schedule starts its Continue. Archived cards wait (nothing runs). */
export async function runDueCardSchedules(start: StartRun, now: Date = new Date()): Promise<number> {
  const due = await q.all<Row & { board_id: string; archived: number }>('SELECT s.*, c.board_id, c.archived FROM card_schedules s JOIN board_cards c ON c.id = s.card_id WHERE s.paused = 0 AND s.next_run <= ?', now.toISOString());
  let started = 0;
  for (const r of due) {
    const next = nextRun(r.every, r.at_time, r.weekday, now).toISOString();
    const claimed = await q.run('UPDATE card_schedules SET next_run = ?, last_run = ? WHERE card_id = ? AND next_run = ?', next, now.toISOString(), r.card_id, r.next_run);
    if (!claimed.changes) continue;
    // RUNS-01: an archived card's time is skipped (recorded, so Runs can say why).
    if (Number(r.archived)) { await q.run("UPDATE card_schedules SET last_result = 'busy', last_reason = 'archived', last_run_id = NULL WHERE card_id = ?", r.card_id); continue; }
    const runKey = `cardsch-${randomUUID()}`;
    let result: 'started' | 'busy' | 'failed' = 'failed';
    try { result = await start(r.user_id, r.board_id, r.card_id, r.agent_id, r.model ?? '', runKey, runOptions(r)); } catch { result = 'failed'; }
    await q.run('UPDATE card_schedules SET last_result = ?, last_reason = ?, last_run_id = ? WHERE card_id = ?', result, result === 'busy' ? 'busy' : result === 'failed' ? 'error' : null, result === 'started' ? runKey : null, r.card_id);
    await event(r.card_id, r.user_id, 'ran', result);
    if (result === 'started') started++;
  }
  return started;
}
