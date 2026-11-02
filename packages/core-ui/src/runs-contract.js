// RUNS-01: wire contract for the Runs section, shared by the browser client (session.ts)
// and the local bridge (application-server.cjs). Only these routes pass, and only the
// fields below come back to the page (texts are already redacted by the server).
const BASE = '/api/runs';
const PLACES = ['running', 'waiting', 'finished', 'failed'];
const KINDS = ['chat', 'task', 'helper', 'code', 'job', 'handoff'];
const QUERY = ['place', 'kind', 'agent', 'project', 'q', 'before', 'limit'];
const RUN_ID = /^(chat|task|code|job|approval|handoff):[A-Za-z0-9_.:-]{1,160}$/;
const SCHEDULE_ID = /^(job|chatsch|cardsch|checkin):[A-Za-z0-9_.:-]{1,160}$/;
const KEY = /^[A-Za-z0-9_.:-]{1,120}$/;
const STATES = ['working', 'queued', 'waiting', 'done', 'failed', 'stopped'];
const STEP_STATES = ['done', 'now', 'wait', 'fail', 'skip'];
const STARTED = ['you', 'schedule', 'card', 'approval', 'agent', 'system', 'manual'];
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const text = (x, max) => typeof x === 'string' ? x.slice(0, max).replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '') : '';
const maybe = (x, max) => typeof x === 'string' && x ? text(x, max) : null;
const date = x => typeof x === 'string' && x.length <= 40 && Number.isFinite(Date.parse(x)) ? x : null;
const num = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
const key = x => typeof x === 'string' && KEY.test(x) ? x : undefined;

