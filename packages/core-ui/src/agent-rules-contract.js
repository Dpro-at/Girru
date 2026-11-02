// Wire contract for Agents › Rules (RULES-01), shared by the browser client (session.ts)
// and the local bridge (application-server.cjs). Only these routes and shapes pass;
// a rule comes back with its own fields only.

export const RULES_PATH = '/api/agent-rules';
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const ID = '[0-9a-f-]{36}';
const ITEM = new RegExp(`^/api/agent-rules/(${ID})$`);
const ACTION = new RegExp(`^/api/agent-rules/(${ID})/(delete|undo-delete|accept|dismiss|versions|put-back)$`);
const RESTORE = new RegExp(`^/api/agent-rules/(${ID})/versions/([1-9][0-9]{0,5})/restore$`);
const EFFECTIVE = /^\/api\/agent-rules\/(effective|conflicts)\?agentId=[A-Za-z0-9_.%-]{1,200}(&projectId=[A-Za-z0-9_-]{1,64})?$/;
const FILES = /^\/api\/agent-rules\/files\/[A-Za-z0-9_-]{1,64}$/;
const TASKS = /^\/api\/agent-rules\/files\/[A-Za-z0-9_-]{1,64}\/tasks$/;
const FIELDS = ['text', 'when', 'projectId', 'who', 'targets', 'paused'];

export function agentRulesRoute(path) {
  return typeof path === 'string' && (path === RULES_PATH || path.startsWith(`${RULES_PATH}/`) || path.startsWith(`${RULES_PATH}?`));
}
/** A rule body: known fields only, each the right kind (the server checks the rest). */
function ruleBody(body, partial) {
  if (!record(body)) return false;
  const keys = Object.keys(body);
  if (!keys.length || !keys.every(k => FIELDS.includes(k))) return false;
  if (!partial && typeof body.text !== 'string') return false;
  if ('text' in body && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000)) return false;
  if ('when' in body && body.when !== null && (typeof body.when !== 'string' || body.when.length > 300)) return false;
  if ('projectId' in body && body.projectId !== null && (typeof body.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.projectId))) return false;
  if ('who' in body && !['all', 'departments', 'agents'].includes(body.who)) return false;
  if ('targets' in body && (!Array.isArray(body.targets) || body.targets.length > 50 || !body.targets.every(t => typeof t === 'string' && t.length > 0 && t.length <= 120))) return false;
  if ('paused' in body && typeof body.paused !== 'boolean') return false;
  return true;
}
export function allowedAgentRules(method, path, body) {
  if (!agentRulesRoute(path)) return false;
  if (method === 'GET') return body === undefined && (path === RULES_PATH || FILES.test(path) || EFFECTIVE.test(path) || (ACTION.exec(path)?.[2] === 'versions'));
  if (method === 'POST') {
    if (path === RULES_PATH) return ruleBody(body, false);
    if (path === `${RULES_PATH}/starter`) return body === undefined;
    if (FILES.test(path)) return record(body) && Object.keys(body).length === 1 && (body.mode === 'private' || body.mode === 'project');
    const a = ACTION.exec(path);
    if (a && a[2] !== 'versions') return body === undefined;
    return RESTORE.test(path) && body === undefined;
  }
  if (method === 'PUT' && TASKS.test(path)) return record(body) && Object.keys(body).length === 1 && typeof body.on === 'boolean';
  if (method === 'PUT') return ITEM.test(path) && ruleBody(body, true);
  return false;
}

