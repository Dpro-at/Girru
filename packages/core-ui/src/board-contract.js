// BOARD-01 wire contract: the company task board. Shared by the browser
// boundary and the local bridge: a strict allow-list of requests and a
// projection of every response to the reviewed fields (never error text).
import { validAgentId } from './agent-id.js';
import { department } from './hire-contract.js';

export const BOARDS_PATH = '/api/boards';
export const priorities = ['low', 'normal', 'high', 'urgent'];
export const boardColors = ['blue', 'green', 'orange', 'red', 'purple', 'pink', 'teal', 'gray'];
export const cardTypes = ['task', 'idea', 'bug', 'milestone', 'request'];
const kinds = ['company', 'department', 'shared'];
const templateId = x => typeof x === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(x);
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 5000;
export const MAX_COMMENT = 4000;
const MAX_CARDS = 5000;
/** TASKLOG-01: start a chat that continues a card's task from its project's task file. */
export const TASK_CONTINUE_PATH = '/api/chat/task-continue';

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (x, keys) => Object.keys(x).every(k => keys.includes(k));
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x);
const version = x => Number.isSafeInteger(x) && x > 0;
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/u;
const textOk = (x, max, required) => typeof x === 'string' && x.length <= max * 2 && [...x].length <= max && !badChars.test(x) && (!required || x.trim().length > 0);
const lineOk = (x, max) => textOk(x, max, true) && !/\n/.test(x);
const date = x => x === null || (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x));
const agents = x => Array.isArray(x) && x.length <= 50 && x.every(validAgentId) && new Set(x).size === x.length;
const departments = x => Array.isArray(x) && x.length <= 12 && x.every(department) && new Set(x).size === x.length;
const labelIds = x => Array.isArray(x) && x.length <= 10 && x.every(id) && new Set(x).size === x.length;
const coverOk = x => x === null || boardColors.includes(x);

