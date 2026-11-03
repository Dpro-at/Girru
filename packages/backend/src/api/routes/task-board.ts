import {syncDepartmentBoards,relatedBoardTasks} from '../../services/task-board.js';
/**
 * Task board API (BOARD-01). Owner only (auth gate owner tier, route access
 * 'owner', handler role check).
 *
 *   GET   /api/boards?archived=1                       -> { boards: [summary], templates: [{id, name, description, columns}], colors }
 *                                                         (first call creates the company board)
 *   POST  /api/boards   { name, description?, template?, color?, departments? } -> 201 board
 *   PUT   /api/boards/:id { expectedVersion, name?, description?, color?, departments?, archived? } -> board
 *   GET   /api/boards/:id?archived=1                   -> { id, name, columns, cards }
 *   POST  /api/boards/:id/columns          { name }    -> board
 *   PUT   /api/boards/:id/columns/:columnId { name }   -> board
 *   POST  /api/boards/:id/cards            { columnId, title, description?, priority?, dueDate?, agents?, departments? } -> 201 card
 *   PUT   /api/boards/:id/cards/:cardId    { expectedVersion, title?, description?, priority?, dueDate?, agents?, departments?,
 *                                            columnId?, beforeCardId?, archived? } -> card; 409 { code: 'version_conflict', card }
 *   GET   /api/boards/:id/cards/:cardId/comments        -> { comments }
 *   POST  /api/boards/:id/cards/:cardId/comments { body } -> 201 { comments }
 *   POST  /api/boards/:id/labels { name, color } -> 201 board;  PUT /api/boards/:id/labels/:labelId { name?, color? } -> board
 *   GET   /api/boards/:id/cards/:cardId/checklist -> { items }
 *   POST  /api/boards/:id/cards/:cardId/checklist { text } -> 201 { items }
 *   PUT   /api/boards/:id/cards/:cardId/checklist/:itemId { text?, done?, remove? } -> { items }
 *   GET   /api/boards/:id/cards/:cardId/chat -> { conversation: { id, title } | null, progress } (CHAT-PRO-02 I step 2: the chat it came from, who works on it)
 *   TASKPAGE-02 (the full task page, owner only):
 *   GET   /api/boards/:id/cards/:cardId/page                     -> { page } who opened it, people and agents, parent, sub-tasks, waits for,
 *                                                                  release, followers, chats, spent, files changed, development
 *   GET   /api/boards/:id/cards/:cardId/activity?before=ISO      -> { items, more } the story, oldest first (150 per page)
 *   GET   /api/boards/:id/cards/:cardId/activity/:messageId/diff -> { files } the changed lines of one reply
 *   PUT   /api/boards/:id/cards/:cardId/people { kind, id, role } -> { people } (role null removes)
 *   PUT   /api/boards/:id/cards/:cardId/release { name }          -> { release }
 *   POST  /api/boards/:id/cards/:cardId/subtasks { title }        -> 201 card
 *   PUT   /api/boards/:id/cards/:cardId/links { waitsFor, on }    -> { ok }
 *   PUT   /api/boards/:id/cards/:cardId/follow { on }             -> { following }
 *   TASKPAGE-03: GET | PUT { every, at, weekday?, agentId?, model?, paused? } | DELETE /api/boards/:id/cards/:cardId/schedule
 *                -> { schedule } (null = it does not repeat); a board's cards carry repeat { every, at, weekday, nextRun, paused, lastResult }
 *   GET   /api/boards/tasks?projectId=  -> { tasks, problems } (TASKLOG-01: the tasks of the projects' task files, read now)
 *   POST  /api/boards/:id/cards/:cardId/task-sort { department } -> { boardId } (TASKLOG-01: a task waiting in To sort goes to that department's board)
 *   GET   /api/boards/:id/cards/:cardId/task -> { task } (TASKLOG-01: the card's task in the project's task file, or null)
 *   TASKLOG-01: a card from a task file has taskFile { no, projectId, projectName, problem, apps, finished }; a board
 *   summary has toSort (cards waiting in "To sort"). Reading the boards first reads the projects' task files.
 *   Cards also take type (task|idea|bug|milestone|request), startDate, cover (colour or null) and labels (label ids).
 * Errors: 400 { code: 'invalid_board' | 'invalid_version' }, 404 { code: 'not_found' }.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { actorOrReply, requireOwner } from '../../repositories/scope.js';
import {
  BoardError, addChecklistItem, addColumn, addComment, addLabel, createBoard, createCard, getBoard, listBoards, listChecklist, listComments, renameColumn,
  updateBoard, updateCard, updateChecklistItem, updateLabel,
} from '../../services/task-board.js';
import { BOARD_COLORS, BOARD_TEMPLATES } from '../../services/board-templates.js';
import { cardConversation, chatProgress } from '../../services/chat-board.js';
import { chatRuns } from '../../services/chat-runs.js';
import { TO_SORT, cardChanged, projectTasks, sortTask, syncAllTasks, taskDetail, taskMarks } from '../../services/task-file.js';
import { q } from '../../repositories/sql-steps.js';
import { storeP6Enabled } from '../../services/store-p6.js';
import { boardSchedules, deleteCardSchedule, getCardSchedule, setCardSchedule } from '../../services/card-schedules.js';
import { addSubtask, replyDiff, setFollow, setLink, setPerson, setRelease, taskActivity, taskPage } from '../../services/task-page.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function ownerOf(request: FastifyRequest, reply: FastifyReply): string | null {
  const actor = actorOrReply(reply, actorOf(request), requireOwner);
  return actor ? actor.userId ?? null : null;
}

function objectBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new BoardError(400, 'invalid_board', 'Body must be a JSON object');
  return body as Record<string, unknown>;
}

function fail(err: unknown, reply: FastifyReply) {
  if (err instanceof BoardError) {
    const extra = (err as BoardError & { current?: unknown }).current;
    const board = (err as BoardError & { currentBoard?: unknown }).currentBoard;
    return reply.code(err.status).send({ error: err.message, code: err.code, ...(extra ? { card: extra } : {}), ...(board ? { board } : {}) });
  }
  throw err;
}

export async function taskBoardRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  type P = { id: string; columnId?: string; cardId?: string; labelId?: string; itemId?: string };
  const ids = (p: P) => [p.id, p.columnId, p.cardId, p.labelId, p.itemId].every((x) => x === undefined || ID.test(x));

  fastify.post('/api/boards/sync-departments',{config},async(request,reply)=>{
    const owner=ownerOf(request,reply);if(owner===null)return reply;
    try{if(request.body!==undefined&&Object.keys(objectBody(request.body)).length)throw new BoardError(400,'invalid_board','No fields accepted');return await syncDepartmentBoards(owner);}catch(err){return fail(err,reply);}
  });
  fastify.get<{Params:P}>('/api/boards/:id/overview',{config},async(request,reply)=>{
    const owner=ownerOf(request,reply);if(owner===null)return reply;if(!ids(request.params))return reply.code(404).send({code:'not_found'});
    try{return await relatedBoardTasks(owner,request.params.id);}catch(err){return fail(err,reply);}
  });
  fastify.get<{ Querystring: { projectId?: string } }>('/api/boards/tasks', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    const pid = request.query?.projectId;
    if (pid !== undefined && !ID.test(pid)) return reply.code(400).send({ error: 'projectId must be a project id', code: 'invalid_board' });
    return projectTasks(owner, pid);
  });

  fastify.get<{ Querystring: { archived?: string } }>('/api/boards', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    await syncAllTasks().catch(() => undefined);
    const sorting = new Map((await q.all<{ board_id: string; n: number }>('SELECT c.board_id, COUNT(*) AS n FROM board_cards c JOIN board_columns col ON col.id = c.column_id WHERE col.name = ? AND c.archived = 0 GROUP BY c.board_id', TO_SORT).catch(() => [])).map((r) => [r.board_id, Number(r.n)]));
    return {
      boards: (await listBoards(owner, request.query?.archived === '1')).map((b) => ({ ...b, toSort: sorting.get(b.id) ?? 0 })),
      templates: BOARD_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, columns: [...t.columns] })),
      colors: [...BOARD_COLORS],
    };
  });

  fastify.post<{ Body: unknown }>('/api/boards', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    try { return reply.code(201).send(await createBoard(owner, objectBody(request.body))); } catch (err) { return fail(err, reply); }
  });

  fastify.put<{ Params: P; Body: unknown }>('/api/boards/:id', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Board not found', code: 'not_found' });
    try { return await updateBoard(owner, request.params.id, objectBody(request.body)); } catch (err) { return fail(err, reply); }
  });

  fastify.get<{ Params: P; Querystring: { archived?: string } }>('/api/boards/:id', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Board not found', code: 'not_found' });
    try {
      const board = await getBoard(owner, request.params.id, request.query?.archived === '1');
      const marks = await taskMarks(board.id), repeats = await boardSchedules(board.id);
      const repeat = (id: string) => { const r = repeats.get(id); return r ? { every: r.every, at: r.at, weekday: r.weekday, nextRun: r.nextRun, paused: r.paused, lastResult: r.lastResult } : null; };
      return { ...board, cards: board.cards.map((c) => ({ ...c, taskFile: marks.get(c.id) ?? null, repeat: repeat(c.id) })) };
    } catch (err) { return fail(err, reply); }
  });

  fastify.post<{ Params: P; Body: unknown }>('/api/boards/:id/columns', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Board not found', code: 'not_found' });
    try { return reply.code(201).send(await addColumn(owner, request.params.id, objectBody(request.body))); } catch (err) { return fail(err, reply); }
  });

  fastify.put<{ Params: P; Body: unknown }>('/api/boards/:id/columns/:columnId', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Column not found', code: 'not_found' });
    try { return await renameColumn(owner, request.params.id, request.params.columnId!, objectBody(request.body)); } catch (err) { return fail(err, reply); }
  });

  fastify.post<{ Params: P; Body: unknown }>('/api/boards/:id/cards', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Board not found', code: 'not_found' });
    try { return reply.code(201).send(await createCard(owner, request.params.id, objectBody(request.body))); } catch (err) { return fail(err, reply); }
  });

  fastify.put<{ Params: P; Body: unknown }>('/api/boards/:id/cards/:cardId', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    try {
      const card = await updateCard(owner, request.params.id, request.params.cardId!, objectBody(request.body));
      // TASKLOG-01: a card from a task file writes its block back (its place, title, agent, priority).
      await cardChanged(card.id);
      return { ...card, taskFile: (await taskMarks(request.params.id)).get(card.id) ?? null };
    } catch (err) { return fail(err, reply); }
  });

  fastify.post<{ Params: P; Body: unknown }>('/api/boards/:id/cards/:cardId/task-sort', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    try {
      const b = objectBody(request.body);
      if (Object.keys(b).some((k) => k !== 'department')) throw new BoardError(400, 'invalid_board', 'Only department');
      return await sortTask(owner, request.params.id, request.params.cardId!, b.department);
    } catch (err) { return fail(err, reply); }
  });

  // TASKPAGE-02: the full task page.
  type PM = P & { messageId?: string };
  const card = (request: FastifyRequest<{ Params: PM }>, reply: FastifyReply) => {
    const owner = ownerOf(request, reply); if (owner === null) return null;
    if (!ids(request.params) || (request.params.messageId !== undefined && !ID.test(request.params.messageId))) { reply.code(404).send({ error: 'Card not found', code: 'not_found' }); return null; }
    return { owner, board: request.params.id, card: request.params.cardId! };
  };
  fastify.get<{ Params: PM }>('/api/boards/:id/cards/:cardId/page', { config }, async (request, reply) => {
    const k = card(request, reply); if (!k) return reply;
    try { return { page: await taskPage(k.owner, k.board, k.card, k.owner) }; } catch (err) { return fail(err, reply); }
  });
  fastify.get<{ Params: PM; Querystring: { before?: string } }>('/api/boards/:id/cards/:cardId/activity', { config }, async (request, reply) => {
    const k = card(request, reply); if (!k) return reply;
    const before = request.query?.before;
    if (before !== undefined && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(before)) return reply.code(400).send({ error: 'before is a time', code: 'invalid_board' });
    try { return await taskActivity(k.owner, k.board, k.card, before); } catch (err) { return fail(err, reply); }
  });
  fastify.get<{ Params: PM }>('/api/boards/:id/cards/:cardId/activity/:messageId/diff', { config }, async (request, reply) => {
    const k = card(request, reply); if (!k) return reply;
    try { return { files: await replyDiff(k.owner, k.board, k.card, request.params.messageId!) }; } catch (err) { return fail(err, reply); }
  });
  fastify.put<{ Params: PM; Body: unknown }>('/api/boards/:id/cards/:cardId/people', { config }, async (request, reply) => {
    const k = card(request, reply); if (!k) return reply;
    try { return { people: await setPerson(k.owner, k.board, k.card, objectBody(request.body)) }; } catch (err) { return fail(err, reply); }
  });
  fastify.put<{ Params: PM; Body: unknown }>('/api/boards/:id/cards/:cardId/release', { config }, async (request, reply) => {
    const k = card(request, reply); if (!k) return reply;
    try { return { release: await setRelease(k.owner, k.board, k.card, objectBody(request.body)) }; } catch (err) { return fail(err, reply); }
  });
  fastify.post<{ Params: PM; Body: unknown }>('/api/boards/:id/cards/:cardId/subtasks', { config }, async (request, reply) => {
    const k = card(request, reply); if (!k) return reply;
    try { return reply.code(201).send(await addSubtask(k.owner, k.board, k.card, objectBody(request.body))); } catch (err) { return fail(err, reply); }
  });
  fastify.put<{ Params: PM; Body: unknown }>('/api/boards/:id/cards/:cardId/links', { config }, async (request, reply) => {
    const k = card(request, reply); if (!k) return reply;
    try { return await setLink(k.owner, k.board, k.card, objectBody(request.body)); } catch (err) { return fail(err, reply); }
  });
  fastify.get<{ Params: PM }>('/api/boards/:id/cards/:cardId/schedule', { config }, async (request, reply) => {
    const k = card(request, reply); if (!k) return reply;
    try { return { schedule: await getCardSchedule(k.owner, k.board, k.card) }; } catch (err) { return fail(err, reply); }
  });
  fastify.put<{ Params: PM; Body: unknown }>('/api/boards/:id/cards/:cardId/schedule', { config }, async (request, reply) => {
    const k = card(request, reply); if (!k) return reply;
    try { return { schedule: await setCardSchedule(k.owner, k.board, k.card, objectBody(request.body)) }; } catch (err) { return fail(err, reply); }
  });
  fastify.delete<{ Params: PM }>('/api/boards/:id/cards/:cardId/schedule', { config }, async (request, reply) => {
    const k = card(request, reply); if (!k) return reply;
    try { await deleteCardSchedule(k.owner, k.board, k.card); return { schedule: null }; } catch (err) { return fail(err, reply); }
  });
  fastify.put<{ Params: PM; Body: unknown }>('/api/boards/:id/cards/:cardId/follow', { config }, async (request, reply) => {
    const k = card(request, reply); if (!k) return reply;
    try { return { following: await setFollow(k.owner, k.board, k.card, k.owner, objectBody(request.body)) }; } catch (err) { return fail(err, reply); }
  });

  fastify.get<{ Params: P }>('/api/boards/:id/cards/:cardId/task', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    const task = await taskDetail(owner, request.params.id, request.params.cardId!);
    // STORE-MAP-01 P6 screens: the task's number ("T-12") for the task page.
    return { task: task && storeP6Enabled() ? { ...task, number: task.no } : task };
  });

  fastify.get<{ Params: P }>('/api/boards/:id/cards/:cardId/comments', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    try { return { comments: await listComments(owner, request.params.id, request.params.cardId!) }; } catch (err) { return fail(err, reply); }
  });

  fastify.post<{ Params: P; Body: unknown }>('/api/boards/:id/cards/:cardId/comments', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    try {
      return reply.code(201).send({ comments: await addComment(owner, request.params.id, request.params.cardId!, objectBody(request.body), { kind: 'user', id: owner }) });
    } catch (err) { return fail(err, reply); }
  });

  // CHAT-PRO-02 I step 2: the conversation a card came from and the progress of the agents on it
  fastify.get<{ Params: P }>('/api/boards/:id/cards/:cardId/chat', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    try {
      const { conversation, agents } = await cardConversation(owner, request.params.id, request.params.cardId!);
      const active = conversation ? chatRuns.activeFor(conversation.id) : undefined;
      const progress = conversation
        ? await chatProgress(conversation.id, conversation.agentId, agents, active ? { agentId: active.agentId, parts: active.parts } : null)
        : { running: false, agents: agents.map((agentId) => ({ agentId, replies: 0, lastAt: null, running: false, plan: null })) };
      return { conversation: conversation ? { id: conversation.id, title: conversation.title } : null, progress };
    } catch (err) { return fail(err, reply); }
  });

  // BOARD-03 step B: labels and checklists
  fastify.post<{ Params: P; Body: unknown }>('/api/boards/:id/labels', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Board not found', code: 'not_found' });
    try { return reply.code(201).send(await addLabel(owner, request.params.id, objectBody(request.body))); } catch (err) { return fail(err, reply); }
  });

  fastify.put<{ Params: P; Body: unknown }>('/api/boards/:id/labels/:labelId', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Label not found', code: 'not_found' });
    try { return await updateLabel(owner, request.params.id, request.params.labelId!, objectBody(request.body)); } catch (err) { return fail(err, reply); }
  });

  fastify.get<{ Params: P }>('/api/boards/:id/cards/:cardId/checklist', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    try { return { items: await listChecklist(owner, request.params.id, request.params.cardId!) }; } catch (err) { return fail(err, reply); }
  });

  fastify.post<{ Params: P; Body: unknown }>('/api/boards/:id/cards/:cardId/checklist', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Card not found', code: 'not_found' });
    try { return reply.code(201).send({ items: await addChecklistItem(owner, request.params.id, request.params.cardId!, objectBody(request.body)) }); } catch (err) { return fail(err, reply); }
  });

  fastify.put<{ Params: P; Body: unknown }>('/api/boards/:id/cards/:cardId/checklist/:itemId', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply); if (owner === null) return reply;
    if (!ids(request.params)) return reply.code(404).send({ error: 'Item not found', code: 'not_found' });
    try { return { items: await updateChecklistItem(owner, request.params.id, request.params.cardId!, request.params.itemId!, objectBody(request.body)) }; } catch (err) { return fail(err, reply); }
  });
}
