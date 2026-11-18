// STORE-MAP-01 P8 wire contract (boards P8a–P8c): the task number T-n as the link
// hub of a board task (its task notes, handoffs, chats and task file), a handoff's
// blockers edited by the owner, and a run's working notes (read only). Shared by the
// browser client (session.ts) and the local bridge (application-server.cjs).
// The backend registers these routes only while its P8 switch is on; otherwise they
// answer 404 and the window shows nothing new (or "not available yet").
//
//   GET   /api/boards/:boardId/cards/:cardId/links          the links of one task (board-contract.js
//                                                           owns this path: its PUT is TASKPAGE-02's
//                                                           "waits for"; the GET answer is projected here)
//   PATCH /api/handoffs/:id                                 { blockers: string[] } → { handoff }
//   GET   /api/runs/:runId/notes?kind=chat|task|delegation  { notes: [{ seq, text, at }], clearsAt }

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const plainId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const runId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(x);
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/gu;
const clip = (x, max) => (typeof x === 'string' ? x.replace(badChars, '').slice(0, max) : '');
const when = x => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(x) && x.length <= 40 ? x : '');
const taskNo = x => (typeof x === 'string' && /^T-\d{1,6}$/.test(x) ? x : null);

/** The kinds of run that keep working notes. */
export const RUN_NOTE_KINDS = ['chat', 'task', 'delegation'];
/** Blockers the owner may list on one handoff, and the length of one line. */
export const MAX_BLOCKERS = 8;
export const MAX_LINE = 300;
/** How long a run's working notes are kept after the run ends (D27). */
export const RUN_NOTES_DAYS = 14;
/** The task file of the project folder. */
export const TASK_FILE = '.girru/tasks.md';
/** A finished task's line lives here. */
export const DONE_FILE = '.girru/tasks-done.md';

export const taskLinksPath = (boardId, cardId) => `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/links`;
export const handoffPath = id => `/api/handoffs/${encodeURIComponent(id)}`;
export const runNotesPath = (id, kind) => `/api/runs/${encodeURIComponent(id)}/notes?kind=${kind}`;

const decoded = (raw, ok) => { let v; try { v = decodeURIComponent(raw); } catch { return null; } return ok(v) && encodeURIComponent(v) === raw ? v : null; };
/** Names under /api/handoffs and /api/runs that are other routes, never a handoff or a run. */
const TAKEN = ['coding-apps', 'conversation', 'task', 'item', 'schedules'];

/** Which P8 route a path is (the links GET is the board contract's), or null. */
export function taskLinksPathOf(path) {
  if (typeof path !== 'string' || path.length > 512 || path.includes('#')) return null;
  let m = /^\/api\/handoffs\/([^/?]+)$/.exec(path);
  if (m) { const id = decoded(m[1], plainId); return id && !TAKEN.includes(id) ? { route: 'handoff', id } : null; }
  m = /^\/api\/runs\/([^/?]+)\/notes\?kind=(chat|task|delegation)$/.exec(path);
  if (m) { const id = decoded(m[1], runId); return id && !TAKEN.includes(id) ? { route: 'run-notes', id, kind: m[2] } : null; }
  return null;
}
export function taskLinksRoute(path) { return taskLinksPathOf(path) !== null; }

/** Blockers as the owner writes them: one short line each, at most 8 (an empty list clears them). */
export function validBlockers(x) {
  return Array.isArray(x) && x.length <= MAX_BLOCKERS && x.every(l => typeof l === 'string' && !!l.trim() && l.length <= MAX_LINE && !/[\r\n]/.test(l) && clip(l, MAX_LINE) === l);
}
export function allowedTaskLinks(method, path, body) {
  const p = taskLinksPathOf(path);
  if (!p) return false;
  if (p.route === 'run-notes') return method === 'GET' && body === undefined;
  return method === 'PATCH' && record(body) && Object.keys(body).length === 1 && validBlockers(body.blockers);
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const fail = () => { throw Error('Invalid task links response'); };
const lines = (x, max = 12) => (Array.isArray(x) ? x.filter(l => typeof l === 'string' && l.trim()).slice(0, max).map(l => clip(l, MAX_LINE)) : []);
const nameOrNull = x => (typeof x === 'string' && x.trim() ? clip(x, 120) : null);
const idOrNull = x => (plainId(x) ? x : null);

/** One handoff as the window shows it (D25, D26). */
export function handoffOf(h) {
  if (!record(h) || !plainId(h.id)) return null;
  return {
    id: h.id, agentId: idOrNull(h.agentId) ?? '', agentName: nameOrNull(h.agentName) ?? 'Agent', app: nameOrNull(h.app),
    fromAgentId: idOrNull(h.fromAgentId), fromAgentName: nameOrNull(h.fromAgentName), at: when(h.at),
    done: lines(h.done), left: lines(h.left), next: lines(h.next), blockers: lines(h.blockers, MAX_BLOCKERS), files: lines(h.files, 40), questions: lines(h.questions),
    cardId: idOrNull(h.cardId), taskNo: taskNo(h.taskNo), conversationId: idOrNull(h.conversationId), conversationTitle: nameOrNull(h.conversationTitle),
  };
}

/** GET …/cards/:cardId/links: the task's number, its notes place, handoffs (newest first), chats and task file. */
export function taskLinksResponse(body) {
  if (!record(body) || !Array.isArray(body.handoffs)) fail();
  const np = record(body.notesPlace) && typeof body.notesPlace.place === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,160}$/.test(body.notesPlace.place)
    ? { place: body.notesPlace.place, count: Number.isSafeInteger(body.notesPlace.count) && body.notesPlace.count >= 0 ? body.notesPlace.count : 0 } : null;
  const tf = record(body.taskFile) ? { path: body.taskFile.path === DONE_FILE ? DONE_FILE : TASK_FILE, line: Number.isSafeInteger(body.taskFile.line) && body.taskFile.line > 0 ? body.taskFile.line : null } : null;
  return {
    taskNo: taskNo(body.taskNo), notesPlace: np,
    handoffs: body.handoffs.slice(0, 50).map(handoffOf).filter(Boolean),
    chats: Array.isArray(body.chats) ? body.chats.slice(0, 50).filter(c => record(c) && plainId(c.id)).map(c => ({ id: c.id, title: clip(c.title, 200), at: when(c.at) })) : [],
    taskFile: tf, blocked: body.blocked === true,
  };
}

const CODES = ['not_found', 'invalid_request', 'invalid_handoff', 'forbidden'];

export function taskLinksPathResponse(path, status, body) {
  const p = taskLinksPathOf(path);
  if (!p) fail();
  if (status !== 200) return { code: record(body) && CODES.includes(body.code) ? body.code : status === 404 ? 'not_found' : 'unavailable' };
  if (!record(body)) fail();
  if (p.route === 'handoff') return { handoff: handoffOf(body.handoff) ?? fail() };
  return {
    notes: Array.isArray(body.notes) ? body.notes.slice(0, 500).filter(n => record(n) && Number.isSafeInteger(n.seq) && typeof n.text === 'string').map(n => ({ seq: n.seq, text: clip(n.text, 2000), at: when(n.at) })) : [],
    clearsAt: when(body.clearsAt) || null,
  };
}
