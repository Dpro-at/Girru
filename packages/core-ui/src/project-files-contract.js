// STORE-MAP-01 P6 wire contract (boards P6a–P6c): where the files Girru writes
// into each project folder stand, the task-number questions from .girru/tasks.md,
// and the "stays on this computer" switch of each memory place. Owner only.
// The backend registers these routes only while its P6 switch is on; otherwise
// they answer 404 and the window shows nothing new.
//
//   GET   /api/memory/project-files                                   projects with their files and states
//   GET   /api/memory/project-files/:projectId/compare?path=<file>    Girru's text and the folder's text
//   POST  /api/memory/project-files/:projectId/rewrite                write the files again (never over a changed file)
//   POST  /api/memory/project-files/:projectId/use-girru              { path } → { project, undo }
//   POST  /api/memory/project-files/:projectId/undo                   { undo }
//   PATCH /api/memory/project-files/:projectId                        { writeFiles?, companyFacts? }
//   GET   /api/memory/project-files/needs-you                         task-number problems
//   POST  /api/memory/project-files/needs-you/:id                     { action: new_task | add_task | leave }
//   GET   /api/memory/place-settings                                  { places: { [place]: { staysLocal } } }
//   PUT   /api/memory/place-settings/:place                           { staysLocal }

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (x, keys) => Object.keys(x).every(k => keys.includes(k));
const plainId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const undoToken = x => typeof x === 'string' && /^[A-Za-z0-9_.:+/=-]{1,512}$/.test(x);

export const FILE_STATES = ['up_to_date', 'waiting', 'changed_in_both', 'folder_not_found', 'could_not_write'];
/** The files Girru writes into a project folder (what the backend's layout returns). */
export const PROJECT_FILE_PATHS = ['.girru/brief.md', '.girru/tasks.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursor/rules/girru.mdc'];
export const PROBLEM_KINDS = ['duplicate_number', 'unknown_number'];
export const PROBLEM_ACTIONS = ['new_task', 'add_task', 'leave'];
/** Memory window places that carry their own "stays on this computer" switch. */
export const PLACE_KEYS = ['owner', 'people', 'experience', 'tasks', 'company'];
const placeKey = x => typeof x === 'string' && (PLACE_KEYS.includes(x) || (x.startsWith('project:') && plainId(x.slice(8))));

export const PROJECT_FILES_PATH = '/api/memory/project-files';
export const PROJECT_FILES_NEEDS_PATH = '/api/memory/project-files/needs-you';
export const PLACE_SETTINGS_PATH = '/api/memory/place-settings';
export const projectFilesPath = id => `/api/memory/project-files/${encodeURIComponent(id)}`;
export const projectFilesComparePath = (id, file) => `${projectFilesPath(id)}/compare?path=${encodeURIComponent(file)}`;
export const projectFilesActionPath = (id, action) => `${projectFilesPath(id)}/${action}`;
export const taskProblemPath = id => `${PROJECT_FILES_NEEDS_PATH}/${encodeURIComponent(id)}`;
export const placeSettingPath = place => `${PLACE_SETTINGS_PATH}/${encodeURIComponent(place)}`;

const decoded = (raw, ok) => { let v; try { v = decodeURIComponent(raw); } catch { return null; } return ok(v) && encodeURIComponent(v) === raw ? v : null; };

/** Which P6 route a path is, with its id (and the compared file), or null. */
export function projectFilesPathOf(path) {
  if (typeof path !== 'string' || path.length > 1024 || path.includes('#')) return null;
  const q = path.indexOf('?');
  const base = q < 0 ? path : path.slice(0, q);
  const raw = q < 0 ? null : path.slice(q + 1);
  let m;
  if ((m = /^\/api\/memory\/project-files\/([^/]+)\/compare$/.exec(base)) && m[1] !== 'needs-you') {
    const id = decoded(m[1], plainId); const p = raw && /^path=([^&]+)$/.exec(raw);
    const file = p ? decoded(p[1], x => PROJECT_FILE_PATHS.includes(x)) : null;
    return id && file ? { route: 'compare', id, file } : null;
  }
  if (raw !== null) return null;
  if (base === PROJECT_FILES_PATH) return { route: 'list' };
  if (base === PROJECT_FILES_NEEDS_PATH) return { route: 'needs' };
  if (base === PLACE_SETTINGS_PATH) return { route: 'places' };
  if ((m = /^\/api\/memory\/project-files\/needs-you\/([^/]+)$/.exec(base))) { const id = decoded(m[1], plainId); return id ? { route: 'problem', id } : null; }
  if ((m = /^\/api\/memory\/place-settings\/([^/]+)$/.exec(base))) { const id = decoded(m[1], placeKey); return id ? { route: 'place', id } : null; }
  if ((m = /^\/api\/memory\/project-files\/([^/]+)(\/rewrite|\/use-girru|\/undo)?$/.exec(base)) && m[1] !== 'needs-you') {
    const id = decoded(m[1], plainId);
    return id ? { route: m[2] ? m[2].slice(1) : 'project', id } : null;
  }
  return null;
}
export function projectFilesRoute(path) { return projectFilesPathOf(path) !== null; }

