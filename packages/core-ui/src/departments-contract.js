// Wire contract for Settings › Departments, shared by the browser client
// (session.ts) and the local bridge (application-server.cjs).
//  - today: a department is the agents' own `department` value; renaming one moves every agent in it;
//  - STORE-MAP-01 P3 (GIRRU_STORE_P3): one list of departments for agents and projects, by id
//    (/api/departments …); rename and merge follow everywhere, a merge can be undone.

export const DEPARTMENT_RENAME_PATH = '/api/agents/departments/rename';
export const DEPARTMENTS_PATH = '/api/departments';
/** The same shape as an agent's department on the agent page (lowercase, at most 64). */
export const departmentName = x => typeof x === 'string' && /^[a-z0-9][a-z0-9 _-]{0,63}$/.test(x);
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const id = x => typeof x === 'string' && ID.test(x);
const text = (x, max = 80) => typeof x === 'string' && x.trim().length > 0 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
const MERGE = /^\/api\/departments\/([^/]+)\/merge$/;
const UNDO = /^\/api\/departments\/merges\/([^/]+)\/undo$/;
const QUESTION = /^\/api\/departments\/questions\/([^/]+)$/;
const ONE = /^\/api\/departments\/([^/]+)$/;
const DELETE = /^\/api\/departments\/([^/]+)\/delete(-preview)?$/;

export function departmentsRoute(path) { return path === DEPARTMENT_RENAME_PATH || path === DEPARTMENTS_PATH || path.startsWith(`${DEPARTMENTS_PATH}/`); }
export function allowedDepartments(method, path, body) {
  if (path === DEPARTMENT_RENAME_PATH) {
    return method === 'POST' && record(body) && Object.keys(body).length === 2 && departmentName(body.from) && departmentName(body.to);
  }
  if (path === DEPARTMENTS_PATH) {
    if (method === 'GET') return body === undefined;
    return method === 'POST' && record(body) && Object.keys(body).length === 1 && text(body.name);
  }
  let m;
  if ((m = MERGE.exec(path))) return method === 'POST' && id(decodeURIComponent(m[1])) && record(body) && Object.keys(body).length === 1 && id(body.into);
  if ((m = UNDO.exec(path))) return method === 'POST' && id(decodeURIComponent(m[1])) && (body === undefined || (record(body) && !Object.keys(body).length));
  if ((m = QUESTION.exec(path))) return method === 'POST' && id(decodeURIComponent(m[1])) && record(body) && Object.keys(body).length === 1 && (body.departmentId === null || id(body.departmentId));
  if ((m = DELETE.exec(path))) {
    if (method !== 'POST' || !id(decodeURIComponent(m[1]))) return false;
    return m[2] ? (body === undefined || (record(body) && !Object.keys(body).length))
      : record(body) && Object.keys(body).length === 1 && typeof body.expectedPreviewHash === 'string' && /^[0-9a-f]{64}$/.test(body.expectedPreviewHash);
  }
  if ((m = ONE.exec(path))) {
    if (method !== 'PATCH' || !id(decodeURIComponent(m[1])) || !record(body) || !Number.isSafeInteger(body.version)) return false;
    const keys = Object.keys(body).filter(k => k !== 'version');
    return keys.length > 0 && keys.every(k => (k === 'name' && text(body.name)) || (k === 'letter' && (body.letter === null || text(body.letter, 2)))
      || (k === 'color' && (body.color === null || (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)))) || (k === 'leadAgentId' && (body.leadAgentId === null || id(body.leadAgentId))));
  }
  return false;
}

const code = status => ({ code: status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 400 ? 'invalid_input' : status === 409 ? 'conflict' : 'unavailable' });
const short = (x, max = 80) => (typeof x === 'string' ? x.slice(0, max) : null);
function department(d) {
  if (!record(d) || !id(d.id) || typeof d.name !== 'string' || !Number.isSafeInteger(d.version)) throw Error('protocol');
  return { id: d.id, name: d.name.slice(0, 80), letter: short(d.letter, 2), color: typeof d.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(d.color) ? d.color : null, leadAgentId: id(d.leadAgentId) ? d.leadAgentId : null, version: d.version };
}
const list = (x, f) => (Array.isArray(x) ? x.slice(0, 500).map(f) : []);

/** Only the known fields pass back to the page. */
export function departmentsResponse(status, body, path = DEPARTMENT_RENAME_PATH) {
  if (status !== 200) {
    const out = code(status);
    if (status === 409 && record(body) && typeof body.code === 'string' && /^[a-z_]{1,40}$/.test(body.code)) out.reason = body.code;
    return out;
  }
  if (path === DEPARTMENT_RENAME_PATH) {
    if (!record(body) || typeof body.from !== 'string' || typeof body.to !== 'string' || !Number.isSafeInteger(body.moved) || body.moved < 0) throw Error('protocol');
    return { from: body.from, to: body.to, moved: body.moved };
  }
  if (!record(body)) throw Error('protocol');
  if (path === DEPARTMENTS_PATH && Array.isArray(body.departments)) {
    return {
      departments: list(body.departments, d => ({ ...department(d),
        agents: list(d.agents, a => ({ id: String(a?.id ?? '').slice(0, 128), name: short(a?.name) ?? '' })).filter(a => id(a.id)),
        projects: list(d.projects, p => ({ key: String(p?.key ?? '').slice(0, 128), name: short(p?.name) ?? '' })).filter(p => p.key) })),
      questions: list(body.questions, q => ({ id: String(q?.id ?? '').slice(0, 128), kind: short(q?.kind, 32) ?? '', subjectId: short(q?.subjectId, 128) ?? '', name: short(q?.name) ?? '' })).filter(q => id(q.id)),
    };
  }
  if (MERGE.test(path)) {
    if (!id(body.mergeId)) throw Error('protocol');
    return { mergeId: body.mergeId, into: department(body.into) };
  }
  if (QUESTION.test(path)) return { ok: body.ok === true };
  if (DELETE.test(path)) {
    const e = record(body.effects) ? body.effects : {};
    // Backend names (projectsToGeneral, …) or this contract's own (projects, …) when read twice.
    const n = (k, own) => [e[k], e[own]].find(v => Number.isSafeInteger(v) && v >= 0) ?? 0;
    const out = { name: short(body.department?.name) ?? short(body.name) ?? '', effects: { projects: n('projectsToGeneral', 'projects'), agents: n('agentsToNone', 'agents'), pinnedFacts: n('pinnedFactsRemoved', 'pinnedFacts'), accessRules: n('accessRulesRemoved', 'accessRules') } };
    if (path.endsWith('-preview')) { if (typeof body.previewHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.previewHash)) throw Error('protocol'); out.previewHash = body.previewHash; }
    return out;
  }
  return { department: department(body.department) };
}