/** The board path this request names, or null. */
export function boardPath(path) {
  if(path===BOARDS_PATH+'/sync-departments')return {kind:'sync',board:''};
  const overview=/^\/api\/boards\/([^/?#]+)\/overview$/.exec(path);if(overview)return id(overview[1])?{kind:'overview',board:overview[1]}:null;
  let m = /^\/api\/boards\/([^/?#]+)$/.exec(path);
  if (m) return id(m[1]) ? { kind: 'board', board: m[1] } : null;
  m = /^\/api\/boards\/([^/?#]+)\?archived=1$/.exec(path);
  if (m) return id(m[1]) ? { kind: 'board-archived', board: m[1] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/columns$/.exec(path);
  if (m) return id(m[1]) ? { kind: 'columns', board: m[1] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/columns\/([^/?#]+)$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: 'column', board: m[1], column: m[2] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards$/.exec(path);
  if (m) return id(m[1]) ? { kind: 'cards', board: m[1] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards\/([^/?#]+)$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: 'card', board: m[1], card: m[2] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards\/([^/?#]+)\/comments$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: 'comments', board: m[1], card: m[2] } : null;
  // TASKPAGE-02: the full task page.
  m = /^\/api\/boards\/([^/?#]+)\/cards\/([^/?#]+)\/(page|people|release|subtasks|links|follow|schedule)$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: `tp-${m[3]}`, board: m[1], card: m[2] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards\/([^/?#]+)\/activity(?:\?before=(\d{4}-\d{2}-\d{2}T[\d:.]+Z))?$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: 'tp-activity', board: m[1], card: m[2] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards\/([^/?#]+)\/activity\/([^/?#]+)\/diff$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) && id(m[3]) ? { kind: 'tp-diff', board: m[1], card: m[2], message: m[3] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards\/([^/?#]+)\/task-sort$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: 'task-sort', board: m[1], card: m[2] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards\/([^/?#]+)\/task$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: 'task', board: m[1], card: m[2] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/labels$/.exec(path);
  if (m) return id(m[1]) ? { kind: 'labels', board: m[1] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/labels\/([^/?#]+)$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: 'label', board: m[1], label: m[2] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards\/([^/?#]+)\/checklist$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: 'checklist', board: m[1], card: m[2] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards\/([^/?#]+)\/checklist\/([^/?#]+)$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) && id(m[3]) ? { kind: 'check', board: m[1], card: m[2], item: m[3] } : null;
  return null;
}

export function validNewCard(b) {
  if (!record(b) || !onlyKeys(b, ['columnId', 'title', 'description', 'priority', 'dueDate', 'agents', 'departments', 'type', 'startDate', 'cover', 'labels']) || !id(b.columnId) || !lineOk(b.title, MAX_TITLE)) return false;
  if (b.type !== undefined && !cardTypes.includes(b.type)) return false;
  if (b.startDate !== undefined && !date(b.startDate)) return false;
  if (b.cover !== undefined && !coverOk(b.cover)) return false;
  if (b.labels !== undefined && !labelIds(b.labels)) return false;
  if (b.description !== undefined && !textOk(b.description, MAX_DESCRIPTION, false)) return false;
  if (b.priority !== undefined && !priorities.includes(b.priority)) return false;
  if (b.dueDate !== undefined && !date(b.dueDate)) return false;
  if (b.agents !== undefined && !agents(b.agents)) return false;
  return b.departments === undefined || departments(b.departments);
}

export function validCardEdit(b) {
  if (!record(b) || !onlyKeys(b, ['expectedVersion', 'title', 'description', 'priority', 'dueDate', 'agents', 'departments', 'columnId', 'beforeCardId', 'archived', 'type', 'startDate', 'cover', 'labels']) || !version(b.expectedVersion)) return false;
  if (b.type !== undefined && !cardTypes.includes(b.type)) return false;
  if (b.startDate !== undefined && !date(b.startDate)) return false;
  if (b.cover !== undefined && !coverOk(b.cover)) return false;
  if (b.labels !== undefined && !labelIds(b.labels)) return false;
  if (Object.keys(b).length < 2) return false;
  if (b.title !== undefined && !lineOk(b.title, MAX_TITLE)) return false;
  if (b.description !== undefined && !textOk(b.description, MAX_DESCRIPTION, false)) return false;
  if (b.priority !== undefined && !priorities.includes(b.priority)) return false;
  if (b.dueDate !== undefined && !date(b.dueDate)) return false;
  if (b.agents !== undefined && !agents(b.agents)) return false;
  if (b.departments !== undefined && !departments(b.departments)) return false;
  if (b.columnId !== undefined && !id(b.columnId)) return false;
  if (b.beforeCardId !== undefined && b.beforeCardId !== null && !id(b.beforeCardId)) return false;
  if (b.beforeCardId !== undefined && b.columnId === undefined) return false;
  return b.archived === undefined || typeof b.archived === 'boolean';
}

const nameBody = b => record(b) && Object.keys(b).length === 1 && lineOk(b.name, 60);

export function validNewBoard(b) {
  if (!record(b) || !onlyKeys(b, ['name', 'description', 'template', 'color', 'departments']) || !lineOk(b.name, 80)) return false;
  if (b.description !== undefined && !textOk(b.description, 500, false)) return false;
  if (b.template !== undefined && !templateId(b.template)) return false;
  if (b.color !== undefined && !boardColors.includes(b.color)) return false;
  return b.departments === undefined || departments(b.departments);
}

export function validBoardEdit(b) {
  if (!record(b) || !onlyKeys(b, ['expectedVersion', 'name', 'description', 'color', 'departments', 'archived']) || !version(b.expectedVersion) || Object.keys(b).length < 2) return false;
  if (b.name !== undefined && !lineOk(b.name, 80)) return false;
  if (b.description !== undefined && !textOk(b.description, 500, false)) return false;
  if (b.color !== undefined && !boardColors.includes(b.color)) return false;
  if (b.departments !== undefined && !departments(b.departments)) return false;
  return b.archived === undefined || typeof b.archived === 'boolean';
}

/** TASKPAGE-02: what a person or an agent does on a task. */
export const ROLES = ['asked', 'does', 'checks', 'tests'];
const personId = x => typeof x === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(x);
const ownerOk = o => record(o) && Object.keys(o).length === 2 && ['user', 'agent'].includes(o.kind) && personId(o.id);
/** TASKPAGE-03: how a task repeats ({ every: 'never' } takes it away). */
export const EVERY = ['hourly', 'daily', 'weekly'];
function scheduleOk(b) {
  if (!record(b)) return false;
  if (b.every === 'never') return Object.keys(b).length === 1;
  return onlyKeys(b, ['every', 'at', 'weekday', 'agentId', 'model', 'paused', 'notify', 'newChat', 'thinking']) && EVERY.includes(b.every) && typeof b.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.at)
    && (b.every !== 'weekly' ? b.weekday === undefined || b.weekday === null : Number.isInteger(b.weekday) && b.weekday >= 0 && b.weekday <= 6)
    && (b.agentId === undefined || b.agentId === null || validAgentId(b.agentId)) && (b.model === undefined || modelOk(b.model)) && (b.paused === undefined || typeof b.paused === 'boolean')
    && (b.notify === undefined || ['important', 'all', 'none'].includes(b.notify)) && (b.newChat === undefined || typeof b.newChat === 'boolean') && (b.thinking === undefined || b.thinking === null || ['quick', 'normal', 'deep'].includes(b.thinking));
}
function repeat(r) {
  if (!record(r) || !EVERY.includes(r.every) || typeof r.at !== 'string' || !/^\d\d:\d\d$/.test(r.at)) return null;
  return { every: r.every, at: r.at, weekday: Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday <= 6 ? r.weekday : null, nextRun: typeof r.nextRun === 'string' ? r.nextRun.slice(0, 40) : '', paused: r.paused === true,
    ...(r.lastRun !== undefined ? { lastRun: typeof r.lastRun === 'string' ? r.lastRun.slice(0, 40) : null } : {}), ...(r.agentId !== undefined ? { agentId: validAgentId(r.agentId) ? r.agentId : null } : {}), ...(r.model !== undefined ? { model: modelOk(r.model) ? r.model : '' } : {}),
    lastResult: ['started', 'busy', 'failed'].includes(r.lastResult) ? r.lastResult : null,
    ...(['important', 'all', 'none'].includes(r.notify) ? { notify: r.notify } : {}), ...(typeof r.newChat === 'boolean' ? { newChat: r.newChat } : {}), ...(['quick', 'normal', 'deep'].includes(r.thinking) ? { thinking: r.thinking } : {}) };
}
const modelOk = x => typeof x === 'string' && (x === '' || /^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,99}$/.test(x));
export function allowedBoard(method, path, body) {
  if (path === TASK_CONTINUE_PATH) return method === 'POST' && record(body) && onlyKeys(body, ['boardId', 'cardId', 'agentId', 'model']) && id(body.boardId) && id(body.cardId)
    && (body.agentId === undefined || validAgentId(body.agentId)) && (body.model === undefined || modelOk(body.model));
  if (path === BOARDS_PATH) return (method === 'GET' && body === undefined) || (method === 'POST' && validNewBoard(body));
  if (path === `${BOARDS_PATH}?archived=1`) return method === 'GET' && body === undefined;
  const p = boardPath(path);
  if (!p) return false;
  if(p.kind==='sync')return method==='POST'&&record(body)&&Object.keys(body).length===0;
  if(p.kind==='overview')return method==='GET'&&body===undefined;
  if (p.kind === 'board') return (method === 'GET' && body === undefined) || (method === 'PUT' && validBoardEdit(body));
  if (p.kind === 'board-archived') return method === 'GET' && body === undefined;
  if (p.kind === 'columns') return method === 'POST' && nameBody(body);
  if (p.kind === 'column') return method === 'PUT' && nameBody(body);
  if (p.kind === 'cards') return method === 'POST' && validNewCard(body);
  if (p.kind === 'card') return method === 'PUT' && validCardEdit(body);
  if (p.kind === 'labels') return method === 'POST' && record(body) && onlyKeys(body, ['name', 'color']) && lineOk(body.name, 40) && boardColors.includes(body.color);
  if (p.kind === 'label') return method === 'PUT' && record(body) && Object.keys(body).length >= 1 && onlyKeys(body, ['name', 'color']) && (body.name === undefined || lineOk(body.name, 40)) && (body.color === undefined || boardColors.includes(body.color));
  if (p.kind === 'checklist') return (method === 'GET' && body === undefined) || (method === 'POST' && record(body) && Object.keys(body).length === 1 && lineOk(body.text, 300));
  if (p.kind === 'check') return method === 'PUT' && record(body) && Object.keys(body).length >= 1 && onlyKeys(body, ['text', 'done', 'remove', 'owner', 'dueDate', 'beforeItemId'])
    && (body.text === undefined || lineOk(body.text, 300)) && (body.done === undefined || typeof body.done === 'boolean') && (body.remove === undefined || body.remove === true)
    && (body.owner === undefined || body.owner === null || ownerOk(body.owner)) && (body.dueDate === undefined || date(body.dueDate)) && (body.beforeItemId === undefined || body.beforeItemId === null || id(body.beforeItemId));
  if (p.kind === 'tp-page' || p.kind === 'tp-activity' || p.kind === 'tp-diff') return method === 'GET' && body === undefined;
  if (p.kind === 'tp-people') return method === 'PUT' && record(body) && onlyKeys(body, ['kind', 'id', 'role']) && Object.keys(body).length === 3 && ['user', 'agent'].includes(body.kind) && personId(body.id) && (body.role === null || ROLES.includes(body.role));
  if (p.kind === 'tp-release') return method === 'PUT' && record(body) && Object.keys(body).length === 1 && (body.name === null || lineOk(body.name, 60));
  if (p.kind === 'tp-subtasks') return method === 'POST' && record(body) && Object.keys(body).length === 1 && lineOk(body.title, MAX_TITLE);
  if (p.kind === 'tp-links') return method === 'PUT' && record(body) && Object.keys(body).length === 2 && id(body.waitsFor) && typeof body.on === 'boolean';
  if (p.kind === 'tp-follow') return method === 'PUT' && record(body) && Object.keys(body).length === 1 && typeof body.on === 'boolean';
  if (p.kind === 'tp-schedule') return (method === 'GET' && body === undefined) || (method === 'PUT' && scheduleOk(body));
  if (p.kind === 'task') return method === 'GET' && body === undefined;
  if (p.kind === 'task-sort') return method === 'POST' && record(body) && Object.keys(body).length === 1 && department(body.department);
  if (p.kind === 'comments') return (method === 'GET' && body === undefined) || (method === 'POST' && record(body) && Object.keys(body).length === 1 && textOk(body.body, MAX_COMMENT, true));
  return false;
}

export function boardRoute(path) {
  return path === BOARDS_PATH || path === `${BOARDS_PATH}?archived=1` || path === TASK_CONTINUE_PATH || boardPath(path) !== null;
}

const fail = () => { throw Error('Invalid board response'); };
const clip = (x, max) => (typeof x === 'string' ? (x.length > max ? x.slice(0, max) : x) : '');
const when = x => {if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(x))return '';const iso=x.replace(' ','T')+(/(Z|[+-]\d{2}:\d{2})$/.test(x)?'':'Z');const value=new Date(iso);return Number.isNaN(value.getTime())?'':value.toISOString();};

const taskNo = x => typeof x === 'string' && /^T-\d{1,6}$/.test(x);
const appNames = x => (Array.isArray(x) ? [...new Set(x.filter(a => typeof a === 'string' && a.trim()).map(a => clip(a.trim(), 40)))].slice(0, 10) : []);
/** TASKLOG-01: where a card's task lives (its number in a project's task file). */
function taskMark(t) {
  if (!record(t) || !taskNo(t.no) || !id(t.projectId)) return null;
  return { no: t.no, projectId: t.projectId, projectName: clip(t.projectName, 120), problem: typeof t.problem === 'string' && t.problem ? clip(t.problem, 300) : null, apps: appNames(t.apps), finished: t.finished === true };
}
const lines = x => (Array.isArray(x) ? x.filter(l => typeof l === 'string').slice(0, 30).map(l => clip(l, 300)) : []);
function taskDetail(t) {
  if (t === null) return null;
  const m = taskMark(t);
  if (!m || !record(t.task)) fail();
  const k = t.task;
  return {
    ...m, file: t.file === '.girru/tasks-done.md' ? '.girru/tasks-done.md' : '.girru/tasks.md', text: clip(t.text, 20000),
    task: { no: m.no, title: clip(k.title, MAX_TITLE), state: clip(k.state, 40), department: clip(k.department, 120), agent: clip(k.agent, 120), priority: clip(k.priority, 40), done: lines(k.done), left: lines(k.left), next: lines(k.next) },
    workedOn: Array.isArray(t.workedOn) ? t.workedOn.filter(w => record(w) && typeof w.app === 'string').slice(0, 10).map(w => ({ app: clip(w.app, 40), agent: clip(w.agent, 120), date: /^\d{4}-\d{2}-\d{2}$/.test(w.date) ? w.date : '', at: typeof w.at === 'string' ? clip(w.at, 20) : null, what: typeof w.what === 'string' ? clip(w.what, 300) : null })) : [],
    log: Array.isArray(t.log) ? t.log.filter(l => record(l) && typeof l.app === 'string').slice(0, 5).map(l => ({ at: clip(l.at, 20), app: clip(l.app, 40), what: clip(l.what, 300) })) : [],
  };
}

function card(c) {
  if (!record(c) || !id(c.id) || !id(c.columnId) || typeof c.title !== 'string' || !priorities.includes(c.priority) || !version(c.version)
    || !Number.isSafeInteger(c.position) || !Array.isArray(c.agents) || !Array.isArray(c.departments)) fail();
  return {
    id: c.id, columnId: c.columnId, title: clip(c.title, MAX_TITLE * 2), description: clip(c.description, MAX_DESCRIPTION * 2), priority: c.priority,
    position: c.position, dueDate: date(c.dueDate) && c.dueDate ? c.dueDate : null, archived: c.archived === true, version: c.version,
    agents: c.agents.filter(validAgentId).slice(0, 50), departments: c.departments.filter(department).slice(0, 12),
    comments: Number.isSafeInteger(c.comments) && c.comments >= 0 ? c.comments : 0, updatedAt: when(c.updatedAt),
    type: cardTypes.includes(c.type) ? c.type : 'task', startDate: date(c.startDate) && c.startDate ? c.startDate : null, cover: boardColors.includes(c.cover) ? c.cover : null,
    labels: Array.isArray(c.labels) ? c.labels.filter(id).slice(0, 10) : [],
    checklist: record(c.checklist) && Number.isSafeInteger(c.checklist.done) && Number.isSafeInteger(c.checklist.total) && c.checklist.done >= 0 && c.checklist.done <= c.checklist.total ? { done: c.checklist.done, total: c.checklist.total } : { done: 0, total: 0 },

    conversationId: typeof c.conversationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(c.conversationId) ? c.conversationId : null,
    taskFile: taskMark(c.taskFile),
    repeat: repeat(c.repeat),
  };
}

function meta(b) {
  if (!record(b) || !id(b.id)) fail();
  return {
    id: b.id, name: clip(b.name, 80), description: clip(b.description, 500), template: templateId(b.template) ? b.template : 'custom',
    color: boardColors.includes(b.color) ? b.color : 'blue', departments: Array.isArray(b.departments) ? b.departments.filter(department).slice(0, 12) : [],
    kind: kinds.includes(b.kind) ? b.kind : 'company', managedDepartment:b.managedDepartment===true,departmentActive:b.departmentActive!==false, archived: b.archived === true, version: version(b.version) ? b.version : 1,
  };
}

function board(b) {
  if (!record(b) || !id(b.id) || !Array.isArray(b.columns) || b.columns.length > 20 || !Array.isArray(b.cards) || b.cards.length > MAX_CARDS) fail();
  return {
    ...meta(b),
    columns: b.columns.map(c => { if (!record(c) || !id(c.id) || !Number.isSafeInteger(c.position)) fail(); return { id: c.id, name: clip(c.name, 60), position: c.position }; }),
    cards: b.cards.map(card),
    labels: Array.isArray(b.labels) ? b.labels.filter(l => record(l) && id(l.id) && boardColors.includes(l.color)).slice(0, 30).map(l => ({ id: l.id, name: clip(l.name, 40), color: l.color })) : [],
  };
}

function comment(c) {
  if (!record(c) || !id(c.id) || !['user', 'agent'].includes(c.authorKind) || typeof c.body !== 'string') fail();
  return { id: c.id, authorKind: c.authorKind, authorId: clip(c.authorId, 128), body: clip(c.body, MAX_COMMENT * 2), createdAt: when(c.createdAt) };
}

const codes = ['invalid_board', 'invalid_version', 'not_found', 'version_conflict', 'read_only_stage'];
function error(status, body) {
  const code = record(body) ? body.code : undefined;
  if (!codes.includes(code)) return null;
  if (code === 'version_conflict' && record(body.card)) return { code, card: card(body.card) };
  if (code === 'version_conflict' && record(body.board)) return { code, board: meta(body.board) };
  return { code };
}

const continueCodes = ['not_found', 'conversation_busy', 'rate_limited', 'no_folder', 'forbidden'];
export function boardResponse(path, status, body) {
  if (path === TASK_CONTINUE_PATH) {
    const conversation = record(body) && record(body.conversation) && typeof body.conversation.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(body.conversation.id) ? { id: body.conversation.id } : null;
    if (status === 201) { if (!conversation) fail(); return { conversation }; }
    return { code: record(body) && continueCodes.includes(body.code) ? body.code : status === 404 ? 'not_found' : 'not_started', conversation };
  }
  if (status !== 200 && status !== 201) return error(status, body);
  if (path === BOARDS_PATH || path === `${BOARDS_PATH}?archived=1`) {
    if (status === 201) return board(body);
    if (!record(body) || !Array.isArray(body.boards) || body.boards.length > 200) fail();
    const count = x => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
    return {
      boards: body.boards.map(b => ({ ...meta(b), cards: count(b.cards), open: count(b.open), toSort: count(b.toSort) })),
      templates: Array.isArray(body.templates) ? body.templates.filter(t => record(t) && templateId(t.id) && Array.isArray(t.columns)).slice(0, 30)
        .map(t => ({ id: t.id, name: clip(t.name, 60), description: clip(t.description, 200), columns: t.columns.filter(c => typeof c === 'string').slice(0, 20).map(c => clip(c, 60)) })) : [],
      colors: Array.isArray(body.colors) ? body.colors.filter(c => boardColors.includes(c)) : [],
    };
  }
  const p = boardPath(path);
  if (!p) fail();
  if(p.kind==='sync'){if(!record(body)||!Number.isSafeInteger(body.created)||body.created<0||body.created>200||!Number.isSafeInteger(body.departments)||body.departments<0||body.departments>200)fail();return {created:body.created,departments:body.departments};}
  if(p.kind==='overview'){
    if(!record(body)||!Array.isArray(body.tasks)||body.tasks.length>500||!Number.isSafeInteger(body.total)||body.total<body.tasks.length||body.limited!==(body.total>body.tasks.length))fail();
    const tasks=body.tasks.map(t=>{if(!record(t)||!id(t.cardId)||!id(t.boardId)||typeof t.title!=='string'||!priorities.includes(t.priority)||!date(t.dueDate))fail();return {cardId:t.cardId,boardId:t.boardId,boardName:clip(t.boardName,80),title:clip(t.title,200),status:clip(t.status,60),priority:t.priority,dueDate:t.dueDate};});
    if(new Set(tasks.map(t=>t.cardId)).size!==tasks.length)fail();return {tasks,total:body.total,limited:body.limited};
  }
  if (p.kind === 'card' || p.kind === 'cards') return card(body);
  if (p.kind === 'task') { if (!record(body) || !('task' in body)) fail(); return { task: taskDetail(body.task) }; }
  if (p.kind === 'task-sort') { if (!record(body) || !id(body.boardId)) fail(); return { boardId: body.boardId }; }
  if (p.kind.startsWith('tp-')) return taskPageResponse(p.kind, body);
  if (p.kind === 'checklist' || p.kind === 'check') {
    if (!record(body) || !Array.isArray(body.items) || body.items.length > 50) fail();
    return { items: body.items.map(i => { if (!record(i) || !id(i.id) || typeof i.done !== 'boolean') fail(); return { id: i.id, text: clip(i.text, 300), done: i.done, owner: ownerOk(i.owner) ? { kind: i.owner.kind, id: i.owner.id } : null, dueDate: date(i.dueDate) && i.dueDate ? i.dueDate : null }; }) };
  }
  if (p.kind === 'comments') {
    if (!record(body) || !Array.isArray(body.comments) || body.comments.length > 500) fail();
    return { comments: body.comments.map(comment) };
  }
  return board(body);
}

// ---- TASKPAGE-02: the full task page ----
const num = x => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
const iso = x => (typeof x === 'string' && x.length <= 40 ? x : '');
const cardRef = r => (record(r) && id(r.id) && id(r.boardId) ? { id: r.id, boardId: r.boardId, title: clip(r.title, MAX_TITLE), done: r.done === true } : null);
const refs = x => (Array.isArray(x) ? x.slice(0, 100).map(cardRef).filter(Boolean) : []);
const actor = a => (record(a) && ['user', 'agent'].includes(a.kind) && typeof a.id === 'string' ? { kind: a.kind, id: clip(a.id, 128), name: clip(a.name, 120) } : { kind: 'user', id: '', name: '' });
const chatRef = c => (record(c) && typeof c.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(c.id) ? { id: c.id, title: typeof c.title === 'string' ? clip(c.title, 120) : null } : null);
function people(x) { return Array.isArray(x) ? x.slice(0, 100).filter(p => record(p) && ['user', 'agent'].includes(p.kind) && personId(p.id)).map(p => ({ kind: p.kind, id: p.id, name: clip(p.name, 120), role: ROLES.includes(p.role) ? p.role : 'does' })) : []; }
function page(p) {
  if (!record(p)) fail();
  const dev = record(p.development) ? { branch: typeof p.development.branch === 'string' ? clip(p.development.branch, 200) : null,
    pr: record(p.development.pr) && Number.isSafeInteger(p.development.pr.number) ? { number: p.development.pr.number, title: clip(p.development.pr.title, 200), state: ['open', 'merged', 'closed', 'draft'].includes(p.development.pr.state) ? p.development.pr.state : 'open',
      url: typeof p.development.pr.url === 'string' && /^https:\/\/github\.com\//.test(p.development.pr.url) ? clip(p.development.pr.url, 300) : '', checks: ['passing', 'pending', 'failing'].includes(p.development.pr.checks) ? p.development.pr.checks : null } : null } : null;
  return {
    openedBy: actor(p.openedBy), openedAt: iso(p.openedAt), people: people(p.people),
    team: Array.isArray(p.team) ? p.team.slice(0, 200).filter(u => record(u) && personId(u.id)).map(u => ({ id: u.id, name: clip(u.name, 120) })) : [],
    parent: cardRef(p.parent), subtasks: refs(p.subtasks), waitsFor: refs(p.waitsFor), blocks: refs(p.blocks),
    release: typeof p.release === 'string' ? clip(p.release, 60) : null, following: p.following === true, followers: num(p.followers),
    chats: Array.isArray(p.chats) ? p.chats.slice(0, 50).map(chatRef).filter(Boolean) : [],
    spent: Array.isArray(p.spent) ? p.spent.slice(0, 20).filter(s => record(s) && typeof s.model === 'string').map(s => ({ app: clip(s.app, 60), model: clip(s.model, 120), paid: s.paid === true, tokens: num(s.tokens), replies: num(s.replies) })) : [],
    files: record(p.files) ? { count: num(p.files.count), added: num(p.files.added), removed: num(p.files.removed), paths: Array.isArray(p.files.paths) ? p.files.paths.filter(x => typeof x === 'string').slice(0, 30).map(x => clip(x, 300)) : [] } : { count: 0, added: 0, removed: 0, paths: [] },
    development: dev,
  };
}
function item(x) {
  if (!record(x) || typeof x.id !== 'string' || !['event', 'comment', 'reply', 'log'].includes(x.kind)) return null;
  const base = { id: clip(x.id, 200), kind: x.kind, at: iso(x.at) };
  if (x.kind === 'event') return { ...base, actor: actor(x.actor), event: clip(x.event, 40), detail: clip(x.detail, 200) };
  if (x.kind === 'comment') return { ...base, actor: actor(x.actor), text: clip(x.text, MAX_COMMENT * 2) };
  if (x.kind === 'log') return { ...base, app: clip(x.app, 40), text: clip(x.text, 300) };
  const chat = chatRef(x.chat);
  if (!chat) return null;
  const ch = record(x.change) && typeof x.change.messageId === 'string' && id(x.change.messageId) ? { messageId: x.change.messageId, files: num(x.change.files), added: num(x.change.added), removed: num(x.change.removed), undone: x.change.undone === true } : null;
  return { ...base, actor: actor(x.actor), app: clip(x.app, 60), model: clip(x.model, 120), chat, text: clip(x.text, 1400), more: x.more === true, tokens: num(x.tokens), change: ch };
}
function taskPageResponse(kind, body) {
  if (!record(body)) fail();
  if (kind === 'tp-page') return { page: page(body.page) };
  if (kind === 'tp-activity') return { items: Array.isArray(body.items) ? body.items.slice(0, 300).map(item).filter(Boolean) : [], more: body.more === true };
  if (kind === 'tp-diff') return { files: Array.isArray(body.files) ? body.files.slice(0, 20).filter(f => record(f) && typeof f.path === 'string').map(f => ({ path: clip(f.path, 300), status: ['A', 'D', 'M'].includes(f.status) ? f.status : 'M', added: num(f.added), removed: num(f.removed), lines: Array.isArray(f.lines) ? f.lines.filter(l => typeof l === 'string').slice(0, 200).map(l => clip(l, 300)) : [], more: f.more === true })) : [] };
  if (kind === 'tp-people') return { people: people(body.people) };
  if (kind === 'tp-release') return { release: typeof body.release === 'string' ? clip(body.release, 60) : null };
  if (kind === 'tp-subtasks') return card(body);
  if (kind === 'tp-links') return { ok: body.ok === true };
  if (kind === 'tp-follow') return { following: body.following === true };
  if (kind === 'tp-schedule') return { schedule: repeat(body.schedule) };
  fail();
}