export function allowedProjectFiles(method, path, body) {
  const p = projectFilesPathOf(path);
  if (!p) return false;
  const get = method === 'GET' && body === undefined;
  switch (p.route) {
    case 'list': case 'needs': case 'places': case 'compare': return get;
    case 'rewrite': return method === 'POST' && body === undefined;
    case 'use-girru': return method === 'POST' && record(body) && Object.keys(body).length === 1 && PROJECT_FILE_PATHS.includes(body.path);
    case 'undo': return method === 'POST' && record(body) && Object.keys(body).length === 1 && undoToken(body.undo);
    case 'project':
      return method === 'PATCH' && record(body) && Object.keys(body).length > 0 && onlyKeys(body, ['writeFiles', 'companyFacts'])
        && ['writeFiles', 'companyFacts'].every(k => body[k] === undefined || typeof body[k] === 'boolean');
    case 'problem': return method === 'POST' && record(body) && Object.keys(body).length === 1 && PROBLEM_ACTIONS.includes(body.action);
    case 'place': return method === 'PUT' && record(body) && Object.keys(body).length === 1 && typeof body.staysLocal === 'boolean';
  }
  return false;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const fail = () => { throw Error('Invalid project files response'); };
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/gu;
const clip = (x, max) => (typeof x === 'string' ? x.replace(badChars, '').slice(0, max) : '');
const whenOrNull = x => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(x) ? x.slice(0, 19) : null);
const versionOf = x => (Number.isSafeInteger(x) && x >= 0 ? x : null);
const list = (x, max) => (Array.isArray(x) ? x.slice(0, max) : []);
const state = x => (FILE_STATES.includes(x) ? x : 'could_not_write');
const NEEDS = ['changed_in_both', 'folder_not_found', 'could_not_write'];

function file(f) {
  return { path: PROJECT_FILE_PATHS.includes(f.path) ? f.path : clip(f.path, 200), what: clip(f.what, 200), version: versionOf(f.version), state: state(f.state), ...(typeof f.reason === 'string' && f.reason ? { reason: clip(f.reason, 300) } : {}) };
}
function project(p) {
  if (!record(p) || !plainId(p.projectId)) fail();
  const s = state(p.state);
  return {
    projectId: p.projectId, name: clip(p.name, 120) || p.projectId, folder: typeof p.folder === 'string' && p.folder ? clip(p.folder, 1024) : null,
    writeFiles: p.writeFiles === true, companyFacts: p.companyFacts === true, state: s, needsYou: NEEDS.includes(s),
    writtenAt: whenOrNull(p.writtenAt), version: versionOf(p.version), files: list(p.files, 12).filter(record).map(file),
  };
}
function problem(x) {
  if (!record(x) || !plainId(x.id) || !PROBLEM_KINDS.includes(x.kind) || !plainId(x.projectId)) return null;
  return {
    id: x.id, kind: x.kind, projectId: x.projectId, projectName: clip(x.projectName, 120) || x.projectId, file: '.girru/tasks.md',
    number: typeof x.number === 'string' && /^T-\d{1,6}$/.test(x.number) ? x.number : '', titles: list(x.titles, 4).filter(t => typeof t === 'string').map(t => clip(t, 200)),
    line: Number.isSafeInteger(x.line) && x.line > 0 ? x.line : 0,
  };
}

const CODES = ['not_found', 'folder_not_found', 'bad_path', 'undo_expired', 'could_not_write', 'bad_place', 'invalid_request', 'invalid_board', 'conflict'];

export function projectFilesResponse(path, status, body) {
  const p = projectFilesPathOf(path);
  if (!p) fail();
  if (status !== 200 && status !== 201) return record(body) && CODES.includes(body.code) ? { code: body.code } : null;
  if (!record(body)) fail();
  switch (p.route) {
    case 'list': return { projects: list(body.projects, 500).filter(x => record(x) && plainId(x.projectId)).map(project) };
    case 'compare': return { path: p.file, version: versionOf(body.version), girruText: clip(body.girruText, 40000), folderText: clip(body.folderText, 40000) };
    case 'rewrite': case 'undo': case 'project': return { project: project(body.project) };
    case 'use-girru': return { project: project(body.project), undo: undoToken(body.undo) ? body.undo : fail() };
    case 'needs': return { items: list(body.items, 200).map(problem).filter(Boolean) };
    case 'problem': return { ok: body.ok === true };
    case 'places': {
      const places = {};
      if (record(body.places)) for (const [k, v] of Object.entries(body.places).slice(0, 600)) if (placeKey(k) && record(v)) places[k] = { staysLocal: v.staysLocal === true };
      return { places };
    }
    case 'place': return { place: placeKey(body.place) ? body.place : p.id, staysLocal: body.staysLocal === true };
  }
  return fail();
}