const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : null);
function rule(r) {
  if (!record(r) || typeof r.id !== 'string' || typeof r.text !== 'string') throw Error('protocol');
  return {
    id: r.id, text: r.text.slice(0, 2000), when: str(r.when, 300), projectId: str(r.projectId, 64), who: ['all', 'departments', 'agents'].includes(r.who) ? r.who : 'all',
    targets: Array.isArray(r.targets) ? r.targets.filter(t => typeof t === 'string').slice(0, 50) : [], paused: r.paused === true,
    status: r.status === 'suggested' ? 'suggested' : 'active', source: r.source === 'agent' ? 'agent' : r.source === 'girru' ? 'girru' : 'owner', shipped: r.shipped === true, locked: r.locked === true,
    suggestedBy: str(r.suggestedBy, 120), reason: str(r.reason, 500), version: Number.isSafeInteger(r.version) ? r.version : 1,
    createdAt: str(r.createdAt, 40) ?? '', updatedAt: str(r.updatedAt, 40) ?? '',
    // STORE-MAP-01 P2: the rule's precedence group, when the backend orders by precedence.
    ...(RULE_GROUPS.includes(r.group) ? { group: r.group } : {}),
  };
}
/** STORE-MAP-01 P2 (AG6): precedence groups, strongest first. */
export const RULE_GROUPS = ['safety', 'project', 'agents', 'departments', 'all'];
const rules = x => (Array.isArray(x) ? x.slice(0, 400).map(rule) : []);
const ACTIONS = ['create', 'add', 'update', 'unchanged', 'tracked', 'link'];
function files(f) {
  if (!record(f)) throw Error('protocol');
  return { projectId: str(f.projectId, 64) ?? '', hasFolder: typeof f.folder === 'string' || f.hasFolder === true, mode: f.mode === 'project' ? 'project' : 'private', written: f.written === true, upToDate: f.upToDate === true,
    files: Array.isArray(f.files) ? f.files.slice(0, 8).filter(x => record(x) && typeof x.name === 'string' && ACTIONS.includes(x.action)).map(x => ({ name: x.name.slice(0, 40), action: x.action })) : [],
    rules: str(f.rules, 60000) ?? '', tasks: taskFile(f.tasks) };
}
/** TASKLOG-01: the project's task file: on or off, open tasks on the board, lines to fix. */
function taskFile(t) {
  if (!record(t)) return { on: false, file: '.girru/tasks.md', open: 0, problems: [] };
  return { on: t.on === true, file: '.girru/tasks.md', open: Number.isSafeInteger(t.open) && t.open >= 0 ? t.open : 0,
    problems: Array.isArray(t.problems) ? t.problems.slice(0, 20).filter(p => record(p) && Number.isSafeInteger(p.line) && typeof p.message === 'string').map(p => ({ line: p.line, message: p.message.slice(0, 200) })) : [] };
}
/** Only rule fields (or a known code; a refused rule keeps its one-line reason) pass back to the page. */
export function agentRulesResponse(path, status, body) {
  if (status === 200 || status === 201) {
    if (!record(body)) throw Error('protocol');
    if (path === RULES_PATH && 'rules' in body) return { rules: rules(body.rules), suggestions: rules(body.suggestions), departments: Array.isArray(body.departments) ? body.departments.filter(d => typeof d === 'string').slice(0, 100) : [], starter: Array.isArray(body.starter) ? body.starter.filter(d => typeof d === 'string').slice(0, 20) : [], precedence: body.precedence === true };
    if ('rule' in body) return { rule: rule(body.rule) };
    if ('files' in body) return { files: files(body.files) };
    if ('rules' in body) return { rules: rules(body.rules), ...(body.precedence === true ? { precedence: true } : {}) };
    if ('added' in body) return { added: rules(body.added) };
    if ('conflicts' in body) return { checked: body.checked === true, conflicts: Array.isArray(body.conflicts) ? body.conflicts.slice(0, 10).filter(c => record(c) && typeof c.a === 'string' && typeof c.b === 'string').map(c => ({ a: c.a, b: c.b, why: str(c.why, 200) ?? '' })) : [] };
    if ('versions' in body) return { versions: Array.isArray(body.versions) ? body.versions.slice(0, 200).filter(v => record(v) && Number.isSafeInteger(v.version) && typeof v.text === 'string').map(v => ({ version: v.version, text: v.text.slice(0, 2000), when: str(v.when, 300), changedAt: str(v.changedAt, 40) ?? '' })) : [] };
    if (body.ok === true) return { ok: true, undoMs: Number.isSafeInteger(body.undoMs) ? body.undoMs : 0 };
    throw Error('protocol');
  }
  const code = status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 400 ? 'invalid_rule' : 'unavailable';
  return status === 400 && record(body) && typeof body.error === 'string' ? { code, error: body.error.slice(0, 300) } : { code };
}