function decoded(segment) { try { const v = decodeURIComponent(segment); return encodeURIComponent(v) === segment ? v : null; } catch { return null; } }
export function runsRoute(path) {
  if (typeof path !== 'string' || !path.startsWith(BASE)) return null;
  const [base, search = ''] = path.split('?');
  if (base === BASE) {
    const q = new URLSearchParams(search), keys = [...q.keys()];
    if (keys.some(k => !QUERY.includes(k)) || new Set(keys).size !== keys.length) return null;
    if (q.has('place') && !PLACES.includes(q.get('place'))) return null;
    if (q.has('kind') && !KINDS.includes(q.get('kind'))) return null;
    for (const k of ['agent', 'project']) if (q.has(k) && !KEY.test(q.get(k))) return null;
    if (q.has('q') && q.get('q').length > 200) return null;
    for (const k of ['before', 'limit']) if (q.has(k) && !/^\d{1,15}$/.test(q.get(k))) return null;
    return { kind: 'list' };
  }
  if (search) return null;
  if (base === `${BASE}/schedules`) return { kind: 'schedules' };
  let m = /^\/api\/runs\/item\/([^/?#]+)(?:\/(stop|retry))?$/.exec(base);
  if (m) { const id = decoded(m[1]); return id && RUN_ID.test(id) ? { kind: m[2] ?? 'item', id } : null; }
  m = /^\/api\/runs\/schedules\/([^/?#]+)\/runs$/.exec(base);
  if (m) { const id = decoded(m[1]); return id && SCHEDULE_ID.test(id) ? { kind: 'scheduleRuns', id } : null; }
  return null;
}
// Board RN6: "Schedule a task" — instructions and when; the rest is the agent's work.
const TASK_KEYS = ['instructions', 'agentId', 'every', 'at', 'weekday', 'notify', 'newChat', 'model', 'thinking', 'projectId'];
function taskScheduleOk(b) {
  if (!record(b) || Object.keys(b).some(k => !TASK_KEYS.includes(k))) return false;
  if (typeof b.instructions !== 'string' || !b.instructions.trim() || b.instructions.length > 5000) return false;
  if (!['hourly', 'daily', 'weekly'].includes(b.every) || typeof b.at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.at)) return false;
  if (b.weekday !== undefined && !(Number.isInteger(b.weekday) && b.weekday >= 0 && b.weekday <= 6)) return false;
  for (const k of ['agentId', 'projectId']) if (b[k] !== undefined && b[k] !== null && !(typeof b[k] === 'string' && KEY.test(b[k]))) return false;
  if (b.notify !== undefined && !['important', 'all', 'none'].includes(b.notify)) return false;
  if (b.newChat !== undefined && typeof b.newChat !== 'boolean') return false;
  if (b.thinking !== undefined && !['quick', 'normal', 'deep'].includes(b.thinking)) return false;
  if (b.model !== undefined && !(typeof b.model === 'string' && b.model.length <= 100 && /^[A-Za-z0-9_.:@/-]*$/.test(b.model))) return false;
  return true;
}
export function allowedRuns(method, path, body) {
  const r = runsRoute(path); if (!r) return false;
  if (r.kind === 'schedules' && method === 'POST') return taskScheduleOk(body);
  if (r.kind === 'stop' || r.kind === 'retry') return method === 'POST' && record(body) && Object.keys(body).length === 0;
  return method === 'GET' && body === undefined;
}

const reason = x => record(x) && typeof x.code === 'string' ? { code: text(x.code, 40), title: text(x.title, 80), text: text(x.text, 400), bug: x.bug === true, ...(typeof x.detail === 'string' ? { detail: text(x.detail, 300) } : {}) } : null;
function run(x) {
  if (!record(x) || typeof x.id !== 'string' || !RUN_ID.test(x.id) || !KINDS.includes(x.kind) || !STATES.includes(x.state)) throw Error('protocol');
  const l = record(x.link) ? x.link : {};
  return {
    id: x.id, kind: x.kind, title: text(x.title, 160) || 'Run', state: x.state, reason: reason(x.reason),
    agentId: key(x.agentId) ?? null, agentName: maybe(x.agentName, 120), app: maybe(x.app, 40), model: maybe(x.model, 120),
    projectId: key(x.projectId) ?? null, projectName: maybe(x.projectName, 120), startedBy: STARTED.includes(x.startedBy) ? x.startedBy : 'you',
    startedAt: date(x.startedAt), endedAt: date(x.endedAt), needsYou: x.needsYou === true, parentId: typeof x.parentId === 'string' && RUN_ID.test(x.parentId) ? x.parentId : null,
    link: { ...(key(l.sessionId) ? { sessionId: l.sessionId } : {}), ...(key(l.jobId) ? { jobId: l.jobId } : {}), ...(key(l.taskRunId) ? { taskRunId: l.taskRunId } : {}), ...(key(l.approvalId) ? { approvalId: l.approvalId } : {}) },
  };
}
function schedule(x) {
  if (!record(x) || typeof x.id !== 'string' || !SCHEDULE_ID.test(x.id) || !['job', 'chatsch', 'cardsch', 'checkin'].includes(x.kind)) throw Error('protocol');
  const l = record(x.link) ? x.link : {};
  return {
    id: x.id, kind: x.kind, title: text(x.title, 160) || 'Schedule', when: text(x.when, 80), enabled: x.enabled === true,
    nextRun: date(x.nextRun), lastRun: date(x.lastRun), lastResult: ['done', 'failed', 'skipped'].includes(x.lastResult) ? x.lastResult : null, lastReason: reason(x.lastReason),
    agentId: key(x.agentId) ?? null, agentName: maybe(x.agentName, 120),
    link: Object.fromEntries(['jobId', 'sessionId', 'boardId', 'cardId', 'agentId'].filter(k => key(l[k])).map(k => [k, l[k]]).concat(typeof l.runId === 'string' && RUN_ID.test(l.runId) ? [['runId', l.runId]] : [])),
  };
}
const list = (x, max, f) => { if (!Array.isArray(x) || x.length > max) throw Error('protocol'); return x.map(f); };
export function runsResponse(path, status, body) {
  const r = runsRoute(path); if (!r) throw Error('protocol');
  if (status !== 200 && status !== 202 && status !== 201) return { code: status === 404 ? 'not_found' : status === 409 ? 'not_possible' : status === 403 ? 'forbidden' : 'runs_unavailable' };
  if (!record(body)) throw Error('protocol');
  if (r.kind === 'list') {
    const c = record(body.counts) ? body.counts : {};
    return { runs: list(body.runs, 100, run), next: num(body.next), counts: { running: num(c.running) ?? 0, waiting: num(c.waiting) ?? 0 } };
  }
  if (r.kind === 'item') {
    const res = record(body.result) ? body.result : {};
    const one = run(body.run); if (one.id !== r.id) throw Error('protocol');
    return {
      run: one, subtasks: Array.isArray(body.subtasks) ? list(body.subtasks, 50, run) : [], subNotice: reason(body.subNotice),
      steps: list(body.steps, 300, s => ({ title: text(s?.title, 200), meta: text(s?.meta, 200), state: STEP_STATES.includes(s?.state) ? s.state : 'done' })),
      log: list(body.log, 400, l => ({ at: text(l?.at, 12), text: text(l?.text, 300) })),
      result: { text: maybe(res.text, 1200), tokensIn: num(res.tokensIn), tokensOut: num(res.tokensOut), costCents: num(res.costCents) },
      copy: text(body.copy, 6000),
    };
  }
  if (r.kind === 'schedules' && Array.isArray(body.schedules)) return { schedules: list(body.schedules, 2000, schedule) };
  if (r.kind === 'schedules') { if (typeof body.id !== 'string' || !SCHEDULE_ID.test(body.id)) throw Error('protocol'); return { id: body.id, ...(key(body.boardId) ? { boardId: body.boardId } : {}), ...(key(body.cardId) ? { cardId: body.cardId } : {}) }; }
  if (r.kind === 'scheduleRuns') return { runs: list(body.runs, 20, run) };
  return { ok: body.ok === true, ...(typeof body.status === 'string' ? { status: text(body.status, 20) } : {}), ...(typeof body.run === 'string' && RUN_ID.test(body.run) ? { run: body.run } : {}), ...(key(body.sessionId) ? { sessionId: body.sessionId } : {}) };
}
