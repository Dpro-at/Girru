/**
 * STORE-MAP-01 P8 (D24-D26, D28, D29): the task number T-n as the link hub.
 *
 *   linksForScope   the card, task number and chat a handoff is saved with, found
 *                   from trusted rows only (the chat's card: board_cards.conversation_id
 *                   or board_card_chats, which a Continue writes; a task run's card:
 *                   board_cards.task_id; the number: task_file_cards)
 *   cardLinks       everything linked to one task: its task notes, its handoffs
 *                   (newest first), its chats and its line in the task file
 *   cardBadges      per card of a board: how many handoffs, and "blocked" when the
 *                   newest one names a blocker
 *   wireHandoffs    a handoff as the window and the coding apps see it
 *
 * Owner only: every lookup carries the owner id (a card on another owner's
 * board, a chat of another person, is never linked or shown). Used only while
 * GIRRU_STORE_P8 is on.
 */

import { q } from '../../repositories/sql-steps.js';
import { getMemoryStorage } from '../storage.js';
import { redactImportText } from '../import/redact.js';
import { CLIENT_NAMES, type BridgeClient } from '../bridge/clients.js';
import { HandoffInputError, MAX_ITEMS, cleanList, toHandoff, type Handoff, type HandoffLinks, type HandoffScope } from './store.js';

const redact = (t: string) => redactImportText(String(t ?? '')).text;

/** A task's number in a project's task file. */
export const TASK_NO = /^T-\d{1,6}$/;

/** The handoff as the window shows it (wire shape of the P8 contract). */
export interface WireHandoff {
  id: string; agentId: string; agentName: string; app: string | null; fromAgentId: string | null; fromAgentName: string | null; at: string;
  done: string[]; left: string[]; next: string[]; blockers: string[]; files: string[]; questions: string[];
  cardId: string | null; taskNo: string | null; conversationId: string | null; conversationTitle: string | null;
}

interface CardRef { id: string; board_id: string; task_id: string | null; conversation_id: string | null }

/** The owner's card a chat works on: the card it came from, else the newest card a Continue gave it. */
export async function cardOfConversation(ownerId: string, conversationId: string): Promise<CardRef | undefined> {
  return q.one<CardRef>(
    `SELECT c.id, c.board_id, c.task_id, c.conversation_id FROM board_cards c JOIN boards b ON b.id = c.board_id
     WHERE b.owner_id = ? AND (c.conversation_id = ? OR c.id IN (SELECT card_id FROM board_card_chats WHERE conversation_id = ?))
     ORDER BY CASE WHEN c.conversation_id = ? THEN 1 ELSE 0 END, c.updated_at DESC, c.id LIMIT 1`, ownerId, conversationId, conversationId, conversationId);
}

/** The owner's card of an orchestrator task (a board task run). */
export async function cardOfTask(ownerId: string, taskId: string): Promise<CardRef | undefined> {
  return q.one<CardRef>('SELECT c.id, c.board_id, c.task_id, c.conversation_id FROM board_cards c JOIN boards b ON b.id = c.board_id WHERE b.owner_id = ? AND c.task_id = ? LIMIT 1', ownerId, taskId);
}

/** The owner's card of task T-n in a project's task file. */
export async function cardOfTaskNo(ownerId: string, projectId: string, taskNo: string): Promise<CardRef | undefined> {
  if (!TASK_NO.test(taskNo)) return undefined;
  return q.one<CardRef>(`SELECT c.id, c.board_id, c.task_id, c.conversation_id FROM task_file_cards t JOIN board_cards c ON c.id = t.card_id JOIN boards b ON b.id = c.board_id
    WHERE b.owner_id = ? AND t.project_id = ? AND t.task_no = ? LIMIT 1`, ownerId, projectId, taskNo);
}

