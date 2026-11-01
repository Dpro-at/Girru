import { approvalPath, allowedApproval, approvalResponse } from './recovery-approvals-contract.js';
// CHAT-REBUILD-01 wire contract: saved conversations and resumable chat runs.
// Shared by the browser boundary and the local bridge: a strict allow-list of
// requests, a projection of every response to the reviewed fields (never error
// text), and the parser for a run's numbered event stream.

export const CONVERSATIONS_PATH = '/api/chat/conversations';
export const PROJECTS_PATH = '/api/chat/projects';
const folderOk = x => typeof x === 'string' && x.length <= 1024 && !/[\u0000-\u001F]/.test(x);
/** CHAT-BUILD-01 stage 3 (CH5): a project's added folders, read only unless write. */
const foldersOk = x => Array.isArray(x) && x.length <= 8 && x.every(f => record(f) && onlyKeys(f, ['path', 'write']) && folderOk(f.path) && f.path.length > 0 && (f.write === undefined || typeof f.write === 'boolean'));
export const CHAT_MODES = ['auto', 'ask', 'accept_edits', 'plan'];
export const CHAT_THINKING = ['quick', 'normal', 'deep'];
const queueOk = x => Array.isArray(x) && x.length <= 20 && x.every(q => record(q) && onlyKeys(q, ['key', 'text']) && typeof q.key === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(q.key) && text(q.text, MAX_MESSAGE) && q.text.trim().length > 0);
const repoOk = x => typeof x === 'string' && x.length <= 300 && (x === '' || /^(https:\/\/|git@)[A-Za-z0-9.@:/_~%+-]{3,300}$/.test(x));
export const MAX_MESSAGE = 100000;
/** CHAT-BUILD-01: request bytes for one message (100,000 Arabic characters are about 200 KB of UTF-8). */
export const MAX_MESSAGE_BYTES = 480 * 1024;
export const MAX_TITLE = 120;
/** One reader connection lasts at most this long; the client re-attaches with after=<seq>. */
export const RUN_STREAM_MS = 5 * 60 * 1000;
/** No byte (event or heartbeat) for this long ends a reader connection. */
export const RUN_IDLE_MS = 45 * 1000;
/** One SSE frame of a run (tool output is cut to 6,000 characters by the server). */
export const RUN_FRAME_BYTES = 128 * 1024;

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (x, keys) => Object.keys(x).every(k => keys.includes(k));
const uuid = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(x);
export const validRunId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(x);
const agentId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(x) && !x.includes('..');
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const text = (x, max) => typeof x === 'string' && x.length <= max && !badChars.test(x);
const title = x => typeof x === 'string' && x.length <= MAX_TITLE && !/[\u0000-\u001F\u007F]/.test(x);
const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '');
const num = x => (Number.isFinite(x) && x >= 0 ? Math.round(x) : undefined);

/** The conversation path this request names, or null. */
/** The chat microphone: a recorded clip (base64) → text, transcribed on this computer. */
export const TRANSCRIBE_PATH = '/api/chat/transcribe';
/** Base64 characters for the largest clip the backend takes (6 MB of audio). */
export const MAX_AUDIO_CHARS = Math.ceil((6 * 1024 * 1024) / 3) * 4;
/** CHAT-GAPS-01: one image (base64) up to 5 MB, up to 4 per message. */
export const MAX_IMAGE_CHARS = Math.ceil((5 * 1024 * 1024) / 3) * 4;
export const MAX_IMAGES = 4;
const IMAGE_ID = /^[a-f0-9]{32}$/;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const STT_LANGUAGES = ['auto', 'ar', 'en', 'de'];

/** CHAT-BUILD-01 stage 2 (CH9): the chat sidebar's sections, order and folded projects, per person. */
export const SIDEBAR_PATH = '/api/chat/sidebar';
const PANEL_PARTS = ['place', 'team', 'results', 'memory', 'mcp'];
const DIFF_VIEWS = ['unified', 'split'];
const partList = x => Array.isArray(x) && x.length <= PANEL_PARTS.length && x.every(p => PANEL_PARTS.includes(p)) && new Set(x).size === x.length;
const scheduleOk = x => record(x) && onlyKeys(x, ['every', 'at', 'weekday', 'message', 'paused']) && ['hourly', 'daily', 'weekly'].includes(x.every) && typeof x.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x.at)
  && (x.weekday === undefined || x.weekday === null || (Number.isInteger(x.weekday) && x.weekday >= 0 && x.weekday <= 6)) && text(x.message, 4000) && x.message.trim().length > 0 && (x.paused === undefined || typeof x.paused === 'boolean');