/** The task number of a card, or null when it is not from a task file. */
export async function taskNoOf(cardId: string): Promise<string | null> {
  return (await q.one<{ task_no: string }>('SELECT task_no FROM task_file_cards WHERE card_id = ?', cardId))?.task_no ?? null;
}

/** The card, task number, chat and giver a handoff of this scope is saved with. */
export async function linksForScope(scope: HandoffScope, given: HandoffLinks = {}): Promise<Required<HandoffLinks>> {
  const conversationId = given.conversationId ?? (scope.kind === 'conversation' ? scope.scopeId : null);
  let cardId = given.cardId ?? null;
  if (!cardId && conversationId) cardId = (await cardOfConversation(scope.ownerId, conversationId))?.id ?? null;
  if (!cardId && scope.kind === 'task') cardId = (await cardOfTask(scope.ownerId, scope.scopeId))?.id ?? null;
  const taskNo = given.taskNo ?? (cardId ? await taskNoOf(cardId) : null);
  return { cardId, taskNo, conversationId, fromAgentId: given.fromAgentId ?? null };
}

/** Handoff rows (any shape of agent_handoffs) as the wire shape, with names. */
export async function wireHandoffs(ownerId: string, rows: Handoff[]): Promise<WireHandoff[]> {
  if (!rows.length) return [];
  const agentIds = [...new Set(rows.flatMap((h) => [h.agentId, h.fromAgentId ?? '']).filter(Boolean))];
  const names = new Map((agentIds.length ? await q.all<{ id: string; name: string }>(`SELECT id, name FROM agents_config WHERE id IN (${agentIds.map(() => '?').join(', ')})`, ...agentIds) : []).map((a) => [a.id, a.name]));
  const convIds = [...new Set(rows.map((h) => h.conversationId ?? '').filter(Boolean))];
  const titles = new Map((convIds.length ? await q.all<{ id: string; title: string | null }>(`SELECT id, title FROM chat_sessions WHERE user_id = ? AND id IN (${convIds.map(() => '?').join(', ')})`, ownerId, ...convIds) : []).map((c) => [c.id, c.title]));
  const appName = (client: string | null | undefined) => (client ? CLIENT_NAMES[client as BridgeClient] ?? client : null);
  return rows.map((h) => {
    const app = appName(h.client ?? (h.agentId.startsWith('app:') ? h.agentId.slice(4) : null));
    return {
      id: h.id, agentId: h.agentId, agentName: names.get(h.agentId) ?? (h.agentId.startsWith('app:') ? app ?? 'Coding app' : h.agentId === '_main' ? 'Main agent' : 'Former agent'), app,
      fromAgentId: h.fromAgentId ?? null, fromAgentName: h.fromAgentId ? names.get(h.fromAgentId) ?? 'Former agent' : null, at: h.createdAt,
      done: h.done, left: h.left, next: h.next, blockers: h.blockers ?? [], files: h.files ?? [], questions: h.questions,
      cardId: h.cardId ?? null, taskNo: h.taskNo ?? null, conversationId: h.conversationId ?? null,
      conversationTitle: h.conversationId ? (titles.get(h.conversationId)?.trim() || null) : null,
    };
  });
}

/** Every handoff saved for one card, newest first (at most 50). */
export async function cardHandoffs(ownerId: string, cardId: string): Promise<Handoff[]> {
  const rows = await q.all<any>('SELECT * FROM agent_handoffs WHERE owner_id = ? AND card_id = ? ORDER BY created_at DESC, version DESC, id DESC LIMIT 50', ownerId, cardId);
  return rows.map(toHandoff);
}

/** The owner's card on that board, or undefined. */
export async function ownedCard(ownerId: string, boardId: string, cardId: string): Promise<CardRef | undefined> {
  return q.one<CardRef>('SELECT c.id, c.board_id, c.task_id, c.conversation_id FROM board_cards c JOIN boards b ON b.id = c.board_id WHERE c.id = ? AND c.board_id = ? AND b.owner_id = ?', cardId, boardId, ownerId);
}

export interface CardLinks {
  taskNo: string | null;
  notesPlace: { place: string; count: number } | null;
  handoffs: WireHandoff[];
  chats: Array<{ id: string; title: string | null; at: string }>;
  taskFile: { path: string; line: number | null } | null;
  blocked: boolean;
}

/** D24: everything linked to one task (the owner's card). Undefined when the card is not theirs. */
export async function cardLinks(ownerId: string, boardId: string, cardId: string): Promise<CardLinks | undefined> {
  const card = await ownedCard(ownerId, boardId, cardId);
  if (!card) return undefined;
  const file = await q.one<{ task_no: string; project_id: string; finished: number }>('SELECT task_no, project_id, finished FROM task_file_cards WHERE card_id = ?', cardId);
  let notesPlace: CardLinks['notesPlace'] = null;
  if (card.task_id) {
    const count = (await getMemoryStorage().getByDrawers(ownerId, [{ kind: 'task', key: card.task_id }]).catch(() => [])).length;
    notesPlace = { place: `task:${card.task_id}`, count };
  }
  const handoffs = await wireHandoffs(ownerId, await cardHandoffs(ownerId, cardId));
  const chats = (await q.all<{ id: string; title: string | null; at: string | null }>(
    `SELECT s.id, s.title, COALESCE(s.updated_at, s.created_at) AS at FROM chat_sessions s WHERE s.user_id = ? AND (s.id = ? OR s.id IN (SELECT conversation_id FROM board_card_chats WHERE card_id = ?))
     ORDER BY s.created_at DESC, s.id`, ownerId, card.conversation_id ?? '', cardId)).map((c) => ({ id: c.id, title: c.title, at: String(c.at ?? '') }));
  let taskFile: CardLinks['taskFile'] = null;
  if (file) {
    const done = Number(file.finished) === 1;
    taskFile = { path: done ? '.girru/tasks-done.md' : '.girru/tasks.md', line: await taskLine(ownerId, file.project_id, file.task_no, done) };
  }
  return { taskNo: file?.task_no ?? null, notesPlace, handoffs, chats, taskFile, blocked: (handoffs[0]?.blockers.length ?? 0) > 0 };
}

/** The 1-based line of the task's heading in its file, or null (no folder, no file, not found). Read only. */
async function taskLine(ownerId: string, projectId: string, taskNo: string, done: boolean): Promise<number | null> {
  const p = await q.one<{ folder: string | null }>('SELECT folder FROM chat_projects WHERE id = ? AND user_id = ?', projectId, ownerId);
  if (!p?.folder) return null;
  const { readTaskFileText } = await import('../../services/task-file.js');
  const text = await readTaskFileText(p.folder, done).catch(() => null);
  if (!text) return null;
  const at = text.split('\n').findIndex((l) => new RegExp(`^##\\s+${taskNo}(\\s|$)`).test(l));
  return at < 0 ? null : at + 1;
}

/** D29: per card of a board, the number of handoffs and whether the newest names a blocker (only cards that have any). */
export async function cardBadges(ownerId: string, boardId: string): Promise<Map<string, { handoffCount: number; blocked: boolean }>> {
  const rows = await q.all<{ card_id: string; blockers: string; created_at: string }>(
    `SELECT h.card_id, h.blockers, h.created_at FROM agent_handoffs h JOIN board_cards c ON c.id = h.card_id
     WHERE h.owner_id = ? AND c.board_id = ? ORDER BY h.created_at DESC, h.version DESC, h.id DESC`, ownerId, boardId);
  const out = new Map<string, { handoffCount: number; blocked: boolean }>();
  for (const r of rows) {
    const cur = out.get(r.card_id);
    if (cur) { cur.handoffCount++; continue; }
    let blocked = false;
    try { const v = JSON.parse(r.blockers ?? '[]'); blocked = Array.isArray(v) && v.length > 0; } catch { blocked = false; }
    out.set(r.card_id, { handoffCount: 1, blocked });
  }
  return out;
}