const scheduleView = x => (record(x) && ['hourly', 'daily', 'weekly'].includes(x.every) ? { every: x.every, at: str(x.at, 5), weekday: Number.isInteger(x.weekday) ? x.weekday : null, message: str(x.message, 4000), paused: x.paused === true, nextRun: str(x.nextRun, 40), lastRun: typeof x.lastRun === 'string' ? x.lastRun.slice(0, 40) : null } : null);
const SIDEBAR_SECTIONS = ['scheduled', 'running', 'pinned', 'projects', 'other', 'archived'];
const sectionList = x => Array.isArray(x) && x.length <= SIDEBAR_SECTIONS.length && x.every(s => SIDEBAR_SECTIONS.includes(s)) && new Set(x).size === x.length;
const folderList = x => Array.isArray(x) && x.length <= 200 && x.every(f => typeof f === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(f));

export function conversationPath(path) {
  if (approvalPath(path)) return { kind: 'approval' };
  if (path === CONVERSATIONS_PATH) return { kind: 'list' };
  if (path === TRANSCRIBE_PATH) return { kind: 'transcribe' };
  if (path === '/api/chat/project-folders') return { kind: 'folder-picker' };
  if (path === SIDEBAR_PATH) return { kind: 'sidebar' };
  if (path === '/api/chat/panel') return { kind: 'panel' };
  if (path === '/api/chat/last') return { kind: 'last' };
  if (path === '/api/chat/settings') return { kind: 'chat-settings' };
  if (path === PROJECTS_PATH) return { kind: 'projects' };
  let pm = /^\/api\/chat\/projects\/([^/?#]+)$/.exec(path);
  if (pm) return uuid(pm[1]) ? { kind: 'project', id: pm[1] } : null;
  pm = /^\/api\/chat\/projects\/([^/?#]+)\/variables$/.exec(path);
  if (pm) return uuid(pm[1]) ? { kind: 'variables', id: pm[1] } : null;
  pm = /^\/api\/chat\/projects\/([^/?#]+)\/variables\/([A-Z_][A-Z0-9_]{0,63})$/.exec(path);
  if (pm) return uuid(pm[1]) ? { kind: 'variable', id: pm[1], name: pm[2] } : null;
  pm = /^\/api\/chat\/projects\/([^/?#]+)\/pr$/.exec(path);
  if (pm) return uuid(pm[1]) ? { kind: 'project-pr', id: pm[1] } : null;
  pm = /^\/api\/chat\/projects\/([^/?#]+)\/git$/.exec(path);
  if (pm) return uuid(pm[1]) ? { kind: 'project-git', id: pm[1] } : null;
  pm = /^\/api\/chat\/projects\/([^/?#]+)\/changes$/.exec(path);
  if (pm) return uuid(pm[1]) ? { kind: 'project-changes', id: pm[1] } : null;
  pm = /^\/api\/chat\/projects\/([^/?#]+)\/(diff|tree|file)(?:\?path=([A-Za-z0-9%._~!*'()-]{0,3000}))?$/.exec(path);
  if (pm) { const rel = paneRel(pm[3]); return uuid(pm[1]) && rel !== null && (rel !== '' || pm[2] === 'tree') ? { kind: `project-${pm[2]}`, id: pm[1], rel } : null; }
  let m = /^\/api\/chat\/conversations\/([^/?#]+)$/.exec(path);
  if (m) return uuid(m[1]) ? { kind: 'one', id: m[1] } : null;
  // CHAT-BUILD-01: one page of a long conversation (?limit=N[&before=<message id>]).
  m = /^\/api\/chat\/conversations\/([^/?#]+)\/messages(?:\?limit=([1-9]\d{0,2})(?:&before=([^&#]+))?)?$/.exec(path);
  if (m) return uuid(m[1]) && (m[2] === undefined || Number(m[2]) <= 500) && (m[3] === undefined || uuid(m[3])) ? { kind: 'messages', id: m[1] } : null;
  // CHAT-BUILD-01 stage 4 (CH8): the side panel's data for one chat.
  m = /^\/api\/chat\/conversations\/([^/?#]+)\/(usage|team|schedule|stop)$/.exec(path);
  if (m) return uuid(m[1]) ? { kind: `chat-${m[2]}`, id: m[1] } : null;
  m = /^\/api\/chat\/conversations\/([^/?#]+)\/apps\/([a-f0-9]{32})\/stop$/.exec(path);
  if (m) return uuid(m[1]) ? { kind: 'app-stop', id: m[1], run: m[2] } : null;
  m = /^\/api\/chat\/conversations\/([^/?#]+)\/images$/.exec(path);
  if (m) return uuid(m[1]) ? { kind: 'images', id: m[1] } : null;
  m = /^\/api\/chat\/conversations\/([^/?#]+)\/images\/([a-f0-9]{32})$/.exec(path);
  if (m) return uuid(m[1]) ? { kind: 'image', id: m[1], image: m[2] } : null;
  m = /^\/api\/chat\/conversations\/([^/?#]+)\/runs$/.exec(path);
  if (m) return uuid(m[1]) ? { kind: 'runs', id: m[1] } : null;
  m = /^\/api\/chat\/runs\/([^/?#]+)\/events(?:\?after=(0|[1-9]\d{0,8}))?$/.exec(path);
  if (m) return validRunId(m[1]) ? { kind: 'events', run: m[1], after: Number(m[2] ?? 0) } : null;
  m = /^\/api\/chat\/runs\/([^/?#]+)\/stop$/.exec(path);
  if (m) return validRunId(m[1]) ? { kind: 'stop', run: m[1] } : null;
  return null;
}

/** A project-relative path from ?path= (decoded): no "..", no leading "/", no NUL. null when invalid. */
function paneRel(raw) {
  if (raw === undefined || raw === '') return '';
  let s; try { s = decodeURIComponent(raw); } catch { return null; }
  if (s.length > 1024 || s.includes('\0') || s.startsWith('/') || s.includes('\\') || s.split('/').some(p => p === '..')) return null;
  return s;
}
/** The path for a pane request: GET /api/chat/projects/:id/{diff|tree|file}?path=… */
export function panePath(id, kind, rel = '') { return `/api/chat/projects/${id}/${kind}${rel ? `?path=${encodeURIComponent(rel)}` : ''}`; }

export function conversationRoute(path) { return conversationPath(path) !== null; }

export function allowedConversation(method, path, body) {
  if (approvalPath(path)) return allowedApproval(method, path, body);
  const p = conversationPath(path);
  if (!p) return false;
  if (p.kind === 'chat-usage' || p.kind === 'chat-team') return method === 'GET' && body === undefined;
  if (p.kind === 'chat-stop' || p.kind === 'app-stop') return method === 'POST' && body === undefined;
  if (p.kind === 'chat-schedule') return method === 'GET' || method === 'DELETE' ? body === undefined : method === 'PUT' && scheduleOk(body);
  if (p.kind === 'panel') return method === 'GET' ? body === undefined : method === 'PUT' && record(body) && onlyKeys(body, ['order', 'folded', 'diff']) && (body.order === undefined || partList(body.order)) && (body.folded === undefined || partList(body.folded)) && (body.diff === undefined || DIFF_VIEWS.includes(body.diff));
  if (p.kind === 'chat-settings') return method === 'GET' ? body === undefined : method === 'PUT' && record(body) && onlyKeys(body, ['notifyDone']) && typeof body.notifyDone === 'boolean';
  if (p.kind === 'last') return method === 'GET' ? body === undefined : method === 'PUT' && record(body) && onlyKeys(body, ['last']) && (body.last === null || uuid(body.last));
  if (p.kind === 'sidebar') return method === 'GET' ? body === undefined : method === 'PUT' && record(body) && Object.keys(body).length > 0 && onlyKeys(body, ['order', 'hidden', 'folded'])
    && (body.order === undefined || sectionList(body.order)) && (body.hidden === undefined || sectionList(body.hidden)) && (body.folded === undefined || folderList(body.folded));
  if (method === 'GET') return body === undefined && ['list', 'messages', 'events', 'projects', 'project-git', 'project-pr', 'project-changes', 'project-diff', 'project-tree', 'project-file', 'transcribe', 'variables', 'image'].includes(p.kind);
  if (method === 'POST' && p.kind === 'transcribe') return record(body) && onlyKeys(body, ['audio', 'language']) && typeof body.audio === 'string' && body.audio.length > 0 && body.audio.length <= MAX_AUDIO_CHARS && /^[A-Za-z0-9+/]+={0,2}$/.test(body.audio)
    && (body.language === undefined || STT_LANGUAGES.includes(body.language));
  if (method === 'DELETE') return body === undefined && (p.kind === 'one' || p.kind === 'project' || p.kind === 'variable');
  if(method==='POST'&&p.kind==='folder-picker')return record(body)&&onlyKeys(body,['path'])&&(body.path===undefined||(typeof body.path==='string'&&body.path.length>0&&body.path.length<=4096&&!/[\x00-\x1f]/.test(body.path)));
  if (p.kind === 'variables') return method === 'GET' && body === undefined;
  if (p.kind === 'variable') return method === 'DELETE' ? body === undefined : method === 'PUT' && record(body) && onlyKeys(body, ['value']) && typeof body.value === 'string' && body.value.length > 0 && body.value.length <= 8000 && !body.value.includes('\u0000');
  if ((method === 'POST' && p.kind === 'projects') || (method === 'PUT' && p.kind === 'project')) { if (body?.folders !== undefined && !foldersOk(body.folders)) return false; }
  if (method === 'POST' && p.kind === 'projects') return record(body) && onlyKeys(body, ['name', 'folder', 'repoUrl', 'folders']) && title(body.name) && body.name.trim().length > 0
    && (body.folder === undefined || folderOk(body.folder)) && (body.repoUrl === undefined || repoOk(body.repoUrl));
  if (method === 'PUT' && p.kind === 'project') return record(body) && Object.keys(body).length > 0 && onlyKeys(body, ['name', 'folder', 'repoUrl', 'folders'])
    && (body.name === undefined || (title(body.name) && body.name.trim().length > 0)) && (body.folder === undefined || body.folder === null || folderOk(body.folder)) && (body.repoUrl === undefined || body.repoUrl === null || repoOk(body.repoUrl));
  if (method === 'POST' && p.kind === 'list') return record(body) && onlyKeys(body, ['title', 'agentId', 'projectId', 'model', 'mode', 'thinking']) && (body.title === undefined || title(body.title)) && (body.agentId === undefined || agentId(body.agentId)) && (body.projectId === undefined || uuid(body.projectId)) && savedModel(body.model)
    && (body.mode === undefined || CHAT_MODES.includes(body.mode)) && (body.thinking === undefined || CHAT_THINKING.includes(body.thinking));
  if (method === 'POST' && p.kind === 'images') return record(body) && onlyKeys(body, ['data', 'name']) && typeof body.data === 'string' && body.data.length > 0 && body.data.length <= MAX_IMAGE_CHARS && /^[A-Za-z0-9+/]+={0,2}$/.test(body.data) && (body.name === undefined || (typeof body.name === 'string' && body.name.length <= 200));
  if (method === 'GET' && p.kind === 'image') return body === undefined;
  if (method === 'POST' && p.kind === 'runs') return record(body) && onlyKeys(body, ['runId', 'message', 'model', 'agentId', 'images']) && (body.images === undefined || (Array.isArray(body.images) && body.images.length <= MAX_IMAGES && body.images.every(x => typeof x === 'string' && IMAGE_ID.test(x)))) && (body.agentId === undefined || agentId(body.agentId)) && validRunId(body.runId) && text(body.message, MAX_MESSAGE) && body.message.trim().length > 0
    && (body.model === undefined || (typeof body.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,99}$/.test(body.model)));
  if (method === 'POST' && p.kind === 'stop') return body === undefined;
  if (method === 'PUT' && p.kind === 'one') return record(body) && Object.keys(body).length > 0 && onlyKeys(body, ['title', 'pinned', 'projectId', 'model', 'archived', 'mode', 'thinking', 'queued']) && (body.projectId === undefined || body.projectId === null || uuid(body.projectId)) && (body.title === undefined || body.title === null || title(body.title)) && (body.pinned === undefined || typeof body.pinned === 'boolean') && (body.archived === undefined || typeof body.archived === 'boolean') && savedModel(body.model)
    && (body.mode === undefined || CHAT_MODES.includes(body.mode)) && (body.thinking === undefined || CHAT_THINKING.includes(body.thinking)) && (body.queued === undefined || queueOk(body.queued));
  return false;
}

const savedModel=x=>x===undefined||x===''||(typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,99}$/.test(x));
function conversation(x) {
  if (!record(x) || !uuid(x.id)) throw Error('protocol');
  return { ...(x.model!==undefined&&x.model!==''&&savedModel(x.model)?{model:x.model}:{}), id: x.id, title: typeof x.title === 'string' ? x.title.slice(0, MAX_TITLE) : null, agentId: agentId(x.agentId) ? x.agentId : null, projectId: uuid(x.projectId) ? x.projectId : null,
    pinned: x.pinned === true, preview: str(x.preview, 200), createdAt: str(x.createdAt, 40), updatedAt: str(x.updatedAt, 40),
    // CHAT-BUILD-01 stage 2: sidebar state (archived, opened from another chat, working now, approvals waiting).
    ...(x.archived === true ? { archived: true } : {}), ...(uuid(x.parentId) ? { parentId: x.parentId } : {}),
    ...(x.running === true ? { running: true } : {}), ...(Number.isSafeInteger(x.waiting) && x.waiting > 0 ? { waiting: Math.min(x.waiting, 999) } : {}),
    ...(CHAT_MODES.includes(x.mode) && x.mode !== 'auto' ? { mode: x.mode } : {}), ...(CHAT_THINKING.includes(x.thinking) && x.thinking !== 'normal' ? { thinking: x.thinking } : {}),
    ...(Array.isArray(x.queued) && queueOk(x.queued) && x.queued.length ? { queued: x.queued.map(q => ({ key: q.key, text: q.text })) } : {}),
    ...(record(x.meeting) && typeof x.meeting.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x.meeting.id) && ['active','paused','review','completed'].includes(x.meeting.state) ? { meeting: { id: x.meeting.id, state: x.meeting.state } } : {}),
    ...(record(x.schedule) && typeof x.schedule.next === 'string' ? { schedule: { next: x.schedule.next.slice(0, 40), paused: x.schedule.paused === true } } : {}) };
}

function call(x) {
  if (!record(x)) throw Error('protocol');
  return { id: str(x.id, 128), name: str(x.name, 128), input: str(x.input, 8000),
    ...(typeof x.output === 'string' ? { output: x.output.slice(0, 12000) } : {}),
    ...(typeof x.isError === 'boolean' ? { isError: x.isError } : {}), ...(num(x.ms) !== undefined ? { ms: num(x.ms) } : {}), ...(typeof x.approvalId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(x.approvalId) ? { approvalId: x.approvalId } : {}) };
}
/** CHAT-BUILD-01 stage 5: notices kept with a reply, and their codes. */
const KEPT_NOTICES = ['injection', 'summarized', 'plan_limit', 'images_not_seen', 'choices'];

function part(x) {
  if (!record(x)) throw Error('protocol');
  if (x.kind === 'text') return { kind: 'text', text: str(x.text, 1000000) };
  if (x.kind === 'reasoning') return { kind: 'reasoning', text: str(x.text, 1000000), ...(num(x.ms) !== undefined ? { ms: num(x.ms) } : {}) };
  if (x.kind === 'tools' && Array.isArray(x.calls) && x.calls.length <= 200) return { kind: 'tools', step: num(x.step) ?? 0, calls: x.calls.map(call) };
  if (x.kind === 'steer') return { kind: 'steer', text: str(x.text, 4000), step: num(x.step) ?? 0 };
  if (x.kind === 'images' && Array.isArray(x.images) && x.images.length <= MAX_IMAGES) return { kind: 'images', images: x.images.filter(i => record(i) && typeof i.id === 'string' && IMAGE_ID.test(i.id) && IMAGE_TYPES.includes(i.type)).map(i => ({ id: i.id, type: i.type, name: str(i.name, 120) })) };
  if (x.kind === 'notice' && KEPT_NOTICES.includes(x.code)) return { kind: 'notice', code: x.code, ...(typeof x.text === 'string' ? { text: x.text.slice(0, x.code === 'summarized' ? 2400 : 300) } : {}) };
  return null;
}

function message(x) {
  if (!record(x) || !['user', 'assistant', 'system'].includes(x.role) || typeof x.content !== 'string') throw Error('protocol');
  const parts = Array.isArray(x.parts) && x.parts.length <= 5000 ? x.parts.map(part).filter(Boolean) : null;
  return { id: str(x.id, 64), role: x.role, content: x.content.slice(0, 1000000), parts,
    status: ['complete', 'stopped', 'error'].includes(x.status) ? x.status : 'complete',
    runId: validRunId(x.runId) ? x.runId : null, durationMs: num(x.durationMs) ?? null, createdAt: str(x.createdAt, 40),
    ...(x.code === 'run_interrupted' ? { code: 'run_interrupted' } : {}),
    ...(agentId(x.agentId) ? { agentId: x.agentId } : {}),
    ...(record(x.changes) && num(x.changes.files) ? { changes: { files: num(x.changes.files), undone: x.changes.undone === true, ...(Number.isSafeInteger(x.changes.added) && x.changes.added >= 0 && Number.isSafeInteger(x.changes.removed) && x.changes.removed >= 0 ? { added: x.changes.added, removed: x.changes.removed } : {}) } } : record(x.changes) && x.changes.unavailable === true ? { changes: { files: 0, undone: false, unavailable: true } } : {}) };
}

function project(x) {
  if (!record(x) || !uuid(x.id) || typeof x.name !== 'string') throw Error('protocol');
  return { id: x.id, name: x.name.slice(0, 80), slug: str(x.slug, 64), folder: typeof x.folder === 'string' ? x.folder.slice(0, 1024) : null, repoUrl: typeof x.repoUrl === 'string' ? x.repoUrl.slice(0, 300) : null,
    folders: Array.isArray(x.folders) ? x.folders.slice(0, 8).filter(f => record(f) && typeof f.path === 'string').map(f => ({ path: f.path.slice(0, 1024), write: f.write === true })) : [] };
}

const ERROR_CODES = { 503: ['stt_unavailable', 'checkpoint_unavailable'], 500: ['stt_failed'], 400: ['invalid_request', 'invalid_project', 'bad_path', 'no_folder', 'stt_invalid', 'invalid_variable', 'invalid_image'], 404: ['not_found'], 409: ['conversation_busy', 'run_id_reused', 'folder_fixed'], 429: ['rate_limited', 'stt_busy'] };

/** A link on github.com only (repository, branch or compare page). */
const githubUrl = x => typeof x === 'string' && x.length <= 600 && /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}(\/[A-Za-z0-9._~%\/-]*(\.\.\.[A-Za-z0-9._~%\/-]+)?(\?expand=1)?)?$/.test(x);

/** Reviewed fields only. Throws on a malformed success body. */
export function conversationResponse(path, status, body) {
  if (approvalPath(path)) return approvalResponse(path, status, body);
  const p = conversationPath(path);
  if (!p) throw Error('protocol');
  if (status !== 200 && status !== 201 && status !== 202) {
    const code = record(body) ? body.code : undefined;
    if (!(ERROR_CODES[status] ?? []).includes(code)) return null;
    return { code, ...(code === 'conversation_busy' && validRunId(body.runId) ? { runId: body.runId } : {}) };
  }
  if (!record(body)) throw Error('protocol');
  if(p.kind==='folder-picker'){
    const valid=x=>typeof x==='string'&&x.length>0&&x.length<=4096&&!/[\x00-\x1f]/.test(x);
    if(!valid(body.path)||(body.parent!==null&&!valid(body.parent))||typeof body.selectable!=='boolean'||!Array.isArray(body.entries)||body.entries.length>500||typeof body.truncated!=='boolean')throw Error('protocol');
    return {path:body.path,parent:body.parent,selectable:body.selectable,truncated:body.truncated,entries:body.entries.map(e=>{if(!record(e)||!valid(e.name)||/[\\/]/.test(e.name)||!valid(e.path)||![body.path.replace(/[\\/]$/,'')+'/'+e.name,body.path.replace(/[\\/]$/,'')+'\\'+e.name].includes(e.path))throw Error('protocol');return {name:e.name,path:e.path};})};
  }
  if (p.kind === 'variables' || p.kind === 'variable') { if (!Array.isArray(body.variables)) throw Error('protocol'); return { variables: body.variables.filter(n => typeof n === 'string' && /^[A-Z_][A-Z0-9_]{0,63}$/.test(n)).slice(0, 32) }; }
  if (p.kind === 'projects' && status === 200) { if (!Array.isArray(body.projects)) throw Error('protocol'); return { projects: body.projects.slice(0, 500).map(project) }; }
  if (p.kind === 'projects' || (p.kind === 'project' && record(body.project))) return { project: project(body.project) };
  if (p.kind === 'project') { if (body.ok !== true) throw Error('protocol'); return { ok: true }; }
  if (p.kind === 'project-pr') {
    const pr = record(body.pr) ? body.pr : null;
    const ok = pr && Number.isSafeInteger(pr.number) && pr.number > 0 && typeof pr.url === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/\d{1,9}$/.test(pr.url)
      && ['open', 'merged', 'closed', 'draft'].includes(pr.state);
    return { pr: ok ? { number: pr.number, title: str(pr.title, 200), state: pr.state, url: pr.url, checks: ['passing', 'pending', 'failing'].includes(pr.checks) ? pr.checks : null } : null,
      ...(body.unavailable === true ? { unavailable: true } : {}) };
  }
  if (p.kind === 'project-git') {
    const g = record(body.git) ? body.git : {}; const count = x => (Number.isSafeInteger(x) && x >= 0 ? x : null);
    const s = (x, max) => (typeof x === 'string' && x ? x.slice(0, max) : null);
    const lc = record(g.lastCommit) && typeof g.lastCommit.hash === 'string' && /^[0-9a-f]{4,40}$/.test(g.lastCommit.hash) ? g.lastCommit : null;
    const gh = record(g.github) && githubUrl(g.github.repoUrl) ? g.github : null;
    return { git: { branch: s(g.branch, 200), remote: s(g.remote, 300), dirty: typeof g.dirty === 'boolean' ? g.dirty : null, added: count(g.added), removed: count(g.removed), files: count(g.files),
      upstream: s(g.upstream, 200), ahead: count(g.ahead), behind: count(g.behind), defaultBranch: s(g.defaultBranch, 200),
      lastCommit: lc ? { hash: lc.hash, subject: str(lc.subject, 200), author: str(lc.author, 100), date: str(lc.date, 40) } : null,
      github: gh ? { owner: str(gh.owner, 39), repo: str(gh.repo, 100), repoUrl: gh.repoUrl, branchUrl: githubUrl(gh.branchUrl) ? gh.branchUrl : null, compareUrl: githubUrl(gh.compareUrl) ? gh.compareUrl : null } : null } };
  }
  const n = x => (Number.isSafeInteger(x) && x >= 0 ? x : null);
  if (p.kind === 'transcribe') return typeof body.text === 'string' ? { text: body.text.slice(0, 20_000), ms: n(body.ms) ?? 0 }
    : { available: body.available === true, missing: Array.isArray(body.missing) ? body.missing.filter(m => typeof m === 'string').slice(0, 5).map(m => m.slice(0, 40)) : [] };
  if (p.kind === 'project-changes') {
    if (!Array.isArray(body.changes)) throw Error('protocol');
    const statuses = ['modified', 'added', 'deleted', 'renamed', 'untracked'];
    return { branch: typeof body.branch === 'string' ? body.branch.slice(0, 200) : null, truncated: body.truncated === true, notGit: body.notGit === true,
      changes: body.changes.slice(0, 1000).filter(c => record(c) && typeof c.path === 'string' && statuses.includes(c.status))
        .map(c => ({ path: c.path.slice(0, 1024), status: c.status, added: n(c.added), removed: n(c.removed), ...(typeof c.from === 'string' ? { from: c.from.slice(0, 1024) } : {}) })) };
  }
  if (p.kind === 'project-diff') return { path: str(body.path, 1024), diff: typeof body.diff === 'string' ? body.diff.slice(0, 400_000) : '', truncated: body.truncated === true, binary: body.binary === true, hidden: body.hidden === true };
  if (p.kind === 'project-tree') {
    if (!Array.isArray(body.entries)) throw Error('protocol');
    return { path: str(body.path, 1024), truncated: body.truncated === true,
      entries: body.entries.slice(0, 1000).filter(e => record(e) && typeof e.name === 'string' && e.name && !e.name.includes('/') && (e.kind === 'dir' || e.kind === 'file')).map(e => ({ name: e.name.slice(0, 255), kind: e.kind, size: n(e.size) })) };
  }
  if (p.kind === 'project-file') return { path: str(body.path, 1024), text: typeof body.text === 'string' ? body.text.slice(0, 524_288) : null, size: n(body.size) ?? 0, binary: body.binary === true, hidden: body.hidden === true, truncated: body.truncated === true };
  if (p.kind === 'list' && status === 200) {
    if (!Array.isArray(body.conversations) || body.conversations.length > 1000) throw Error('protocol');
    return { conversations: body.conversations.map(conversation) };
  }
  if (p.kind === 'list' || (p.kind === 'one' && record(body.conversation))) return { conversation: conversation(body.conversation) };
  if (p.kind === 'one') { if (body.ok !== true) throw Error('protocol'); return { ok: true }; }
  if (p.kind === 'messages') {
    if (!Array.isArray(body.messages) || body.messages.length > 20000) throw Error('protocol');
    return { conversation: conversation(body.conversation), messages: body.messages.map(message), activeRunId: validRunId(body.activeRunId) ? body.activeRunId : null, ...(body.hasMore === true ? { hasMore: true } : {}) };
  }
  if (p.kind === 'runs') {
    if (!validRunId(body.runId)) throw Error('protocol');
    return { runId: body.runId, ...(body.replayed === true ? { replayed: true } : {}), ...(record(body.userMessage) ? { userMessage: message(body.userMessage) } : {}) };
  }
  if (p.kind === 'chat-usage') return { usage: (Array.isArray(body.usage) ? body.usage : []).slice(0, 50).filter(record).map(u => ({ model: str(u.model, 120), tokensIn: num(u.tokensIn) ?? 0, tokensOut: num(u.tokensOut) ?? 0, replies: num(u.replies) ?? 0 })) };
  if (p.kind === 'chat-team') return { team: (Array.isArray(body.team) ? body.team : []).slice(0, 20).filter(record).map(t => ({ agentId: str(t.agentId, 128), agentName: str(t.agentName, 80), model: str(t.model, 120), status: ['started', 'answered', 'waiting_approval', 'failed'].includes(t.status) ? t.status : 'failed', at: str(t.at, 40) })),
    steps: (Array.isArray(body.steps) ? body.steps : []).slice(0, 20).filter(x => record(x) && typeof x.agentId === 'string' && typeof x.tool === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(x.tool)).map(x => ({ agentId: str(x.agentId, 128), tool: x.tool, at: str(x.at, 40) })),
    apps: (Array.isArray(body.apps) ? body.apps : []).slice(0, 20).filter(a => record(a) && typeof a.id === 'string' && /^[a-f0-9]{32}$/.test(a.id)).map(a => ({ id: a.id, app: str(a.app, 60), agentName: typeof a.agentName === 'string' ? str(a.agentName, 80) : null, about: str(a.about, 120), startedAt: str(a.startedAt, 40) })) };
  if (p.kind === 'app-stop') { if (body.ok !== true) throw Error('protocol'); return { ok: true }; }
  if (p.kind === 'chat-stop') return { ok: body.ok === true, stopped: num(body.stopped) ?? 0 };
  if (p.kind === 'chat-schedule') return body.ok === true ? { ok: true } : { schedule: scheduleView(body.schedule) };
  if (p.kind === 'panel') { const v = record(body.panel) ? body.panel : {}; return { panel: { order: partList(v.order) ? v.order : PANEL_PARTS, folded: partList(v.folded) ? v.folded : [], diff: v.diff === 'split' ? 'split' : 'unified' } }; }
  if (p.kind === 'images') { const v = record(body.image) ? body.image : {}; if (typeof v.id !== 'string' || !IMAGE_ID.test(v.id) || !IMAGE_TYPES.includes(v.type)) throw Error('protocol'); return { image: { id: v.id, type: v.type, name: str(v.name, 120), size: num(v.size) ?? 0 } }; }
  if (p.kind === 'image') { const v = record(body.image) ? body.image : {}; if (typeof v.id !== 'string' || !IMAGE_ID.test(v.id) || !IMAGE_TYPES.includes(v.type) || typeof v.data !== 'string' || v.data.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.data)) throw Error('protocol'); return { image: { id: v.id, type: v.type, name: str(v.name, 120), data: v.data } }; }
  if (p.kind === 'chat-settings') return { settings: { notifyDone: !(record(body.settings) && body.settings.notifyDone === false) } };
  if (p.kind === 'last') return { last: uuid(body.last) ? body.last : null };
  if (p.kind === 'sidebar') {
    const v = record(body.sidebar) ? body.sidebar : {};
    return { sidebar: { order: sectionList(v.order) ? v.order : SIDEBAR_SECTIONS, hidden: sectionList(v.hidden) ? v.hidden : ['running', 'archived'], folded: folderList(v.folded) ? v.folded : [] } };
  }
  if (p.kind === 'stop') return { ok: body.ok === true, status: ['stopping', 'complete', 'stopped', 'error'].includes(body.status) ? body.status : 'stopping' };
  throw Error('protocol');
}

/** One run event, reduced to the reviewed fields; undefined for kinds the UI does not show. */
export function projectRunEvent(x) {
  const e = projectEvent(x);
  return e && num(x.at) !== undefined ? { ...e, at: num(x.at) } : e;
}
/** Typed reasons a run may end with (CHAT-PRO-02 G: LM Studio not running). */
const END_CODES = ['model_unavailable', 'local_model_missing', 'lmstudio_not_running', 'subscription_org_blocked'];
/** Notices a running turn may show (CHAT-BUILD-01); never part of the answer. */
const NOTICE_CODES = ['rate_limited', 'claude_key_missing', 'local_model_slow', 'injection', 'summarized', 'plan_limit', 'images_not_seen'];
function projectEvent(x) {
  if (!record(x) || !Number.isSafeInteger(x.seq) || x.seq < 1) throw Error('protocol');
  const seq = x.seq;
  if (x.type === 'text' || x.type === 'reasoning') return { seq, type: x.type, content: str(x.content, RUN_FRAME_BYTES) };
  if (x.type === 'tool_start' && Array.isArray(x.tools) && x.tools.length <= 64) {
    return { seq, type: 'tool_start', step: num(x.step) ?? 0, tools: x.tools.map(t => ({ id: str(t?.id, 128), name: str(t?.name, 128), input: str(t?.input, 8000) })) };
  }
  if (x.type === 'tool_result' && Array.isArray(x.results) && x.results.length <= 64) {
    return { seq, type: 'tool_result', step: num(x.step) ?? 0, results: x.results.map(r => ({ id: str(r?.id, 128), name: str(r?.name, 128), output: str(r?.output, 12000), isError: r?.isError === true, ...(num(r?.ms) !== undefined ? { ms: num(r.ms) } : {}), ...(typeof r?.approvalId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(r.approvalId) ? { approvalId: r.approvalId } : {}) })) };
  }
  if (x.type === 'notice' && NOTICE_CODES.includes(x.code)) {
    return { seq, type: 'notice', code: x.code, ...(num(x.waitSec) !== undefined ? { waitSec: num(x.waitSec) } : {}), ...(typeof x.model === 'string' ? { model: str(x.model, 100) } : {}), ...(typeof x.text === 'string' ? { text: str(x.text, x.code === 'summarized' ? 2400 : 300) } : {}) };
  }
  if (x.type === 'steer') return { seq, type: 'steer', content: str(x.content, 4000), step: num(x.step) ?? 0 };
  if (x.type === 'end' && ['complete', 'stopped', 'error'].includes(x.status)) {
    return { seq, type: 'end', status: x.status, ms: num(x.ms) ?? 0, ...(END_CODES.includes(x.code) ? { code: x.code } : {}) };
  }
  return undefined;
}

/** Incremental parser for a run's SSE stream: numbered frames in order, comments ignored. */
export class RunEventParser {
  constructor(after = 0) { this.last = after; this.decoder = new TextDecoder('utf-8', { fatal: true }); this.line = ''; this.data = []; this.size = 0; this.cr = false; this.ended = false; }
  push(bytes) { return this.consume(this.decoder.decode(bytes, { stream: true })); }
  consume(chunk) {
    const out = [];
    for (const ch of chunk) {
      if (this.cr) { this.cr = false; if (ch === '\n') continue; }
      if (ch === '\r' || ch === '\n') {
        if (this.line === '') {
          if (this.data.length) {
            const raw = JSON.parse(this.data.join('\n'));
            this.data = []; this.size = 0;
            // CHAT-BUILD-01 stage 5: the live preview has no number; it never moves the resume point.
            if (raw && raw.type === 'preview' && raw.seq === undefined) { if (!this.ended) out.push({ seq: 0, type: 'preview', content: str(raw.content, RUN_FRAME_BYTES), ...(typeof raw.tool === 'string' ? { tool: raw.tool.slice(0, 128) } : {}) }); }
            const frame = raw && raw.type === 'preview' && raw.seq === undefined ? undefined : projectRunEvent(raw);
            if (frame && frame.seq > this.last) {
              if (this.ended) throw Error('protocol');
              this.last = frame.seq; if (frame.type === 'end') this.ended = true; out.push(frame);
            }
          }
        } else if (this.line.startsWith('data:')) this.data.push(this.line.slice(5).replace(/^ /, ''));
        this.line = ''; this.cr = ch === '\r';
      } else {
        this.line += ch;
        if (++this.size > RUN_FRAME_BYTES) throw Error('limit');
      }
    }
    return out;
  }
  finish() { this.consume(this.decoder.decode()); }
}