/** D29: the owner edits a handoff's blockers (only those; in place). Undefined when it is not theirs. */
export async function setBlockers(ownerId: string, id: string, raw: unknown): Promise<WireHandoff | undefined> {
  if (!Array.isArray(raw)) throw new HandoffInputError('blockers must be a list of short texts');
  const blockers = cleanList(raw, 'blockers', MAX_ITEMS);
  const res = await q.run('UPDATE agent_handoffs SET blockers = ? WHERE id = ? AND owner_id = ?', JSON.stringify(blockers), id, ownerId);
  if (!res.changes) return undefined;
  const row = await q.one<any>('SELECT * FROM agent_handoffs WHERE id = ? AND owner_id = ?', id, ownerId);
  return row ? (await wireHandoffs(ownerId, [toHandoff(row)]))[0] : undefined;
}

/** The task's card and board of handoffs (Memory › Handoffs: "Open the task T-12"). */
export async function boardsOfCards(cardIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(cardIds.filter(Boolean))].slice(0, 200);
  if (!ids.length) return new Map();
  return new Map((await q.all<{ id: string; board_id: string }>(`SELECT id, board_id FROM board_cards WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids)).map((r) => [r.id, r.board_id]));
}

/** A wire handoff as text for a coding app (latest_handoff / project_brief with a task). Data, not instructions. */
export function wireHandoffNote(h: WireHandoff): string {
  const who = h.fromAgentName ? `${h.fromAgentName} handed this to ${h.agentName}` : h.app && h.app !== h.agentName ? `${h.agentName} (${h.app})` : h.agentName;
  const out = [`Latest handoff${h.taskNo ? ` for ${h.taskNo}` : ''} — from ${who}, ${h.at}${h.conversationTitle ? ` (chat: ${h.conversationTitle})` : ''}`];
  const section = (title: string, list: string[]) => { if (list.length) out.push(`${title}:`, ...list.map((i) => `- ${i}`)); };
  section('Done', h.done); section('Left', h.left); section('Next', h.next); section('Blockers', h.blockers); section('Files touched', h.files); section('Open questions', h.questions);
  return out.join('\n');
}

/** P8 (D28): the brief section of one task for a coding app: its card, newest handoff and chats. Undefined when T-n is no task of the project. */
export async function taskBriefSection(ownerId: string, projectId: string, taskNo: string): Promise<{ text: string; cardId: string; handoff: WireHandoff | null } | undefined> {
  const card = await cardOfTaskNo(ownerId, projectId, taskNo);
  if (!card) return undefined;
  const links = await cardLinks(ownerId, card.board_id, card.id);
  if (!links) return undefined;
  const title = (await q.one<{ title: string }>('SELECT title FROM board_cards WHERE id = ?', card.id))?.title ?? '';
  const clip = (t: string, n: number) => redact(t).replace(/\s+/g, ' ').trim().slice(0, n);
  const lines = [`### Task ${taskNo} · ${clip(title, 200)}`];
  if (links.taskFile) lines.push(`In \`${links.taskFile.path}\`${links.taskFile.line ? ` at line ${links.taskFile.line}` : ''}.`);
  if (links.blocked) lines.push('Blocked: see the blockers of the newest handoff.');
  lines.push(`${links.handoffs.length} handoff${links.handoffs.length === 1 ? '' : 's'} and ${links.chats.length} chat${links.chats.length === 1 ? '' : 's'} are linked to this task.`);
  if (links.chats.length) lines.push(...links.chats.slice(0, 5).map((c) => `- Chat: ${clip(c.title || 'Untitled chat', 120)}`));
  const newest = links.handoffs[0] ?? null;
  if (newest) lines.push('', wireHandoffNote(newest));
  return { text: lines.join('\n'), cardId: card.id, handoff: newest };
}
